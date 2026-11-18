import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { uuid } from '../common/validate';
import { REPORT_REASONS, SafetyService } from './safety.service';

@Controller('v1')
@UseGuards(AuthGuard)
export class SafetyController {
  constructor(@Inject(SafetyService) private readonly safety: SafetyService) {}

  @Get('blocks')
  list(@UserId() userId: string) {
    return this.safety.blocks(userId);
  }

  @Post('blocks')
  @HttpCode(200)
  block(@UserId() userId: string, @Body() body: any) {
    return this.safety.block(userId, uuid(body?.userId, '회원'));
  }

  @Delete('blocks/:userId')
  @HttpCode(200)
  unblock(@UserId() userId: string, @Param('userId') target: string) {
    return this.safety.unblock(userId, uuid(target, '회원'));
  }

  @Get('report-reasons')
  reasons() {
    return { items: REPORT_REASONS };
  }

  @Post('reports')
  report(@UserId() userId: string, @Body() body: any) {
    return this.safety.report(userId, body);
  }
}
