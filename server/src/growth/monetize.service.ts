import { Inject, Injectable } from '@nestjs/common';
import { bad, forbidden, notFound, tooMany } from '../common/errors';
import { Db, Q } from '../db/db';
import { appendMessage, ChatService } from '../chat/chat.service';
import { PointsService } from '../points/points.service';
import { selectPublicProfiles } from '../profile/public-profile';
import { PushService } from '../push/push.service';
import { GrowthService } from './growth.service';

const BOOST_MINUTES = 30;
const kstDay = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const kstHour = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).getUTCHours();

/**
 * 수익·재방문 기능.
 * - 프로필 부스트: 포인트로 30분 동안 주변 사람 목록 맨 위에 노출
 * - 포인트 선물: 1대1 대화 상대에게 포인트를 보낸다(현금화는 불가, 받은 사람은 앱 안에서만 사용)
 * - 나를 본 사람: 오늘·이번 주 방문자 수는 무료, 누가 봤는지는 포인트(또는 VIP)로 24시간 열람
 * - 오늘의 추천 친구: 매일 정해진 시각에 같은 지역 회원 몇 명을 골라 알림
 * - 단체 알림: 관리자가 대상을 골라 휴대폰 알림 발송(광고성은 수신 동의자에게만, 야간 금지)
 */
