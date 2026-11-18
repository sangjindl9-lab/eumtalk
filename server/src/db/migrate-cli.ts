import { Pool } from 'pg';
import { loadConfig } from '../config';
import { migrate } from './migrate';

async function main() {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.databaseUrl, ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : undefined });
  const applied = await migrate(pool, (m) => console.log(m));
  console.log(applied.length ? `마이그레이션 ${applied.length}건 적용 완료` : '적용할 마이그레이션이 없습니다.');
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
