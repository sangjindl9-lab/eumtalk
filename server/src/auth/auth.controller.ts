import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, SessionId } from '../common/auth.guard';
import { uuid } from '../common/validate';
import { AuthService } from './auth.service';

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
