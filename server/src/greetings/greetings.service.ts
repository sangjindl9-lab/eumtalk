import { Inject, Injectable } from '@nestjs/common';
import { bad, conflict, forbidden, notFound, tooMany } from '../common/errors';
import { containsLink } from '../common/validate';
import { appendMessage, ChatService, ensureDirectConversation } from '../chat/chat.service';
import { Db, lockPair, Q } from '../db/db';
import { selectPublicProfiles } from '../profile/public-profile';
import { RateLimiter } from '../realtime/redis';
import { Realtime } from '../realtime/realtime';
import { blockIn } from '../safety/safety.service';

const MAX_LEN = 100;
const DAILY_LIMIT = 30;
const REGREET_DAYS = 7;

@Injectable()
export class GreetingsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
    @Inject(ChatService) private readonly chat: ChatService,
  ) {}

  private validateText(raw: unknown): string {
    const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    const len = [...text].length;
    if (len < 1 || len > MAX_LEN) throw bad('INVALID_GREETING', `인사말은 1~${MAX_LEN}자로 입력해 주세요.`);
    if (containsLink(text)) throw bad('LINK_NOT_ALLOWED', '수락 전 인사말에는 링크를 넣을 수 없습니다.');
    return text;
  }

  /** 대기 중 요청을 수락 상태로 바꾸고 대화방과 첫 메시지를 만든다. 잠금은 호출한 쪽이 잡고 있다. */
  private async acceptLocked(q: Q, g: { id: string; sender_id: string; receiver_id: string; body: string }, low: string, high: string) {
    const conv = await ensureDirectConversation(q, low, high);
    await appendMessage(q, conv.id, g.sender_id, `greeting-${g.id}`, 'greeting', g.body);
    await q.query(`UPDATE greeting_requests SET status = 'accepted', conversation_id = $2, responded_at = now() WHERE id = $1`, [g.id, conv.id]);
    return conv.id;
  }

  private async notifyConversation(conversationId: string, userIds: string[]) {
    for (const id of userIds) {
      const conversation = await this.chat.summaryFor(id, conversationId);
      if (conversation) this.rt.emit([id], { type: 'conversation.created', data: { conversation } });
    }
  }

  async send(userId: string, toUserId: string, textRaw: unknown) {
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
      if (conv) return { status: 'conversation' as const, conversationId: conv.id, notify: false };

      const pendings = await q.query<any>(
        `SELECT * FROM greeting_requests WHERE status = 'pending'
            AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))`,
        [userId, toUserId],
      );
      if (pendings.some((g) => g.sender_id === userId)) {
        throw conflict('GREETING_PENDING', '이미 보낸 인사가 답을 기다리고 있습니다.');
      }
      const reverse = pendings.find((g) => g.sender_id === toUserId);
      if (reverse) {
        // 서로 인사를 보낸 경우: 양쪽 모두 대화 의사를 밝힌 것이므로 바로 한 개의 대화방으로 잇는다.
        const conversationId = await this.acceptLocked(q, reverse, low, high);
        const mine = await q.one<{ id: string }>(
          `INSERT INTO greeting_requests (sender_id, receiver_id, body, status, conversation_id, responded_at)
           VALUES ($1, $2, $3, 'accepted', $4, now()) RETURNING id`,
          [userId, toUserId, text, conversationId],
        );
        await appendMessage(q, conversationId, userId, `greeting-${mine!.id}`, 'greeting', text);
        return { status: 'matched' as const, conversationId, notify: true, reverseId: reverse.id as string };
      }

      if (!target.accept_greetings) throw forbidden('GREETINGS_OFF', '새 인사를 받지 않는 회원입니다.');
      const declined = await q.one(
        `SELECT 1 FROM greeting_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'declined'
            AND responded_at > now() - ($3 || ' days')::interval`,
        [userId, toUserId, String(REGREET_DAYS)],
      );
      if (declined) throw forbidden('CANNOT_GREET', '지금은 이 회원에게 인사를 보낼 수 없습니다.');
      if (!(await this.rl.hit(`greet:${userId}`, DAILY_LIMIT, 86400))) throw tooMany('오늘 보낼 수 있는 인사를 모두 사용했습니다.');

      const g = await q.one<{ id: string; created_at: Date }>(
        `INSERT INTO greeting_requests (sender_id, receiver_id, body) VALUES ($1, $2, $3) RETURNING id, created_at`,
        [userId, toUserId, text],
      );
      return { status: 'sent' as const, greetingId: g!.id, notify: true };
    });

    if (result.status === 'sent') {
      const [item] = await this.listReceived(toUserId, result.greetingId);
      if (item) this.rt.emit([toUserId], { type: 'greeting.received', data: { greeting: item } });
      return { status: 'sent', greetingId: result.greetingId };
    }
    if (result.status === 'matched') {
      this.rt.emit([userId, toUserId], { type: 'greeting.updated', data: { greetingId: result.reverseId, status: 'accepted', conversationId: result.conversationId } });
      await this.notifyConversation(result.conversationId, [userId, toUserId]);
    }
    return { status: result.status, conversationId: result.conversationId };
  }

  private async listReceived(userId: string, onlyId?: string) {
    const rows = await this.db.query<any>(
      `SELECT id, sender_id, body, created_at FROM greeting_requests
        WHERE receiver_id = $1 AND status = 'pending' ${onlyId ? 'AND id = $2' : ''}
        ORDER BY created_at DESC LIMIT 100`,
      onlyId ? [userId, onlyId] : [userId],
    );
    const out = [];
    for (const r of rows) {
      const [sender] = await selectPublicProfiles(this.db, { viewerId: userId, onlyUserId: r.sender_id, limit: 1 });
      if (!sender) continue; // 차단·탈퇴한 상대의 요청은 보이지 않는다.
      out.push({ id: r.id, body: r.body, createdAt: new Date(r.created_at).toISOString(), sender });
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
