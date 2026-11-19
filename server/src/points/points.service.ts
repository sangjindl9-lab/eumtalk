import { Inject, Injectable } from '@nestjs/common';
import { AppError, bad } from '../common/errors';
import { Db, Q } from '../db/db';

export interface Quote {
  key: string;
  label: string;
  units: number;
  unitPrice: number;
  freeUnits: number;
  cost: number;
  balance: number;
  enough: boolean;
  vipDiscountPercent?: number;
}

/**
 * 포인트 원장. 잔액은 point_wallets 한 줄, 모든 증감은 point_ledger 에 한 건씩 남는다.
 * 지갑 행을 잠근 상태에서 idem_key 를 확인하므로 같은 사건이 두 번 와도 한 번만 반영된다.
 */
@Injectable()
export class PointsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async apply(
    q: Q,
    userId: string,
    delta: number,
    type: 'charge' | 'spend' | 'refund' | 'admin' | 'grant',
    reason: string,
    ref: { type?: string; id?: string; idemKey?: string; by?: string } = {},
  ): Promise<{ balance: number; duplicate: boolean }> {
    await q.query('INSERT INTO point_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    const wallet = await q.one<{ balance: number }>('SELECT balance FROM point_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    if (ref.idemKey && (await q.one('SELECT 1 FROM point_ledger WHERE idem_key = $1', [ref.idemKey]))) {
      return { balance: wallet!.balance, duplicate: true };
    }
    const next = wallet!.balance + delta;
    if (next < 0) throw new AppError(402, 'INSUFFICIENT_POINTS', '포인트가 부족합니다.', { balance: wallet!.balance, needed: -delta });
    await q.query('UPDATE point_wallets SET balance = $2 WHERE user_id = $1', [userId, next]);
    await q.query(
      `INSERT INTO point_ledger (user_id, delta, balance_after, type, reason, ref_type, ref_id, idem_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, delta, next, type, reason, ref.type ?? null, ref.id ?? null, ref.idemKey ?? null, ref.by ?? null],
    );
    return { balance: next, duplicate: false };
  }

  async balance(q: Q, userId: string): Promise<number> {
    return (await q.one<{ balance: number }>('SELECT balance FROM point_wallets WHERE user_id = $1', [userId]))?.balance ?? 0;
  }

  async isPremium(q: Q, userId: string): Promise<boolean> {
    return !!(await q.one(`SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > now()`, [userId]));
  }

  private async price(q: Q, key: string) {
    const p = await q.one<{ key: string; label: string; points: number; free_per_day: number }>('SELECT * FROM feature_prices WHERE key = $1', [key]);
    if (!p) throw bad('INVALID_INPUT', '알 수 없는 유료 기능입니다.');
    return p;
  }

  /** 결제 전 안내용 견적(차감하지 않는다). */
  async quote(q: Q, userId: string, key: string, units: number, opts: { freeForPremium?: boolean } = {}): Promise<Quote> {
    const p = await this.price(q, key);
    const used = (await q.one<{ used: number }>(`SELECT used FROM feature_usage WHERE user_id = $1 AND key = $2 AND day = (now() AT TIME ZONE 'Asia/Seoul')::date`, [userId, key]))?.used ?? 0;
    let freeUnits = Math.min(units, Math.max(0, p.free_per_day - used));
    const premium = await this.isPremium(q, userId);
    if (opts.freeForPremium && premium) freeUnits = units;
    // VIP 할인: 유료 기능 포인트를 일정 비율 깎아 준다(관리자 마케팅 설정).
    let unitPrice = p.points;
    let vipDiscountPercent = 0;
    if (premium && unitPrice > 0) {
      const d = (await q.one<{ d: number }>(`SELECT coalesce((value->>'vipDiscountPercent')::int, 0) AS d FROM growth_settings WHERE id`))?.d ?? 0;
      if (d > 0) {
        vipDiscountPercent = d;
        unitPrice = Math.max(0, Math.ceil((p.points * (100 - d)) / 100));
      }
    }
    const cost = (units - freeUnits) * unitPrice;
    const balance = await this.balance(q, userId);
    return { key, label: p.label, units, unitPrice, freeUnits, cost, balance, enough: balance >= cost, vipDiscountPercent };
  }

  /** 유료 기능 사용분 차감. 반드시 기능 실행과 같은 트랜잭션에서 호출한다(실패하면 함께 되돌려진다). */
  async charge(q: Q, userId: string, key: string, units: number, ref: { type: string; id: string }, opts: { freeForPremium?: boolean } = {}) {
    if (units <= 0) return { cost: 0, freeUnits: 0, balance: await this.balance(q, userId) };
    const quote = await this.quote(q, userId, key, units, opts);
    const dailyFree = opts.freeForPremium && quote.freeUnits === units && (await this.isPremium(q, userId)) ? 0 : quote.freeUnits;
    if (dailyFree > 0) {
      await q.query(
        `INSERT INTO feature_usage (user_id, key, day, used) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Seoul')::date, $3)
         ON CONFLICT (user_id, key, day) DO UPDATE SET used = feature_usage.used + EXCLUDED.used`,
        [userId, key, dailyFree],
      );
    }
    let balance = quote.balance;
    if (quote.cost > 0) balance = (await this.apply(q, userId, -quote.cost, 'spend', quote.label, ref)).balance;
    return { cost: quote.cost, freeUnits: quote.freeUnits, balance };
  }

  async overview(userId: string) {
    const balance = await this.balance(this.db, userId);
    const sub = await this.db.one<any>(`SELECT product_id, status, expires_at, auto_renew FROM subscriptions WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1`, [userId]);
    const prices = await this.db.query('SELECT key, label, points, free_per_day AS "freePerDay", unit FROM feature_prices ORDER BY key');
    const products = await this.db.query('SELECT id, kind, title, points FROM products WHERE active ORDER BY sort');
    return {
      balance,
      subscription: sub ? { productId: sub.product_id, status: sub.status === 'active' && new Date(sub.expires_at) < new Date() ? 'expired' : sub.status, expiresAt: new Date(sub.expires_at).toISOString(), autoRenew: sub.auto_renew } : null,
      prices,
      products,
    };
  }

  async ledger(userId: string, beforeId: number | null, limit: number) {
    const rows = await this.db.query<any>(
      `SELECT id, delta, balance_after, type, reason, ref_type, created_at FROM point_ledger
        WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [userId, beforeId, limit],
    );
    return {
      items: rows.map((r) => ({ id: Number(r.id), delta: r.delta, balanceAfter: r.balance_after, type: r.type, reason: r.reason, refType: r.ref_type, createdAt: new Date(r.created_at).toISOString() })),
    };
  }
}
