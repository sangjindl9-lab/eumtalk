import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AdminService } from '../admin/admin.service';
import { AuthGuard, UserId } from '../common/auth.guard';
import { intIn, uuid } from '../common/validate';
import { AppConfig, CONFIG } from '../config';
import { Db } from '../db/db';
import { GrowthService, normalizeCode } from './growth.service';

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

@Controller()
export class GrowthController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(GrowthService) private readonly growth: GrowthService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(Db) private readonly db: Db,
  ) {}

  // ── 회원 ──
  @Get('v1/invite/check')
  check(@Query('code') code: string) {
    return this.growth.checkCode(code);
  }

  @UseGuards(AuthGuard)
  @Get('v1/me/invite')
  invite(@UserId() userId: string) {
    return this.growth.inviteOverview(userId);
  }

  @UseGuards(AuthGuard)
  @Post('v1/me/invite/redeem')
  @HttpCode(200)
  redeem(@UserId() userId: string, @Body() body: any, @Ip() ip: string) {
    return this.growth.redeemLater(userId, body?.code, ip || 'unknown');
  }

  @UseGuards(AuthGuard)
  @Get('v1/me/attendance')
  attendance(@UserId() userId: string) {
    return this.growth.attendanceStatus(userId);
  }

  @UseGuards(AuthGuard)
  @Post('v1/me/attendance')
  @HttpCode(200)
  checkIn(@UserId() userId: string) {
    return this.growth.checkIn(userId);
  }

  // ── 관리자 ──
  @Get('v1/admin/growth')
  async stats(@Headers('authorization') auth: string, @Query('days') days?: string) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'support');
    return this.growth.adminStats(intIn(days, 14, 7, 90));
  }

  @Post('v1/admin/growth/settings')
  @HttpCode(200)
  async settings(@Headers('authorization') auth: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'points');
    const s = await this.growth.updateSettings(body);
    await this.admin.audit(this.db, a.id, 'growth.settings', 'growth', 'settings', { ...s });
    return s;
  }

  @Post('v1/admin/announcements/:id/push')
  @HttpCode(200)
  async pushAnnouncement(@Headers('authorization') auth: string, @Param('id') id: string) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'support');
    const sent = await this.growth.pushAnnouncement(uuid(id, '공지'));
    await this.admin.audit(this.db, a.id, 'announcement.push', 'announcement', id, { sent });
    return { ok: true, sent };
  }

  // ── 공개 초대 페이지: 링크를 받은 사람이 코드를 보고 앱을 설치한다 ──
  @Get('i/:code')
  async landing(@Param('code') raw: string, @Res() res: any) {
    const b = this.cfg.brand;
    const v = await this.growth.checkCode(raw);
    const code = v.valid ? normalizeCode(raw) : '';
    const pkg = (b as any).androidApplicationId || 'kr.eumsoft.eumtalk';
    const ref = encodeURIComponent(`utm_source=invite&utm_medium=friend&utm_campaign=invite&utm_content=${code || 'none'}`);
    const play = `https://play.google.com/store/apps/details?id=${pkg}&referrer=${ref}`;
    const color = b.seedColor || '#2F6B5E';
    res.type('html').setHeader('cache-control', 'public, max-age=300');
    res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(b.appName)} 초대장</title>
<meta property="og:title" content="${esc(b.appName)}에 초대받았어요">
<meta property="og:description" content="${esc(b.tagline || '')}${code && 'reward' in v ? ` · 초대 코드 ${code} 입력하면 ${v.reward}포인트` : ''}">
<style>
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;background:#f6f6f5;color:#1c1e1d}
main{max-width:420px;margin:0 auto;padding:48px 24px;text-align:center}
h1{font-size:26px;font-weight:600;margin:0 0 8px}p{color:#4a4f4d;margin:0 0 24px}
.code{display:inline-block;font:600 28px/1 ui-monospace,Menlo,monospace;letter-spacing:6px;background:#fff;border:1px solid rgba(28,30,29,.12);border-radius:12px;padding:16px 20px;margin:8px 0 6px}
.hint{font-size:14px;color:#6b706e;margin-bottom:28px}
a.btn{display:block;background:${esc(color)};color:#fff;text-decoration:none;border-radius:12px;padding:16px;font-weight:600}
button{margin-top:12px;background:none;border:1px solid rgba(28,30,29,.2);border-radius:12px;padding:12px 16px;font:inherit;width:100%}
small{display:block;margin-top:28px;color:#8a8f8d}
</style></head><body><main>
<h1>${esc(b.appName)}에 초대받았어요</h1>
<p>${esc(b.tagline || '')}</p>
${
  code
    ? `<div class="code" id="c">${esc(code)}</div><div class="hint">가입할 때 이 초대 코드를 넣으면 ${'reward' in v ? v.reward : 0}포인트를 받아요</div>`
    : `<div class="hint">초대 코드가 올바르지 않거나 이벤트가 끝났어요. 앱은 그대로 설치할 수 있어요.</div>`
}
<a class="btn" href="${esc(play)}">Google Play에서 설치하기</a>
${code ? `<button onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(code)}').then(()=>this.textContent='복사했어요')">초대 코드 복사</button>` : ''}
<small>만 19세 이상만 이용할 수 있어요.</small>
</main></body></html>`);
  }
}
