import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig, CONFIG } from '../config';

/** Redis 연결(선택). 없으면 메모리 방식으로 대체되어 서버 1대에서만 정확하다. */
@Injectable()
export class RedisConn implements OnModuleDestroy {
  readonly client: Redis | null;
  readonly sub: Redis | null;
  private readonly log = new Logger('Redis');

  constructor(@Inject(CONFIG) cfg: AppConfig) {
    if (cfg.redisUrl) {
      const opts = { maxRetriesPerRequest: 2, lazyConnect: false };
      this.client = new Redis(cfg.redisUrl, opts);
      this.sub = new Redis(cfg.redisUrl, opts);
      this.client.on('error', (e) => this.log.warn(`redis: ${e.message}`));
      this.sub.on('error', (e) => this.log.warn(`redis(sub): ${e.message}`));
    } else {
      this.client = null;
      this.sub = null;
    }
  }

  async onModuleDestroy() {
    this.client?.disconnect();
    this.sub?.disconnect();
  }
}

/** 속도 제한. Redis가 있으면 서버 간 공유된다. */
@Injectable()
export class RateLimiter {
  private readonly mem = new Map<string, { n: number; until: number }>();
  constructor(@Inject(RedisConn) private readonly redis: RedisConn) {}

  /** 허용되면 true */
  async hit(key: string, limit: number, windowSec: number): Promise<boolean> {
    const c = this.redis.client;
    if (c) {
      try {
        const k = `rl:${key}`;
        const n = await c.incr(k);
        if (n === 1) await c.expire(k, windowSec);
        return n <= limit;
      } catch {
        /* Redis 장애 시 메모리 방식으로 계속 */
      }
    }
    const now = Date.now();
    const cur = this.mem.get(key);
    if (!cur || cur.until < now) {
      this.mem.set(key, { n: 1, until: now + windowSec * 1000 });
      if (this.mem.size > 50000) for (const [k, v] of this.mem) if (v.until < now) this.mem.delete(k);
      return true;
    }
    cur.n += 1;
    return cur.n <= limit;
  }
}
