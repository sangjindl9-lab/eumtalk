import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { intIn, uuid } from '../common/validate';
import { ChatService } from './chat.service';

@Controller('v1/conversations')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get()
  async list(@UserId() userId: string) {
    return { items: await this.chat.list(userId) };
  }

  @Get(':id/messages')
  messages(@UserId() userId: string, @Param('id') id: string, @Query() q: any) {
    const after = q.afterSeq !== undefined ? intIn(q.afterSeq, 0, 0, Number.MAX_SAFE_INTEGER) : null;
    const before = q.beforeSeq !== undefined ? intIn(q.beforeSeq, 0, 0, Number.MAX_SAFE_INTEGER) : null;
    const search = typeof q.q === 'string' && q.q.trim().length >= 1 ? q.q.trim().slice(0, 50) : undefined;
    return this.chat.messages(userId, uuid(id, '대화방'), after, before, intIn(q.limit, 50, 1, 200), search);
  }

  @Post(':id/messages')
  @HttpCode(200)
  send(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.chat.send(userId, uuid(id, '대화방'), body);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.chat.markRead(userId, uuid(id, '대화방'), body?.seq);
  }

  @Post(':id/mute')
  @HttpCode(200)
  mute(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.chat.setMuted(userId, uuid(id, '대화방'), body?.muted === true);
  }

  @Post(':id/leave')
  @HttpCode(200)
  leave(@UserId() userId: string, @Param('id') id: string) {
    return this.chat.leaveDirect(userId, uuid(id, '대화방'));
  }

  @Get(':id/export')
  export(@UserId() userId: string, @Param('id') id: string) {
    return this.chat.exportText(userId, uuid(id, '대화방'));
  }
}
