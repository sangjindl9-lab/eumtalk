import { Inject, Injectable } from '@nestjs/common';
import { bad, forbidden, notFound, tooMany } from '../common/errors';
import { Db, Q } from '../db/db';
import { RateLimiter } from '../realtime/redis';
import { Realtime } from '../realtime/realtime';

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  clientMsgId: string;
  kind: string;
  body: string;
  replyToId: string | null;
  createdAt: string;
}

export const toMessage = (r: any): MessageDto => ({
  id: r.id,
  conversationId: r.conversation_id,
  seq: Number(r.seq),
  senderId: r.sender_id,
  clientMsgId: r.client_msg_id,
  kind: r.kind,
  body: r.deleted_at ? '' : r.body,
  replyToId: r.reply_to_id,
  createdAt: new Date(r.created_at).toISOString(),
});

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

/** 메시지 저장. 같은 clientMsgId가 다시 오면 새로 만들지 않고 기존 메시지를 돌려준다. */
export async function appendMessage(
  q: Q,
  conversationId: string,
  senderId: string,
  clientMsgId: string,
  kind: string,
  body: string,
  replyToId: string | null = null,
): Promise<{ message: MessageDto; duplicate: boolean }> {
  // 방 단위 행 잠금으로 seq 발급과 중복 확인을 직렬화한다.
  await q.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
  const dup = await q.one('SELECT * FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3', [conversationId, senderId, clientMsgId]);
  if (dup) return { message: toMessage(dup), duplicate: true };
  const c = await q.one<{ last_seq: string }>(
    'UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq',
    [conversationId],
  );
  const row = await q.one(
    `INSERT INTO messages (conversation_id, seq, sender_id, client_msg_id, kind, body, reply_to_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [conversationId, c!.last_seq, senderId, clientMsgId, kind, body, replyToId],
  );
  await q.query('UPDATE conversation_participants SET last_read_seq = $3 WHERE conversation_id = $1 AND user_id = $2', [conversationId, senderId, c!.last_seq]);
  return { message: toMessage(row), duplicate: false };
}

@Injectable()
export class ChatService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
  ) {}

  async list(userId: string, onlyId?: string) {
    const rows = await this.db.query<any>(
      `SELECT c.id, c.last_seq, c.last_message_at, c.created_at, cp.last_read_seq, cp.muted,
              pcp.user_id AS peer_id, pcp.last_read_seq AS peer_read_seq, pu.status AS peer_status,
              pp.nickname AS peer_nickname, pp.avatar_color AS peer_color,
              m.body AS last_body, m.kind AS last_kind, m.sender_id AS last_sender, m.created_at AS last_at,
              (SELECT count(*) FROM messages x WHERE x.conversation_id = c.id AND x.seq > cp.last_read_seq AND x.sender_id <> $1) AS unread,
              EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = pcp.user_id) OR (b.blocker_id = pcp.user_id AND b.blocked_id = $1)) AS blocked,
              EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = pcp.user_id) AS blocked_by_me
         FROM conversation_participants cp
         JOIN conversations c ON c.id = cp.conversation_id AND c.type = 'direct'
         JOIN conversation_participants pcp ON pcp.conversation_id = c.id AND pcp.user_id <> $1
         JOIN users pu ON pu.id = pcp.user_id
         LEFT JOIN profiles pp ON pp.user_id = pcp.user_id
         LEFT JOIN messages m ON m.conversation_id = c.id AND m.seq = c.last_seq
        WHERE cp.user_id = $1 AND cp.left_at IS NULL ${onlyId ? 'AND c.id = $2' : ''}
        ORDER BY c.last_message_at DESC LIMIT 200`,
      onlyId ? [userId, onlyId] : [userId],
    );
    return rows.map((r) => {
      const gone = r.peer_status !== 'active';
      return {
        id: r.id,
        peer: { userId: r.peer_id, nickname: gone ? '탈퇴한 회원' : r.peer_nickname, avatarColor: gone ? 0 : r.peer_color, active: !gone },
        lastSeq: Number(r.last_seq),
        lastReadSeq: Number(r.last_read_seq),
        peerReadSeq: Number(r.peer_read_seq),
        unreadCount: Number(r.unread),
        muted: r.muted,
        canSend: !gone && !r.blocked,
        blockedByMe: r.blocked_by_me,
        lastMessage: r.last_at ? { body: r.last_body, kind: r.last_kind, senderId: r.last_sender, createdAt: new Date(r.last_at).toISOString() } : null,
        updatedAt: new Date(r.last_message_at).toISOString(),
      };
    });
  }

  async summaryFor(userId: string, conversationId: string) {
    return (await this.list(userId, conversationId))[0] ?? null;
  }

  private async membership(q: Q, userId: string, conversationId: string) {
    const m = await q.one<{ peer_id: string }>(
      `SELECT pcp.user_id AS peer_id FROM conversation_participants cp
         JOIN conversation_participants pcp ON pcp.conversation_id = cp.conversation_id AND pcp.user_id <> cp.user_id
        WHERE cp.conversation_id = $1 AND cp.user_id = $2 AND cp.left_at IS NULL`,
      [conversationId, userId],
    );
    if (!m) throw notFound('대화방을 찾을 수 없습니다.');
    return m;
  }

  async messages(userId: string, conversationId: string, afterSeq: number | null, beforeSeq: number | null, limit: number) {
    await this.membership(this.db, userId, conversationId);
    let rows: any[];
    if (afterSeq !== null) {
      rows = await this.db.query('SELECT * FROM messages WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3', [conversationId, afterSeq, limit]);
    } else {
      rows = await this.db.query(
        `SELECT * FROM messages WHERE conversation_id = $1 AND ($2::bigint IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
        [conversationId, beforeSeq, limit],
      );
      rows.reverse();
    }
    const c = await this.db.one<{ last_seq: string }>('SELECT last_seq FROM conversations WHERE id = $1', [conversationId]);
    return { items: rows.map(toMessage), lastSeq: Number(c!.last_seq), hasMore: rows.length === limit };
  }

  async send(userId: string, conversationId: string, body: any) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const clientMsgId = typeof body?.clientMsgId === 'string' ? body.clientMsgId : '';
    if (!text || [...text].length > 2000) throw bad('INVALID_MESSAGE', '메시지는 1~2000자로 입력해 주세요.');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientMsgId)) throw bad('INVALID_INPUT', 'clientMsgId가 올바르지 않습니다.');
    if (!(await this.rl.hit(`msg:${userId}`, 30, 10))) throw tooMany('메시지를 너무 빠르게 보내고 있습니다.');

    const { message, duplicate, peerId } = await this.db.tx(async (q) => {
      const m = await this.membership(q, userId, conversationId);
      const state = await q.one<{ status: string; blocked: boolean }>(
        `SELECT u.status, EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) AS blocked
           FROM users u WHERE u.id = $2`,
        [userId, m.peer_id],
      );
      if (!state || state.status !== 'active' || state.blocked) throw forbidden('CANNOT_SEND', '메시지를 보낼 수 없는 상대입니다.');
      let replyToId: string | null = null;
      if (typeof body?.replyToId === 'string') {
        const r = await q.one<{ id: string }>('SELECT id FROM messages WHERE id = $1 AND conversation_id = $2', [body.replyToId, conversationId]).catch(() => null);
        replyToId = r?.id ?? null;
      }
      const out = await appendMessage(q, conversationId, userId, clientMsgId, 'text', text, replyToId);
      return { ...out, peerId: m.peer_id };
    });
    if (!duplicate) this.rt.emit([userId, peerId], { type: 'message.new', data: { message } });
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
    this.rt.emit([m.peer_id, userId], { type: 'conversation.read', data: { conversationId, userId, seq: lastReadSeq } });
    return { lastReadSeq };
  }
}
