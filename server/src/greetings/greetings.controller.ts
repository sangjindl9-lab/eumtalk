import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { uuid } from '../common/validate';
import { GreetingsService } from './greetings.service';

@Controller('v1/greetings')
@UseGuards(AuthGuard)
export class GreetingsController {
  constructor(@Inject(GreetingsService) private readonly greetings: GreetingsService) {}

  @Get()
  list(@UserId() userId: string, @Query('box') box?: string) {
    return this.greetings.list(userId, box === 'sent' ? 'sent' : 'received');
  }

  @Post()
  @HttpCode(200)
  send(@UserId() userId: string, @Body() body: any) {
    return this.greetings.send(userId, uuid(body?.toUserId, '회원'), body?.text);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@UserId() userId: string, @Param('id') id: string) {
    return this.greetings.accept(userId, uuid(id, '인사 요청'));
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@UserId() userId: string, @Param('id') id: string) {
    return this.greetings.decline(userId, uuid(id, '인사 요청'), false);
  }

  @Post(':id/block')
  @HttpCode(200)
  block(@UserId() userId: string, @Param('id') id: string) {
    return this.greetings.decline(userId, uuid(id, '인사 요청'), true);
  }
}
