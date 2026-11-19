import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { AppConfig, CONFIG } from '../config';
import { bad, conflict, notFound } from '../common/errors';
import { Db, Q } from '../db/db';
import { PointsService } from '../points/points.service';
import { PushService } from '../push/push.service';

export interface GrowthSettings {
  inviteEnabled: boolean;
  inviteeReward: number;
  inviterReward: number;
  inviterMonthlyCap: number;
  redeemWindowDays: number;
  attendanceEnabled: boolean;
  attendancePoints: number;
  streakDays: number;
  streakBonus: number;
  vipDiscountPercent: number;
  giftMin: number;
  giftMax: number;
  giftDailyMax: number;
  recommendEnabled: boolean;
  recommendCount: number;
  recommendHour: number;
}

export const GROWTH_DEFAULTS: GrowthSettings = {
  inviteEnabled: true,
  inviteeReward: 50,
  inviterReward: 100,
  inviterMonthlyCap: 30,
  redeemWindowDays: 7,
  attendanceEnabled: true,
  attendancePoints: 5,
  streakDays: 7,
  streakBonus: 30,
  vipDiscountPercent: 30,
  giftMin: 10,
  giftMax: 1000,
  giftDailyMax: 3000,
  recommendEnabled: true,
  recommendCount: 3,
  recommendHour: 12,
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-Z0-9]{6}$/;
export const normalizeCode = (v: unknown) =>
  String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);

/** 한국 날짜(YYYY-MM-DD) */
const kstDay = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 성장 기능: 친구 초대 보상과 출석 체크.
 * - 초대받은 회원은 가입(또는 가입 후 며칠 안에 코드 입력) 즉시 보상.
 * - 초대한 회원은 초대받은 회원이 "다음 날 이후 다시 와서 출석"해야 보상(가짜 계정 남용 방지).
 *   같은 IP에서 만든 계정이거나 월 한도를 넘으면 보상하지 않는다.
 */
@Injectable()
export class GrowthService {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  async settings(q: Q = this.db): Promise<GrowthSettings> {
    const r = await q.one<{ value: Partial<GrowthSettings> }>('SELECT value FROM growth_settings WHERE id');
    return { ...GROWTH_DEFAULTS, ...(r?.value || {}) };
  }

  async updateSettings(patch: any): Promise<GrowthSettings> {
    const cur = await this.settings();
    const next: any = { ...cur };
    for (const k of ['inviteEnabled', 'attendanceEnabled', 'recommendEnabled'] as const) if (typeof patch?.[k] === 'boolean') next[k] = patch[k];
    const ints: [keyof GrowthSettings, number, number][] = [
      ['inviteeReward', 0, 10000],
      ['inviterReward', 0, 10000],
      ['inviterMonthlyCap', 0, 1000],
      ['redeemWindowDays', 0, 90],
      ['attendancePoints', 0, 1000],
      ['streakDays', 2, 60],
      ['streakBonus', 0, 10000],
      ['vipDiscountPercent', 0, 100],
      ['giftMin', 1, 100000],
      ['giftMax', 1, 100000],
      ['giftDailyMax', 1, 1000000],
      ['recommendCount', 1, 10],
      ['recommendHour', 7, 21],
    ];
    for (const [k, min, max] of ints) {
      if (patch?.[k] === undefined) continue;
      const n = Number(patch[k]);
      if (!Number.isInteger(n) || n < min || n > max) throw bad('INVALID_INPUT', `${k} 값은 ${min}~${max} 사이 정수여야 합니다.`);
      next[k] = n;
    }
    if (next.giftMin > next.giftMax) throw bad('INVALID_INPUT', '선물 최소 포인트가 최대보다 클 수 없습니다.');
    await this.db.query('INSERT INTO growth_settings (id, value) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value', [JSON.stringify(next)]);
    return next;
  }

