import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { AccountService } from '../account/account.service';
import { AppConfig, CONFIG } from '../config';
import { randomToken, sha256 } from '../common/crypto';
import { AppError, bad, conflict, forbidden, notFound } from '../common/errors';
import { str } from '../common/validate';
import { Db, Q } from '../db/db';
import { MediaService } from '../media/media.service';
import { PointsService } from '../points/points.service';
import { Realtime } from '../realtime/realtime';
import { RedisConn } from '../realtime/redis';
import { RoomsService } from '../rooms/rooms.service';
import { REPORT_REASONS } from '../safety/safety.service';

export type AdminRole = 'owner' | 'moderator' | 'support' | 'finance';
export interface Admin {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

/** 업무별 권한 분리. owner 는 모든 업무를 할 수 있다. */
const PERMISSIONS: Record<string, AdminRole[]> = {
  reports: ['moderator'],
  users: ['moderator', 'support'],
  sanction: ['moderator'],
  rooms: ['moderator'],
  posts: ['moderator'],
  points: ['finance'],
  support: ['support'],
  admins: [],
  audit: [],
};

const hashPassword = (pw: string) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
};
const checkPassword = (pw: string, stored: string) => {
  const [, salt, hash] = stored.split('$');
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const reasonLabel = (id: string) => REPORT_REASONS.find((r) => r.id === id)?.label ?? id;
const iso = (d: any) => (d ? new Date(d).toISOString() : null);

@Injectable()
export class AdminService {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(RedisConn) private readonly redis: RedisConn,
    @Inject(AccountService) private readonly account: AccountService,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(RoomsService) private readonly rooms: RoomsService,
  ) {}

  /** 관리자가 한 명도 없고 ADMIN_EMAIL·ADMIN_PASSWORD 가 있으면 최초 소유자 계정을 만든다. */
  async ensureOwner() {
    if (!this.cfg.adminEmail || !this.cfg.adminPassword) return;
    if (!(await this.db.one('SELECT 1 FROM admins LIMIT 1'))) await this.createAdmin(this.db, this.cfg.adminEmail, this.cfg.adminPassword, 'owner', '소유자');
  }

  private async createAdmin(q: Q, emailRaw: string, password: string, role: AdminRole, name: string) {
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('INVALID_INPUT', '이메일을 확인해 주세요.');
    if (String(password || '').length < 10) throw bad('INVALID_INPUT', '비밀번호는 10자 이상으로 정해 주세요.');
    if (await q.one('SELECT 1 FROM admins WHERE email = $1', [email])) throw conflict('ADMIN_EXISTS', '이미 등록된 이메일입니다.');
    return (await q.one<{ id: string }>('INSERT INTO admins (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [email, name, hashPassword(password), role]))!.id;
  }

  /** 최초 1회: 서버의 ADMIN_TOKEN 으로 소유자 계정을 만든다. */
  async bootstrap(token: string, body: any) {
    if (!this.cfg.adminToken || token !== this.cfg.adminToken) throw new AppError(401, 'UNAUTHORIZED', '관리자 인증이 필요합니다.');
    if (await this.db.one('SELECT 1 FROM admins LIMIT 1')) throw conflict('ALREADY_SETUP', '이미 관리자 계정이 있습니다. 로그인해 주세요.');
    await this.createAdmin(this.db, body?.email, body?.password, 'owner', String(body?.name || '소유자'));
    return this.login(body);
  }

  async needsSetup() {
    return { needsSetup: !(await this.db.one('SELECT 1 FROM admins LIMIT 1')) };
  }

  async login(body: any) {
    const a = await this.db.one<any>('SELECT * FROM admins WHERE email = $1 AND active', [String(body?.email || '').trim().toLowerCase()]);
    if (!a || !checkPassword(String(body?.password || ''), a.password_hash)) throw new AppError(401, 'LOGIN_FAILED', '이메일 또는 비밀번호가 맞지 않습니다.');
    const token = randomToken();
    await this.db.query(`INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES ($1, $2, now() + interval '12 hours')`, [sha256(token), a.id]);
    await this.audit(this.db, a.id, 'admin.login', 'admin', a.id);
    return { token, admin: { id: a.id, email: a.email, name: a.name, role: a.role } };
  }

  async authenticate(header: string | undefined): Promise<Admin> {
    const token = (header || '').replace(/^Bearer\s+/i, '');
    const a = token
      ? await this.db.one<any>(
          `SELECT a.id, a.email, a.name, a.role FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active`,
          [sha256(token)],
        )
      : null;
    if (!a) throw new AppError(401, 'UNAUTHORIZED', '관리자 로그인이 필요합니다.');
    return a;
  }

  async logout(header: string | undefined) {
    await this.db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256((header || '').replace(/^Bearer\s+/i, ''))]);
    return { ok: true };
  }

  require(admin: Admin, area: keyof typeof PERMISSIONS) {
    if (admin.role !== 'owner' && !PERMISSIONS[area].includes(admin.role)) throw forbidden('NO_PERMISSION', '이 업무를 처리할 권한이 없습니다.');
  }

  async audit(q: Q, adminId: string, action: string, targetType?: string, targetId?: string, detail: Record<string, unknown> = {}) {
    await q.query('INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5)', [adminId, action, targetType ?? null, targetId ?? null, JSON.stringify(detail)]);
  }

  async status() {
    const counts = await this.db.one<any>(
      `SELECT (SELECT count(*) FROM users WHERE status = 'active') AS users,
              (SELECT count(*) FROM conversations WHERE type = 'direct') AS conversations,
              (SELECT count(*) FROM rooms WHERE status = 'open') AS rooms,
              (SELECT count(*) FROM messages) AS messages,
              (SELECT count(*) FROM posts WHERE status = 'visible') AS posts,
              (SELECT count(*) FROM reports WHERE status = 'open') AS open_reports,
              (SELECT count(*) FROM appeals WHERE status = 'pending') AS pending_appeals,
              (SELECT count(*) FROM inquiries WHERE status = 'open') AS open_inquiries`,
    );
    let redis = 'not_configured';
    if (this.redis.client) redis = await this.redis.client.ping().then(() => 'ok').catch(() => 'error');
    return {
      environment: this.cfg.appEnv,
      identityMode: this.cfg.identityMode,
      identityProvider: this.cfg.identityProvider,
      signupAvailable: this.cfg.identityMode !== 'unconfigured',
      database: 'ok',
      redis,
      storage: this.cfg.storage.driver,
      push: this.cfg.push.provider,
      iap: this.cfg.iap.mode,
      problems: this.cfg.problems,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
    };
  }

  // ── 신고 처리 ─────────────────────────────────────────────────────────

  async reports(status: string) {
    const rows = await this.db.query<any>(
      `SELECT r.id, r.target_type, r.reason, r.status, r.resolution, r.created_at, r.resolved_at,
              rp.nickname AS reporter, tp.nickname AS target, r.target_user_id,
              (SELECT count(*) FROM reports x WHERE x.target_user_id = r.target_user_id) AS target_reports
         FROM reports r LEFT JOIN profiles rp ON rp.user_id = r.reporter_id LEFT JOIN profiles tp ON tp.user_id = r.target_user_id
        WHERE ($1 = 'all' OR r.status = $1) ORDER BY r.created_at DESC LIMIT 200`,
      [status],
    );
    // 목록에는 신고된 내용 자체를 싣지 않는다. 내용은 건별 열람(기록됨)으로만 본다.
    return {
      items: rows.map((r) => ({
        id: r.id, targetType: r.target_type, reason: r.reason, reasonLabel: reasonLabel(r.reason), status: r.status, resolution: r.resolution,
        reporter: r.reporter, target: r.target, targetUserId: r.target_user_id, targetReports: Number(r.target_reports), createdAt: iso(r.created_at), resolvedAt: iso(r.resolved_at),
      })),
    };
  }

  /** 증거 열람. 신고에 묶인 사본만 보여주고, 열람 사실을 기록한다. */
  async reportDetail(admin: Admin, id: string) {
    const r = await this.db.one<any>(
      `SELECT r.*, rp.nickname AS reporter, tp.nickname AS target, tu.status AS target_status
         FROM reports r LEFT JOIN profiles rp ON rp.user_id = r.reporter_id LEFT JOIN profiles tp ON tp.user_id = r.target_user_id LEFT JOIN users tu ON tu.id = r.target_user_id
        WHERE r.id = $1`,
      [id],
    );
    if (!r) throw notFound('신고를 찾을 수 없습니다.');
    await this.audit(this.db, admin.id, 'report.evidence.view', 'report', id);
    const mediaIds: string[] = [r.snapshot?.mediaId, ...(r.snapshot?.mediaIds ?? [])].filter(Boolean);
    const photos = [];
    for (const m of mediaIds) {
      const url = await this.media.adminUrl(m);
      if (url) photos.push({ mediaId: m, url });
    }
    const history = await this.db.query<any>(
      `SELECT l.action, l.detail, l.created_at, a.name, a.email FROM admin_audit_log l LEFT JOIN admins a ON a.id = l.admin_id
        WHERE l.target_type = 'report' AND l.target_id = $1 ORDER BY l.id DESC LIMIT 100`,
      [id],
    );
    const prior = r.target_user_id ? await this.db.query<any>('SELECT type, reason, until, lifted_at, created_at FROM sanctions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [r.target_user_id]) : [];
    return {
      id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, reasonLabel: reasonLabel(r.reason), detail: r.detail, status: r.status, resolution: r.resolution,
      reporter: r.reporter, target: r.target, targetUserId: r.target_user_id, targetStatus: r.target_status, createdAt: iso(r.created_at), resolvedAt: iso(r.resolved_at),
      evidence: r.snapshot, photos,
      history: history.map((h) => ({ action: h.action, detail: h.detail, by: h.name || h.email, at: iso(h.created_at) })),
      priorSanctions: prior.map((s) => ({ type: s.type, reason: s.reason, until: iso(s.until), lifted: !!s.lifted_at, createdAt: iso(s.created_at) })),
    };
  }

  /** 신고 대상 콘텐츠 숨김/복구. 숨겨진 메시지는 참여자 화면에 바로 반영된다. */
  private async setHidden(q: Q, r: any, hidden: boolean) {
    const events: { users: string[]; event: any }[] = [];
    const t = r.target_type;
    if (t === 'message') {
      const m = await q.one<any>(`UPDATE messages SET hidden_at = ${hidden ? 'now()' : 'NULL'} WHERE id::text = $1 RETURNING id, conversation_id, media_id`, [r.target_id]);
      if (m) {
        if (m.media_id) await q.query(`UPDATE media SET status = $2 WHERE id = $1 AND status <> 'deleted'`, [m.media_id, hidden ? 'hidden' : 'ready']);
        const members = await q.query<{ user_id: string }>('SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL', [m.conversation_id]);
        events.push({ users: members.map((x) => x.user_id), event: { type: 'message.hidden', data: { conversationId: m.conversation_id, messageId: m.id, hidden } } });
      }
    } else if (t === 'post') {
      await q.query(`UPDATE posts SET status = $2, pinned_until = CASE WHEN $2 = 'hidden' THEN NULL ELSE pinned_until END WHERE id::text = $1 AND status <> 'deleted'`, [r.target_id, hidden ? 'hidden' : 'visible']);
    } else if (t === 'comment') {
      const c = await q.one<any>(`UPDATE post_comments SET status = $2 WHERE id::text = $1 AND status = $3 RETURNING post_id`, [r.target_id, hidden ? 'hidden' : 'visible', hidden ? 'visible' : 'hidden']);
      if (c) await q.query('UPDATE posts SET comment_count = GREATEST(comment_count + $2, 0) WHERE id = $1', [c.post_id, hidden ? -1 : 1]);
    } else if (t === 'photo') {
      await q.query(`UPDATE media SET status = $2 WHERE id::text = $1 AND status <> 'deleted'`, [r.target_id, hidden ? 'hidden' : 'ready']);
      if (hidden) await q.query('UPDATE profiles SET photo_media_id = NULL WHERE photo_media_id::text = $1', [r.target_id]);
    } else if (t === 'profile' && hidden) {
      await q.query(`UPDATE profiles SET bio = '', photo_media_id = NULL WHERE user_id::text = $1`, [r.target_id]);
    } else if (t === 'room') {
      await q.query(`UPDATE rooms SET status = $2 WHERE conversation_id::text = $1`, [r.target_id, hidden ? 'closed' : 'open']);
    }
    return events;
  }

  private async suspend(q: Q, userId: string, days: number | null) {
    await q.query(`UPDATE users SET status = 'suspended', suspended_until = ${days ? `now() + interval '${Math.trunc(days)} days'` : 'NULL'} WHERE id = $1 AND status <> 'deleted'`, [userId]);
    await q.query(`UPDATE greeting_requests SET status = 'cancelled', responded_at = now() WHERE status = 'pending' AND sender_id = $1`, [userId]);
  }

  /**
   * 조치: dismiss(조치 없이 종결) / warn(경고) / hide(콘텐츠 숨김) / suspend(이용 정지, days 없으면 무기한)
   * 조치와 함께 대상자·신고자 통지, 처리 이력 기록까지 한 트랜잭션으로 남긴다.
   */
  async act(admin: Admin, id: string, body: any) {
    const action = String(body?.action || '');
    if (!['dismiss', 'warn', 'hide', 'suspend'].includes(action)) throw bad('INVALID_INPUT', '조치 종류를 선택해 주세요.');
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const days = action === 'suspend' && body?.days ? Math.min(3650, Math.max(1, Math.trunc(Number(body.days)))) : null;
    const out = await this.db.tx(async (q) => {
      const r = await q.one<any>('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound('신고를 찾을 수 없습니다.');
      if (r.status !== 'open') throw conflict('ALREADY_RESOLVED', '이미 처리된 신고입니다.');
      const label = reasonLabel(r.reason);
      let events: { users: string[]; event: any }[] = [];
      let sanctionId: string | null = null;
      const resolution = { dismiss: '조치 없이 종결', warn: '경고', hide: '콘텐츠 숨김', suspend: days ? `이용 정지 ${days}일` : '이용 정지(무기한)' }[action]!;
      if (action !== 'dismiss' && r.target_user_id) {
        if (action === 'hide' || action === 'suspend') events = await this.setHidden(q, r, true);
        if (action === 'suspend') await this.suspend(q, r.target_user_id, days);
        const type = action === 'warn' ? 'warning' : action === 'hide' ? 'content_hidden' : 'suspension';
        sanctionId = (await q.one<{ id: string }>(
          `INSERT INTO sanctions (user_id, type, reason, report_id, until, created_by) VALUES ($1, $2, $3, $4, ${days ? `now() + interval '${days} days'` : 'NULL'}, $5) RETURNING id`,
          [r.target_user_id, type, `${label}${note ? ` — ${note}` : ''}`, id, admin.id],
        ))!.id;
        await this.account.notify(q, r.target_user_id, 'sanction', `운영 조치 안내: ${resolution}`,
          `신고가 접수되어 확인한 결과 이용규칙 위반(${label})으로 판단해 "${resolution}" 조치했습니다. 이의가 있으면 내 정보 > 조치 내역에서 이의신청할 수 있습니다.`, { sanctionId });
      }
      await q.query(`UPDATE reports SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now() WHERE id = $1`, [id, action === 'dismiss' ? 'dismissed' : 'resolved', resolution, admin.id]);
      await this.account.notify(q, r.reporter_id, 'report_result', '신고 처리 결과',
        action === 'dismiss' ? `신고하신 내용(${label})을 확인했으나 이용규칙 위반으로 보기 어려워 조치 없이 종결했습니다.` : `신고하신 내용(${label})을 확인하고 운영 조치를 했습니다. 알려 주셔서 감사합니다.`, { reportId: id });
      await this.audit(q, admin.id, `report.${action}`, 'report', id, { resolution, note, sanctionId });
      return { events, targetUserId: r.target_user_id as string | null, reporterId: r.reporter_id as string, resolution, suspended: action === 'suspend' };
    });
    for (const e of out.events) this.rt.emit(e.users, e.event);
    this.rt.emit([out.reporterId, ...(out.targetUserId ? [out.targetUserId] : [])], { type: 'notice.new', data: {} });
    if (out.suspended && out.targetUserId) this.rt.emit([out.targetUserId], { type: 'account.suspended', data: {} });
    return { ok: true, resolution: out.resolution };
  }

  async appeals(status: string) {
    const rows = await this.db.query<any>(
      `SELECT a.*, p.nickname, s.type AS sanction_type, s.reason AS sanction_reason, s.report_id FROM appeals a JOIN sanctions s ON s.id = a.sanction_id LEFT JOIN profiles p ON p.user_id = a.user_id
        WHERE ($1 = 'all' OR a.status = $1) ORDER BY a.created_at DESC LIMIT 200`,
      [status],
    );
    return { items: rows.map((r) => ({ id: r.id, nickname: r.nickname, body: r.body, status: r.status, answer: r.answer, sanctionType: r.sanction_type, sanctionReason: r.sanction_reason, reportId: r.report_id, createdAt: iso(r.created_at) })) };
  }

  /** 이의신청 결정. 받아들이면 조치를 해제하고(정지 해제·숨김 복구) 결과를 알린다. */
  async decideAppeal(admin: Admin, id: string, body: any) {
    const accept = body?.accept === true;
    const answer = str(body?.answer, '답변', 2, 1000);
    const out = await this.db.tx(async (q) => {
      const a = await q.one<any>(`SELECT a.*, s.type, s.report_id, s.user_id AS target FROM appeals a JOIN sanctions s ON s.id = a.sanction_id WHERE a.id = $1 AND a.status = 'pending' FOR UPDATE OF a`, [id]);
      if (!a) throw notFound('처리할 이의신청을 찾을 수 없습니다.');
      let events: { users: string[]; event: any }[] = [];
      if (accept) {
        await q.query('UPDATE sanctions SET lifted_at = now() WHERE id = $1', [a.sanction_id]);
        const r = a.report_id ? await q.one<any>('SELECT * FROM reports WHERE id = $1', [a.report_id]) : null;
        if (a.type === 'suspension') await q.query(`UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1 AND status = 'suspended'`, [a.target]);
        if (r && (a.type === 'suspension' || a.type === 'content_hidden')) events = await this.setHidden(q, r, false);
      }
      await q.query('UPDATE appeals SET status = $2, answer = $3, decided_by = $4, decided_at = now() WHERE id = $1', [id, accept ? 'accepted' : 'rejected', answer, admin.id]);
      await this.account.notify(q, a.user_id, 'appeal_result', accept ? '이의신청이 받아들여졌습니다' : '이의신청 검토 결과', answer, { appealId: id });
      await this.audit(q, admin.id, accept ? 'appeal.accept' : 'appeal.reject', 'report', a.report_id ?? undefined, { appealId: id, answer });
      return { events, userId: a.user_id as string };
    });
    for (const e of out.events) this.rt.emit(e.users, e.event);
    this.rt.emit([out.userId], { type: 'notice.new', data: {} });
    return { ok: true };
  }

  // ── 회원 ──────────────────────────────────────────────────────────────

  async users(qs: string, status: string) {
    const rows = await this.db.query<any>(
      `SELECT u.id, u.status, u.suspended_until, u.created_at, p.nickname, p.age_band, r.name AS region, p.last_active_at,
              (SELECT count(*) FROM reports x WHERE x.target_user_id = u.id) AS reports,
              COALESCE((SELECT balance FROM point_wallets w WHERE w.user_id = u.id), 0) AS balance
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN regions r ON r.id = p.region_id
        WHERE ($1 = '' OR p.nickname ILIKE '%' || $1 || '%') AND ($2 = 'all' OR u.status = $2)
        ORDER BY u.created_at DESC LIMIT 200`,
      [qs.replace(/[%_\\]/g, '\\$&'), status],
    );
    // 휴대폰 번호·출생 연도는 관리자 화면에도 싣지 않는다.
    return { items: rows.map((r) => ({ id: r.id, nickname: r.nickname, ageBand: r.age_band, region: r.region, status: r.status, suspendedUntil: iso(r.suspended_until), reports: Number(r.reports), balance: r.balance, lastActiveAt: iso(r.last_active_at), createdAt: iso(r.created_at) })) };
  }

  async setSuspended(admin: Admin, userId: string, body: any) {
    const on = body?.suspended !== false;
    const reason = on ? str(body?.reason, '사유', 2, 300) : '';
    const days = on && body?.days ? Math.min(3650, Math.max(1, Math.trunc(Number(body.days)))) : null;
    await this.db.tx(async (q) => {
      if (!(await q.one(`SELECT 1 FROM users WHERE id = $1 AND status <> 'deleted'`, [userId]))) throw notFound('회원을 찾을 수 없습니다.');
      if (on) {
        await this.suspend(q, userId, days);
        const s = await q.one<{ id: string }>(`INSERT INTO sanctions (user_id, type, reason, until, created_by) VALUES ($1, 'suspension', $2, ${days ? `now() + interval '${days} days'` : 'NULL'}, $3) RETURNING id`, [userId, reason, admin.id]);
        await this.account.notify(q, userId, 'sanction', `운영 조치 안내: 이용 정지${days ? ` ${days}일` : ''}`, `사유: ${reason}. 이의가 있으면 내 정보 > 조치 내역에서 이의신청할 수 있습니다.`, { sanctionId: s!.id });
      } else {
        await q.query(`UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1 AND status = 'suspended'`, [userId]);
        await q.query(`UPDATE sanctions SET lifted_at = now() WHERE user_id = $1 AND type = 'suspension' AND lifted_at IS NULL`, [userId]);
        await this.account.notify(q, userId, 'sanction', '이용 정지가 해제되었습니다', '다시 서비스를 이용할 수 있습니다.');
      }
      await this.audit(q, admin.id, on ? 'user.suspend' : 'user.unsuspend', 'user', userId, { days, reason });
    });
    if (on) this.rt.emit([userId], { type: 'account.suspended', data: {} });
    return { ok: true };
  }

  // ── 그룹방·게시물 ─────────────────────────────────────────────────────

  async roomList(qs: string) {
    const rows = await this.db.query<any>(
      `SELECT r.*, c.last_message_at, rg.name AS region, p.nickname AS owner FROM rooms r JOIN conversations c ON c.id = r.conversation_id
         LEFT JOIN regions rg ON rg.id = r.region_id LEFT JOIN profiles p ON p.user_id = r.owner_id
        WHERE ($1 = '' OR r.title ILIKE '%' || $1 || '%') ORDER BY (r.kind = 'region') DESC, c.last_message_at DESC LIMIT 200`,
      [qs.replace(/[%_\\]/g, '\\$&')],
    );
    return { items: rows.map((r) => ({ id: r.conversation_id, kind: r.kind, title: r.title, region: r.region, owner: r.owner, memberCount: r.member_count, capacity: r.capacity, status: r.status, isPrivate: r.is_private, lastActivityAt: iso(r.last_message_at) })) };
  }

  /** 운영자가 여는 상설 지역방 */
  async createRegionRoom(admin: Admin, body: any) {
    const out = await this.rooms.create(null, { ...body, isPrivate: false, searchable: true, requireApproval: false, capacity: body?.capacity ?? 300 });
    await this.audit(this.db, admin.id, 'room.create', 'room', out.id, { title: body?.title });
    return out;
  }

  async setRoomStatus(admin: Admin, id: string, open: boolean) {
    await this.db.query(`UPDATE rooms SET status = $2 WHERE conversation_id = $1`, [id, open ? 'open' : 'closed']);
    await this.audit(this.db, admin.id, open ? 'room.reopen' : 'room.close', 'room', id);
    return { ok: true };
  }

  async postList(qs: string, status: string) {
    const rows = await this.db.query<any>(
      `SELECT p.id, p.kind, p.category, p.title, p.status, p.price, p.market_status, p.pinned_until, p.created_at, pr.nickname, rg.name AS region,
              (SELECT count(*) FROM reports x WHERE x.target_type = 'post' AND x.target_id = p.id::text) AS reports
         FROM posts p LEFT JOIN profiles pr ON pr.user_id = p.author_id JOIN regions rg ON rg.id = p.region_id
        WHERE ($1 = '' OR p.title ILIKE '%' || $1 || '%') AND ($2 = 'all' OR p.status = $2) ORDER BY p.created_at DESC LIMIT 200`,
      [qs.replace(/[%_\\]/g, '\\$&'), status],
    );
    return { items: rows.map((r) => ({ id: r.id, kind: r.kind, category: r.category, title: r.title, status: r.status, price: r.price, marketStatus: r.market_status, author: r.nickname, region: r.region, pinnedUntil: iso(r.pinned_until), reports: Number(r.reports), createdAt: iso(r.created_at) })) };
  }

  async setPostHidden(admin: Admin, id: string, hidden: boolean, reason: string) {
    const p = await this.db.one<any>(`UPDATE posts SET status = $2, pinned_until = CASE WHEN $2 = 'hidden' THEN NULL ELSE pinned_until END WHERE id = $1 AND status <> 'deleted' RETURNING author_id, title`, [id, hidden ? 'hidden' : 'visible']);
    if (!p) throw notFound('글을 찾을 수 없습니다.');
    if (hidden) await this.account.notify(this.db, p.author_id, 'sanction', '게시글이 숨김 처리되었습니다', `"${p.title}" 글이 이용규칙에 따라 숨김 처리되었습니다.${reason ? ` 사유: ${reason}` : ''}`);
    await this.audit(this.db, admin.id, hidden ? 'post.hide' : 'post.restore', 'post', id, { reason });
    return { ok: true };
  }

  // ── 포인트·결제 ───────────────────────────────────────────────────────

  async ledger(userId: string | null) {
    const rows = await this.db.query<any>(
      `SELECT l.*, p.nickname FROM point_ledger l LEFT JOIN profiles p ON p.user_id = l.user_id WHERE ($1::uuid IS NULL OR l.user_id = $1) ORDER BY l.id DESC LIMIT 300`,
      [userId],
    );
    return { items: rows.map((r) => ({ id: Number(r.id), userId: r.user_id, nickname: r.nickname, delta: r.delta, balanceAfter: r.balance_after, type: r.type, reason: r.reason, refType: r.ref_type, refId: r.ref_id, by: r.created_by, createdAt: iso(r.created_at) })) };
  }

  async adjust(admin: Admin, body: any) {
    const delta = Math.trunc(Number(body?.delta));
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw bad('INVALID_INPUT', '조정할 포인트를 확인해 주세요.');
    const reason = str(body?.reason, '사유', 2, 200);
    const userId = String(body?.userId || '');
    const out = await this.db.tx(async (q) => {
      if (!(await q.one('SELECT 1 FROM users WHERE id::text = $1', [userId]))) throw notFound('회원을 찾을 수 없습니다.');
      const r = await this.points.apply(q, userId, delta, 'admin', `관리자 조정: ${reason}`, { type: 'admin', id: admin.id, by: admin.email });
      await this.audit(q, admin.id, 'points.adjust', 'user', userId, { delta, reason });
      return r;
    });
    return { balance: out.balance };
  }

  async purchases() {
    const rows = await this.db.query<any>(
      `SELECT pu.*, p.nickname, pr.title FROM purchases pu LEFT JOIN profiles p ON p.user_id = pu.user_id JOIN products pr ON pr.id = pu.product_id ORDER BY pu.created_at DESC LIMIT 300`,
    );
    const subs = await this.db.query<any>(
      `SELECT s.*, p.nickname FROM subscriptions s LEFT JOIN profiles p ON p.user_id = s.user_id ORDER BY s.updated_at DESC LIMIT 300`,
    );
    return {
      purchases: rows.map((r) => ({ id: r.id, nickname: r.nickname, store: r.store, product: r.title, transactionId: r.transaction_id, status: r.status, points: r.points_granted, createdAt: iso(r.created_at), refundedAt: iso(r.refunded_at) })),
      subscriptions: subs.map((s) => ({ id: s.id, nickname: s.nickname, store: s.store, productId: s.product_id, status: s.status === 'active' && new Date(s.expires_at) < new Date() ? 'expired' : s.status, expiresAt: iso(s.expires_at), autoRenew: s.auto_renew })),
    };
  }

  async prices() {
    return {
      prices: await this.db.query('SELECT key, label, points, free_per_day AS "freePerDay", unit FROM feature_prices ORDER BY key'),
      products: await this.db.query('SELECT id, kind, title, points, active FROM products ORDER BY sort'),
    };
  }

  async setPrice(admin: Admin, key: string, body: any) {
    const points = Math.trunc(Number(body?.points));
    const free = Math.trunc(Number(body?.freePerDay ?? 0));
    if (!(points >= 0 && points <= 100000) || !(free >= 0 && free <= 1000)) throw bad('INVALID_INPUT', '값을 확인해 주세요.');
    const row = await this.db.one('UPDATE feature_prices SET points = $2, free_per_day = $3 WHERE key = $1 RETURNING key', [key, points, free]);
    if (!row) throw notFound('항목을 찾을 수 없습니다.');
    await this.audit(this.db, admin.id, 'price.update', 'price', key, { points, freePerDay: free });
    return { ok: true };
  }

  async setProduct(admin: Admin, id: string, body: any) {
    const points = Math.trunc(Number(body?.points));
    if (!(points >= 0 && points <= 1_000_000)) throw bad('INVALID_INPUT', '값을 확인해 주세요.');
    const row = await this.db.one('UPDATE products SET points = $2, active = $3 WHERE id = $1 RETURNING id', [id, points, body?.active !== false]);
    if (!row) throw notFound('상품을 찾을 수 없습니다.');
    await this.audit(this.db, admin.id, 'product.update', 'product', id, { points, active: body?.active !== false });
    return { ok: true };
  }

  // ── 공지·문의 ─────────────────────────────────────────────────────────

  async announcementList() {
    const rows = await this.db.query<any>('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100');
    return { items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, published: r.published, createdAt: iso(r.created_at) })) };
  }
  async announce(admin: Admin, body: any) {
    const row = await this.db.one<{ id: string }>('INSERT INTO announcements (title, body, created_by) VALUES ($1, $2, $3) RETURNING id', [str(body?.title, '제목', 2, 80), str(body?.body, '내용', 2, 5000), admin.id]);
    await this.audit(this.db, admin.id, 'announcement.create', 'announcement', row!.id);
    return { id: row!.id };
  }
  async setAnnouncement(admin: Admin, id: string, published: boolean) {
    await this.db.query('UPDATE announcements SET published = $2 WHERE id = $1', [id, published]);
    await this.audit(this.db, admin.id, 'announcement.update', 'announcement', id, { published });
    return { ok: true };
  }
  async inquiryList(status: string) {
    const rows = await this.db.query<any>(`SELECT i.*, p.nickname FROM inquiries i LEFT JOIN profiles p ON p.user_id = i.user_id WHERE ($1 = 'all' OR i.status = $1) ORDER BY i.created_at DESC LIMIT 200`, [status]);
    return { items: rows.map((r) => ({ id: r.id, userId: r.user_id, nickname: r.nickname, body: r.body, status: r.status, answer: r.answer, createdAt: iso(r.created_at) })) };
  }
  async answerInquiry(admin: Admin, id: string, body: any) {
    const answer = str(body?.answer, '답변', 2, 2000);
    const row = await this.db.one<any>(`UPDATE inquiries SET status = 'answered', answer = $2, answered_by = $3, answered_at = now() WHERE id = $1 RETURNING user_id`, [id, answer, admin.id]);
    if (!row) throw notFound('문의를 찾을 수 없습니다.');
    await this.account.notify(this.db, row.user_id, 'inquiry', '문의에 답변이 등록되었습니다', answer, { inquiryId: id });
    await this.audit(this.db, admin.id, 'inquiry.answer', 'inquiry', id);
    this.rt.emit([row.user_id], { type: 'notice.new', data: {} });
    return { ok: true };
  }

  // ── 관리자 계정·기록 ──────────────────────────────────────────────────

  async adminList() {
    return { items: await this.db.query('SELECT id, email, name, role, active, created_at AS "createdAt" FROM admins ORDER BY created_at') };
  }
  async addAdmin(admin: Admin, body: any) {
    if (!['owner', 'moderator', 'support', 'finance'].includes(body?.role)) throw bad('INVALID_INPUT', '역할을 선택해 주세요.');
    const id = await this.createAdmin(this.db, body?.email, body?.password, body.role, String(body?.name || ''));
    await this.audit(this.db, admin.id, 'admin.create', 'admin', id, { role: body.role });
    return { id };
  }
  async updateAdmin(admin: Admin, id: string, body: any) {
    if (id === admin.id && (body?.active === false || (body?.role && body.role !== 'owner'))) throw bad('INVALID_INPUT', '자신의 권한은 낮출 수 없습니다.');
    const cur = await this.db.one<any>('SELECT * FROM admins WHERE id = $1', [id]);
    if (!cur) throw notFound('관리자를 찾을 수 없습니다.');
    const role = ['owner', 'moderator', 'support', 'finance'].includes(body?.role) ? body.role : cur.role;
    const active = typeof body?.active === 'boolean' ? body.active : cur.active;
    await this.db.query('UPDATE admins SET role = $2, active = $3 WHERE id = $1', [id, role, active]);
    if (!active) await this.db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [id]);
    await this.audit(this.db, admin.id, 'admin.update', 'admin', id, { role, active });
    return { ok: true };
  }
  async auditLog() {
    const rows = await this.db.query<any>('SELECT l.*, a.name, a.email FROM admin_audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 300');
    return { items: rows.map((r) => ({ id: Number(r.id), by: r.name || r.email, action: r.action, targetType: r.target_type, targetId: r.target_id, detail: r.detail, at: iso(r.created_at) })) };
  }
}
