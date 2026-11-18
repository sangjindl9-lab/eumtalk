import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { ContentFilter } from '../common/content-filter';
import { bad, conflict, forbidden, notFound } from '../common/errors';
import { isUuid, str } from '../common/validate';
import { appendMessage, ChatService, MessageDto } from '../chat/chat.service';
import { Db, Q } from '../db/db';
import { MediaService } from '../media/media.service';
import { PointsService } from '../points/points.service';
import { Realtime } from '../realtime/realtime';

const FREE_MAX_CAPACITY = 50;
const HARD_MAX_CAPACITY = 300;
const EXPAND_STEP = 10;
const MAX_OWNED = 5;

@Injectable()
export class RoomsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(ContentFilter) private readonly filter: ContentFilter,
    @Inject(PointsService) private readonly points: PointsService,
  ) {}

  private parse(body: any, partial = false) {
    const out: any = {};
    if (!partial || body?.title !== undefined) out.title = str(body?.title, '방 제목', 2, 30);
    if (!partial || body?.intro !== undefined) out.intro = typeof body?.intro === 'string' ? body.intro.trim().slice(0, 300) : '';
    if (!partial || body?.tags !== undefined) {
      out.tags = [...new Set<string>((Array.isArray(body?.tags) ? body.tags : []).map((t: unknown) => String(t).replace(/^#/, '').trim()).filter((t: string) => t.length >= 1 && t.length <= 12))].slice(0, 5);
    }
    if (body?.searchable !== undefined) out.searchable = body.searchable === true;
    if (body?.isPrivate !== undefined) out.isPrivate = body.isPrivate === true;
    if (body?.requireApproval !== undefined) out.requireApproval = body.requireApproval === true;
    if (body?.capacity !== undefined) out.capacity = Math.trunc(Number(body.capacity));
    if (body?.regionId !== undefined) out.regionId = body.regionId ? String(body.regionId) : null;
    if (body?.imageMediaId !== undefined) out.imageMediaId = isUuid(body.imageMediaId) ? body.imageMediaId : null;
    this.filter.assertText(out.title, out.intro, ...(out.tags ?? []));
    return out;
  }

  /** 회원이 만드는 관심사 그룹방. ownerId 가 null 이면 운영자가 여는 상설 지역방이다. */
  async create(ownerId: string | null, body: any) {
    const p = this.parse(body);
    const kind = ownerId ? 'interest' : 'region';
    const capacity = p.capacity ?? 30;
    if (!(capacity >= 2 && capacity <= (ownerId ? FREE_MAX_CAPACITY : 1000))) throw bad('INVALID_CAPACITY', `정원은 2~${ownerId ? FREE_MAX_CAPACITY : 1000}명으로 정해 주세요.`);
    const isPrivate = p.isPrivate === true;
    const id = await this.db.tx(async (q) => {
      if (p.regionId && !(await q.one('SELECT 1 FROM regions WHERE id = $1', [p.regionId]))) throw bad('INVALID_REGION', '활동 지역을 확인해 주세요.');
      if (ownerId) {
        const owned = await q.one<{ n: string }>(`SELECT count(*) AS n FROM rooms WHERE owner_id = $1 AND status = 'open'`, [ownerId]);
        if (Number(owned!.n) >= MAX_OWNED) throw conflict('TOO_MANY_ROOMS', `운영 중인 방은 ${MAX_OWNED}개까지 만들 수 있습니다.`);
        if (p.imageMediaId) await this.media.assertOwned(q, ownerId, [p.imageMediaId], 'room');
      }
      const conv = await q.one<{ id: string }>(`INSERT INTO conversations (type) VALUES ('group') RETURNING id`);
      await q.query(
        `INSERT INTO rooms (conversation_id, kind, title, intro, tags, region_id, capacity, member_count, searchable, is_private, invite_code, require_approval, owner_id, image_media_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [conv!.id, kind, p.title, p.intro, p.tags, p.regionId ?? null, capacity, ownerId ? 1 : 0, isPrivate ? false : p.searchable !== false, isPrivate,
          isPrivate ? randomBytes(5).toString('hex') : null, p.requireApproval === true, ownerId, ownerId ? (p.imageMediaId ?? null) : null],
      );
      if (ownerId) await q.query(`INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`, [conv!.id, ownerId]);
      return conv!.id;
    });
    if (ownerId) {
      const conversation = await this.chat.summaryFor(ownerId, id);
      this.rt.emit([ownerId], { type: 'conversation.created', data: { conversation } });
    }
    return ownerId ? this.get(ownerId, id) : { id };
  }

  private mapRoom(r: any) {
    return {
      id: r.conversation_id,
      kind: r.kind,
      title: r.title,
      intro: r.intro,
      tags: r.tags,
      regionId: r.region_id,
      regionName: r.region_name ?? null,
      memberCount: r.member_count,
      capacity: r.capacity,
      isPrivate: r.is_private,
      requireApproval: r.require_approval,
      searchable: r.searchable,
      imageMediaId: r.image_media_id,
      closed: r.status !== 'open',
      lastActivityAt: new Date(r.last_message_at).toISOString(),
      myRole: r.my_role ?? null,
      pendingRequest: !!r.pending,
    };
  }

  private readonly SELECT = `
    SELECT r.*, c.last_message_at, rg.name AS region_name,
           (SELECT cp.role FROM conversation_participants cp WHERE cp.conversation_id = r.conversation_id AND cp.user_id = $1 AND cp.left_at IS NULL) AS my_role,
           EXISTS (SELECT 1 FROM room_join_requests j WHERE j.conversation_id = r.conversation_id AND j.user_id = $1 AND j.status = 'pending') AS pending
      FROM rooms r JOIN conversations c ON c.id = r.conversation_id LEFT JOIN regions rg ON rg.id = r.region_id`;

  async list(userId: string, qy: any) {
    const params: unknown[] = [userId];
    const where: string[] = [];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (qy.mine === 'true' || qy.mine === true) {
      where.push(`EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = r.conversation_id AND cp.user_id = $1 AND cp.left_at IS NULL)`);
    } else {
      where.push(`r.status = 'open' AND r.searchable AND NOT r.is_private`);
      if (qy.regionId) where.push(`r.region_id = ${add(String(qy.regionId))}`);
      if (qy.sido) where.push(`rg.sido = ${add(String(qy.sido))}`);
      if (qy.kind === 'region' || qy.kind === 'interest') where.push(`r.kind = ${add(qy.kind)}`);
      if (qy.tag) where.push(`${add(String(qy.tag).replace(/^#/, ''))} = ANY(r.tags)`);
      if (typeof qy.q === 'string' && qy.q.trim()) {
        const k = add(`%${qy.q.trim().replace(/[%_\\]/g, '\\$&')}%`);
        where.push(`(r.title ILIKE ${k} OR rg.name ILIKE ${k} OR EXISTS (SELECT 1 FROM unnest(r.tags) t WHERE t ILIKE ${k}))`);
      }
    }
    const rows = await this.db.query<any>(`${this.SELECT} WHERE ${where.join(' AND ')} ORDER BY (r.kind = 'region') DESC, c.last_message_at DESC LIMIT 100`, params);
    return { items: rows.map((r) => this.mapRoom(r)) };
  }

  async get(userId: string, id: string) {
    const r = await this.db.one<any>(`${this.SELECT} WHERE r.conversation_id = $2`, [userId, id]);
    if (!r) throw notFound('방을 찾을 수 없습니다.');
    const staff = r.my_role === 'owner' || r.my_role === 'manager';
    if (r.is_private && !r.my_role) return { ...this.mapRoom(r), intro: '', notice: null, inviteCode: null, pendingRequests: 0 };
    const notice = r.pinned_message_id ? await this.db.one<any>('SELECT id, body FROM messages WHERE id = $1 AND hidden_at IS NULL', [r.pinned_message_id]) : null;
    const pending = staff ? Number((await this.db.one<any>(`SELECT count(*) AS n FROM room_join_requests WHERE conversation_id = $1 AND status = 'pending'`, [id])).n) : 0;
    return { ...this.mapRoom(r), notice: notice ? { messageId: notice.id, body: notice.body } : null, inviteCode: staff ? r.invite_code : null, pendingRequests: pending };
  }

  private async system(q: Q, roomId: string, actorId: string, text: string): Promise<MessageDto> {
    return (await appendMessage(q, roomId, actorId, `sys-${randomUUID()}`, { kind: 'system', body: text })).message;
  }

  /**
   * 입장 처리. 방 행을 잠근 뒤 "정원 미만일 때만 인원 +1"을 한 문장으로 실행하므로
   * 마지막 한 자리에 여러 명이 동시에 들어와도 정원을 넘지 않는다.
   */
  private async addMember(q: Q, roomId: string, userId: string): Promise<MessageDto> {
    const ok = await q.one(`UPDATE rooms SET member_count = member_count + 1 WHERE conversation_id = $1 AND member_count < capacity AND status = 'open' RETURNING 1`, [roomId]);
    if (!ok) throw conflict('ROOM_FULL', '정원이 가득 찼습니다.');
    await q.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role, last_read_seq)
       VALUES ($1, $2, 'member', (SELECT last_seq FROM conversations WHERE id = $1))
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'member', joined_at = now(), last_read_seq = EXCLUDED.last_read_seq`,
      [roomId, userId],
    );
    const nick = (await q.one<{ nickname: string }>('SELECT nickname FROM profiles WHERE user_id = $1', [userId]))?.nickname ?? '새 회원';
    return this.system(q, roomId, userId, `${nick} 님이 들어왔습니다.`);
  }

  private async afterJoin(roomId: string, userId: string, sys: MessageDto) {
    const conversation = await this.chat.summaryFor(userId, roomId);
    this.rt.emit([userId], { type: 'conversation.created', data: { conversation } });
    await this.chat.fanOut(roomId, sys, { push: false });
  }

  async join(userId: string, roomId: string, body: any) {
    const out = await this.db.tx(async (q) => {
      const r = await q.one<any>('SELECT * FROM rooms WHERE conversation_id = $1 FOR UPDATE', [roomId]);
      if (!r || r.status !== 'open') throw notFound('방을 찾을 수 없습니다.');
      if (await q.one('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL', [roomId, userId])) return { status: 'joined' as const, sys: null };
      if (await q.one('SELECT 1 FROM room_bans WHERE conversation_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())', [roomId, userId])) {
        throw forbidden('ROOM_BANNED', '이 방에는 다시 들어갈 수 없습니다.');
      }
      if (r.is_private && String(body?.inviteCode || '') !== r.invite_code) throw forbidden('INVITE_REQUIRED', '초대 코드가 필요한 비밀방입니다.');
      if (r.require_approval) {
        if (r.member_count >= r.capacity) throw conflict('ROOM_FULL', '정원이 가득 찼습니다.');
        await q.query(`INSERT INTO room_join_requests (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [roomId, userId]);
        return { status: 'requested' as const, sys: null };
      }
      return { status: 'joined' as const, sys: await this.addMember(q, roomId, userId) };
    });
    if (out.sys) await this.afterJoin(roomId, userId, out.sys);
    if (out.status === 'requested') {
      const staff = await this.db.query<{ user_id: string }>(`SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND role IN ('owner','manager') AND left_at IS NULL`, [roomId]);
      this.rt.emit(staff.map((s) => s.user_id), { type: 'room.request', data: { roomId } });
    }
    return { status: out.status };
  }

  private async role(q: Q, roomId: string, userId: string): Promise<string | null> {
    return (await q.one<{ role: string }>('SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL', [roomId, userId]))?.role ?? null;
  }
  private async requireStaff(q: Q, roomId: string, userId: string) {
    const role = await this.role(q, roomId, userId);
    if (role !== 'owner' && role !== 'manager') throw forbidden('NOT_STAFF', '방장·운영진만 할 수 있습니다.');
    return role;
  }
  private async requireOwner(q: Q, roomId: string, userId: string) {
    if ((await this.role(q, roomId, userId)) !== 'owner') throw forbidden('NOT_OWNER', '방장만 할 수 있습니다.');
  }

  async requests(userId: string, roomId: string) {
    await this.requireStaff(this.db, roomId, userId);
    const rows = await this.db.query<any>(
      `SELECT j.id, j.user_id, j.created_at, p.nickname, p.age_band, p.avatar_color FROM room_join_requests j JOIN profiles p ON p.user_id = j.user_id
        WHERE j.conversation_id = $1 AND j.status = 'pending' ORDER BY j.created_at`,
      [roomId],
    );
    return { items: rows.map((r) => ({ id: r.id, userId: r.user_id, nickname: r.nickname, ageBand: r.age_band, avatarColor: r.avatar_color, createdAt: new Date(r.created_at).toISOString() })) };
  }

  async decide(userId: string, roomId: string, requestId: string, approve: boolean) {
    const out = await this.db.tx(async (q) => {
      await this.requireStaff(q, roomId, userId);
      await q.query('SELECT 1 FROM rooms WHERE conversation_id = $1 FOR UPDATE', [roomId]);
      const j = await q.one<any>(`SELECT * FROM room_join_requests WHERE id = $1 AND conversation_id = $2 AND status = 'pending' FOR UPDATE`, [requestId, roomId]);
      if (!j) throw notFound('가입 신청을 찾을 수 없습니다.');
      const sys = approve ? await this.addMember(q, roomId, j.user_id) : null;
      await q.query(`UPDATE room_join_requests SET status = $2, decided_at = now() WHERE id = $1`, [requestId, approve ? 'approved' : 'rejected']);
      return { targetId: j.user_id as string, sys };
    });
    if (out.sys) await this.afterJoin(roomId, out.targetId, out.sys);
    return { ok: true };
  }

  async members(userId: string, roomId: string) {
    if (!(await this.role(this.db, roomId, userId))) throw notFound('방을 찾을 수 없습니다.');
    const rows = await this.db.query<any>(
      `SELECT cp.user_id, cp.role, p.nickname, p.avatar_color, p.photo_media_id FROM conversation_participants cp JOIN profiles p ON p.user_id = cp.user_id
        WHERE cp.conversation_id = $1 AND cp.left_at IS NULL
        ORDER BY CASE cp.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, cp.joined_at LIMIT 1000`,
      [roomId],
    );
    return { items: rows.map((r) => ({ userId: r.user_id, role: r.role, nickname: r.nickname, avatarColor: r.avatar_color, photoMediaId: r.photo_media_id })) };
  }

  private async removeMember(q: Q, roomId: string, userId: string) {
    await q.query('UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2', [roomId, userId]);
    await q.query('UPDATE rooms SET member_count = GREATEST(member_count - 1, 0) WHERE conversation_id = $1', [roomId]);
  }

  /** 나가기. 방장은 권한을 넘기거나(transferTo) 방을 종료(close)해야 한다. */
  async leave(userId: string, roomId: string, body: any) {
    const out = await this.db.tx(async (q) => {
      const r = await q.one<any>('SELECT * FROM rooms WHERE conversation_id = $1 FOR UPDATE', [roomId]);
      const role = await this.role(q, roomId, userId);
      if (!r || !role) throw notFound('방을 찾을 수 없습니다.');
      const nick = (await q.one<{ nickname: string }>('SELECT nickname FROM profiles WHERE user_id = $1', [userId]))?.nickname ?? '';
      if (role === 'owner') {
        const others = r.member_count - 1;
        if (others > 0 && body?.close !== true) {
          const to = isUuid(body?.transferTo) ? body.transferTo : null;
          if (!to || !(await this.role(q, roomId, to)) || to === userId) {
            throw conflict('OWNER_MUST_CHOOSE', '방장은 나가기 전에 방장을 넘기거나 방을 종료해야 합니다.');
          }
          await q.query(`UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`, [roomId, to]);
          await q.query('UPDATE rooms SET owner_id = $2 WHERE conversation_id = $1', [roomId, to]);
        } else {
          const sys = await this.system(q, roomId, userId, '방장이 방을 종료했습니다.');
          await q.query(`UPDATE rooms SET status = 'closed' WHERE conversation_id = $1`, [roomId]);
          await this.removeMember(q, roomId, userId);
          return { sys, closed: true };
        }
      }
      const sys = await this.system(q, roomId, userId, `${nick} 님이 나갔습니다.`);
      await this.removeMember(q, roomId, userId);
      return { sys, closed: false };
    });
    await this.chat.fanOut(roomId, out.sys, { push: false });
    this.rt.emit([userId], { type: 'conversation.removed', data: { conversationId: roomId } });
    return { ok: true, closed: out.closed };
  }

  /** 강퇴. banDays: 0 = 재가입 제한 없음, 숫자 = 그 기간 동안 제한, null = 무기한 제한 */
  async kick(userId: string, roomId: string, targetId: string, body: any) {
    const sys = await this.db.tx(async (q) => {
      await q.query('SELECT 1 FROM rooms WHERE conversation_id = $1 FOR UPDATE', [roomId]);
      const actor = await this.requireStaff(q, roomId, userId);
      const target = await this.role(q, roomId, targetId);
      if (!target || targetId === userId) throw notFound('대상 회원을 찾을 수 없습니다.');
      if (target === 'owner' || (target === 'manager' && actor !== 'owner')) throw forbidden('NOT_ALLOWED', '이 회원은 내보낼 수 없습니다.');
      const nick = (await q.one<{ nickname: string }>('SELECT nickname FROM profiles WHERE user_id = $1', [targetId]))?.nickname ?? '';
      const days = body?.banDays === null || body?.banDays === undefined ? null : Math.max(0, Math.trunc(Number(body.banDays) || 0));
      if (days !== 0) {
        await q.query(
          `INSERT INTO room_bans (conversation_id, user_id, until, created_by) VALUES ($1, $2, ${days === null ? 'NULL' : `now() + interval '${days} days'`}, $3)
           ON CONFLICT (conversation_id, user_id) DO UPDATE SET until = EXCLUDED.until, created_by = EXCLUDED.created_by, created_at = now()`,
          [roomId, targetId, userId],
        );
      }
      const m = await this.system(q, roomId, userId, `${nick} 님이 방에서 내보내졌습니다.`);
      await this.removeMember(q, roomId, targetId);
      return m;
    });
    await this.chat.fanOut(roomId, sys, { push: false });
    this.rt.emit([targetId], { type: 'conversation.removed', data: { conversationId: roomId, reason: 'kicked' } });
    return { ok: true };
  }

  async unban(userId: string, roomId: string, targetId: string) {
    await this.requireStaff(this.db, roomId, userId);
    await this.db.query('DELETE FROM room_bans WHERE conversation_id = $1 AND user_id = $2', [roomId, targetId]);
    return { ok: true };
  }

  async setRole(userId: string, roomId: string, targetId: string, role: string) {
    if (!['manager', 'member', 'owner'].includes(role)) throw bad('INVALID_INPUT', '권한 값이 올바르지 않습니다.');
    await this.db.tx(async (q) => {
      await this.requireOwner(q, roomId, userId);
      if (!(await this.role(q, roomId, targetId)) || targetId === userId) throw notFound('대상 회원을 찾을 수 없습니다.');
      if (role === 'owner') {
        // 방장 위임: 기존 방장은 운영진으로 남는다.
        await q.query(`UPDATE conversation_participants SET role = 'manager' WHERE conversation_id = $1 AND user_id = $2`, [roomId, userId]);
        await q.query('UPDATE rooms SET owner_id = $2 WHERE conversation_id = $1', [roomId, targetId]);
      }
      await q.query('UPDATE conversation_participants SET role = $3 WHERE conversation_id = $1 AND user_id = $2', [roomId, targetId, role]);
    });
    this.rt.emit([targetId, userId], { type: 'room.updated', data: { roomId } });
    return { ok: true };
  }

  async pin(userId: string, roomId: string, messageId: string | null) {
    await this.requireStaff(this.db, roomId, userId);
    if (messageId && !(await this.db.one(`SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND kind = 'text'`, [messageId, roomId]))) {
      throw notFound('공지로 고정할 메시지를 찾을 수 없습니다.');
    }
    await this.db.query('UPDATE rooms SET pinned_message_id = $2 WHERE conversation_id = $1', [roomId, messageId]);
    const members = await this.db.query<{ user_id: string }>('SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL', [roomId]);
    this.rt.emit(members.map((m) => m.user_id), { type: 'room.updated', data: { roomId } });
    return { ok: true };
  }

  async update(userId: string, roomId: string, body: any) {
    const p = this.parse(body, true);
    await this.db.tx(async (q) => {
      const r = await q.one<any>('SELECT * FROM rooms WHERE conversation_id = $1 FOR UPDATE', [roomId]);
      await this.requireOwner(q, roomId, userId);
      if (p.capacity !== undefined) {
        // 무료 한도 또는 이미 확장해 둔 정원 안에서만 조정할 수 있다. 그 이상은 expand(유료).
        const ceiling = Math.max(FREE_MAX_CAPACITY, r.capacity);
        if (!(p.capacity >= Math.max(2, r.member_count) && p.capacity <= ceiling)) throw bad('INVALID_CAPACITY', `정원은 현재 인원 이상 ${ceiling}명 이하로 정해 주세요.`);
      }
      if (p.imageMediaId) await this.media.assertOwned(q, userId, [p.imageMediaId], 'room');
      const isPrivate = p.isPrivate ?? r.is_private;
      await q.query(
        `UPDATE rooms SET title = $2, intro = $3, tags = $4, capacity = $5, searchable = $6, is_private = $7, require_approval = $8, image_media_id = $9, region_id = $10,
                invite_code = CASE WHEN $7 THEN COALESCE(invite_code, $11) ELSE NULL END
          WHERE conversation_id = $1`,
        [roomId, p.title ?? r.title, p.intro ?? r.intro, p.tags ?? r.tags, p.capacity ?? r.capacity, isPrivate ? false : (p.searchable ?? r.searchable), isPrivate,
          p.requireApproval ?? r.require_approval, p.imageMediaId === undefined ? r.image_media_id : p.imageMediaId, p.regionId === undefined ? r.region_id : p.regionId, randomBytes(5).toString('hex')],
      );
    });
    return this.get(userId, roomId);
  }

  async expandQuote(userId: string) {
    return { step: EXPAND_STEP, max: HARD_MAX_CAPACITY, ...(await this.points.quote(this.db, userId, 'room_expand', 1)) };
  }

  /** 정원 확장(유료): 차감과 정원 변경이 한 트랜잭션이라 어느 한쪽만 반영되는 일이 없다. */
  async expand(userId: string, roomId: string) {
    const out = await this.db.tx(async (q) => {
      const r = await q.one<any>('SELECT * FROM rooms WHERE conversation_id = $1 FOR UPDATE', [roomId]);
      await this.requireOwner(q, roomId, userId);
      if (r.capacity + EXPAND_STEP > HARD_MAX_CAPACITY) throw bad('INVALID_CAPACITY', `정원은 최대 ${HARD_MAX_CAPACITY}명입니다.`);
      const charged = await this.points.charge(q, userId, 'room_expand', 1, { type: 'room', id: roomId });
      await q.query('UPDATE rooms SET capacity = capacity + $2 WHERE conversation_id = $1', [roomId, EXPAND_STEP]);
      return { capacity: r.capacity + EXPAND_STEP, ...charged };
    });
    return out;
  }
}
