import { Controller, Get, Inject } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { Db } from '../db/db';

@Controller()
export class SystemController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
  ) {}

  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true };
  }

  /** 앱 이름·색상·운영사 정보. 저장소의 brand/brand.json 한 곳에서 바꾼다. */
  @Get('v1/app-config')
  appConfig() {
    const b = this.cfg.brand;
    return {
      appName: b.appName,
      appNameEn: b.appNameEn,
      tagline: b.tagline,
      seedColor: b.seedColor,
      accentColor: b.accentColor,
      operator: b.operator,
      environment: this.cfg.appEnv,
      signupAvailable: this.cfg.identityMode !== 'unconfigured',
      identityMode: this.cfg.identityMode,
      adultOnly: true,
    };
  }
}
