import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { isUuid, uuid } from '../common/validate';
import { AdminService } from './admin.service';

/**
 * 관리자 API. 개인 대화를 검색·열람하는 엔드포인트는 두지 않는다.
 * 대화 내용은 신고에 묶인 사본만, 신고 처리 권한이 있는 담당자가, 기록을 남기며 볼 수 있다.
 */
@Controller('v1/admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('setup')
  setup() {
    return this.admin.needsSetup();
  }
  @Post('bootstrap')
  @HttpCode(200)
  bootstrap(@Headers('x-admin-token') token: string, @Body() body: any) {
    return this.admin.bootstrap(token, body);
  }
  @Post('login')
  @HttpCode(200)
  login(@Body() body: any) {
    return this.admin.login(body);
  }
  @Post('logout')
  @HttpCode(200)
  logout(@Headers('authorization') auth: string) {
    return this.admin.logout(auth);
  }
  @Get('me')
  me(@Headers('authorization') auth: string) {
    return this.admin.authenticate(auth);
  }
  @Get('system-status')
  async status(@Headers('authorization') auth: string) {
    await this.admin.authenticate(auth);
    return this.admin.status();
  }

  @Get('reports')
  async reports(@Headers('authorization') auth: string, @Query('status') status?: string) {
    this.admin.require(await this.admin.authenticate(auth), 'reports');
    return this.admin.reports(status || 'open');
  }
  @Get('reports/:id')
  async report(@Headers('authorization') auth: string, @Param('id') id: string) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'reports');
    return this.admin.reportDetail(a, uuid(id, '신고'));
  }
  @Post('reports/:id/action')
  @HttpCode(200)
  async act(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'reports');
    return this.admin.act(a, uuid(id, '신고'), body);
  }
  @Get('appeals')
  async appeals(@Headers('authorization') auth: string, @Query('status') status?: string) {
    this.admin.require(await this.admin.authenticate(auth), 'reports');
    return this.admin.appeals(status || 'pending');
  }
  @Post('appeals/:id/decide')
  @HttpCode(200)
  async decideAppeal(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'reports');
    return this.admin.decideAppeal(a, uuid(id, '이의신청'), body);
  }

  @Get('users')
  async users(@Headers('authorization') auth: string, @Query('q') q?: string, @Query('status') status?: string) {
    this.admin.require(await this.admin.authenticate(auth), 'users');
    return this.admin.users(q || '', status || 'all');
  }
  @Post('users/:id/suspension')
  @HttpCode(200)
  async suspension(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'sanction');
    return this.admin.setSuspended(a, uuid(id, '회원'), body);
  }

  @Get('rooms')
  async rooms(@Headers('authorization') auth: string, @Query('q') q?: string) {
    this.admin.require(await this.admin.authenticate(auth), 'rooms');
    return this.admin.roomList(q || '');
  }
  @Post('rooms')
  async createRoom(@Headers('authorization') auth: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'rooms');
    return this.admin.createRegionRoom(a, body);
  }
  @Post('rooms/:id/status')
  @HttpCode(200)
  async roomStatus(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'rooms');
    return this.admin.setRoomStatus(a, uuid(id, '방'), body?.open === true);
  }

  @Get('posts')
  async posts(@Headers('authorization') auth: string, @Query('q') q?: string, @Query('status') status?: string) {
    this.admin.require(await this.admin.authenticate(auth), 'posts');
    return this.admin.postList(q || '', status || 'all');
  }
  @Post('posts/:id/hidden')
  @HttpCode(200)
  async postHidden(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'posts');
    return this.admin.setPostHidden(a, uuid(id, '글'), body?.hidden !== false, String(body?.reason || ''));
  }

  @Get('points/ledger')
  async ledger(@Headers('authorization') auth: string, @Query('userId') userId?: string) {
    this.admin.require(await this.admin.authenticate(auth), 'points');
    return this.admin.ledger(isUuid(userId) ? userId : null);
  }
  @Post('points/adjust')
  @HttpCode(200)
  async adjust(@Headers('authorization') auth: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'points');
    return this.admin.adjust(a, body);
  }
  @Get('purchases')
  async purchases(@Headers('authorization') auth: string) {
    this.admin.require(await this.admin.authenticate(auth), 'points');
    return this.admin.purchases();
  }
  @Get('prices')
  async prices(@Headers('authorization') auth: string) {
    this.admin.require(await this.admin.authenticate(auth), 'points');
    return this.admin.prices();
  }
  @Put('prices/:key')
  async setPrice(@Headers('authorization') auth: string, @Param('key') key: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'points');
    return this.admin.setPrice(a, key, body);
  }
  @Put('products/:id')
  async setProduct(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'points');
    return this.admin.setProduct(a, id, body);
  }

  @Get('announcements')
  async announcements(@Headers('authorization') auth: string) {
    this.admin.require(await this.admin.authenticate(auth), 'support');
    return this.admin.announcementList();
  }
  @Post('announcements')
  async announce(@Headers('authorization') auth: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'support');
    return this.admin.announce(a, body);
  }
  @Post('announcements/:id/published')
  @HttpCode(200)
  async setAnnouncement(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'support');
    return this.admin.setAnnouncement(a, uuid(id, '공지'), body?.published === true);
  }
  @Get('inquiries')
  async inquiries(@Headers('authorization') auth: string, @Query('status') status?: string) {
    this.admin.require(await this.admin.authenticate(auth), 'support');
    return this.admin.inquiryList(status || 'open');
  }
  @Post('inquiries/:id/answer')
  @HttpCode(200)
  async answer(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'support');
    return this.admin.answerInquiry(a, uuid(id, '문의'), body);
  }

  @Get('admins')
  async admins(@Headers('authorization') auth: string) {
    this.admin.require(await this.admin.authenticate(auth), 'admins');
    return this.admin.adminList();
  }
  @Post('admins')
  async addAdmin(@Headers('authorization') auth: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'admins');
    return this.admin.addAdmin(a, body);
  }
  @Post('admins/:id')
  @HttpCode(200)
  async updateAdmin(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const a = await this.admin.authenticate(auth);
    this.admin.require(a, 'admins');
    return this.admin.updateAdmin(a, uuid(id, '관리자'), body);
  }
  @Get('audit')
  async audit(@Headers('authorization') auth: string) {
    this.admin.require(await this.admin.authenticate(auth), 'audit');
    return this.admin.auditLog();
  }
}
