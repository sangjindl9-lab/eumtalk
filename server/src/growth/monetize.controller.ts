import { Body, Controller, Get, Headers, HttpCode, Inject, OnModuleDestroy, OnModuleInit, Param, Post, UseGuards } from '@nestjs/common';
import { AdminService } from '../admin/admin.service';
import { AuthGuard, UserId } from '../common/auth.guard';
import { uuid } from '../common/validate';
import { Db } from '../db/db';
import { bad } from '../common/errors';
import { PushService } from '../push/push.service';
import { MonetizeService } from './monetize.service';

@Controller()
export class MonetizeController implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(MonetizeService) private readonly m: MonetizeService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(Db) private readonly db: Db,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_JOBS === '1') return;
    const run = () => this.m.runDailyPicks().catch(() => undefined);
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, 10 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  @UseGuards(AuthGuard)
  @Get('v1/me/boost')
  boostStatus(@UserId() userId: string) {
    return this.m.boostStatus(userId);
  }

  @UseGuards(AuthGuard)
  @Post('v1/me/boost')
  @HttpCode(200)
  boost(@UserId() userId: string) {
    return this.m.boost(userId);
  }

  @UseGuards(AuthGuard)
  @Post('v1/conversations/:id/gift')
  @HttpCode(200)
  gift(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.m.gift(userId, uuid(id, '대화방'), body);
  }

  @UseGuards(AuthGuard)
  @Get('v1/me/visitors')
  visitors(@UserId() userId: string) {
    return this.m.visitors(userId);
  }

  @UseGuards(AuthGuard)
  @Post('v1/me/visitors/unlock')
  @HttpCode(200)
  unlock(@UserId() userId: string) {
    return this.m.unlockVisitors(userId);
  }

  @UseGuards(AuthGuard)
  @Get('v1/me/picks')
  picks(@UserId() userId: string) {
    return this.m.todayPicks(userId);
  }

  // ── 관리자 단체 알림 ──
  private async staff(auth: string) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'support');
    return a;
  }

  @Post('v1/admin/campaigns/preview')
  @HttpCode(200)
  async preview(@Headers('authorization') auth: string, @Body() body: any) {
    await this.staff(auth);
    return this.m.campaignPreview(body);
  }

  @Get('v1/admin/campaigns')
  async list(@Headers('authorization') auth: string) {
    await this.staff(auth);
    return this.m.campaigns();
  }

  @Post('v1/admin/campaigns')
  @HttpCode(200)
  async send(@Headers('authorization') auth: string, @Body() body: any) {
    const a = await this.staff(auth);
    const r = await this.m.campaignSend(a.id, body);
    await this.admin.audit(this.db, a.id, 'campaign.send', 'campaign', r.id, { sent: r.sent, advertising: body?.advertising !== false });
    return r;
  }

  @Post('v1/admin/picks/run')
  @HttpCode(200)
  async runPicks(@Headers('authorization') auth: string) {
    await this.staff(auth);
    return { sent: await this.m.runDailyPicks(true) };
  }

  // ── 앱 버전·업데이트 알림 ──
  @Get('v1/admin/app-release')
  async release(@Headers('authorization') auth: string) {
    await this.staff(auth);
    const rows = await this.db.query<any>('SELECT * FROM app_release ORDER BY platform');
    return { items: rows.map((r) => ({ platform: r.platform, latestBuild: r.latest_build, latestName: r.latest_name, minBuild: r.min_build, notes: r.notes, storeUrl: r.store_url, notifiedBuild: r.notified_build, updatedAt: new Date(r.updated_at).toISOString() })) };
  }

  /** 최신 버전 등록. notify=true 이면 모든 회원에게 "새 버전" 알림(한 버전에 한 번). */
  @Post('v1/admin/app-release')
  @HttpCode(200)
  async setRelease(@Headers('authorization') auth: string, @Body() body: any) {
    const a = await this.staff(auth);
    const platform = body?.platform === 'ios' ? 'ios' : 'android';
    const latest = Math.trunc(Number(body?.latestBuild));
    const min = Math.trunc(Number(body?.minBuild ?? 0));
    if (!Number.isFinite(latest) || latest < 0 || !Number.isFinite(min) || min < 0 || min > latest) throw bad('INVALID_INPUT', '버전 번호를 확인해 주세요(필수 버전은 최신 버전보다 클 수 없습니다).');
    const name = String(body?.latestName ?? '').trim().slice(0, 20);
    const notes = String(body?.notes ?? '').trim().slice(0, 500);
    const url = String(body?.storeUrl ?? '').trim().slice(0, 300);
    const row = await this.db.one<any>(
      `UPDATE app_release SET latest_build = $2, latest_name = $3, min_build = $4, notes = $5, store_url = CASE WHEN $6 = '' THEN store_url ELSE $6 END, updated_at = now()
        WHERE platform = $1 RETURNING *`,
      [platform, latest, name, min, notes, url],
    );
    let sent = 0;
    if (body?.notify === true && latest > row.notified_build) {
      await this.db.query('UPDATE app_release SET notified_build = $2 WHERE platform = $1', [platform, latest]);
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        // 해당 플랫폼 기기를 등록한 회원 우선, 기기 정보가 없는 회원도 포함(앱을 열면 업데이트 안내가 뜬다)
        const users = await this.db.query<{ id: string }>(
          `SELECT u.id FROM users u WHERE u.status = 'active' AND u.id > $2
              AND NOT EXISTS (SELECT 1 FROM device_tokens d WHERE d.user_id = u.id AND d.platform <> $1
                               AND NOT EXISTS (SELECT 1 FROM device_tokens d2 WHERE d2.user_id = u.id AND d2.platform = $1))
            ORDER BY u.id LIMIT 500`,
          [platform, after],
        );
        if (!users.length) break;
        after = users[users.length - 1].id;
        await this.push
          .send(users.map((u) => ({ userId: u.id, kind: 'notice' as const, title: `이음톡 새 버전${name ? ` ${name}` : ''}이 나왔어요`, body: notes ? notes.slice(0, 100) : '눌러서 업데이트해 주세요.', privateBody: '이음톡 새 버전이 나왔어요.', data: { kind: 'update' } })))
          .catch(() => undefined);
        sent += users.length;
      }
    }
    await this.admin.audit(this.db, a.id, 'app_release.update', 'app_release', platform, { latest, min, sent });
    return { ok: true, sent };
  }
}
