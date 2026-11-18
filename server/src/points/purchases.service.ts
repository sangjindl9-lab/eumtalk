import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { bad, conflict } from '../common/errors';
import { Db } from '../db/db';
import { PointsService } from './points.service';
import { resolveVerifier, VerifiedTransaction } from './store';

/** 구매 검증과 지급. 모든 판단은 스토어가 확인해 준 거래 정보로만 한다. */
@Injectable()
export class PurchasesService {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(PointsService) private readonly points: PointsService,
  ) {}

  /** 앱의 구매 완료·복원 요청. 같은 영수증이 여러 번 와도(이벤트 반복, 앱 재시작 후 재전송) 한 번만 지급된다. */
  async verify(userId: string, body: any) {
    const store = String(body?.store || '');
    const productId = String(body?.productId || '');
    const token = String(body?.token || '');
    if (!['google', 'apple', 'dev'].includes(store) || !productId || !token) throw bad('INVALID_INPUT', '구매 정보가 올바르지 않습니다.');
    const product = await this.db.one<any>('SELECT * FROM products WHERE id = $1 AND active', [productId]);
    if (!product) throw bad('INVALID_PRODUCT', '판매 중인 상품이 아닙니다.');
    const tx = await resolveVerifier(this.cfg, store).verify({ productId, token, subscription: product.kind === 'subscription' });
    return this.record(userId, tx);
  }

  /** 스토어 서버 알림(갱신·만료·환불)과 시험용 이벤트가 함께 쓰는 반영 로직. userId 가 없으면 기존 구독의 소유자를 쓴다. */
  async record(userIdOrNull: string | null, tx: VerifiedTransaction) {
    return this.db.tx(async (q) => {
      // 같은 거래가 동시에 여러 번 들어와도(이벤트 반복, 재전송) 한 줄로 세워 처리한다.
      for (const key of [...new Set([`${tx.store}:${tx.originalTransactionId}`, `${tx.store}:${tx.transactionId}`])].sort()) {
        await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`purchase:${key}`]);
      }
      const product = await q.one<any>('SELECT * FROM products WHERE id = $1', [tx.productId]);
      if (!product) throw bad('INVALID_PRODUCT', '등록되지 않은 상품입니다.');
      const existingSub = await q.one<any>('SELECT * FROM subscriptions WHERE store = $1 AND original_transaction_id = $2 FOR UPDATE', [tx.store, tx.originalTransactionId]);
      const priorOwner = await q.one<{ user_id: string }>('SELECT user_id FROM purchases WHERE store = $1 AND transaction_id = $2', [tx.store, tx.transactionId]);
      const userId = userIdOrNull ?? existingSub?.user_id ?? priorOwner?.user_id;
      if (!userId) throw bad('INVALID_RECEIPT', '소유자를 확인할 수 없는 거래입니다.');
      if (existingSub && existingSub.user_id !== userId) throw conflict('RECEIPT_OWNED', '다른 계정에서 사용 중인 구독입니다.');

      const prior = await q.one<any>('SELECT * FROM purchases WHERE store = $1 AND transaction_id = $2 FOR UPDATE', [tx.store, tx.transactionId]);
      if (prior && prior.user_id !== userId) throw conflict('RECEIPT_OWNED', '이미 다른 계정에서 처리된 영수증입니다.');

      let granted = 0;
      let refunded = 0;
      if (tx.revoked) {
        // 환불: 지급했던 포인트를 남은 잔액 한도 안에서 회수하고 구독 혜택을 끝낸다.
        if (prior && prior.status === 'granted') {
          const balance = await this.points.balance(q, userId);
          refunded = Math.min(balance, prior.points_granted);
          if (refunded > 0) await this.points.apply(q, userId, -refunded, 'refund', `환불: ${product.title}`, { type: 'purchase', id: prior.id, idemKey: `refund:${tx.store}:${tx.transactionId}` });
          await q.query(`UPDATE purchases SET status = 'refunded', refunded_at = now() WHERE id = $1`, [prior.id]);
        }
        if (product.kind === 'subscription') {
          await q.query(`UPDATE subscriptions SET status = 'refunded', updated_at = now() WHERE store = $1 AND original_transaction_id = $2`, [tx.store, tx.originalTransactionId]);
        }
      } else {
        if (!prior) {
          const row = await q.one<{ id: string }>(
            `INSERT INTO purchases (user_id, store, product_id, transaction_id, original_transaction_id, points_granted, raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [userId, tx.store, tx.productId, tx.transactionId, tx.originalTransactionId, product.points, JSON.stringify(tx.raw ?? {})],
          );
          if (product.points > 0) {
            const r = await this.points.apply(q, userId, product.points, 'charge', product.kind === 'subscription' ? `${product.title} 포인트` : `충전: ${product.title}`, {
              type: 'purchase', id: row!.id, idemKey: `purchase:${tx.store}:${tx.transactionId}`,
            });
            if (!r.duplicate) granted = product.points;
          }
        }
        if (product.kind === 'subscription' && tx.expiresAt) {
          const status = tx.expiresAt > new Date() ? 'active' : 'expired';
          await q.query(
            `INSERT INTO subscriptions (user_id, store, product_id, original_transaction_id, status, expires_at, auto_renew)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (store, original_transaction_id) DO UPDATE
               SET status = EXCLUDED.status, expires_at = GREATEST(subscriptions.expires_at, EXCLUDED.expires_at),
                   auto_renew = EXCLUDED.auto_renew, product_id = EXCLUDED.product_id, updated_at = now()`,
            [userId, tx.store, tx.productId, tx.originalTransactionId, status, tx.expiresAt, tx.autoRenew],
          );
        }
      }
      const balance = await this.points.balance(q, userId);
      return { balance, granted, refunded, alreadyProcessed: !!prior && !tx.revoked, premium: await this.points.isPremium(q, userId) };
    });
  }

  /** 만료 처리(스토어 만료 알림 또는 주기 점검). */
  async expire(store: string, originalTransactionId: string) {
    await this.db.query(`UPDATE subscriptions SET status = 'expired', auto_renew = false, updated_at = now() WHERE store = $1 AND original_transaction_id = $2 AND status = 'active'`, [store, originalTransactionId]);
    return { ok: true };
  }
}
