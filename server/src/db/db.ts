import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppConfig, CONFIG } from '../config';

export interface Q {
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T | null>;
}

function wrap(c: Pool | PoolClient): Q {
  return {
    async query(sql, params) {
      return (await c.query(sql, params as any[])).rows;
    },
    async one(sql, params) {
      return (await c.query(sql, params as any[])).rows[0] ?? null;
    },
  };
}

@Injectable()
export class Db implements Q, OnModuleDestroy {
  readonly pool: Pool;
  private readonly q: Q;

  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.pool = new Pool({
      connectionString: cfg.databaseUrl,
      ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 15,
    });
    this.q = wrap(this.pool);
  }

  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]) {
    return this.q.query<T>(sql, params);
  }
  one<T extends QueryResultRow = any>(sql: string, params?: unknown[]) {
    return this.q.one<T>(sql, params);
  }

  async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(wrap(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

/** 두 회원 조합에 대한 트랜잭션 잠금. 동시 인사·중복 수락에서도 대화방이 하나만 생기게 한다. */
export async function lockPair(q: Q, a: string, b: string) {
  const [low, high] = a < b ? [a, b] : [b, a];
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`pair:${low}:${high}`]);
  return { low, high };
}