  /** 가입 직후 회원 초대 코드 발급(중복이면 다시 뽑는다). */
  async assignInviteCode(q: Q, userId: string): Promise<string> {
    for (let i = 0; i < 20; i++) {
      let c = '';
      for (let j = 0; j < 6; j++) c += ALPHABET[randomInt(ALPHABET.length)];
      const r = await q.one<{ invite_code: string }>(
        `UPDATE profiles SET invite_code = $2 WHERE user_id = $1 AND invite_code IS NULL
           AND NOT EXISTS (SELECT 1 FROM profiles WHERE invite_code = $2) RETURNING invite_code`,
        [userId, c],
      );
      if (r) return r.invite_code;
      const has = await q.one<{ invite_code: string | null }>('SELECT invite_code FROM profiles WHERE user_id = $1', [userId]);
      if (has?.invite_code) return has.invite_code;
    }
    throw new Error('invite code allocation failed');
  }

  private async myCode(userId: string): Promise<string> {
    const r = await this.db.one<{ invite_code: string | null }>('SELECT invite_code FROM profiles WHERE user_id = $1', [userId]);
    if (!r) throw notFound('회원을 찾을 수 없습니다.');
    return r.invite_code ?? (await this.db.tx((q) => this.assignInviteCode(q, userId)));
  }

  /** 가입 전 화면에서 코드가 맞는지 확인(공개). */
  async checkCode(raw: unknown) {
    const code = normalizeCode(raw);
    const s = await this.settings();
    if (!s.inviteEnabled || !CODE.test(code)) return { valid: false };
    const r = await this.db.one(`SELECT 1 FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.invite_code = $1 AND u.status = 'active'`, [code]);
    return r ? { valid: true, code, reward: s.inviteeReward } : { valid: false };
  }

  /**
   * 초대 코드 적용. 가입 트랜잭션 안에서(가입 시) 또는 가입 후 며칠 안에 따로 호출된다.
   * strict=false 이면 잘못된 코드를 조용히 무시한다(가입 자체는 막지 않음).
   */
  async redeem(q: Q, inviteeId: string, raw: unknown, ip: string | null, strict: boolean): Promise<{ reward: number } | null> {
    const s = await this.settings(q);
    const code = normalizeCode(raw);
    const fail = (c: string, m: string) => {
      if (strict) throw bad(c, m);
      return null;
    };
    if (!s.inviteEnabled) return fail('INVITE_DISABLED', '지금은 친구 초대 이벤트가 진행되지 않습니다.');
    if (!CODE.test(code)) return fail('INVALID_INVITE', '초대 코드를 다시 확인해 주세요.');
    const inviter = await q.one<{ user_id: string }>(
      `SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.invite_code = $1 AND u.status = 'active'`,
      [code],
    );
    if (!inviter) return fail('INVALID_INVITE', '초대 코드를 다시 확인해 주세요.');
    if (inviter.user_id === inviteeId) return fail('SELF_INVITE', '내 초대 코드는 입력할 수 없어요.');
    const me = await q.one<{ created_at: Date }>('SELECT created_at FROM users WHERE id = $1', [inviteeId]);
    if (strict && me && Date.now() - new Date(me.created_at).getTime() > s.redeemWindowDays * 86400_000) {
      throw bad('INVITE_EXPIRED', `초대 코드는 가입 후 ${s.redeemWindowDays}일 안에만 입력할 수 있어요.`);
    }
    // 서로 초대(A가 B를, B가 A를)는 막는다.
    if (await q.one('SELECT 1 FROM referrals WHERE inviter_id = $1 AND invitee_id = $2', [inviteeId, inviter.user_id])) {
      return fail('INVALID_INVITE', '나를 초대한 회원의 코드는 입력할 수 없어요.');
    }
    const ins = await q.one<{ id: string }>(
      `INSERT INTO referrals (inviter_id, invitee_id, code, invitee_ip, invitee_reward) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (invitee_id) DO NOTHING RETURNING id`,
      [inviter.user_id, inviteeId, code, ip, s.inviteeReward],
    );
    if (!ins) return fail('ALREADY_INVITED', '초대 코드는 한 번만 입력할 수 있어요.');
    if (s.inviteeReward > 0) {
      await this.points.apply(q, inviteeId, s.inviteeReward, 'grant', '친구 초대 가입 보상', { type: 'referral', id: String(ins.id), idemKey: `ref-invitee:${inviteeId}` });
    }
    return { reward: s.inviteeReward };
  }

