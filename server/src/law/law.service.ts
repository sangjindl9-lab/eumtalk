import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Admin, AdminService } from '../admin/admin.service';
import { AppConfig, CONFIG } from '../config';
import { decrypt } from '../common/crypto';
import { bad, conflict, notFound } from '../common/errors';
import { str } from '../common/validate';
import { Db, Q } from '../db/db';
import { MediaService } from '../media/media.service';

/**
 * 수사기관 자료 제공.
 *
 * 흐름: 접수(요청 대장 기록) → 보존 조치(선택) → 소유자 승인(법적 근거 확인) → 제공 자료 생성(SHA-256 기록)
 *      → 제공 완료 기록 → 종결. 모든 단계와 자료 열람·내려받기는 관리자 조치 기록에 남는다.
 *
 * 법적 근거별로 꺼낼 수 있는 자료 범위를 서버가 제한한다.
 *  - 통신자료 제공요청(전기통신사업법 제83조): 가입 정보만
 *  - 통신사실확인자료 제공요청(통신비밀보호법 제13조): 접속 기록, 대화 상대·일시(내용 제외)
 *  - 압수·수색·검증 영장: 대화 내용을 포함한 모든 자료
 *  - 긴급(생명·신체 위험): 영장 범위와 같되, 사후 영장 확인이 필요하다고 자료에 표시
 *  - 보존 요청: 자료 제공 없이 보존 조치만
 */
export const LAW_BASIS: Record<string, { label: string; scopes: string[] }> = {
  warrant: { label: '압수·수색·검증 영장', scopes: ['account', 'access', 'comm_meta', 'messages', 'posts', 'reports', 'payments'] },
  comm_confirm: { label: '통신사실확인자료 제공요청(통신비밀보호법 제13조)', scopes: ['access', 'comm_meta'] },
  comm_data: { label: '통신자료 제공요청(전기통신사업법 제83조)', scopes: ['account'] },
  emergency: { label: '긴급 요청(생명·신체에 대한 위험)', scopes: ['account', 'access', 'comm_meta', 'messages', 'posts', 'reports', 'payments'] },
  preservation: { label: '자료 보존 요청', scopes: [] },
};

export const LAW_SCOPES: Record<string, string> = {
  account: '가입·회원 정보',
  access: '접속 기록(IP·시각·기기)',
  comm_meta: '대화 상대·일시(내용 제외)',
  messages: '대화 내용(1대1·그룹방, 사진 포함)',
  posts: '게시글·댓글',
  reports: '신고·운영 조치 이력',
  payments: '결제·포인트 내역',
};

const STATUS_LABEL: Record<string, string> = {
  received: '접수',
  approved: '승인',
  exported: '자료 생성',
  delivered: '제공 완료',
  closed: '종결',
  rejected: '반려',
};

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const MAX_ROWS = 20000;

