import { Inject, Injectable } from '@nestjs/common';
import { bad, conflict, notFound } from '../common/errors';
import { str } from '../common/validate';
import { Db, Q } from '../db/db';
import { MediaService } from '../media/media.service';
import { Realtime } from '../realtime/realtime';

@Injectable()
export class AccountService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  /** 이용자에게 처리 결과 등을 알린다. */
  async notify(q: Q, userId: string, kind: string, title: string, body: string, ref: Record<string, unknown> = {}) {
    await q.query('INSERT INTO user_notices (user_id, kind, title, body, ref) VALUES ($1, $2, $3, $4, $5)', [userId, kind, title, body, JSON.stringify(ref)]);
  }

  async notices(userId: string) {
    const rows = await this.db.query<any>('SELECT * FROM user_notices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [userId]);
    await this.db.query('UPDATE user_notices SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
    return { items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, ref: r.ref, unread: !r.read_at, createdAt: new Date(r.created_at).toISOString() })) };
  }

  async unreadNotices(userId: string) {
    return Number((await this.db.one<any>('SELECT count(*) AS n FROM user_notices WHERE user_id = $1 AND read_at IS NULL', [userId])).n);
  }

  async sanctions(userId: string) {
    const rows = await this.db.query<any>(
      `SELECT s.*, a.id AS appeal_id, a.status AS appeal_status, a.answer AS appeal_answer
         FROM sanctions s LEFT JOIN LATERAL (SELECT * FROM appeals WHERE sanction_id = s.id ORDER BY created_at DESC LIMIT 1) a ON true
        WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
      [userId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        reason: r.reason,
        until: r.until ? new Date(r.until).toISOString() : null,
        lifted: !!r.lifted_at,
        createdAt: new Date(r.created_at).toISOString(),
        appeal: r.appeal_id ? { status: r.appeal_status, answer: r.appeal_answer } : null,
      })),
    };
  }

  async appeal(userId: string, body: any) {
    const text = str(body?.body, '이의신청 내용', 5, 1000);
    const s = await this.db.one('SELECT 1 FROM sanctions WHERE id::text = $1 AND user_id = $2', [String(body?.sanctionId || ''), userId]);
    if (!s) throw notFound('조치 내역을 찾을 수 없습니다.');
    if (await this.db.one(`SELECT 1 FROM appeals WHERE sanction_id::text = $1`, [String(body.sanctionId)])) throw conflict('APPEAL_EXISTS', '이미 이의신청한 조치입니다.');
    await this.db.query('INSERT INTO appeals (sanction_id, user_id, body) VALUES ($1, $2, $3)', [body.sanctionId, userId, text]);
    return { ok: true };
  }

  async inquire(userId: string, body: any) {
    const text = str(body?.body, '문의 내용', 5, 2000);
    await this.db.query('INSERT INTO inquiries (user_id, body) VALUES ($1, $2)', [userId, text]);
    return { ok: true };
  }

  async inquiries(userId: string) {
    const rows = await this.db.query<any>('SELECT * FROM inquiries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    return { items: rows.map((r) => ({ id: r.id, body: r.body, status: r.status, answer: r.answer, createdAt: new Date(r.created_at).toISOString(), answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : null })) };
  }

  async announcements() {
    const rows = await this.db.query<any>('SELECT id, title, body, created_at FROM announcements WHERE published ORDER BY created_at DESC LIMIT 30');
    return { items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: new Date(r.created_at).toISOString() })) };
  }

  /**
   * 계정 삭제. 항목별 처리:
   *  - 즉시 삭제: 프로필 내용·관심사·위치·프로필/게시글 사진·푸시 토큰·로그인 세션·차단 목록·북마크·공감
   *  - 노출 중단: 주변 목록·검색·게시글·댓글(삭제 상태), 운영 중인 그룹방은 종료 또는 다음 운영진에게 위임
   *  - 보존: 신고·조치 기록, 포인트 원장·구매 기록(분쟁·법정 보존 대상), 상대방 대화방의 메시지(보낸 사람은 '탈퇴한 회원')
   */
  async deleteAccount(userId: string, reason: string) {
    if (await this.db.one(`SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > now() AND auto_renew`, [userId])) {
      // 구독 해지는 스토어에서만 가능하므로 안내만 하고 삭제는 진행한다(detail 에 남긴다).
    }
    const detail = await this.db.tx(async (q) => {
      const u = await q.one<{ status: string }>('SELECT status FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!u || u.status === 'deleted') throw bad('ALREADY_DELETED', '이미 삭제된 계정입니다.');
      const d: Record<string, unknown> = {};

      // 그룹방: 내가 방장이면 운영진→가장 오래된 회원 순으로 넘기고, 아무도 없으면 종료
      const owned = await q.query<{ conversation_id: string }>(`SELECT conversation_id FROM rooms WHERE owner_id = $1 AND status = 'open' FOR UPDATE`, [userId]);
      let transferred = 0;
      let closed = 0;
      for (const r of owned) {
        const next = await q.one<{ user_id: string }>(
          `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2 AND left_at IS NULL
            ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
          [r.conversation_id, userId],
        );
        if (next) {
          await q.query(`UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`, [r.conversation_id, next.user_id]);
          await q.query('UPDATE rooms SET owner_id = $2 WHERE conversation_id = $1', [r.conversation_id, next.user_id]);
          transferred++;
        } else {
          await q.query(`UPDATE rooms SET status = 'closed', owner_id = NULL WHERE conversation_id = $1`, [r.conversation_id]);
          closed++;
        }
      }
      const left = await q.query(
        `UPDATE conversation_participants cp SET left_at = now() FROM conversations c
          WHERE c.id = cp.conversation_id AND c.type = 'group' AND cp.user_id = $1 AND cp.left_at IS NULL RETURNING cp.conversation_id`,
        [userId],
      );
      if (left.length) await q.query('UPDATE rooms SET member_count = GREATEST(member_count - 1, 0) WHERE conversation_id = ANY($1::uuid[])', [left.map((l: any) => l.conversation_id)]);
      d.rooms = { transferred, closed, left: left.length };

      // 보존 조치 중이면 탈퇴 직전 회원 정보 사본을 남기고 사진 원본도 지우지 않는다.
      const holds = await q.query<{ id: string }>('SELECT id FROM law_holds WHERE user_id = $1 AND released_at IS NULL', [userId]);
      if (holds.length) {
        const snap = await q.one<any>(
          `SELECT u.created_at, p.nickname, p.age_band, p.gender, p.bio, r.name AS region, up.birth_year, up.identity_provider,
                  (SELECT json_agg(json_build_object('id', m.id, 'purpose', m.purpose, 'createdAt', m.created_at)) FROM media m WHERE m.owner_id = u.id AND m.status <> 'deleted') AS media
             FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN regions r ON r.id = p.region_id LEFT JOIN user_private up ON up.user_id = u.id
            WHERE u.id = $1`,
          [userId],
        );
        await q.query(`UPDATE law_holds SET snapshot = $2 WHERE user_id = $1 AND released_at IS NULL`, [userId, JSON.stringify({ ...snap, deletedAt: new Date().toISOString(), reason })]);
        await q.query(`UPDATE media SET status = 'held' WHERE owner_id = $1 AND purpose = ANY($2::text[]) AND status <> 'deleted'`, [userId, ['profile', 'post', 'room']]);
        d.photosDeleted = 0;
        d.legalHold = true;
      } else {
        d.photosDeleted = await this.media.removeAllOf(q, userId, ['profile', 'post', 'room']);
      }
      d.postsHidden = (await q.query(`UPDATE posts SET status = 'deleted', pinned_until = NULL WHERE author_id = $1 AND status <> 'deleted' RETURNING 1`, [userId])).length;
      d.commentsHidden = (await q.query(`UPDATE post_comments SET status = 'deleted' WHERE author_id = $1 AND status <> 'deleted' RETURNING 1`, [userId])).length;
      await q.query(`UPDATE greeting_requests SET status = 'cancelled', responded_at = now() WHERE status = 'pending' AND (sender_id = $1 OR receiver_id = $1)`, [userId]);
      d.pushTokensDeleted = (await q.query('DELETE FROM device_tokens WHERE user_id = $1 RETURNING 1', [userId])).length;
      d.sessionsRevoked = (await q.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING 1', [userId])).length;
      await q.query('DELETE FROM user_locations WHERE user_id = $1', [userId]);
      await q.query('DELETE FROM profile_interests WHERE user_id = $1', [userId]);
      await q.query('DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
      await q.query('DELETE FROM post_bookmarks WHERE user_id = $1', [userId]);
      await q.query('DELETE FROM post_likes WHERE user_id = $1', [userId]);
      await q.query('DELETE FROM user_notices WHERE user_id = $1', [userId]);
      // 프로필은 검색·주변에서 빠지도록 비우고, 닉네임은 재사용할 수 있게 바꾼다.
      await q.query(
        `UPDATE profiles SET nickname = 'x' || substr(replace($1::text, '-', ''), 1, 11), bio = '', gender = NULL, gender_public = false, photo_media_id = NULL,
                show_in_nearby = false, show_last_active = false, accept_greetings = false, browse_region_id = NULL, browse_until = NULL
          WHERE user_id = $1`,
        [userId],
      );
      await q.query('UPDATE user_private SET phone_enc = NULL, birth_year = NULL, identity_ref_hash = NULL WHERE user_id = $1', [userId]);
      await q.query(`UPDATE users SET status = 'deleted', phone_hash = NULL, deleted_at = now(), suspended_until = NULL WHERE id = $1`, [userId]);
      await q.query('UPDATE nickname_history SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
      d.retained = ['신고·조치 기록', '포인트 원장', '구매·구독 기록', '상대방 대화방에 남은 메시지'];
      await q.query('INSERT INTO account_deletions (user_id, reason, detail) VALUES ($1, $2, $3)', [userId, reason.slice(0, 300), JSON.stringify(d)]);
      return d;
    });
    this.rt.disconnectUser(userId);
    return { ok: true, detail };
  }
}
