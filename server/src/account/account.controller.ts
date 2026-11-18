import { Body, Controller, Delete, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { bad } from '../common/errors';
import { PushService } from '../push/push.service';
import { AccountService } from './account.service';

@Controller('v1')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(@Inject(AccountService) private readonly account: AccountService, @Inject(PushService) private readonly push: PushService) {}

  @Get('notices')
  notices(@UserId() userId: string) {
    return this.account.notices(userId);
  }
  @Get('notices/unread-count')
  async unread(@UserId() userId: string) {
    return { count: await this.account.unreadNotices(userId) };
  }
  @Get('sanctions')
  sanctions(@UserId() userId: string) {
    return this.account.sanctions(userId);
  }
  @Post('appeals')
  @HttpCode(200)
  appeal(@UserId() userId: string, @Body() body: any) {
    return this.account.appeal(userId, body);
  }
  @Get('inquiries')
  inquiries(@UserId() userId: string) {
    return this.account.inquiries(userId);
  }
  @Post('inquiries')
  @HttpCode(200)
  inquire(@UserId() userId: string, @Body() body: any) {
    return this.account.inquire(userId, body);
  }
  @Get('announcements')
  announcements() {
    return this.account.announcements();
  }

  @Post('devices')
  @HttpCode(200)
  async device(@UserId() userId: string, @Body() body: any) {
    const token = String(body?.token || '');
    if (token.length < 10 || token.length > 4096) throw bad('INVALID_INPUT', '기기 토큰이 올바르지 않습니다.');
    await this.push.register(userId, token, ['android', 'ios'].includes(body?.platform) ? body.platform : 'android');
    return { ok: true };
  }
  @Post('devices/remove')
  @HttpCode(200)
  async removeDevice(@UserId() userId: string, @Body() body: any) {
    await this.push.unregister(userId, body?.token ? String(body.token) : undefined);
    return { ok: true };
  }

  /** 계정 삭제 신청. 실수 방지를 위해 confirm: "삭제" 를 함께 보내야 한다. */
  @Delete('me')
  @HttpCode(200)
  remove(@UserId() userId: string, @Body() body: any) {
    if (body?.confirm !== '삭제') throw bad('CONFIRM_REQUIRED', '확인 문구를 입력해 주세요.');
    return this.account.deleteAccount(userId, typeof body?.reason === 'string' ? body.reason : '');
  }
}