function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .filter((k) => (v as any)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
    .join(',')}}`;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

@Injectable()
export class LawService {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  meta() {
    return {
      bases: Object.entries(LAW_BASIS).map(([id, b]) => ({ id, label: b.label, scopes: b.scopes })),
      scopes: Object.entries(LAW_SCOPES).map(([id, label]) => ({ id, label })),
      statuses: STATUS_LABEL,
    };
  }

  // ── 대상 회원 찾기: 현재 닉네임·과거 닉네임·회원 ID ────────────────────────
  async findUsers(qRaw: string) {
    const q = String(qRaw || '').trim();
    if (q.length < 1) return { items: [] };
    const like = q.replace(/[%_\\]/g, '\\$&');
    const rows = await this.db.query<any>(
      `SELECT u.id, u.status, u.created_at, u.deleted_at, p.nickname AS current_nickname,
              (SELECT array_agg(DISTINCT h.nickname) FROM nickname_history h WHERE h.user_id = u.id) AS nicknames,
              EXISTS (SELECT 1 FROM law_holds lh WHERE lh.user_id = u.id AND lh.released_at IS NULL) AS on_hold
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id::text = $1
           OR EXISTS (SELECT 1 FROM nickname_history h WHERE h.user_id = u.id AND h.nickname ILIKE '%' || $2 || '%')
           OR p.nickname ILIKE '%' || $2 || '%'
        ORDER BY u.created_at DESC LIMIT 50`,
      [q, like],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        nickname: r.status === 'deleted' ? null : r.current_nickname,
        nicknames: r.nicknames ?? [],
        status: r.status,
        createdAt: iso(r.created_at),
        deletedAt: iso(r.deleted_at),
        onHold: r.on_hold,
      })),
    };
  }

  // ── 요청 대장 ───────────────────────────────────────────────────────
  async list() {
    const rows = await this.db.query<any>(
      `SELECT r.*, a.name AS created_by_name,
              (SELECT count(*) FROM law_request_targets t WHERE t.request_id = r.id) AS targets,
              (SELECT count(*) FROM law_exports e WHERE e.request_id = r.id) AS exports
         FROM law_requests r LEFT JOIN admins a ON a.id = r.created_by
        ORDER BY r.created_at DESC LIMIT 300`,
    );
    return { items: rows.map((r) => this.view(r)) };
  }

  private view(r: any) {
    return {
      id: r.id,
      agency: r.agency,
      officer: r.officer,
      officerContact: r.officer_contact,
      docNumber: r.doc_number,
      basis: r.basis,
      basisLabel: LAW_BASIS[r.basis]?.label ?? r.basis,
      receivedAt: r.received_at ? String(r.received_at instanceof Date ? r.received_at.toISOString().slice(0, 10) : r.received_at).slice(0, 10) : null,
      dueAt: r.due_at ? String(r.due_at instanceof Date ? r.due_at.toISOString().slice(0, 10) : r.due_at).slice(0, 10) : null,
      periodFrom: iso(r.period_from),
      periodTo: iso(r.period_to),
      scope: r.scope ?? [],
      counterpartIds: r.counterpart_ids ?? [],
      note: r.note,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      createdAt: iso(r.created_at),
      createdBy: r.created_by_name ?? null,
      approvedAt: iso(r.approved_at),
      deliveredAt: iso(r.delivered_at),
      deliveryMethod: r.delivery_method,
      closedAt: iso(r.closed_at),
      closeNote: r.close_note,
      targets: r.targets !== undefined ? Number(r.targets) : undefined,
      exports: r.exports !== undefined ? Number(r.exports) : undefined,
    };
  }

  private parseDate(v: unknown, field: string): string | null {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw bad('INVALID_INPUT', `${field}를 확인해 주세요.`);
    return d.toISOString();
  }

  private normalizeScope(basis: string, scopeRaw: unknown): string[] {
    const allowed = LAW_BASIS[basis]?.scopes ?? [];
    const scope = Array.isArray(scopeRaw) ? [...new Set(scopeRaw.map(String))] : [];
    const unknown = scope.filter((s) => !LAW_SCOPES[s]);
    if (unknown.length) throw bad('INVALID_INPUT', `알 수 없는 자료 범위입니다: ${unknown.join(', ')}`);
    const over = scope.filter((s) => !allowed.includes(s));
    if (over.length) {
      throw bad('SCOPE_NOT_ALLOWED', `${LAW_BASIS[basis].label}로는 ${over.map((s) => LAW_SCOPES[s]).join(', ')}을(를) 제공할 수 없습니다. 영장이 필요합니다.`);
    }
    return scope;
  }

  async create(a: Admin, body: any) {
    const basis = String(body?.basis || '');
    if (!LAW_BASIS[basis]) throw bad('INVALID_INPUT', '법적 근거를 선택해 주세요.');
    const agency = str(body?.agency, '요청 기관', 2, 100);
    const scope = this.normalizeScope(basis, body?.scope);
    const userIds: string[] = Array.isArray(body?.userIds) ? [...new Set<string>(body.userIds.map(String))] : [];
    if (!userIds.length) throw bad('INVALID_INPUT', '대상 회원을 한 명 이상 지정해 주세요.');
    const counterpartIds: string[] = Array.isArray(body?.counterpartIds) ? [...new Set<string>(body.counterpartIds.map(String))] : [];
    const periodFrom = this.parseDate(body?.periodFrom, '조회 시작일');
    const periodTo = this.parseDate(body?.periodTo, '조회 종료일');
    if (periodFrom && periodTo && periodFrom > periodTo) throw bad('INVALID_INPUT', '조회 기간을 확인해 주세요.');

    return this.db.tx(async (q) => {
      const found = await q.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      if (found.length !== userIds.length) throw bad('INVALID_INPUT', '대상 회원을 찾을 수 없습니다.');
      if (counterpartIds.length) {
        const cp = await q.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [counterpartIds]);
        if (cp.length !== counterpartIds.length) throw bad('INVALID_INPUT', '대화 상대를 찾을 수 없습니다.');
      }
      const r = await q.one<any>(
        `INSERT INTO law_requests (agency, officer, officer_contact, doc_number, basis, received_at, due_at, period_from, period_to, scope, counterpart_ids, note, created_by)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, current_date), $7::date, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [
          agency,
          String(body?.officer || '').slice(0, 100),
          String(body?.officerContact || '').slice(0, 200),
          String(body?.docNumber || '').slice(0, 200),
          basis,
          body?.receivedAt || null,
          body?.dueAt || null,
          periodFrom,
          periodTo,
          scope,
          counterpartIds,
          String(body?.note || '').slice(0, 2000),
          a.id,
        ],
      );
      for (const uid of userIds) await q.query('INSERT INTO law_request_targets (request_id, user_id) VALUES ($1, $2)', [r.id, uid]);
      if (body?.hold === true || basis === 'preservation') {
        for (const uid of userIds) await this.placeHold(q, a, uid, r.id, `요청 ${agency} ${r.doc_number || ''}`.trim());
      }
      await this.admin.audit(q, a.id, 'law.request.create', 'law_request', r.id, { basis, scope, targets: userIds.length });
      return this.view(r);
    });
  }

  async detail(a: Admin, id: string) {
    const r = await this.db.one<any>('SELECT r.*, a.name AS created_by_name FROM law_requests r LEFT JOIN admins a ON a.id = r.created_by WHERE r.id = $1', [id]);
    if (!r) throw notFound('요청을 찾을 수 없습니다.');
    const targets = await this.db.query<any>(
      `SELECT u.id, u.status, u.created_at, u.deleted_at, p.nickname,
              (SELECT array_agg(DISTINCT h.nickname) FROM nickname_history h WHERE h.user_id = u.id) AS nicknames,
              EXISTS (SELECT 1 FROM law_holds lh WHERE lh.user_id = u.id AND lh.released_at IS NULL) AS on_hold
         FROM law_request_targets t JOIN users u ON u.id = t.user_id LEFT JOIN profiles p ON p.user_id = u.id
        WHERE t.request_id = $1 ORDER BY u.created_at`,
      [id],
    );
    const exports = await this.db.query<any>(
      `SELECT e.id, e.created_at, e.sha256, e.byte_size, a.name AS by FROM law_exports e LEFT JOIN admins a ON a.id = e.created_by WHERE e.request_id = $1 ORDER BY e.created_at DESC`,
      [id],
    );
    const holds = await this.db.query<any>(
      `SELECT h.id, h.user_id, h.reason, h.created_at, h.released_at, h.snapshot IS NOT NULL AS has_snapshot FROM law_holds h WHERE h.request_id = $1 ORDER BY h.created_at`,
      [id],
    );
    await this.admin.audit(this.db, a.id, 'law.request.view', 'law_request', id);
    return {
      request: this.view(r),
      targets: targets.map((t) => ({
        id: t.id,
        nickname: t.status === 'deleted' ? null : t.nickname,
        nicknames: t.nicknames ?? [],
        status: t.status,
        createdAt: iso(t.created_at),
        deletedAt: iso(t.deleted_at),
        onHold: t.on_hold,
      })),
      exports: exports.map((e) => ({ id: e.id, createdAt: iso(e.created_at), sha256: e.sha256, byteSize: e.byte_size, by: e.by })),
      holds: holds.map((h) => ({ id: h.id, userId: h.user_id, reason: h.reason, createdAt: iso(h.created_at), releasedAt: iso(h.released_at), hasSnapshot: h.has_snapshot })),
    };
  }

  // ── 보존 조치 ───────────────────────────────────────────────────────
  private async placeHold(q: Q, a: Admin, userId: string, requestId: string | null, reason: string) {
    if (await q.one('SELECT 1 FROM law_holds WHERE user_id = $1 AND released_at IS NULL AND request_id IS NOT DISTINCT FROM $2', [userId, requestId])) return;
    const h = await q.one<{ id: string }>('INSERT INTO law_holds (user_id, request_id, reason, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [userId, requestId, reason.slice(0, 300), a.id]);
    await this.admin.audit(q, a.id, 'law.hold.place', 'user', userId, { requestId, holdId: h!.id });
  }

  async setHold(a: Admin, requestId: string, body: any) {
    const on = body?.on !== false;
    const userId = String(body?.userId || '');
    return this.db.tx(async (q) => {
      const r = await q.one<any>('SELECT * FROM law_requests WHERE id = $1', [requestId]);
      if (!r) throw notFound('요청을 찾을 수 없습니다.');
      if (!(await q.one('SELECT 1 FROM law_request_targets WHERE request_id = $1 AND user_id = $2', [requestId, userId]))) throw bad('INVALID_INPUT', '이 요청의 대상 회원이 아닙니다.');
      if (on) {
        await this.placeHold(q, a, userId, requestId, `요청 ${r.agency} ${r.doc_number || ''}`.trim());
      } else {
        const rows = await q.query<{ id: string }>(
          'UPDATE law_holds SET released_at = now(), released_by = $3 WHERE user_id = $1 AND request_id = $2 AND released_at IS NULL RETURNING id',
          [userId, requestId, a.id],
        );
        if (rows.length) await this.admin.audit(q, a.id, 'law.hold.release', 'user', userId, { requestId });
      }
      return { ok: true };
    });
  }

  // ── 상태 변경 ──────────────────────────────────────────────────────
  async approve(a: Admin, id: string, body: any) {
    return this.db.tx(async (q) => {
      const r = await q.one<any>('SELECT * FROM law_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound('요청을 찾을 수 없습니다.');
      if (r.status !== 'received') throw conflict('INVALID_STATE', '접수 상태인 요청만 승인할 수 있습니다.');
      if (body?.confirmed !== true) throw bad('CONFIRM_REQUIRED', '공문·영장 원본과 요청 기관을 확인했는지 체크해 주세요.');
      if (r.basis === 'preservation' || !r.scope?.length) throw bad('NOTHING_TO_EXPORT', '보존 요청은 자료를 제공하지 않습니다. 영장 등 제공 요청을 따로 접수해 주세요.');
      const u = await q.one<any>(`UPDATE law_requests SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [id, a.id]);
      await this.admin.audit(q, a.id, 'law.request.approve', 'law_request', id, { basis: r.basis, scope: r.scope });
      return this.view(u);
    });
  }

  async reject(a: Admin, id: string, body: any) {
    const note = str(body?.note, '반려 사유', 2, 1000);
    const u = await this.db.one<any>(`UPDATE law_requests SET status = 'rejected', closed_at = now(), close_note = $2 WHERE id = $1 AND status IN ('received','approved') RETURNING *`, [id, note]);
    if (!u) throw conflict('INVALID_STATE', '접수·승인 상태인 요청만 반려할 수 있습니다.');
    await this.admin.audit(this.db, a.id, 'law.request.reject', 'law_request', id, { note });
    return this.view(u);
  }

  async delivered(a: Admin, id: string, body: any) {
    const method = str(body?.method, '제공 방법', 2, 300);
    const u = await this.db.one<any>(`UPDATE law_requests SET status = 'delivered', delivered_at = now(), delivery_method = $2 WHERE id = $1 AND status = 'exported' RETURNING *`, [id, method]);
    if (!u) throw conflict('INVALID_STATE', '자료를 생성한 요청만 제공 완료로 기록할 수 있습니다.');
    await this.admin.audit(this.db, a.id, 'law.request.delivered', 'law_request', id, { method });
    return this.view(u);
  }

  async close(a: Admin, id: string, body: any) {
    const note = String(body?.note || '').slice(0, 1000);
    const releaseHolds = body?.releaseHolds === true;
    return this.db.tx(async (q) => {
      const u = await q.one<any>(`UPDATE law_requests SET status = 'closed', closed_at = now(), close_note = $2 WHERE id = $1 AND status NOT IN ('closed','rejected') RETURNING *`, [id, note]);
      if (!u) throw conflict('INVALID_STATE', '이미 종결된 요청입니다.');
      if (releaseHolds) await q.query('UPDATE law_holds SET released_at = now(), released_by = $2 WHERE request_id = $1 AND released_at IS NULL', [id, a.id]);
      await this.admin.audit(q, a.id, 'law.request.close', 'law_request', id, { releaseHolds });
      return this.view(u);
    });
  }

  // ── 제공 자료 생성 ─────────────────────────────────────────────────
  async generate(a: Admin, id: string) {
    const r = await this.db.one<any>('SELECT * FROM law_requests WHERE id = $1', [id]);
    if (!r) throw notFound('요청을 찾을 수 없습니다.');
    if (!['approved', 'exported'].includes(r.status)) throw conflict('INVALID_STATE', '소유자 승인 후에 자료를 만들 수 있습니다.');
    const scope: string[] = r.scope ?? [];
    const from: string | null = r.period_from ? new Date(r.period_from).toISOString() : null;
    const to: string | null = r.period_to ? new Date(r.period_to).toISOString() : null;
    const targetIds = (await this.db.query<{ user_id: string }>('SELECT user_id FROM law_request_targets WHERE request_id = $1', [id])).map((t) => t.user_id);
    const counterparts: string[] = r.counterpart_ids ?? [];
    const inRange = (col: string, i: number) => `($${i}::timestamptz IS NULL OR ${col} >= $${i}::timestamptz) AND ($${i + 1}::timestamptz IS NULL OR ${col} <= $${i + 1}::timestamptz)`;

    const subjects: any[] = [];
    for (const uid of targetIds) {
      const s: any = { userId: uid };
      if (scope.includes('account')) s.account = await this.account(uid);
      if (scope.includes('access')) {
        s.accessLogs = (
          await this.db.query<any>(`SELECT at, ip, platform, user_agent FROM access_logs WHERE user_id = $1 AND ${inRange('at', 2)} ORDER BY at LIMIT ${MAX_ROWS}`, [uid, from, to])
        ).map((x) => ({ at: iso(x.at), ip: x.ip, platform: x.platform, userAgent: x.user_agent }));
        s.sessions = (await this.db.query<any>('SELECT created_at, last_used_at, revoked_at, platform FROM sessions WHERE user_id = $1 ORDER BY created_at', [uid])).map((x) => ({
          createdAt: iso(x.created_at),
          lastUsedAt: iso(x.last_used_at),
          revokedAt: iso(x.revoked_at),
          platform: x.platform,
        }));
      }
      if (scope.includes('comm_meta') || scope.includes('messages')) {
        s.conversations = await this.conversations(uid, from, to, counterparts);
        s.greetings = (
          await this.db.query<any>(
            `SELECT g.created_at, g.responded_at, g.status, g.sender_id, g.receiver_id, ${scope.includes('messages') ? 'g.body' : 'NULL AS body'}
               FROM greeting_requests g
              WHERE (g.sender_id = $1 OR g.receiver_id = $1) AND ${inRange('g.created_at', 2)}
                AND (cardinality($4::uuid[]) = 0 OR g.sender_id = ANY($4::uuid[]) OR g.receiver_id = ANY($4::uuid[]))
              ORDER BY g.created_at LIMIT ${MAX_ROWS}`,
            [uid, from, to, counterparts],
          )
        ).map((g) => ({
          direction: g.sender_id === uid ? 'sent' : 'received',
          counterpartUserId: g.sender_id === uid ? g.receiver_id : g.sender_id,
          at: iso(g.created_at),
          status: g.status,
          respondedAt: iso(g.responded_at),
          ...(scope.includes('messages') ? { body: g.body } : {}),
        }));
      }
      if (scope.includes('messages')) s.messages = await this.messages(uid, from, to, counterparts);
      if (scope.includes('posts')) {
        s.posts = (
          await this.db.query<any>(`SELECT id, kind, category, title, body, price, status, media_ids, created_at FROM posts WHERE author_id = $1 AND ${inRange('created_at', 2)} ORDER BY created_at LIMIT ${MAX_ROWS}`, [uid, from, to])
        ).map((p) => ({ id: p.id, kind: p.kind, category: p.category, title: p.title, body: p.body, price: p.price, status: p.status, mediaIds: p.media_ids, createdAt: iso(p.created_at) }));
        s.comments = (
          await this.db.query<any>(`SELECT id, post_id, body, status, created_at FROM post_comments WHERE author_id = $1 AND ${inRange('created_at', 2)} ORDER BY created_at LIMIT ${MAX_ROWS}`, [uid, from, to])
        ).map((c) => ({ id: c.id, postId: c.post_id, body: c.body, status: c.status, createdAt: iso(c.created_at) }));
      }
      if (scope.includes('reports')) {
        s.reportsFiled = (
          await this.db.query<any>(`SELECT id, target_type, target_id, target_user_id, reason, detail, status, created_at FROM reports WHERE reporter_id = $1 AND ${inRange('created_at', 2)} ORDER BY created_at`, [uid, from, to])
        ).map((x) => ({ id: x.id, targetType: x.target_type, targetId: x.target_id, targetUserId: x.target_user_id, reason: x.reason, detail: x.detail, status: x.status, createdAt: iso(x.created_at) }));
        s.reportsAgainst = (
          await this.db.query<any>(`SELECT id, target_type, target_id, reporter_id, reason, detail, status, snapshot, created_at FROM reports WHERE target_user_id = $1 AND ${inRange('created_at', 2)} ORDER BY created_at`, [uid, from, to])
        ).map((x) => ({ id: x.id, targetType: x.target_type, targetId: x.target_id, reporterUserId: x.reporter_id, reason: x.reason, detail: x.detail, status: x.status, evidence: x.snapshot, createdAt: iso(x.created_at) }));
        s.sanctions = (await this.db.query<any>('SELECT type, reason, until, lifted_at, created_at FROM sanctions WHERE user_id = $1 ORDER BY created_at', [uid])).map((x) => ({
          type: x.type,
          reason: x.reason,
          until: iso(x.until),
          liftedAt: iso(x.lifted_at),
          createdAt: iso(x.created_at),
        }));
      }
      if (scope.includes('payments')) {
        s.purchases = (
          await this.db.query<any>(`SELECT store, product_id, transaction_id, status, points_granted, created_at, refunded_at FROM purchases WHERE user_id = $1 AND ${inRange('created_at', 2)} ORDER BY created_at`, [uid, from, to])
        ).map((x) => ({ store: x.store, productId: x.product_id, transactionId: x.transaction_id, status: x.status, points: x.points_granted, createdAt: iso(x.created_at), refundedAt: iso(x.refunded_at) }));
        s.pointLedger = (
          await this.db.query<any>(`SELECT delta, balance_after, type, reason, created_at FROM point_ledger WHERE user_id = $1 AND ${inRange('created_at', 2)} ORDER BY id LIMIT ${MAX_ROWS}`, [uid, from, to])
        ).map((x) => ({ delta: x.delta, balanceAfter: x.balance_after, type: x.type, reason: x.reason, at: iso(x.created_at) }));
      }
      subjects.push(s);
    }

    const op = this.cfg.brand.operator || ({} as any);
    const content = {
      format: 'eumtalk-law-export/1',
      service: { name: this.cfg.brand.appName, nameEn: this.cfg.brand.appNameEn, operator: op.company || '', contact: op.email || '' },
      request: {
        id: r.id,
        agency: r.agency,
        officer: r.officer,
        docNumber: r.doc_number,
        basis: r.basis,
        basisLabel: LAW_BASIS[r.basis].label,
        receivedAt: this.view(r).receivedAt,
        periodFrom: from,
        periodTo: to,
        scope,
        scopeLabels: scope.map((s) => LAW_SCOPES[s]),
        counterpartUserIds: counterparts,
        followUpWarrantRequired: r.basis === 'emergency',
      },
      generatedAt: new Date().toISOString(),
      generatedBy: a.name || a.email,
      timeZoneNote: '모든 시각은 UTC(협정 세계시) 기준 ISO 8601 형식입니다. 한국 시각은 9시간을 더합니다.',
      subjects,
    };
    const text = canonical(content);
    const sha = createHash('sha256').update(text, 'utf8').digest('hex');
    const e = await this.db.tx(async (q) => {
      const row = await q.one<any>('INSERT INTO law_exports (request_id, created_by, sha256, byte_size, content) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at', [id, a.id, sha, Buffer.byteLength(text), text]);
      await q.query(`UPDATE law_requests SET status = 'exported' WHERE id = $1 AND status IN ('approved','exported')`, [id]);
      await this.admin.audit(q, a.id, 'law.export.create', 'law_request', id, { exportId: row!.id, sha256: sha, scope });
      return row!;
    });
    return { id: e.id, createdAt: iso(e.created_at), sha256: sha, byteSize: Buffer.byteLength(text) };
  }

  private async account(uid: string) {
    const u = await this.db.one<any>(
      `SELECT u.id, u.status, u.created_at, u.deleted_at, p.nickname, p.age_band, p.gender, p.bio, r.name AS region,
              up.birth_year, up.phone_enc, up.identity_provider, up.adult_verified_at
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN regions r ON r.id = p.region_id LEFT JOIN user_private up ON up.user_id = u.id
        WHERE u.id = $1`,
      [uid],
    );
    if (!u) return null;
    let phone: string | null = null;
    if (u.phone_enc) {
      try {
        phone = decrypt(this.cfg.dataKey, u.phone_enc);
      } catch {
        phone = '(복호화 실패)';
      }
    }
    const history = await this.db.query<any>('SELECT nickname, started_at, ended_at FROM nickname_history WHERE user_id = $1 ORDER BY started_at', [uid]);
    const deletion = await this.db.one<any>('SELECT reason, created_at FROM account_deletions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [uid]);
    const holdSnap = await this.db.one<any>('SELECT snapshot FROM law_holds WHERE user_id = $1 AND snapshot IS NOT NULL ORDER BY created_at DESC LIMIT 1', [uid]);
    const deleted = u.status === 'deleted';
    return {
      userId: u.id,
      status: u.status,
      signupAt: iso(u.created_at),
      deletedAt: iso(u.deleted_at),
      deletionReason: deletion?.reason ?? null,
      nickname: deleted ? null : u.nickname,
      nicknameHistory: history.map((h) => ({ nickname: h.nickname, from: iso(h.started_at), to: iso(h.ended_at) })),
      ageBand: deleted ? holdSnap?.snapshot?.age_band ?? null : u.age_band,
      birthYear: u.birth_year ?? holdSnap?.snapshot?.birth_year ?? null,
      gender: deleted ? holdSnap?.snapshot?.gender ?? null : u.gender,
      region: deleted ? holdSnap?.snapshot?.region ?? null : u.region,
      bio: deleted ? holdSnap?.snapshot?.bio ?? null : u.bio,
      signupMethod: u.identity_provider === 'anonymous' ? '익명 가입(출생 연도·성인 여부 자기 신고)' : u.identity_provider === 'portone' ? '휴대폰 본인인증' : u.identity_provider,
      phone,
      preservedAtDeletion: holdSnap?.snapshot ?? null,
      note: '실명·주민등록번호·주소는 수집하지 않습니다.',
    };
  }

  private async conversations(uid: string, from: string | null, to: string | null, counterparts: string[]) {
    const rows = await this.db.query<any>(
      `SELECT c.id, c.type, c.created_at, cp.joined_at, cp.left_at, rm.title,
              (SELECT array_agg(x.user_id) FROM conversation_participants x WHERE x.conversation_id = c.id AND x.user_id <> $1) AS others,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND ($2::timestamptz IS NULL OR m.created_at >= $2) AND ($3::timestamptz IS NULL OR m.created_at <= $3)) AS msg_count,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id = $1 AND ($2::timestamptz IS NULL OR m.created_at >= $2) AND ($3::timestamptz IS NULL OR m.created_at <= $3)) AS sent_count,
              (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND ($2::timestamptz IS NULL OR m.created_at >= $2) AND ($3::timestamptz IS NULL OR m.created_at <= $3)) AS first_at,
              (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND ($2::timestamptz IS NULL OR m.created_at >= $2) AND ($3::timestamptz IS NULL OR m.created_at <= $3)) AS last_at
         FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id LEFT JOIN rooms rm ON rm.conversation_id = c.id
        WHERE cp.user_id = $1
          AND (cardinality($4::uuid[]) = 0 OR EXISTS (SELECT 1 FROM conversation_participants y WHERE y.conversation_id = c.id AND y.user_id = ANY($4::uuid[])))
        ORDER BY c.created_at`,
      [uid, from, to, counterparts],
    );
    return rows
      .filter((c) => Number(c.msg_count) > 0 || (!from && !to))
      .map((c) => ({
        conversationId: c.id,
        type: c.type === 'direct' ? '1대1' : '그룹방',
        roomTitle: c.title ?? null,
        otherUserIds: c.type === 'direct' ? c.others ?? [] : undefined,
        otherMemberCount: c.type === 'group' ? (c.others ?? []).length : undefined,
        joinedAt: iso(c.joined_at),
        leftAt: iso(c.left_at),
        messagesInPeriod: Number(c.msg_count),
        sentByTargetInPeriod: Number(c.sent_count),
        firstMessageAt: iso(c.first_at),
        lastMessageAt: iso(c.last_at),
      }));
  }

  private async messages(uid: string, from: string | null, to: string | null, counterparts: string[]) {
    const rows = await this.db.query<any>(
      `SELECT m.id, m.conversation_id, m.seq, m.sender_id, m.kind, m.body, m.created_at, m.deleted_at, m.hidden_at, m.media_id,
              md.mime, md.bytes, md.created_at AS media_created_at
         FROM messages m
         JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1
         LEFT JOIN media md ON md.id = m.media_id
        WHERE ($2::timestamptz IS NULL OR m.created_at >= $2) AND ($3::timestamptz IS NULL OR m.created_at <= $3)
          AND (cardinality($4::uuid[]) = 0 OR EXISTS (SELECT 1 FROM conversation_participants y WHERE y.conversation_id = m.conversation_id AND y.user_id = ANY($4::uuid[])))
        ORDER BY m.conversation_id, m.seq LIMIT ${MAX_ROWS}`,
      [uid, from, to, counterparts],
    );
    return rows.map((m) => ({
      messageId: m.id,
      conversationId: m.conversation_id,
      seq: Number(m.seq),
      senderUserId: m.sender_id,
      byTarget: m.sender_id === uid,
      kind: m.kind,
      body: m.body,
      at: iso(m.created_at),
      deletedBySenderAt: iso(m.deleted_at),
      hiddenByOperatorAt: iso(m.hidden_at),
      photo: m.media_id ? { mediaId: m.media_id, mime: m.mime, bytes: m.bytes, uploadedAt: iso(m.media_created_at) } : null,
    }));
  }

  // ── 내려받기 ───────────────────────────────────────────────────────
  async download(a: Admin, requestId: string, exportId: string, format: string) {
    const e = await this.db.one<any>('SELECT e.*, r.agency, r.doc_number FROM law_exports e JOIN law_requests r ON r.id = e.request_id WHERE e.id = $1 AND e.request_id = $2', [exportId, requestId]);
    if (!e) throw notFound('제공 자료를 찾을 수 없습니다.');
    const content = typeof e.content === 'string' ? JSON.parse(e.content) : e.content;
    const text = canonical(content);
    const sha = createHash('sha256').update(text, 'utf8').digest('hex');
    if (sha !== e.sha256) throw conflict('INTEGRITY_FAILED', '저장된 자료의 해시가 맞지 않습니다. 자료가 변경되었을 수 있습니다.');
    await this.admin.audit(this.db, a.id, 'law.export.download', 'law_request', requestId, { exportId, format });
    const stamp = new Date(e.created_at).toISOString().slice(0, 10);
    const base = `eumtalk-law-${stamp}-${String(requestId).slice(0, 8)}`;
    if (format === 'json') return { filename: `${base}.json`, mime: 'application/json', sha256: sha, content: text };
    return { filename: `${base}.html`, mime: 'text/html', sha256: sha, content: this.html(content, sha) };
  }

  /** 기간 안의 대화 사진을 볼 수 있는 짧은 링크. 승인된 요청의 대상 회원이 들어간 대화 사진만. */
  async mediaUrl(a: Admin, requestId: string, mediaId: string) {
    const r = await this.db.one<any>('SELECT * FROM law_requests WHERE id = $1', [requestId]);
    if (!r || !['approved', 'exported', 'delivered'].includes(r.status) || !(r.scope ?? []).includes('messages')) throw notFound('사진을 볼 수 없습니다.');
    const m = await this.db.one<any>(
      `SELECT md.storage_key FROM media md
        WHERE md.id = $1 AND md.status <> 'deleted' AND EXISTS (
          SELECT 1 FROM messages m JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
            JOIN law_request_targets t ON t.user_id = cp.user_id AND t.request_id = $2
           WHERE m.media_id = md.id)`,
      [mediaId, requestId],
    );
    if (!m) throw notFound('사진을 찾을 수 없습니다.');
    await this.admin.audit(this.db, a.id, 'law.media.view', 'media', mediaId, { requestId });
    return { url: this.media.storage.signedUrl(m.storage_key, 300), expiresInSec: 300 };
  }

  private html(c: any, sha: string) {
    const kst = (v: string | null) => (v ? new Date(new Date(v).getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) + ' KST' : '');
    const table = (head: string[], rows: (string | number | null | undefined)[][]) =>
      rows.length
        ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : '<p class="muted">해당 기간에 자료가 없습니다.</p>';
    const req = c.request;
    const parts: string[] = [];
    for (const s of c.subjects) {
      parts.push(`<h2>대상 회원 ${esc(s.userId)}</h2>`);
      if (s.account) {
        const x = s.account;
        parts.push('<h3>가입·회원 정보</h3>');
        parts.push(
          table(['항목', '내용'], [
            ['회원 ID', x.userId],
            ['상태', x.status],
            ['가입 일시', kst(x.signupAt)],
            ['탈퇴 일시', kst(x.deletedAt)],
            ['현재 닉네임', x.nickname],
            ['가입 방식', x.signupMethod],
            ['휴대폰 번호', x.phone ?? '수집하지 않음'],
            ['출생 연도(자기 신고)', x.birthYear],
            ['연령대', x.ageBand],
            ['성별', x.gender],
            ['활동 지역', x.region],
            ['자기소개', x.bio],
            ['비고', x.note],
          ]),
        );
        parts.push('<h4>닉네임 이력</h4>' + table(['닉네임', '사용 시작', '사용 종료'], x.nicknameHistory.map((h: any) => [h.nickname, kst(h.from), kst(h.to)])));
      }
      if (s.accessLogs) {
        parts.push('<h3>접속 기록</h3>' + table(['일시', 'IP', '기기', 'User-Agent'], s.accessLogs.map((l: any) => [kst(l.at), l.ip, l.platform, l.userAgent])));
        parts.push('<h4>로그인 세션</h4>' + table(['로그인', '마지막 사용', '로그아웃', '기기'], s.sessions.map((l: any) => [kst(l.createdAt), kst(l.lastUsedAt), kst(l.revokedAt), l.platform])));
      }
      if (s.conversations) {
        parts.push(
          '<h3>대화 상대·일시</h3>' +
            table(
              ['대화 ID', '종류', '상대 회원 ID / 방 이름', '기간 내 메시지', '대상자가 보낸 수', '처음', '마지막'],
              s.conversations.map((v: any) => [v.conversationId, v.type, v.type === '1대1' ? (v.otherUserIds ?? []).join(', ') : `${v.roomTitle ?? ''} (참여자 ${v.otherMemberCount + 1}명)`, v.messagesInPeriod, v.sentByTargetInPeriod, kst(v.firstMessageAt), kst(v.lastMessageAt)]),
            ),
        );
        parts.push('<h4>인사 요청</h4>' + table(['일시', '방향', '상대 회원 ID', '상태', '내용'], s.greetings.map((g: any) => [kst(g.at), g.direction === 'sent' ? '보냄' : '받음', g.counterpartUserId, g.status, g.body ?? '(내용 제외)'])));
      }
      if (s.messages) {
        parts.push(
          '<h3>대화 내용</h3>' +
            table(
              ['일시', '대화 ID', '보낸 회원 ID', '내용', '사진', '비고'],
              s.messages.map((m: any) => [
                kst(m.at),
                m.conversationId,
                m.senderUserId + (m.byTarget ? ' (대상자)' : ''),
                m.body,
                m.photo ? `사진 ${m.photo.mediaId}` : '',
                [m.deletedBySenderAt ? `보낸 사람이 삭제(${kst(m.deletedBySenderAt)})` : '', m.hiddenByOperatorAt ? `운영 조치로 숨김(${kst(m.hiddenByOperatorAt)})` : ''].filter(Boolean).join(' '),
              ]),
            ),
        );
      }
      if (s.posts) {
        parts.push('<h3>게시글</h3>' + table(['일시', '종류', '제목', '내용', '상태'], s.posts.map((p: any) => [kst(p.createdAt), `${p.kind}/${p.category}`, p.title, p.body, p.status])));
        parts.push('<h4>댓글</h4>' + table(['일시', '게시글 ID', '내용', '상태'], s.comments.map((p: any) => [kst(p.createdAt), p.postId, p.body, p.status])));
      }
      if (s.reportsFiled) {
        parts.push('<h3>신고 이력</h3><h4>대상자가 한 신고</h4>' + table(['일시', '대상', '피신고 회원 ID', '사유', '상세', '상태'], s.reportsFiled.map((x: any) => [kst(x.createdAt), x.targetType, x.targetUserId, x.reason, x.detail, x.status])));
        parts.push('<h4>대상자가 받은 신고</h4>' + table(['일시', '대상', '신고자 ID', '사유', '상세', '상태'], s.reportsAgainst.map((x: any) => [kst(x.createdAt), x.targetType, x.reporterUserId, x.reason, x.detail, x.status])));
        parts.push('<h4>운영 조치</h4>' + table(['일시', '종류', '사유', '기한', '해제'], s.sanctions.map((x: any) => [kst(x.createdAt), x.type, x.reason, kst(x.until), kst(x.liftedAt)])));
      }
      if (s.purchases) {
        parts.push('<h3>결제 내역</h3>' + table(['일시', '스토어', '상품', '거래 번호', '상태', '포인트'], s.purchases.map((x: any) => [kst(x.createdAt), x.store, x.productId, x.transactionId, x.status, x.points])));
        parts.push('<h4>포인트 원장</h4>' + table(['일시', '증감', '잔액', '종류', '사유'], s.pointLedger.map((x: any) => [kst(x.at), x.delta, x.balanceAfter, x.type, x.reason])));
      }
    }
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>수사기관 제공 자료 — ${esc(c.service.name)}</title>
<style>body{font:13px/1.55 "Noto Sans KR","Apple SD Gothic Neo",system-ui,sans-serif;color:#111;margin:24px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 6px;border-top:2px solid #111;padding-top:10px}h3{font-size:14px;margin:18px 0 6px}h4{font-size:13px;margin:12px 0 4px}
table{border-collapse:collapse;width:100%;margin:4px 0 10px}th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-all}th{background:#eee}.muted{color:#666}.box{border:1px solid #111;padding:10px 12px;margin:12px 0}
@media print{body{margin:0}h2{page-break-before:always}h2:first-of-type{page-break-before:auto}}</style></head><body>
<h1>수사기관 제공 자료</h1>
<p class="muted">${esc(c.service.name)} (${esc(c.service.nameEn)}) · 운영: ${esc(c.service.operator)} · ${esc(c.service.contact)}</p>
<div class="box">${table(['항목', '내용'], [
      ['요청 기관', req.agency],
      ['담당자', req.officer],
      ['공문·영장 번호', req.docNumber],
      ['법적 근거', req.basisLabel + (req.followUpWarrantRequired ? ' — 사후 영장 확인 필요' : '')],
      ['접수일', req.receivedAt],
      ['조회 기간', `${kst(req.periodFrom) || '처음부터'} ~ ${kst(req.periodTo) || '현재까지'}`],
      ['제공 범위', req.scopeLabels.join(', ')],
      ['대화 상대 한정', req.counterpartUserIds.length ? req.counterpartUserIds.join(', ') : '없음'],
      ['자료 생성 일시', kst(c.generatedAt)],
      ['자료 생성자', c.generatedBy],
      ['원본 SHA-256', sha],
    ])}
<p class="muted">이 문서는 함께 제공하는 JSON 원본 파일을 사람이 읽기 쉽게 옮긴 것입니다. 원본의 동일성은 JSON 파일의 SHA-256 값으로 확인합니다. 시각은 한국 시각(KST)으로 표시했습니다.</p></div>
${parts.join('\n')}
<p class="muted" style="margin-top:32px">— 끝 —</p></body></html>`;
  }

  /** 오래된 기록 정리: 접속 기록 90일, 보존 조치가 없는 탈퇴 회원의 닉네임 이력 1년. */
  async purge() {
    await this.db.query(`DELETE FROM access_logs WHERE at < now() - interval '90 days' AND user_id NOT IN (SELECT user_id FROM law_holds WHERE released_at IS NULL)`);
    await this.db.query(
      `DELETE FROM nickname_history h USING users u
        WHERE u.id = h.user_id AND u.status = 'deleted' AND u.deleted_at < now() - interval '1 year'
          AND NOT EXISTS (SELECT 1 FROM law_holds lh WHERE lh.user_id = u.id AND lh.released_at IS NULL)`,
    );
  }
}
