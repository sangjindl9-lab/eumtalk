import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

export function migrationsDir(): string {
  const candidates = [path.resolve(process.cwd(), 'migrations'), path.resolve(__dirname, '../../migrations')];
  const found = candidates.find((d) => fs.existsSync(d));
  if (!found) throw new Error('migrations 폴더를 찾을 수 없습니다.');
  return found;
}

/** migrations/*.sql 을 이름순으로 한 번씩만 적용한다. */
export async function migrate(pool: Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`마이그레이션 실패: ${file} — ${(e as Error).message}`);
      }
      applied.push(file);
      log(`적용: ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return applied;
}
