import { Body, Controller, Get, Headers, HttpCode, Inject, OnModuleDestroy, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { uuid } from '../common/validate';
import { AdminService } from '../admin/admin.service';
import { LawService } from './law.service';

/**
 * 수사기관 자료 제공(관리자 전용, 소유자만).
 * 개인 대화 내용은 이 경로로만, 승인된 요청의 범위 안에서, 기록을 남기며 꺼낼 수 있다.
 */
@Controller('v1/admin/law')
export class LawController implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(LawService) private readonly law: LawService,
  ) {}

  onModuleInit() {
    const run = () => this.law.purge().catch(() => undefined);
    setTimeout(run, 30_000).unref();
    this.timer = setInterval(run, 6 * 3600_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async owner(auth: string) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'legal');
    return a;
  }

  @Get('meta')
  async meta(@Headers('authorization') auth: string) {
    await this.owner(auth);
    return this.law.meta();
  }

  @Get('users')
  async users(@Headers('authorization') auth: string, @Query('q') q?: string) {
    await this.owner(auth);
    return this.law.findUsers(q || '');
  }

  @Get('requests')
  async list(@Headers('authorization') auth: string) {
    await this.owner(auth);
    return this.law.list();
  }

  @Post('requests')
  async create(@Headers('authorization') auth: string, @Body() body: any) {
    return this.law.create(await this.owner(auth), body);
  }

  @Get('requests/:id')
  async detail(@Headers('authorization') auth: string, @Param('id') id: string) {
    return this.law.detail(await this.owner(auth), uuid(id, '요청'));
  }

  @Post('requests/:id/hold')
  @HttpCode(200)
  async hold(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    return this.law.setHold(await this.owner(auth), uuid(id, '요청'), { ...body, userId: uuid(body?.userId, '회원') });
  }

  @Post('requests/:id/approve')
  @HttpCode(200)
  async approve(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    return this.law.approve(await this.owner(auth), uuid(id, '요청'), body);
  }

  @Post('requests/:id/reject')
  @HttpCode(200)
  async reject(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    return this.law.reject(await this.owner(auth), uuid(id, '요청'), body);
  }

  @Post('requests/:id/exports')
  async generate(@Headers('authorization') auth: string, @Param('id') id: string) {
    return this.law.generate(await this.owner(auth), uuid(id, '요청'));
  }

  @Get('requests/:id/exports/:exportId')
  async download(@Headers('authorization') auth: string, @Param('id') id: string, @Param('exportId') exportId: string, @Query('format') format?: string) {
    return this.law.download(await this.owner(auth), uuid(id, '요청'), uuid(exportId, '자료'), format === 'json' ? 'json' : 'html');
  }

  @Get('requests/:id/media/:mediaId')
  async media(@Headers('authorization') auth: string, @Param('id') id: string, @Param('mediaId') mediaId: string) {
    return this.law.mediaUrl(await this.owner(auth), uuid(id, '요청'), uuid(mediaId, '사진'));
  }

  @Post('requests/:id/delivered')
  @HttpCode(200)
  async delivered(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    return this.law.delivered(await this.owner(auth), uuid(id, '요청'), body);
  }

  @Post('requests/:id/close')
  @HttpCode(200)
  async close(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    return this.law.close(await this.owner(auth), uuid(id, '요청'), body);
  }
}
