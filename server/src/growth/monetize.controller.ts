import { Body, Controller, Get, Headers, HttpCode, Inject, OnModuleDestroy, OnModuleInit, Param, Post, UseGuards } from '@nestjs/common';
import { AdminService } from '../admin/admin.service';
import { AuthGuard, UserId } from '../common/auth.guard';
import { uuid } from '../common/validate';
import { Db } from '../db/db';
import { MonetizeService } from './monetize.service';

@Controller()
export class MonetizeController implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(MonetizeService) private readonly m: MonetizeService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(Db) private readonly db: Db,
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
}
