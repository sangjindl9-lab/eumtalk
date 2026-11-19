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
  async appConfig() {
    const b = this.cfg.brand;
    const rel = await this.db.query<any>('SELECT * FROM app_release').catch(() => [] as any[]);
    const update: Record<string, unknown> = {};
    for (const r of rel) {
      update[r.platform] = { latestBuild: r.latest_build, latestName: r.latest_name, minBuild: r.min_build, notes: r.notes, storeUrl: r.store_url };
    }
    return {
      update,
      appName: b.appName,
      appNameEn: b.appNameEn,
      tagline: b.tagline,
      seedColor: b.seedColor,
      accentColor: b.accentColor,
      operator: b.operator,
      environment: this.cfg.appEnv,
      signupAvailable: this.cfg.identityMode !== 'unconfigured',
      identityMode: this.cfg.identityMode,
      identityFlow: this.cfg.identityMode === 'anonymous' ? 'anonymous' : this.cfg.identityMode === 'dev' ? 'code' : this.cfg.identityMode === 'live' ? 'web' : 'none',
      pushEnabled: this.cfg.push.provider === 'fcm',
      adultOnly: true,
    };
  }
}
