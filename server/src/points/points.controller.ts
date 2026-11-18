import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { AppConfig, CONFIG } from '../config';
import { bad, forbidden, notFound } from '../common/errors';
import { intIn } from '../common/validate';
import { Db } from '../db/db';
import { PointsService } from './points.service';
import { PurchasesService } from './purchases.service';
import { resolveVerifier } from './store';

@Controller('v1')
export class PointsController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(PurchasesService) private readonly purchases: PurchasesService,
  ) {}

  @Get('points')
  @UseGuards(AuthGuard)
  overview(@UserId() userId: string) {
    return this.points.overview(userId);
  }

  @Get('points/ledger')
  @UseGuards(AuthGuard)
  ledger(@UserId() userId: string, @Query() q: any) {
    return this.points.ledger(userId, q.before ? intIn(q.before, 0, 0, Number.MAX_SAFE_INTEGER) : null, intIn(q.limit, 50, 1, 100));
  }

  /** 구매 완료·복원 시 앱이 호출. 지급은 서버가 스토어에 확인한 뒤에만 한다. */
  @Post('purchases/verify')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  verify(@UserId() userId: string, @Body() body: any) {
    return this.purchases.verify(userId, body);
  }

  // ── 다른 지역 둘러보기 ────────────────────────────────────────────────
  @Post('me/browse/quote')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  browseQuote(@UserId() userId: string) {
    return this.points.quote(this.db, userId, 'region_browse', 1, { freeForPremium: true });
  }

  @Post('me/browse')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async browse(@UserId() userId: string, @Body() body: any) {
    const regionId = String(body?.regionId || '');
    return this.db.tx(async (q) => {
      const region = await q.one<{ name: string }>('SELECT name FROM regions WHERE id = $1', [regionId]);
      if (!region) throw bad('INVALID_REGION', '지역을 선택해 주세요.');
      const me = await q.one<any>('SELECT region_id, browse_region_id, browse_until FROM profiles WHERE user_id = $1 FOR UPDATE', [userId]);
      if (me.region_id === regionId) throw bad('INVALID_REGION', '내 활동 지역입니다.');
      // 이용권이 남아 있으면 지역만 바꾼다(추가 차감 없음).
      const active = me.browse_until && new Date(me.browse_until) > new Date();
      const charged = active ? { cost: 0, balance: await this.points.balance(q, userId) } : await this.points.charge(q, userId, 'region_browse', 1, { type: 'region', id: regionId }, { freeForPremium: true });
      const row = await q.one<any>(
        `UPDATE profiles SET browse_region_id = $2, browse_until = CASE WHEN $3 THEN browse_until ELSE now() + interval '24 hours' END WHERE user_id = $1 RETURNING browse_until`,
        [userId, regionId, !!active],
      );
      return { regionId, regionName: region.name, until: new Date(row.browse_until).toISOString(), cost: charged.cost, balance: charged.balance };
    });
  }

  @Delete('me/browse')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async stopBrowse(@UserId() userId: string) {
    await this.db.query('UPDATE profiles SET browse_region_id = NULL, browse_until = NULL WHERE user_id = $1', [userId]);
    return { ok: true };
  }

  // ── 스토어 서버 알림: 알림 내용은 믿지 않고 거래 식별자만 꺼내 스토어에 다시 확인한다 ──
  @Post('store/google/notifications')
  @HttpCode(200)
  async google(@Query('token') token: string, @Body() body: any) {
    if (!process.env.STORE_WEBHOOK_TOKEN || token !== process.env.STORE_WEBHOOK_TOKEN) throw forbidden('FORBIDDEN', '허용되지 않은 요청입니다.');
    const data = JSON.parse(Buffer.from(String(body?.message?.data || ''), 'base64').toString() || '{}');
    const n = data.subscriptionNotification;
    if (!n) return { ok: true };
    const tx = await resolveVerifier(this.cfg, 'google').verify({ productId: n.subscriptionId, token: n.purchaseToken, subscription: true });
    await this.purchases.record(null, tx).catch(() => undefined);
    if (tx.expiresAt && tx.expiresAt <= new Date()) await this.purchases.expire('google', tx.originalTransactionId);
    return { ok: true };
  }

  @Post('store/apple/notifications')
  @HttpCode(200)
  async apple(@Body() body: any) {
    const payload = JSON.parse(Buffer.from(String(body?.signedPayload || '').split('.')[1] || '', 'base64url').toString() || '{}');
    const info = payload?.data?.signedTransactionInfo ? JSON.parse(Buffer.from(String(payload.data.signedTransactionInfo).split('.')[1], 'base64url').toString()) : null;
    if (!info?.transactionId) return { ok: true };
    const tx = await resolveVerifier(this.cfg, 'apple').verify({ productId: info.productId, token: String(info.transactionId), subscription: !!info.expiresDate });
    await this.purchases.record(null, tx).catch(() => undefined);
    if (tx.expiresAt && tx.expiresAt <= new Date()) await this.purchases.expire('apple', tx.originalTransactionId);
    return { ok: true };
  }

  /** 개발·시험 환경 전용: 갱신·만료·환불 알림을 흉내 낸다. */
  @Post('dev/store-event')
  @HttpCode(200)
  async devEvent(@Body() body: any) {
    if (this.cfg.appEnv === 'production' || this.cfg.iap.mode !== 'dev') throw notFound();
    if (body?.type === 'expire') return this.purchases.expire('dev', String(body.originalTransactionId));
    const tx = await resolveVerifier(this.cfg, 'dev').verify({ productId: String(body.productId), token: String(body.token), subscription: body.subscription === true });
    return this.purchases.record(null, tx);
  }
}
