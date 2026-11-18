import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { bad, conflict, forbidden, notFound, tooMany } from '../common/errors';
import { containsLink } from '../common/validate';
import { appendMessage, ChatService, ensureDirectConversation } from '../chat/chat.service';
import { Db, lockPair, Q } from '../db/db';
import { PointsService } from '../points/points.service';
import { ListFilter, selectPublicProfiles } from '../profile/public-profile';
import { PushService } from '../push/push.service';
import { RateLimiter } from '../realtime/redis';
import { Realtime } from '../realtime/realtime';
import { blockIn } from '../safety/safety.service';

const MAX_LEN = 100;
const DAILY_LIMIT = 30;
const REGREET_DAYS = 7;
const MULTI_MAX = 30;

/** 장터 거래 문의처럼 "무엇에 대한 인사인지"를 함께 전달하는 정보 */
export interface GreetingContext {
  type: 'market';
  postId: string;
  title: string;
  price: number | null;
  category: string;
  thumbMediaId: string | null;
}

@Injectable()
export class GreetingsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(PushService) private readonly push: PushService,
    @Inject(PointsService) private readonly points: PointsService,
  ) {}

  private validateText(raw: unknown): string {
    const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    const len = [...text].length;
    if (len < 1 || len > MAX_LEN) throw bad('INVALID_GREETING', `인사말은 1~${MAX_LEN}자로 입력해 주세요.`);
    if (containsLink(text)) throw bad('LINK_NOT_ALLOWED', '수락 전 인사말에는 링크를 넣을 수 없습니다.');
    return text;
  }

  /** 대기 중 요청을 수락 상태로 바꾸고 대화방과 첫 메시지를 만든다. 잠금은 호출한 쪽이 잡고 있다. */
  private async acceptLocked(q: Q, g: { id: string; sender_id: string; receiver_id: string; body: string; context?: any }, low: string, high: string) {
    const conv = await ensureDirectConversation(q, low, high);
    await appendMessage(q, conv.id, g.sender_id, `greeting-${g.id}`, { kind: 'greeting', body: g.body, meta: g.context ? { context: g.context } : null });
    await q.query(`UPDATE greeting_requests SET status = 'accepted', conversation_id = $2, responded_at = now() WHERE id = $1`, [g.id, conv.id]);
    return conv.id;
  }

  private async notifyConversation(conversationId: string, userIds: string[]) {
    for (const id of userIds) {
      const conversation = await this.chat.summaryFor(id, conversationId);
      if (conversation) this.rt.emit([id], { type: 'conversation.created', data: { conversation } });
    }
  }

  private async notifyReceived(toUserId: string, greetingId: string) {
    const [item] = await this.listReceived(toUserId, greetingId);
    if (!item) return;
    this.rt.emit([toUserId], { type: 'greeting.received', data: { greeting: item } });
    await this.push.send([
      {
        userId: toUserId,
        kind: 'greeting',
        title: item.context ? `거래 문의: ${item.context.title}` : `${item.sender.nickname} 님의 인사`,
        body: item.body,
        privateBody: '새 인사가 도착했습니다.',
        data: { greetingId },
      },
    ]);
  }

  async send(userId: string, toUserId: string, textRaw: unknown, context: GreetingContext | null = null) {
    if (userId === toUserId) throw bad('INVALID_INPUT', '자신에게는 인사를 보낼 수 없습니다.');
    const text = this.validateText(textRaw);

    const result = await this.db.tx(async (q) => {
      const { low, high } = await lockPair(q, userId, toUserId);
      const target = await q.one<{ status: string; accept_greetings: boolean; blocked: boolean }>(
        `SELECT u.status, p.accept_greetings,
                EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) AS blocked
           FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $2`,
        [userId, toUserId],
      );
      // 차단 여부는 상대에게 드러내지 않도록 같은 문구로 응답한다.
      if (!target || target.status !== 'active' || target.blocked) throw forbidden('CANNOT_GREET', '지금은 이 회원에게 인사를 보낼 수 없습니다.');

      const conv = await q.one<{ id: string }>(`SELECT id FROM conversations WHERE type = 'direct' AND user_low = $1 AND user_high = $2`, [low, high]);
      if (conv) {
        // 이미 대화 중인 상대의 물건을 문의하면 그 대화방에 물건 정보를 붙여 보낸다.
        const msg = context ? (await appendMessage(q, conv.id, userId, `inq-${randomUUID()}`, { kind: 'text', body: text, meta: { context } })).message : null;
        return { status: 'conversation' as const, conversationId: conv.id, message: msg };
      }

      const pendings = await q.query<any>(
        `SELECT * FROM greeting_requests WHERE status = 'pending'
            AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))`,
        [userId, toUserId],
      );
      if (pendings.some((g) => g.sender_id === userId)) throw conflict('GREETING_PENDING', '이미 보낸 인사가 답을 기다리고 있습니다.');
      const reverse = pendings.find((g) => g.sender_id === toUserId);
      if (reverse) {
        // 서로 인사를 보낸 경우: 양쪽 모두 대화 의사를 밝힌 것이므로 바로 한 개의 대화방으로 잇는다.
        const conversationId = await this.acceptLocked(q, reverse, low, high);
        const mine = await q.one<{ id: string }>(
          `INSERT INTO greeting_requests (sender_id, receiver_id, body, status, conversation_id, responded_at, context)
           VALUES ($1, $2, $3, 'accepted', $4, now(), $5) RETURNING id`,
          [userId, toUserId, text, conversationId, context ? JSON.stringify(context) : null],
        );
        await appendMessage(q, conversationId, userId, `greeting-${mine!.id}`, { kind: 'greeting', body: text, meta: context ? { context } : null });
        return { status: 'matched' as const, conversationId, reverseId: reverse.id as string };
      }

      // 장터 문의는 판매자가 공개로 올린 글에 대한 연락이므로 '새 인사 받기'와 무관하게 전달한다.
      if (!target.accept_greetings && !context) throw forbidden('GREETINGS_OFF', '새 인사를 받지 않는 회원입니다.');
      const declined = await q.one(
        `SELECT 1 FROM greeting_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'declined'
            AND responded_at > now() - ($3 || ' days')::interval`,
        [userId, toUserId, String(REGREET_DAYS)],
      );
      if (declined) throw forbidden('CANNOT_GREET', '지금은 이 회원에게 인사를 보낼 수 없습니다.');
      if (!(await this.rl.hit(`greet:${userId}`, DAILY_LIMIT, 86400))) throw tooMany('오늘 보낼 수 있는 인사를 모두 사용했습니다.');

      const g = await q.one<{ id: string }>(
        `INSERT INTO greeting_requests (sender_id, receiver_id, body, context) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, toUserId, text, context ? JSON.stringify(context) : null],
      );
      return { status: 'sent' as const, greetingId: g!.id };
    });

    if (result.status === 'sent') {
      await this.notifyReceived(toUserId, result.greetingId);
      return { status: 'sent', greetingId: result.greetingId };
    }
    if (result.status === 'matched') {
      this.rt.emit([userId, toUserId], { type: 'greeting.updated', data: { greetingId: result.reverseId, status: 'accepted', conversationId: result.conversationId } });
      await this.notifyConversation(result.conversationId, [userId, toUserId]);
    } else if (result.message) {
      await this.chat.fanOut(result.conversationId, result.message);
    }
    return { status: result.status, conversationId: result.conversationId };
  }

  // ── 다중 인사(유료) ───────────────────────────────────────────────────

  /** 조건에 맞는 회원 중 실제로 인사를 받을 수 있는 대상만 고른다. */
  private async multiTargets(q: Q, userId: string, filter: any, max: number): Promise<string[]> {
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 10) : undefined);
    const f: ListFilter = {
      viewerId: userId,
      requireVisible: true,
      scope: ['near', 'sido', 'all'].includes(filter?.scope) ? filter.scope : 'near',
      ageBands: list(filter?.ageBands),
      interestIds: list(filter?.interestIds),
      sort: 'near',
      limit: 200,
    };
    const candidates = (await selectPublicProfiles(q, f)).filter((p) => p.acceptsGreetings && p.proximity !== 'visiting').map((p) => p.userId);
    if (candidates.length === 0) return [];
    // 수신 거부(위에서 제외), 차단(조회에서 제외), 이미 대화 중·대기 중·최근 거절 대상은 서버에서 뺀다.
    const excluded = await q.query<{ id: string }>(
      `SELECT x.id FROM unnest($2::uuid[]) AS x(id)
        WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.type = 'direct' AND c.user_low = LEAST($1::uuid, x.id) AND c.user_high = GREATEST($1::uuid, x.id))
           OR EXISTS (SELECT 1 FROM greeting_requests g WHERE g.status = 'pending' AND ((g.sender_id = $1 AND g.receiver_id = x.id) OR (g.sender_id = x.id AND g.receiver_id = $1)))
           OR EXISTS (SELECT 1 FROM greeting_requests g WHERE g.sender_id = $1 AND g.receiver_id = x.id AND g.status = 'declined' AND g.responded_at > now() - interval '${REGREET_DAYS} days')`,
      [userId, candidates],
    );
    const skip = new Set(excluded.map((e) => e.id));
    return [...new Set(candidates)].filter((id) => !skip.has(id)).slice(0, max);
  }

  async multiPreview(userId: string, body: any) {
    const max = Math.min(MULTI_MAX, Math.max(1, Math.trunc(Number(body?.max) || MULTI_MAX)));
    const targets = await this.multiTargets(this.db, userId, body?.filter, max);
    const quote = await this.points.quote(this.db, userId, 'multi_greeting', targets.length);
    return { targetCount: targets.length, ...quote };
  }

  /** 발송과 차감을 한 트랜잭션으로 처리한다. 실제로 만들어진 인사 수만큼만 차감한다. */
  async multiSend(userId: string, body: any) {
    const text = this.validateText(body?.text);
    const max = Math.min(MULTI_MAX, Math.max(1, Math.trunc(Number(body?.max) || MULTI_MAX)));
    const batchId = randomUUID();
    const out = await this.db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`multi:${userId}`]);
      const targets = await this.multiTargets(q, userId, body?.filter, max);
      const sent: { id: string; to: string }[] = [];
      for (const to of targets) {
        const row = await q.one<{ id: string }>(
          `INSERT INTO greeting_requests (sender_id, receiver_id, body, batch_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (sender_id, receiver_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
          [userId, to, text, batchId],
        );
        if (row) sent.push({ id: row.id, to });
      }
      const charged = await this.points.charge(q, userId, 'multi_greeting', sent.length, { type: 'multi_greeting', id: batchId });
      return { sent, charged };
    });
    for (const s of out.sent) await this.notifyReceived(s.to, s.id);
    return { sentCount: out.sent.length, cost: out.charged.cost, balance: out.charged.balance };
  }

  private async listReceived(userId: string, onlyId?: string) {
    const rows = await this.db.query<any>(
      `SELECT id, sender_id, body, context, created_at FROM greeting_requests
        WHERE receiver_id = $1 AND status = 'pending' ${onlyId ? 'AND id = $2' : ''}
        ORDER BY created_at DESC LIMIT 100`,
      onlyId ? [userId, onlyId] : [userId],
    );
    const out = [];
    for (const r of rows) {
      const [sender] = await selectPublicProfiles(this.db, { viewerId: userId, onlyUserId: r.sender_id, limit: 1 });
      if (!sender) continue; // 차단·탈퇴한 상대의 요청은 보이지 않는다.
      out.push({ id: r.id, body: r.body, context: r.context as GreetingContext | null, createdAt: new Date(r.created_at).toISOString(), sender });
    }
    return out;
  }

  async list(userId: string, box: string) {
    if (box === 'sent') {
      const rows = await this.db.query<any>(
        `SELECT g.id, g.receiver_id, g.body, g.status, g.conversation_id, g.created_at, p.nickname, p.avatar_color
           FROM greeting_requests g JOIN users u ON u.id = g.receiver_id LEFT JOIN profiles p ON p.user_id = g.receiver_id
          WHERE g.sender_id = $1 AND g.created_at > now() - interval '30 days' AND u.status = 'active'
          ORDER BY g.created_at DESC LIMIT 100`,
        [userId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          body: r.body,
          // 거절 여부는 보낸 사람에게 구체적으로 알리지 않는다.
          status: r.status === 'pending' ? 'pending' : r.status === 'accepted' ? 'accepted' : 'closed',
          conversationId: r.conversation_id,
          createdAt: new Date(r.created_at).toISOString(),
          receiver: { userId: r.receiver_id, nickname: r.nickname, avatarColor: r.avatar_color },
        })),
      };
    }
    return { items: await this.listReceived(userId) };
  }

  async accept(userId: string, greetingId: string) {
    const head = await this.db.one<{ sender_id: string }>('SELECT sender_id FROM greeting_requests WHERE id = $1 AND receiver_id = $2', [greetingId, userId]);
    if (!head) throw notFound('인사 요청을 찾을 수 없습니다.');
    const out = await this.db.tx(async (q) => {
      const { low, high } = await lockPair(q, userId, head.sender_id);
      const g = await q.one<any>('SELECT * FROM greeting_requests WHERE id = $1', [greetingId]);
      // 수락 버튼을 두 번 눌러도 같은 대화방을 돌려준다.
      if (g.status === 'accepted') return { conversationId: g.conversation_id as string, created: false };
      if (g.status !== 'pending') throw conflict('GREETING_CLOSED', '이미 처리된 인사 요청입니다.');
      const s = await q.one<{ status: string; blocked: boolean }>(
        `SELECT u.status, EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) AS blocked
           FROM users u WHERE u.id = $2`,
        [userId, g.sender_id],
      );
      if (!s || s.status !== 'active' || s.blocked) throw forbidden('CANNOT_ACCEPT', '수락할 수 없는 요청입니다.');
      return { conversationId: await this.acceptLocked(q, g, low, high), created: true };
    });
    if (out.created) {
      this.rt.emit([userId, head.sender_id], { type: 'greeting.updated', data: { greetingId, status: 'accepted', conversationId: out.conversationId } });
      await this.notifyConversation(out.conversationId, [userId, head.sender_id]);
    }
    return { conversationId: out.conversationId, conversation: await this.chat.summaryFor(userId, out.conversationId) };
  }

  async decline(userId: string, greetingId: string, alsoBlock: boolean) {
    const g = await this.db.tx(async (q) => {
      const row = await q.one<any>('SELECT * FROM greeting_requests WHERE id = $1 AND receiver_id = $2 FOR UPDATE', [greetingId, userId]);
      if (!row) throw notFound('인사 요청을 찾을 수 없습니다.');
      if (row.status === 'pending') {
        await q.query(`UPDATE greeting_requests SET status = 'declined', responded_at = now() WHERE id = $1`, [greetingId]);
      } else if (row.status === 'accepted' && !alsoBlock) {
        throw conflict('GREETING_CLOSED', '이미 수락한 인사 요청입니다.');
      }
      if (alsoBlock) await blockIn(q, userId, row.sender_id);
      return row;
    });
    this.rt.emit([userId], { type: 'greeting.updated', data: { greetingId, status: 'declined' } });
    if (alsoBlock) this.rt.emit([userId], { type: 'block.updated', data: { userId: g.sender_id, blocked: true } });
    return { ok: true };
  }
}
