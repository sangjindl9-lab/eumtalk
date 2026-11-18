import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { AdminService } from './admin/admin.service';
import { AppModule } from './app.module';
import { AllErrorsFilter } from './common/errors';
import { AppConfig } from './config';
import { Db } from './db/db';
import { migrate } from './db/migrate';
import { Realtime } from './realtime/realtime';

export async function createServer(cfg: AppConfig, opts: { logger?: boolean; autoMigrate?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forConfig(cfg), { logger: opts.logger === false ? false : ['log', 'warn', 'error'] });
  // 사진 업로드는 본문에 이미지 바이트를 그대로 받는다.
  app.use('/v1/media', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '12mb' }));
  app.useGlobalFilters(new AllErrorsFilter());
  app.enableCors({ origin: cfg.corsOrigins.length ? cfg.corsOrigins : true });
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);
  if (opts.autoMigrate !== false) {
    const log = new Logger('Migrate');
    await migrate(app.get(Db).pool, (m) => log.log(m));
  }
  await app.get(AdminService).ensureOwner().catch(() => undefined);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Realtime).attach(app.getHttpServer());
  return app;
}
