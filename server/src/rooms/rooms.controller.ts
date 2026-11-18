import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { isUuid, uuid } from '../common/validate';
import { RoomsService } from './rooms.service';

@Controller('v1/rooms')
@UseGuards(AuthGuard)
export class RoomsController {
  constructor(@Inject(RoomsService) private readonly rooms: RoomsService) {}

  @Get()
  list(@UserId() userId: string, @Query() q: any) {
    return this.rooms.list(userId, q);
  }
  @Post()
  create(@UserId() userId: string, @Body() body: any) {
    return this.rooms.create(userId, body);
  }
  @Get('expand-quote')
  expandQuote(@UserId() userId: string) {
    return this.rooms.expandQuote(userId);
  }
  @Get(':id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.rooms.get(userId, uuid(id, '방'));
  }
  @Patch(':id')
  update(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.rooms.update(userId, uuid(id, '방'), body);
  }
  @Post(':id/join')
  @HttpCode(200)
  join(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.rooms.join(userId, uuid(id, '방'), body);
  }
  @Post(':id/leave')
  @HttpCode(200)
  leave(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.rooms.leave(userId, uuid(id, '방'), body);
  }
  @Get(':id/members')
  members(@UserId() userId: string, @Param('id') id: string) {
    return this.rooms.members(userId, uuid(id, '방'));
  }
  @Get(':id/requests')
  requests(@UserId() userId: string, @Param('id') id: string) {
    return this.rooms.requests(userId, uuid(id, '방'));
  }
  @Post(':id/requests/:rid/:action')
  @HttpCode(200)
  decide(@UserId() userId: string, @Param('id') id: string, @Param('rid') rid: string, @Param('action') action: string) {
    return this.rooms.decide(userId, uuid(id, '방'), uuid(rid, '가입 신청'), action === 'approve');
  }
  @Post(':id/members/:uid/kick')
  @HttpCode(200)
  kick(@UserId() userId: string, @Param('id') id: string, @Param('uid') uid: string, @Body() body: any) {
    return this.rooms.kick(userId, uuid(id, '방'), uuid(uid, '회원'), body);
  }
  @Delete(':id/bans/:uid')
  @HttpCode(200)
  unban(@UserId() userId: string, @Param('id') id: string, @Param('uid') uid: string) {
    return this.rooms.unban(userId, uuid(id, '방'), uuid(uid, '회원'));
  }
  @Post(':id/members/:uid/role')
  @HttpCode(200)
  role(@UserId() userId: string, @Param('id') id: string, @Param('uid') uid: string, @Body() body: any) {
    return this.rooms.setRole(userId, uuid(id, '방'), uuid(uid, '회원'), String(body?.role));
  }
  @Post(':id/notice')
  @HttpCode(200)
  notice(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.rooms.pin(userId, uuid(id, '방'), isUuid(body?.messageId) ? body.messageId : null);
  }
  @Post(':id/expand')
  @HttpCode(200)
  expand(@UserId() userId: string, @Param('id') id: string) {
    return this.rooms.expand(userId, uuid(id, '방'));
  }
}
