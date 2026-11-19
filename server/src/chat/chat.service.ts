import { Inject, Injectable } from '@nestjs/common';
import { bad, forbidden, notFound, tooMany } from '../common/errors';
import { isUuid } from '../common/validate';
import { Db, Q } from '../db/db';
import { MediaService } from '../media/media.service';
import { PushService } from '../push/push.service';
import { RateLimiter } from '../realtime/redis';
import { Realtime } from '../realtime/realtime';

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  senderNickname: string | null;
  senderColor: number;
  clientMsgId: string;
  kind: string;
  body: string;
  mediaId: string | null;
  meta: any;
  replyToId: string | null;
  /** 운영 조치로 숨겨진 메시지 */
  hidden: boolean;
  /** 그룹방에서 내가 차단한 회원의 메시지(내용을 내려주지 않는다) */
  masked: boolean;
  createdAt: string;
}

/** r 에 sender_nickname / sender_color / sender_active / mask 가 있으면 반영한다. */
export const toMessage = (r: any): MessageDto => {
  const hidden = !!r.hidden_at || !!r.deleted_at;
  const masked = !!r.mask;
  const blank = hidden || masked;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    senderId: r.sender_id,
    senderNickname: r.sender_active === false ? '탈퇴한 회원' : (r.sender_nickname ?? null),
    senderColor: r.sender_color ?? 0,
    clientMsgId: r.client_msg_id,
    kind: r.kind,
    body: blank ? '' : r.body,
    mediaId: blank ? null : (r.media_id ?? null),
    meta: blank ? null : (r.meta ?? null),
    replyToId: r.reply_to_id,
    hidden,
    masked,
    createdAt: new Date(r.created_at).toISOString(),
  };
};

/** viewer 기준 메시지 조회 SQL. $1 = viewer. 그룹방에서 viewer 가 차단한 회원의 메시지는 mask=true. */
const MESSAGE_SELECT = `
  SELECT m.*, p.nickname AS sender_nickname, p.avatar_color AS sender_color, (u.status = 'active') AS sender_active,
         (c.type = 'group' AND EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = m.sender_id)) AS mask
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN profiles p ON p.user_id = m.sender_id`;

