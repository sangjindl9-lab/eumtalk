import { Inject, Injectable } from '@nestjs/common';
import { bad, notFound, tooMany } from '../common/errors';
import { Db, Q } from '../db/db';
import { RateLimiter } from '../realtime/redis';
import { Realtime } from '../realtime/realtime';

export const REPORT_REASONS = [
  { id: 'sexual', label: '성적 접근·거래 유도' },
  { id: 'scam', label: '사기' },
  { id: 'abuse', label: '욕설·괴롭힘' },
  { id: 'spam', label: '스팸·광고' },
  { id: 'impersonation', label: '사칭' },
  { id: 'privacy', label: '개인정보 노출' },
  { id: 'other', label: '기타' },
];

/** 차단 처리. 차단 즉시 두 사람 사이의 대기 중 인사 요청도 정리한다. */
export async function blockIn(q: Q, blockerId: string, blockedId: string) {
  await q.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [blockerId, blockedId]);
  await q.query(
    `UPDATE greeting_requests
        SET status = CASE WHEN sender_id = $1 THEN 'cancelled' ELSE 'declined' END, responded_at = now()
      WHERE status = 'pending' AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))`,
    [blockerId, blockedId],
  );
}

@Injectable()
export class SafetyService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
  ) {}

  async block(userId: string, targetId: string) {
    if (userId === targetId) throw bad('INVALID_INPUT', '자신은 차단할 수 없습니다.');
    if (!(await this.db.one('SELECT 1 FROM users WHERE id = $1', [targetId]))) throw notFound('회원을 찾을 수 없습니다.');
    await this.db.tx((q) => blockIn(q, userId, targetId));
    this.rt.emit([userId], { type: 'block.updated', data: { userId: targetId, blocked: true } });
    return { ok: true };
  }

  async unblock(userId: string, targetId: string) {
    await this.db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, targetId]);
    this.rt.emit([userId], { type: 'block.updated', data: { userId: targetId, blocked: false } });
    return { ok: true };
  }

  async blocks(userId: string) {
    const rows = await this.db.query<any>(
      `SELECT b.blocked_id, b.created_at, p.nickname, p.avatar_color
         FROM blocks b LEFT JOIN profiles p ON p.user_id = b.blocked_id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [userId],
    );
    return { items: rows.map((r) => ({ userId: r.blocked_id, nickname: r.nickname ?? '탈퇴한 회원', avatarColor: r.avatar_color ?? 0, blockedAt: new Date(r.created_at).toISOString() })) };
  }

  /** 신고 접수. 문제 콘텐츠와 시점을 서버가 직접 사본으로 남긴다(신고자가 보낸 본문은 믿지 않는다). */
  async report(userId: string, body: any) {
    const reason = String(body?.reason || '');
    if (!REPORT_REASONS.some((r) => r.id === reason)) throw bad('INVALID_INPUT', '신고 사유를 선택해 주세요.');
    const targetType = String(body?.targetType || '');
    const targetId = String(body?.targetId || '');
    const detail = typeof body?.detail === 'string' ? body.detail.trim().slice(0, 1000) : '';
    if (!(await this.rl.hit(`report:${userId}`, 20, 3600))) throw tooMany('신고가 많이 접수되었습니다. 잠시 후 다시 시도해 주세요.');

    let targetUserId: string | null = null;
    let snapshot: Record<string, unknown> = {};
    if (targetType === 'profile') {
      const p = await this.db.one<any>('SELECT user_id, nickname, bio, age_band, region_id FROM profiles WHERE user_id::text = $1', [targetId]);
      if (!p || p.user_id === userId) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = p.user_id;
      snapshot = { nickname: p.nickname, bio: p.bio, ageBand: p.age_band, regionId: p.region_id };
    } else if (targetType === 'message') {
      const m = await this.db.one<any>(
        `SELECT m.* FROM messages m
           JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
          WHERE m.id::text = $1`,
        [targetId, userId],
      );
      if (!m || m.sender_id === userId) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = m.sender_id;
      snapshot = { messageId: m.id, conversationId: m.conversation_id, seq: Number(m.seq), kind: m.kind, body: m.body, mediaId: m.media_id, sentAt: new Date(m.created_at).toISOString() };
    } else if (targetType === 'greeting') {
      const g = await this.db.one<any>('SELECT * FROM greeting_requests WHERE id::text = $1 AND receiver_id = $2', [targetId, userId]);
      if (!g) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = g.sender_id;
      snapshot = { body: g.body, sentAt: new Date(g.created_at).toISOString() };
    } else if (targetType === 'post') {
      const p = await this.db.one<any>(`SELECT * FROM posts WHERE id::text = $1 AND status = 'visible'`, [targetId]);
      if (!p || p.author_id === userId) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = p.author_id;
      snapshot = { kind: p.kind, category: p.category, title: p.title, body: p.body, price: p.price, mediaIds: p.media_ids, postedAt: new Date(p.created_at).toISOString() };
    } else if (targetType === 'comment') {
      const c = await this.db.one<any>(`SELECT * FROM post_comments WHERE id::text = $1 AND status = 'visible'`, [targetId]);
      if (!c || c.author_id === userId) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = c.author_id;
      snapshot = { postId: c.post_id, body: c.body, postedAt: new Date(c.created_at).toISOString() };
    } else if (targetType === 'room') {
      const r = await this.db.one<any>('SELECT * FROM rooms WHERE conversation_id::text = $1', [targetId]);
      if (!r) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = r.owner_id;
      snapshot = { title: r.title, intro: r.intro, tags: r.tags, imageMediaId: r.image_media_id };
    } else if (targetType === 'photo') {
      // 내가 볼 수 있는 사진만 신고할 수 있다(대화 첨부는 참여자만).
      const m = await this.db.one<any>(
        `SELECT m.* FROM media m WHERE m.id::text = $1 AND m.status = 'ready'
            AND (m.purpose <> 'chat' OR EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = m.conversation_id AND cp.user_id = $2))`,
        [targetId, userId],
      );
      if (!m || m.owner_id === userId) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = m.owner_id;
      snapshot = { mediaId: m.id, purpose: m.purpose, conversationId: m.conversation_id, uploadedAt: new Date(m.created_at).toISOString() };
    } else {
      throw bad('INVALID_INPUT', '신고 대상이 올바르지 않습니다.');
    }
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO reports (reporter_id, target_type, target_id, target_user_id, reason, detail, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, targetType, targetId, targetUserId, reason, detail, JSON.stringify({ ...snapshot, reportedAt: new Date().toISOString() })],
    );
    return { id: row!.id, ok: true };
  }
}