@Injectable()
export class MonetizeService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(PushService) private readonly push: PushService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(GrowthService) private readonly growth: GrowthService,
  ) {}

  // ── 프로필 부스트 ──

  async boostStatus(userId: string) {
    const p = await this.db.one<{ boost_until: Date | null; show_in_nearby: boolean }>('SELECT boost_until, show_in_nearby FROM profiles WHERE user_id = $1', [userId]);
    const quote = await this.points.quote(this.db, userId, 'profile_boost', 1);
    const active = !!p?.boost_until && new Date(p.boost_until) > new Date();
    return { minutes: BOOST_MINUTES, boostUntil: active ? new Date(p!.boost_until!).toISOString() : null, visible: p?.show_in_nearby ?? false, ...quote };
  }

  async boost(userId: string) {
    const out = await this.db.tx(async (q) => {
      const p = await q.one<{ show_in_nearby: boolean }>('SELECT show_in_nearby FROM profiles WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!p?.show_in_nearby) throw bad('HIDDEN_PROFILE', '"주변 사람에 내 프로필 표시"가 꺼져 있어요. 켜야 부스트할 수 있습니다.');
      const charged = await this.points.charge(q, userId, 'profile_boost', 1, { type: 'boost', id: userId });
      const r = await q.one<{ boost_until: Date }>(
        `UPDATE profiles SET boost_until = GREATEST(coalesce(boost_until, now()), now()) + make_interval(mins => $2)
          WHERE user_id = $1 RETURNING boost_until`,
        [userId, BOOST_MINUTES],
      );
      return { boostUntil: new Date(r!.boost_until).toISOString(), cost: charged.cost, balance: charged.balance };
    });
    return out;
  }

  // ── 포인트 선물 ──

  async gift(userId: string, conversationId: string, body: any) {
    const s = await this.growth.settings();
    const pts = Math.trunc(Number(body?.points));
    if (!Number.isFinite(pts) || pts < s.giftMin || pts > s.giftMax) throw bad('INVALID_GIFT', `선물은 ${s.giftMin}~${s.giftMax}P 사이로 보낼 수 있어요.`);
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 60) : '';
    const clientMsgId = typeof body?.clientMsgId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.clientMsgId) ? body.clientMsgId : `gift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { message, duplicate, peerId } = await this.db.tx(async (q) => {
      const c = await q.one<{ peer_id: string }>(
        `SELECT other.user_id AS peer_id FROM conversations c
           JOIN conversation_participants me ON me.conversation_id = c.id AND me.user_id = $1
           JOIN conversation_participants other ON other.conversation_id = c.id AND other.user_id <> $1
          WHERE c.id = $2 AND c.type = 'direct'`,
        [userId, conversationId],
      );
      if (!c) throw notFound('선물은 1대1 대화에서만 보낼 수 있어요.');
      const ok = await q.one(
        `SELECT 1 FROM users u WHERE u.id = $2 AND u.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1))`,
        [userId, c.peer_id],
      );
      if (!ok) throw forbidden('CANNOT_SEND', '선물을 보낼 수 없는 상대입니다.');
      const today = await q.one<{ n: number }>(
        `SELECT coalesce(sum(points), 0)::int AS n FROM gifts WHERE sender_id = $1 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`,
        [userId],
      );
      if ((today?.n ?? 0) + pts > s.giftDailyMax) throw tooMany(`선물은 하루 ${s.giftDailyMax}P까지 보낼 수 있어요.`);
      const g = await q.one<{ id: string }>('INSERT INTO gifts (sender_id, receiver_id, conversation_id, points) VALUES ($1, $2, $3, $4) RETURNING id', [userId, c.peer_id, conversationId, pts]);
      await this.points.apply(q, userId, -pts, 'spend', '포인트 선물 보냄', { type: 'gift', id: String(g!.id), idemKey: `gift-out:${g!.id}` });
      await this.points.apply(q, c.peer_id, pts, 'grant', '포인트 선물 받음', { type: 'gift', id: String(g!.id), idemKey: `gift-in:${g!.id}` });
      const m = await appendMessage(q, conversationId, userId, clientMsgId, { kind: 'gift', body: `${pts}P를 선물했어요${note ? `\n${note}` : ''}`, meta: { points: pts } });
      return { ...m, peerId: c.peer_id };
    });
    if (!duplicate) await this.chat.fanOut(conversationId, message);
    return { message, balance: await this.points.balance(this.db, userId), peerId };
  }

  // ── 나를 본 사람 ──

  async visitors(userId: string) {
    const counts = await this.db.one<{ today: number; week: number }>(
      `SELECT count(DISTINCT viewer_id) FILTER (WHERE day = (now() AT TIME ZONE 'Asia/Seoul')::date)::int AS today,
              count(DISTINCT viewer_id)::int AS week
         FROM profile_views v JOIN users u ON u.id = v.viewer_id AND u.status = 'active'
        WHERE v.viewed_id = $1 AND v.day > (now() AT TIME ZONE 'Asia/Seoul')::date - 7
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = v.viewer_id) OR (b.blocker_id = v.viewer_id AND b.blocked_id = $1))`,
      [userId],
    );
    const me = await this.db.one<{ leave_footprints: boolean }>('SELECT leave_footprints FROM profiles WHERE user_id = $1', [userId]);
    const premium = await this.points.isPremium(this.db, userId);
    const u = await this.db.one<{ until: Date }>('SELECT until FROM visitor_unlocks WHERE user_id = $1 AND until > now()', [userId]);
    const unlocked = premium || !!u;
    const quote = await this.points.quote(this.db, userId, 'visitor_unlock', 1, { freeForPremium: true });
    let items: any[] = [];
    if (unlocked) {
      const rows = await this.db.query<{ viewer_id: string; at: Date }>(
        `SELECT viewer_id, max(at) AS at FROM profile_views
          WHERE viewed_id = $1 AND day > (now() AT TIME ZONE 'Asia/Seoul')::date - 7
          GROUP BY viewer_id ORDER BY max(at) DESC LIMIT 50`,
        [userId],
      );
      for (const r of rows) {
        const [p] = await selectPublicProfiles(this.db, { viewerId: userId, onlyUserId: r.viewer_id, limit: 1 });
        if (p) items.push({ profile: p, viewedAt: new Date(r.at).toISOString() });
      }
    }
    return {
      today: counts?.today ?? 0,
      week: counts?.week ?? 0,
      unlocked,
      vip: premium,
      unlockUntil: u ? new Date(u.until).toISOString() : null,
      leaveFootprints: me?.leave_footprints ?? true,
      price: quote.unitPrice,
      balance: quote.balance,
      items,
    };
  }

  async unlockVisitors(userId: string) {
    await this.db.tx(async (q) => {
      const me = await q.one<{ leave_footprints: boolean }>('SELECT leave_footprints FROM profiles WHERE user_id = $1', [userId]);
      if (!me?.leave_footprints) throw bad('FOOTPRINTS_OFF', '"내 방문 기록 남기기"를 켜야 나를 본 사람을 볼 수 있어요.');
      if (await this.points.isPremium(q, userId)) return;
      await this.points.charge(q, userId, 'visitor_unlock', 1, { type: 'visitor_unlock', id: userId });
      await q.query(
        `INSERT INTO visitor_unlocks (user_id, until) VALUES ($1, now() + interval '24 hours')
         ON CONFLICT (user_id) DO UPDATE SET until = GREATEST(visitor_unlocks.until, now()) + interval '24 hours'`,
        [userId],
      );
    });
    return this.visitors(userId);
  }

  // ── 오늘의 추천 친구 ──

  private async generatePicks(q: Q, userId: string, count: number): Promise<string[]> {
    const rows = await q.query<{ user_id: string }>(
      `SELECT p.user_id FROM profiles p
         JOIN users u ON u.id = p.user_id AND u.status = 'active'
         JOIN profiles me ON me.user_id = $1
        WHERE p.user_id <> $1 AND p.show_in_nearby AND p.accept_greetings
          AND (p.region_id = me.region_id OR EXISTS (SELECT 1 FROM regions a, regions b WHERE a.id = p.region_id AND b.id = me.region_id AND a.sido = b.sido))
          AND p.last_active_at > now() - interval '14 days'
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = p.user_id) OR (b.blocker_id = p.user_id AND b.blocked_id = $1))
          AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.type = 'direct' AND c.user_low = LEAST($1, p.user_id) AND c.user_high = GREATEST($1, p.user_id))
          AND NOT EXISTS (SELECT 1 FROM greeting_requests g WHERE (g.sender_id = $1 AND g.receiver_id = p.user_id) OR (g.sender_id = p.user_id AND g.receiver_id = $1))
          AND NOT EXISTS (SELECT 1 FROM daily_picks d WHERE d.user_id = $1 AND d.day > (now() AT TIME ZONE 'Asia/Seoul')::date - 7 AND p.user_id = ANY(d.picks))
        ORDER BY (p.region_id = me.region_id) DESC, (p.age_band = me.age_band) DESC,
                 EXISTS (SELECT 1 FROM profile_interests a JOIN profile_interests b ON b.interest_id = a.interest_id WHERE a.user_id = $1 AND b.user_id = p.user_id) DESC,
                 random()
        LIMIT $2`,
      [userId, count],
    );
    const ids = rows.map((r) => r.user_id);
    await q.query(
      `INSERT INTO daily_picks (user_id, day, picks) VALUES ($1, (now() AT TIME ZONE 'Asia/Seoul')::date, $2::uuid[])
       ON CONFLICT (user_id, day) DO NOTHING`,
      [userId, ids],
    );
    return ids;
  }

  async todayPicks(userId: string) {
    const s = await this.growth.settings();
    if (!s.recommendEnabled) return { enabled: false, items: [] };
    let row = await this.db.one<{ picks: string[] }>(`SELECT picks FROM daily_picks WHERE user_id = $1 AND day = (now() AT TIME ZONE 'Asia/Seoul')::date`, [userId]);
    const ids = row ? row.picks : await this.generatePicks(this.db, userId, s.recommendCount);
    const items = [];
    for (const id of ids) {
      const [p] = await selectPublicProfiles(this.db, { viewerId: userId, onlyUserId: id, requireVisible: true, limit: 1 });
      if (p) items.push(p);
    }
    return { enabled: true, items };
  }

  /** 하루 한 번, 추천 시각이 지나면 최근 활동 회원에게 추천을 만들어 알린다. */
  async runDailyPicks(force = false): Promise<number> {
    const s = await this.growth.settings();
    if (!s.recommendEnabled) return 0;
    if (!force && kstHour() < s.recommendHour) return 0;
    const claim = await this.db.one(`INSERT INTO job_runs (name, day) VALUES ('daily_picks', $1::date) ON CONFLICT DO NOTHING RETURNING day`, [kstDay()]);
    if (!claim) return 0;
    const users = await this.db.query<{ user_id: string }>(
      `SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id AND u.status = 'active'
        WHERE p.last_active_at > now() - interval '30 days'`,
    );
    let sent = 0;
    for (const u of users) {
      try {
        const existing = await this.db.one<{ picks: string[]; pushed: boolean }>(`SELECT picks, pushed FROM daily_picks WHERE user_id = $1 AND day = $2::date`, [u.user_id, kstDay()]);
        const ids = existing ? existing.picks : await this.generatePicks(this.db, u.user_id, s.recommendCount);
        if (!ids.length || existing?.pushed) continue;
        await this.db.query(`UPDATE daily_picks SET pushed = true WHERE user_id = $1 AND day = $2::date`, [u.user_id, kstDay()]);
        await this.push.send([
          { userId: u.user_id, kind: 'recommend', title: '오늘의 추천 친구가 도착했어요', body: `우리 동네에서 ${ids.length}명을 골라 봤어요. 인사를 건네 보세요.`, privateBody: '오늘의 추천 친구가 도착했어요.', data: { kind: 'recommend' } },
        ]);
        sent++;
      } catch {
        // 한 회원의 실패가 전체를 멈추지 않게 한다.
      }
    }
    return sent;
  }

  // ── 관리자 단체 알림 ──

  private audience(target: any, advertising: boolean) {
    const where = [`u.status = 'active'`];
    const params: unknown[] = [];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const segment = ['all', 'vip', 'active', 'inactive'].includes(target?.segment) ? target.segment : 'all';
    const days = Math.min(365, Math.max(1, Math.trunc(Number(target?.days) || 7)));
    if (segment === 'vip') where.push(`EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' AND s.expires_at > now())`);
    if (segment === 'active') where.push(`p.last_active_at > now() - make_interval(days => ${add(days)})`);
    if (segment === 'inactive') where.push(`(p.last_active_at IS NULL OR p.last_active_at <= now() - make_interval(days => ${add(days)}))`);
    if (typeof target?.sido === 'string' && target.sido) where.push(`r.sido = ${add(target.sido)}`);
    // 광고성 정보: 수신 동의한 회원에게만(정보통신망법 제50조)
    if (advertising) where.push(`coalesce((p.notify->>'marketing')::boolean, false) AND coalesce((p.notify->>'all')::boolean, true)`);
    return {
      sql: `FROM users u JOIN profiles p ON p.user_id = u.id JOIN regions r ON r.id = p.region_id WHERE ${where.join(' AND ')}`,
      params,
      normalized: { segment, days, sido: typeof target?.sido === 'string' ? target.sido : '' },
    };
  }

  async campaignPreview(body: any) {
    const advertising = body?.advertising !== false;
    const a = this.audience(body?.target, advertising);
    const r = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n ${a.sql}`, a.params);
    const sidos = await this.db.query<{ sido: string }>('SELECT DISTINCT sido FROM regions ORDER BY sido');
    return { count: r?.n ?? 0, nightBlocked: advertising && this.isNight(), sidos: sidos.map((x) => x.sido) };
  }

  private isNight() {
    const h = kstHour();
    return h >= 21 || h < 8;
  }

  async campaignSend(adminId: string, body: any) {
    const advertising = body?.advertising !== false;
    const title = String(body?.title ?? '').trim();
    const text = String(body?.body ?? '').trim();
    if (title.length < 2 || title.length > 60) throw bad('INVALID_INPUT', '제목은 2~60자로 입력해 주세요.');
    if (text.length < 2 || text.length > 200) throw bad('INVALID_INPUT', '내용은 2~200자로 입력해 주세요.');
    if (advertising && this.isNight()) throw bad('NIGHT_BLOCKED', '광고성 알림은 오후 9시부터 오전 8시까지 보낼 수 없습니다(정보통신망법).');
    const a = this.audience(body?.target, advertising);
    const finalTitle = advertising && !title.startsWith('(광고)') ? `(광고) ${title}` : title;
    const finalBody = advertising ? `${text}\n수신거부: 앱 내 정보 → 알림 설정` : text;
    const c = await this.db.one<{ id: string }>(
      'INSERT INTO push_campaigns (title, body, advertising, target, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [finalTitle, finalBody, advertising, JSON.stringify(a.normalized), adminId],
    );
    let sent = 0;
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const users = await this.db.query<{ id: string }>(`SELECT u.id ${a.sql} AND u.id > $${a.params.length + 1} ORDER BY u.id LIMIT 500`, [...a.params, after]);
      if (!users.length) break;
      after = users[users.length - 1].id;
      await this.push
        .send(
          users.map((x) => ({
            userId: x.id,
            kind: (advertising ? 'marketing' : 'notice') as 'marketing' | 'notice',
            title: finalTitle,
            body: finalBody,
            privateBody: advertising ? '(광고) 새 소식이 있어요.' : '새 운영 알림이 있습니다.',
            data: { kind: 'notice', campaignId: c!.id },
          })),
        )
        .catch(() => undefined);
      sent += users.length;
    }
    await this.db.query('UPDATE push_campaigns SET sent = $2 WHERE id = $1', [c!.id, sent]);
    return { id: c!.id, sent };
  }

  async campaigns() {
    const rows = await this.db.query<any>(
      `SELECT c.*, a.name AS admin_name FROM push_campaigns c LEFT JOIN admins a ON a.id = c.created_by ORDER BY c.created_at DESC LIMIT 100`,
    );
    return {
      items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, advertising: r.advertising, target: r.target, sent: r.sent, adminName: r.admin_name, createdAt: new Date(r.created_at).toISOString() })),
    };
  }
}