  /** 초대받은 회원이 가입 다음 날 이후 다시 오면 초대한 회원에게 보상(출석 체크 때 호출). */
  private async settleReferral(q: Q, inviteeId: string, s: GrowthSettings): Promise<string | null> {
    const ref = await q.one<any>(
      `SELECT r.*, u.created_at AS invitee_created FROM referrals r JOIN users u ON u.id = r.invitee_id
        WHERE r.invitee_id = $1 AND r.status = 'pending' FOR UPDATE OF r`,
      [inviteeId],
    );
    if (!ref) return null;
    if (kstDay(new Date(ref.invitee_created)) >= kstDay()) return null; // 가입 당일은 아직
    let note: string | null = null;
    if (ref.invitee_ip && (await q.one(`SELECT 1 FROM access_logs WHERE user_id = $1 AND ip = $2 AND at > now() - interval '30 days'`, [ref.inviter_id, ref.invitee_ip]))) {
      note = '같은 IP에서 가입';
    } else {
      const month = await q.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM referrals WHERE inviter_id = $1 AND status = 'rewarded'
           AND rewarded_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
        [ref.inviter_id],
      );
      if ((month?.n ?? 0) >= s.inviterMonthlyCap) note = '이번 달 보상 한도 초과';
    }
    const inviterOk = await q.one(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [ref.inviter_id]);
    if (!inviterOk) note = note ?? '초대한 회원 이용 불가';
    if (note || s.inviterReward <= 0) {
      await q.query(`UPDATE referrals SET status = 'blocked', note = $2, rewarded_at = now() WHERE id = $1`, [ref.id, note ?? '보상 없음']);
      return null;
    }
    await this.points.apply(q, ref.inviter_id, s.inviterReward, 'grant', '친구 초대 보상', { type: 'referral', id: String(ref.id), idemKey: `ref-inviter:${ref.id}` });
    await q.query(`UPDATE referrals SET status = 'rewarded', inviter_reward = $2, rewarded_at = now() WHERE id = $1`, [ref.id, s.inviterReward]);
    return ref.inviter_id;
  }

  /** 내 초대 현황(앱의 친구 초대 화면). */
  async inviteOverview(userId: string) {
    const s = await this.settings();
    const code = await this.myCode(userId);
    const stats = await this.db.one<any>(
      `SELECT count(*)::int AS invited,
              count(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              coalesce(sum(inviter_reward), 0)::int AS earned
         FROM referrals WHERE inviter_id = $1`,
      [userId],
    );
    const mine = await this.db.one<any>('SELECT code, invitee_reward FROM referrals WHERE invitee_id = $1', [userId]);
    const me = await this.db.one<{ created_at: Date }>('SELECT created_at FROM users WHERE id = $1', [userId]);
    const canRedeem = s.inviteEnabled && !mine && !!me && Date.now() - new Date(me.created_at).getTime() <= s.redeemWindowDays * 86400_000;
    const link = `${this.cfg.publicUrl}/i/${code}`;
    const app = this.cfg.brand.appName;
    return {
      enabled: s.inviteEnabled,
      code,
      link,
      shareText:
        `${app}에서 우리 동네 사람들과 이야기해요.\n` +
        `가입할 때 초대 코드 ${code} 를 넣으면 ${s.inviteeReward}포인트를 드려요.\n${link}`,
      inviteeReward: s.inviteeReward,
      inviterReward: s.inviterReward,
      monthlyCap: s.inviterMonthlyCap,
      redeemWindowDays: s.redeemWindowDays,
      invited: stats?.invited ?? 0,
      rewarded: stats?.rewarded ?? 0,
      pending: stats?.pending ?? 0,
      earned: stats?.earned ?? 0,
      redeemedCode: mine?.code ?? null,
      canRedeem,
    };
  }

  async redeemLater(userId: string, raw: unknown, ip: string) {
    const r = await this.db.tx((q) => this.redeem(q, userId, raw, ip, true));
    return { ok: true, reward: r?.reward ?? 0, balance: await this.points.balance(this.db, userId) };
  }

  // ── 출석 체크 ─────────────────────────────────────────────────────────

  async attendanceStatus(userId: string) {
    const s = await this.settings();
    const today = kstDay();
    const rows = await this.db.query<{ day: string; streak: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, streak FROM attendance
        WHERE user_id = $1 AND day > (now() AT TIME ZONE 'Asia/Seoul')::date - 14 ORDER BY day DESC`,
      [userId],
    );
    const days = new Set(rows.map((r) => r.day));
    const last = rows[0];
    const yesterday = kstDay(new Date(Date.now() - 86400_000));
    const streak = last && (last.day === today || last.day === yesterday) ? last.streak : 0;
    const week: { day: string; done: boolean }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = kstDay(new Date(Date.now() - i * 86400_000));
      week.push({ day: d, done: days.has(d) });
    }
    return {
      enabled: s.attendanceEnabled,
      checkedToday: days.has(today),
      streak,
      week,
      points: s.attendancePoints,
      streakDays: s.streakDays,
      streakBonus: s.streakBonus,
      // 앞으로 몇 번 더 출석하면 연속 보너스를 받는지(오늘 출석 전이면 오늘 포함)
      daysToBonus: s.streakDays - (streak % s.streakDays),
      total: (await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM attendance WHERE user_id = $1', [userId]))?.n ?? 0,
    };
  }

  async checkIn(userId: string) {
    const s = await this.settings();
    if (!s.attendanceEnabled) throw bad('ATTENDANCE_DISABLED', '지금은 출석 체크 이벤트가 진행되지 않습니다.');
    const today = kstDay();
    const result = await this.db.tx(async (q) => {
      const prev = await q.one<{ streak: number }>(`SELECT streak FROM attendance WHERE user_id = $1 AND day = $2::date - 1`, [userId, today]);
      const streak = (prev?.streak ?? 0) + 1;
      const bonus = streak % s.streakDays === 0 ? s.streakBonus : 0;
      const pts = s.attendancePoints + bonus;
      const ins = await q.one('INSERT INTO attendance (user_id, day, streak, points) VALUES ($1, $2::date, $3, $4) ON CONFLICT DO NOTHING RETURNING day', [userId, today, streak, pts]);
      if (!ins) throw conflict('ALREADY_CHECKED', '오늘은 이미 출석했어요. 내일 또 만나요.');
      if (pts > 0) {
        await this.points.apply(q, userId, pts, 'grant', bonus ? `출석 체크 (${streak}일 연속 보너스)` : '출석 체크', {
          type: 'attendance',
          id: today,
          idemKey: `attend:${userId}:${today}`,
        });
      }
      const rewardedInviter = await this.settleReferral(q, userId, s);
      return { streak, points: pts, bonus, rewardedInviter };
    });
    if (result.rewardedInviter) {
      await this.push
        .send([{ userId: result.rewardedInviter, kind: 'notice', title: '친구 초대 보상 도착', body: `초대한 친구가 이음톡을 쓰기 시작했어요. ${s.inviterReward}포인트를 드렸어요.`, privateBody: '새 알림이 있습니다.', data: { kind: 'notice' } }])
        .catch(() => undefined);
    }
    return { ok: true, streak: result.streak, points: result.points, bonus: result.bonus, balance: await this.points.balance(this.db, userId), status: await this.attendanceStatus(userId) };
  }

  // ── 관리자: 마케팅 현황 ───────────────────────────────────────────────

  async adminStats(days: number) {
    const daily = await this.db.query<any>(
      `WITH d AS (SELECT generate_series((now() AT TIME ZONE 'Asia/Seoul')::date - ($1::int - 1), (now() AT TIME ZONE 'Asia/Seoul')::date, interval '1 day')::date AS day)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM users u WHERE (u.created_at AT TIME ZONE 'Asia/Seoul')::date = d.day)::int AS signups,
              (SELECT count(*) FROM referrals r WHERE (r.created_at AT TIME ZONE 'Asia/Seoul')::date = d.day)::int AS invited,
              (SELECT count(*) FROM attendance a WHERE a.day = d.day)::int AS attendance,
              (SELECT count(DISTINCT user_id) FROM access_logs l WHERE (l.at AT TIME ZONE 'Asia/Seoul')::date = d.day)::int AS active
         FROM d ORDER BY d.day DESC`,
      [days],
    );
    const totals = await this.db.one<any>(
      `SELECT (SELECT count(*) FROM users WHERE status <> 'deleted')::int AS members,
              (SELECT count(*) FROM referrals)::int AS referrals,
              (SELECT count(*) FROM referrals WHERE status = 'rewarded')::int AS rewarded,
              (SELECT count(*) FROM referrals WHERE status = 'blocked')::int AS blocked,
              (SELECT coalesce(sum(invitee_reward + inviter_reward), 0) FROM referrals)::int AS referral_points,
              (SELECT coalesce(sum(points), 0) FROM attendance)::int AS attendance_points`,
    );
    const top = await this.db.query<any>(
      `SELECT r.inviter_id AS "userId", p.nickname, count(*)::int AS invited,
              count(*) FILTER (WHERE r.status = 'rewarded')::int AS rewarded,
              count(*) FILTER (WHERE r.status = 'blocked')::int AS blocked
         FROM referrals r LEFT JOIN profiles p ON p.user_id = r.inviter_id
        GROUP BY r.inviter_id, p.nickname ORDER BY invited DESC LIMIT 20`,
    );
    return {
      settings: await this.settings(),
      totals: {
        members: totals.members,
        referrals: totals.referrals,
        rewarded: totals.rewarded,
        blocked: totals.blocked,
        referralPoints: totals.referral_points,
        attendancePoints: totals.attendance_points,
      },
      daily,
      topInviters: top,
    };
  }

  /** 운영 공지를 모든 회원에게 푸시(회원별 알림 설정을 지킨다). */
  async pushAnnouncement(id: string): Promise<number> {
    const a = await this.db.one<{ title: string; body: string; pushed_at: Date | null }>('SELECT title, body, pushed_at FROM announcements WHERE id = $1', [id]);
    if (!a) throw notFound('공지를 찾을 수 없습니다.');
    if (a.pushed_at) throw conflict('ALREADY_PUSHED', '이미 알림을 보낸 공지입니다.');
    await this.db.query('UPDATE announcements SET pushed_at = now() WHERE id = $1', [id]);
    let sent = 0;
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const users = await this.db.query<{ id: string }>(`SELECT id FROM users WHERE status = 'active' AND id > $1 ORDER BY id LIMIT 500`, [after]);
      if (!users.length) break;
      after = users[users.length - 1].id;
      await this.push
        .send(users.map((u) => ({ userId: u.id, kind: 'notice' as const, title: a.title, body: a.body.slice(0, 120), privateBody: '새 운영 공지가 있습니다.', data: { kind: 'notice', announcementId: id } })))
        .catch(() => undefined);
      sent += users.length;
    }
    await this.db.query('UPDATE announcements SET push_count = $2 WHERE id = $1', [id, sent]);
    return sent;
  }
}