/** 두 사람의 1대1 대화방을 만들거나 기존 방을 돌려준다. 호출 전에 lockPair로 잠가 둔다. */
export async function ensureDirectConversation(q: Q, low: string, high: string): Promise<{ id: string; created: boolean }> {
  const ins = await q.one<{ id: string }>(
    `INSERT INTO conversations (type, user_low, user_high) VALUES ('direct', $1, $2)
     ON CONFLICT (user_low, user_high) WHERE type = 'direct' DO NOTHING RETURNING id`,
    [low, high],
  );
  const id = ins?.id ?? (await q.one<{ id: string }>(`SELECT id FROM conversations WHERE type = 'direct' AND user_low = $1 AND user_high = $2`, [low, high]))!.id;
  await q.query(
    `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
    [id, low, high],
  );
  return { id, created: !!ins };
}

export interface AppendOpts {
  kind?: string;
  body?: string;
  replyToId?: string | null;
  mediaId?: string | null;
  meta?: unknown;
}

/** 메시지 저장. 같은 clientMsgId가 다시 오면 새로 만들지 않고 기존 메시지를 돌려준다. */
export async function appendMessage(q: Q, conversationId: string, senderId: string, clientMsgId: string, opts: AppendOpts): Promise<{ message: MessageDto; duplicate: boolean }> {
  // 방 단위 행 잠금으로 seq 발급과 중복 확인을 직렬화한다.
  const conv = await q.one<{ type: string }>('SELECT type FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
  const withSender = async (id: string) => toMessage(await q.one(`${MESSAGE_SELECT} WHERE m.id = $2`, [senderId, id]));
  const dup = await q.one<{ id: string }>('SELECT id FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3', [conversationId, senderId, clientMsgId]);
  if (dup) return { message: await withSender(dup.id), duplicate: true };
  const c = await q.one<{ last_seq: string }>('UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq', [conversationId]);
  const row = await q.one<{ id: string }>(
    `INSERT INTO messages (conversation_id, seq, sender_id, client_msg_id, kind, body, reply_to_id, media_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [conversationId, c!.last_seq, senderId, clientMsgId, opts.kind ?? 'text', opts.body ?? '', opts.replyToId ?? null, opts.mediaId ?? null, opts.meta ? JSON.stringify(opts.meta) : null],
  );
  await q.query('UPDATE conversation_participants SET last_read_seq = $3 WHERE conversation_id = $1 AND user_id = $2', [conversationId, senderId, c!.last_seq]);
  // 1대1 방은 한쪽이 나갔더라도 새 메시지가 오면 다시 목록에 나타난다.
  if (conv?.type === 'direct') await q.query('UPDATE conversation_participants SET left_at = NULL WHERE conversation_id = $1 AND left_at IS NOT NULL', [conversationId]);
  return { message: await withSender(row!.id), duplicate: false };
}

const previewOf = (kind: string, body: string) => (kind === 'image' ? '사진' : body);

@Injectable()
export class ChatService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  async list(userId: string, onlyId?: string) {
    const rows = await this.db.query<any>(
      `SELECT c.id, c.type, c.last_seq, c.last_message_at, cp.last_read_seq, cp.muted, cp.role,
              r.title AS room_title, r.kind AS room_kind, r.member_count, r.capacity, r.image_media_id, r.status AS room_status,
              pcp.user_id AS peer_id, pcp.last_read_seq AS peer_read_seq, pu.status AS peer_status,
              pp.nickname AS peer_nickname, pp.avatar_color AS peer_color, pp.photo_media_id AS peer_photo,
              m.body AS last_body, m.kind AS last_kind, m.sender_id AS last_sender, m.created_at AS last_at,
              (m.hidden_at IS NOT NULL) AS last_hidden,
              (c.type = 'group' AND EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = m.sender_id)) AS last_masked,
              (SELECT count(*) FROM messages x WHERE x.conversation_id = c.id AND x.seq > cp.last_read_seq AND x.sender_id <> $1 AND x.kind <> 'system') AS unread,
              EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = pcp.user_id) OR (b.blocker_id = pcp.user_id AND b.blocked_id = $1)) AS blocked,
              EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = pcp.user_id) AS blocked_by_me
         FROM conversation_participants cp
         JOIN conversations c ON c.id = cp.conversation_id
         LEFT JOIN rooms r ON r.conversation_id = c.id
         LEFT JOIN conversation_participants pcp ON c.type = 'direct' AND pcp.conversation_id = c.id AND pcp.user_id <> $1
         LEFT JOIN users pu ON pu.id = pcp.user_id
         LEFT JOIN profiles pp ON pp.user_id = pcp.user_id
         LEFT JOIN messages m ON m.conversation_id = c.id AND m.seq = c.last_seq
        WHERE cp.user_id = $1 AND cp.left_at IS NULL ${onlyId ? 'AND c.id = $2' : ''}
        ORDER BY c.last_message_at DESC LIMIT 300`,
      onlyId ? [userId, onlyId] : [userId],
    );
    return rows.map((r) => {
      const group = r.type === 'group';
      const gone = !group && r.peer_status !== 'active';
      const lastBody = !r.last_at ? null : r.last_hidden ? '숨겨진 메시지' : r.last_masked ? '차단한 회원의 메시지' : previewOf(r.last_kind, r.last_body);
      return {
        id: r.id,
        type: r.type,
        title: group ? r.room_title : gone ? '탈퇴한 회원' : r.peer_nickname,
        peer: group ? null : { userId: r.peer_id, nickname: gone ? '탈퇴한 회원' : r.peer_nickname, avatarColor: gone ? 0 : r.peer_color, photoMediaId: gone ? null : r.peer_photo, active: !gone },
        room: group
          ? { kind: r.room_kind, memberCount: r.member_count, capacity: r.capacity, imageMediaId: r.image_media_id, role: r.role, closed: r.room_status !== 'open' }
          : null,
        lastSeq: Number(r.last_seq),
        lastReadSeq: Number(r.last_read_seq),
        peerReadSeq: group ? 0 : Number(r.peer_read_seq),
        unreadCount: Number(r.unread),
        muted: r.muted,
        canSend: group ? r.room_status === 'open' : !gone && !r.blocked,
        blockedByMe: !group && r.blocked_by_me,
        lastMessage: lastBody === null ? null : { body: lastBody, kind: r.last_kind, senderId: r.last_sender, createdAt: new Date(r.last_at).toISOString() },
        updatedAt: new Date(r.last_message_at).toISOString(),
      };
    });
  }

  async summaryFor(userId: string, conversationId: string) {
    return (await this.list(userId, conversationId))[0] ?? null;
  }

  private async membership(q: Q, userId: string, conversationId: string) {
    const m = await q.one<{ type: string; role: string; peer_id: string | null; room_status: string | null }>(
      `SELECT c.type, cp.role, r.status AS room_status,
              (SELECT pcp.user_id FROM conversation_participants pcp WHERE c.type = 'direct' AND pcp.conversation_id = c.id AND pcp.user_id <> cp.user_id) AS peer_id
         FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id
         LEFT JOIN rooms r ON r.conversation_id = c.id
        WHERE cp.conversation_id = $1 AND cp.user_id = $2 AND cp.left_at IS NULL`,
      [conversationId, userId],
    );
    if (!m) throw notFound('대화방을 찾을 수 없습니다.');
    return m;
  }

  async messages(userId: string, conversationId: string, afterSeq: number | null, beforeSeq: number | null, limit: number, search?: string) {
    await this.membership(this.db, userId, conversationId);
    let rows: any[];
    if (search) {
      rows = await this.db.query(
        `${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.kind IN ('text','greeting') AND m.hidden_at IS NULL AND m.body ILIKE $3 ORDER BY m.seq DESC LIMIT $4`,
        [userId, conversationId, `%${search.replace(/[%_\\]/g, '\\$&')}%`, limit],
      );
      rows = rows.filter((r) => !r.mask).reverse();
    } else if (afterSeq !== null) {
      rows = await this.db.query(`${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.seq > $3 ORDER BY m.seq ASC LIMIT $4`, [userId, conversationId, afterSeq, limit]);
    } else {
      rows = await this.db.query(`${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND ($3::bigint IS NULL OR m.seq < $3) ORDER BY m.seq DESC LIMIT $4`, [userId, conversationId, beforeSeq, limit]);
      rows.reverse();
    }
    const c = await this.db.one<{ last_seq: string }>('SELECT last_seq FROM conversations WHERE id = $1', [conversationId]);
    return { items: rows.map(toMessage), lastSeq: Number(c!.last_seq), hasMore: rows.length === limit };
  }

  /** 저장이 끝난 메시지를 참여자에게 알린다. 차단 관계에 따라 내용 가림·푸시 제외를 적용한다. */
  async fanOut(conversationId: string, message: MessageDto, opts: { push?: boolean } = {}) {
    const rows = await this.db.query<any>(
      `SELECT cp.user_id, cp.muted, c.type, r.title AS room_title,
              EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = cp.user_id AND b.blocked_id = $2) AS blocks_sender,
              EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = cp.user_id) AS blocked_by_sender
         FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id
         LEFT JOIN rooms r ON r.conversation_id = c.id
        WHERE cp.conversation_id = $1 AND cp.left_at IS NULL`,
      [conversationId, message.senderId],
    );
    const group = rows[0]?.type === 'group';
    const clear = rows.filter((r) => !(group && r.blocks_sender)).map((r) => r.user_id);
    const maskedTo = rows.filter((r) => group && r.blocks_sender).map((r) => r.user_id);
    this.rt.emit(clear, { type: 'message.new', data: { message } });
    if (maskedTo.length) {
      this.rt.emit(maskedTo, { type: 'message.new', data: { message: { ...message, body: '', mediaId: null, meta: null, masked: true } } });
    }
    if (opts.push === false || message.kind === 'system') return;
    const text = previewOf(message.kind, message.body);
    const targets = rows.filter((r) => r.user_id !== message.senderId && !r.muted && !r.blocks_sender && !r.blocked_by_sender);
    await this.push.send(
      targets.map((r) => ({
        userId: r.user_id,
        kind: group ? ('room' as const) : ('message' as const),
        title: group ? `${r.room_title}` : (message.senderNickname ?? '새 메시지'),
        body: group ? `${message.senderNickname ?? ''}: ${text}` : text,
        privateBody: '새 메시지가 도착했습니다.',
        data: { conversationId },
      })),
    );
  }

  async send(userId: string, conversationId: string, body: any) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const mediaId = isUuid(body?.mediaId) ? (body.mediaId as string) : null;
    const clientMsgId = typeof body?.clientMsgId === 'string' ? body.clientMsgId : '';
    if (!mediaId && (!text || [...text].length > 2000)) throw bad('INVALID_MESSAGE', '메시지는 1~2000자로 입력해 주세요.');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientMsgId)) throw bad('INVALID_INPUT', 'clientMsgId가 올바르지 않습니다.');
    if (!(await this.rl.hit(`msg:${userId}`, 30, 10))) throw tooMany('메시지를 너무 빠르게 보내고 있습니다.');

    const { message, duplicate } = await this.db.tx(async (q) => {
      const m = await this.membership(q, userId, conversationId);
      if (m.type === 'direct') {
        const state = await q.one<{ status: string; blocked: boolean }>(
          `SELECT u.status, EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) AS blocked
             FROM users u WHERE u.id = $2`,
          [userId, m.peer_id],
        );
        if (!state || state.status !== 'active' || state.blocked) throw forbidden('CANNOT_SEND', '메시지를 보낼 수 없는 상대입니다.');
      } else if (m.room_status !== 'open') {
        throw forbidden('ROOM_CLOSED', '종료된 방입니다.');
      }
      let replyToId: string | null = null;
      if (isUuid(body?.replyToId)) {
        replyToId = (await q.one<{ id: string }>('SELECT id FROM messages WHERE id = $1 AND conversation_id = $2', [body.replyToId, conversationId]))?.id ?? null;
      }
      if (mediaId) await this.media.assertOwned(q, userId, [mediaId], 'chat', conversationId);
      return appendMessage(q, conversationId, userId, clientMsgId, mediaId ? { kind: 'image', mediaId, replyToId } : { kind: 'text', body: text, replyToId });
    });
    if (!duplicate) await this.fanOut(conversationId, message);
    return { message, duplicate };
  }

  async markRead(userId: string, conversationId: string, seqRaw: unknown) {
    const m = await this.membership(this.db, userId, conversationId);
    const seq = Math.max(0, Math.trunc(Number(seqRaw) || 0));
    const row = await this.db.one<{ last_read_seq: string }>(
      `UPDATE conversation_participants cp
          SET last_read_seq = GREATEST(cp.last_read_seq, LEAST($3::bigint, c.last_seq))
         FROM conversations c
        WHERE c.id = cp.conversation_id AND cp.conversation_id = $1 AND cp.user_id = $2
        RETURNING cp.last_read_seq`,
      [conversationId, userId, seq],
    );
    const lastReadSeq = Number(row!.last_read_seq);
    this.rt.emit(m.peer_id ? [m.peer_id, userId] : [userId], { type: 'conversation.read', data: { conversationId, userId, seq: lastReadSeq } });
    return { lastReadSeq };
  }

  async setMuted(userId: string, conversationId: string, muted: boolean) {
    await this.membership(this.db, userId, conversationId);
    await this.db.query('UPDATE conversation_participants SET muted = $3 WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId, muted]);
    return { muted };
  }

  /** 1대1 방 나가기: 내 목록에서만 사라진다. 그룹방은 RoomsService.leave 를 쓴다. */
  async leaveDirect(userId: string, conversationId: string) {
    const m = await this.membership(this.db, userId, conversationId);
    if (m.type !== 'direct') throw bad('INVALID_INPUT', '그룹방은 방 정보에서 나갈 수 있습니다.');
    await this.db.query('UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    this.rt.emit([userId], { type: 'conversation.removed', data: { conversationId } });
    return { ok: true };
  }

  /** 대화 내용 TXT 내보내기(내가 볼 수 있는 내용만). */
  async exportText(userId: string, conversationId: string) {
    const summary = await this.summaryFor(userId, conversationId);
    if (!summary) throw notFound('대화방을 찾을 수 없습니다.');
    const rows = await this.db.query(`${MESSAGE_SELECT} WHERE m.conversation_id = $2 ORDER BY m.seq ASC LIMIT 20000`, [userId, conversationId]);
    const fmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
    const lines = rows.map(toMessage).map((m) => {
      const who = m.kind === 'system' ? '안내' : (m.senderNickname ?? '알 수 없음');
      const what = m.hidden ? '(숨겨진 메시지)' : m.masked ? '(차단한 회원의 메시지)' : m.kind === 'image' ? '(사진)' : m.body;
      return `[${fmt.format(new Date(m.createdAt))}] ${who}: ${what}`;
    });
    return { filename: `대화_${summary.title}.txt`, text: [`${summary.title} 대화 내용`, `내보낸 시각: ${fmt.format(new Date())}`, '', ...lines].join('\n') };
  }
}
