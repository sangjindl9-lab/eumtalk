import { Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { notFound } from '../common/errors';
import { isUuid, uuid } from '../common/validate';
import { MediaService } from './media.service';
import { LocalStorage } from './storage';

@Controller('v1')
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  /** 본문에 이미지 바이트를 그대로 보낸다(Content-Type: image/*). */
  @Post('media')
  @UseGuards(AuthGuard)
  upload(@UserId() userId: string, @Query('purpose') purpose: string, @Query('conversationId') conversationId: string | undefined, @Req() req: any) {
    return this.media.upload(userId, purpose, isUuid(conversationId) ? conversationId : null, req.body);
  }

  @Get('media/:id/url')
  @UseGuards(AuthGuard)
  url(@UserId() userId: string, @Param('id') id: string) {
    return this.media.urlFor(userId, uuid(id, '사진'));
  }

  /** 로컬 저장소 전용: 서명·만료가 맞을 때만 파일을 내려준다. */
  @Get('media-file/:key')
  file(@Param('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: any) {
    const storage = this.media.storage;
    const path = storage instanceof LocalStorage ? storage.verify(key, exp, sig) : null;
    if (!path) throw notFound('링크가 만료되었습니다.');
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'private, max-age=60');
    res.sendFile(path);
  }
}
