import { Controller, Get, Headers, Inject } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { AppError } from '../common/errors';
import { Db } from '../db/db';
import { RedisConn } from '../realtime/redis';

@Controller()
export class SystemController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(RedisConn) private readonly redis: RedisConn,
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

  /** 관리자 웹이 보여주는 시스템 상태. 설정 누락(예: 본인확인 미설정)을 한글 문장으로 알려준다. */
  @Get('v1/admin/system-status')
  async status(@Headers('authorization') auth?: string) {
    const token = (auth || '').replace(/^Bearer\s+/i, '');
    if (!this.cfg.adminToken || token !== this.cfg.adminToken) throw new AppError(401, 'UNAUTHORIZED', '관리자 인증이 필요합니다.');
    const counts = await this.db.one<any>(
      `SELECT (SELECT count(*) FROM users WHERE status = 'active') AS users,
              (SELECT count(*) FROM conversations) AS conversations,
              (SELECT count(*) FROM messages) AS messages,
              (SELECT count(*) FROM greeting_requests WHERE status = 'pending') AS pending_greetings,
              (SELECT count(*) FROM reports WHERE status = 'open') AS open_reports,
              (SELECT count(*) FROM schema_migrations) AS migrations`,
    );
    let redis = 'not_configured';
    if (this.redis.client) redis = await this.redis.client.ping().then(() => 'ok').catch(() => 'error');
    return {
      environment: this.cfg.appEnv,
      identityMode: this.cfg.identityMode,
      identityProvider: this.cfg.identityProvider,
      signupAvailable: this.cfg.identityMode !== 'unconfigured',
      database: 'ok',
      redis,
      problems: this.cfg.problems,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
    };
  }
}
