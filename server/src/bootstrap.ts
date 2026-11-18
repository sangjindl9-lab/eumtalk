import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllErrorsFilter } from './common/errors';
import { AppConfig } from './config';
import { Db } from './db/db';
import { migrate } from './db/migrate';
import { Realtime } from './realtime/realtime';

export async function createServer(cfg: AppConfig, opts: { logger?: boolean; autoMigrate?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forConfig(cfg), { logger: opts.logger === false ? false : ['log', 'warn', 'error'] });
  app.useGlobalFilters(new AllErrorsFilter());
  app.enableCors({ origin: cfg.corsOrigins.length ? cfg.corsOrigins : true });
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);
  if (opts.autoMigrate !== false) {
    const log = new Logger('Migrate');
    await migrate(app.get(Db).pool, (m) => log.log(m));
  }
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Realtime).attach(app.getHttpServer());
  return app;
}
