import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { uuid } from '../common/validate';
import { PostsService } from './posts.service';

@Controller('v1')
@UseGuards(AuthGuard)
export class PostsController {
  constructor(@Inject(PostsService) private readonly posts: PostsService) {}

  @Get('posts')
  list(@UserId() userId: string, @Query() q: any) {
    return this.posts.list(userId, q);
  }
  @Post('posts')
  create(@UserId() userId: string, @Body() body: any) {
    return this.posts.create(userId, body);
  }
  @Get('posts/:id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.posts.get(userId, uuid(id, '글'));
  }
  @Patch('posts/:id')
  update(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.posts.update(userId, uuid(id, '글'), body);
  }
  @Delete('posts/:id')
  @HttpCode(200)
  remove(@UserId() userId: string, @Param('id') id: string) {
    return this.posts.remove(userId, uuid(id, '글'));
  }
  @Post('posts/:id/comments')
  @HttpCode(200)
  comment(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.posts.comment(userId, uuid(id, '글'), body);
  }
  @Delete('comments/:id')
  @HttpCode(200)
  removeComment(@UserId() userId: string, @Param('id') id: string) {
    return this.posts.removeComment(userId, uuid(id, '댓글'));
  }
  @Post('posts/:id/like')
  @HttpCode(200)
  like(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.posts.toggle(userId, uuid(id, '글'), 'like', body?.on !== false);
  }
  @Post('posts/:id/bookmark')
  @HttpCode(200)
  bookmark(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.posts.toggle(userId, uuid(id, '글'), 'bookmark', body?.on !== false);
  }
  @Post('posts/:id/pin/quote')
  @HttpCode(200)
  pinQuote(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.posts.pinQuote(userId, uuid(id, '글'), body);
  }
  @Post('posts/:id/pin')
  @HttpCode(200)
  pin(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.posts.pin(userId, uuid(id, '글'), body);
  }
  @Post('posts/:id/inquiry')
  @HttpCode(200)
  inquire(@UserId() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.posts.inquire(userId, uuid(id, '글'), body);
  }
}
