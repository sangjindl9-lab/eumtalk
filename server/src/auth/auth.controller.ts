import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard, SessionId } from '../common/auth.guard';
import { uuid } from '../common/validate';
import { AuthService } from './auth.service';
import { DONE_PAGE } from './identity';

const platformOf = (h?: string) => (['android', 'ios', 'web'].includes(String(h)) ? String(h) : null);

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('status')
  status() {
    return this.auth.status();
  }

  @Post('phone/start')
  @HttpCode(200)
  start(@Body() body: any, @Ip() ip: string) {
    return this.auth.startPhone(body?.phone, ip || 'unknown');
  }

  @Post('phone/verify')
  @HttpCode(200)
  verify(@Body() body: any, @Headers('x-platform') platform?: string) {
    return this.auth.verifyPhone(uuid(body?.verificationId, 'verificationId'), body?.code, platformOf(platform));
  }

  /** 익명 가입(본인인증 없음) */
  @Post('anonymous/start')
  @HttpCode(200)
  anonymousStart(@Body() body: any, @Ip() ip: string) {
    return this.auth.startAnonymous(body, ip || 'unknown');
  }

  /** 본인확인 사업자 화면 방식 */
  @Post('identity/start')
  @HttpCode(200)
  identityStart(@Ip() ip: string) {
    return this.auth.startIdentity(ip || 'unknown');
  }

  @Get('identity/page')
  async identityPage(@Query('id') id: string, @Res() res: any) {
    const html = await this.auth.identityPage(String(id || ''));
    res.status(html ? 200 : 410).type('html').setHeader('cache-control', 'no-store');
    res.send(html ?? '<!doctype html><meta charset="utf-8"><p>인증 시간이 지났습니다. 앱에서 다시 시작해 주세요.</p>');
  }

  @Get('identity/done')
  identityDone(@Res() res: any) {
    res.type('html').setHeader('cache-control', 'no-store');
    res.send(DONE_PAGE);
  }

  @Post('identity/complete')
  @HttpCode(200)
  identityComplete(@Body() body: any, @Headers('x-platform') platform?: string) {
    return this.auth.completeIdentity(uuid(body?.verificationId, 'verificationId'), platformOf(platform));
  }

  @Post('adult/verify')
  @HttpCode(200)
  adult(@Body() body: any) {
    return this.auth.verifyAdult(body?.signupToken, body || {});
  }

  @Post('signup')
  signup(@Body() body: any, @Headers('x-platform') platform?: string) {
    return this.auth.signup(body, platformOf(platform));
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  logout(@SessionId() sessionId: string) {
    return this.auth.logout(sessionId);
  }
}
