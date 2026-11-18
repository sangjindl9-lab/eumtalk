import { Logger } from '@nestjs/common';
import { createServer } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const cfg = loadConfig();
  const app = await createServer(cfg, { autoMigrate: process.env.AUTO_MIGRATE !== 'false' });
  const log = new Logger('Boot');
  log.log(`${cfg.brand.appName} 서버 시작 — 환경: ${cfg.appEnv}, 포트: ${cfg.port}, 본인확인: ${cfg.identityMode}`);
  for (const p of cfg.problems) (p.blocking ? log.error : log.warn).call(log, `[설정 확인] ${p.key}: ${p.message}`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
