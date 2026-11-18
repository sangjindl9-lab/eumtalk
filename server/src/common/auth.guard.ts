import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { sha256 } from './crypto';
import { AppError } from './errors';
import { Db } from '../db/db';

const lastTouch = new Map<string, number>();

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Db) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new AppError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const row = await this.db.one<{ id: string; user_id: string; status: string }>(
      `SELECT s.id, s.user_id, u.status FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      [sha256(token)],
    );
    if (!row || row.status === 'deleted') throw new AppError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    if (row.status === 'suspended') throw new AppError(403, 'SUSPENDED', '이용이 정지된 계정입니다. 내 정보 > 문의에서 확인해 주세요.');
    req.userId = row.user_id;
    req.sessionId = row.id;

    // 최근 활동 시각은 1분에 한 번만 갱신한다.
    const now = Date.now();
    if ((lastTouch.get(row.user_id) || 0) < now - 60_000) {
      lastTouch.set(row.user_id, now);
      if (lastTouch.size > 100000) lastTouch.clear();
      this.db
        .query('UPDATE profiles SET last_active_at = now() WHERE user_id = $1', [row.user_id])
        .catch(() => undefined);
    }
    return true;
  }
}

export const UserId = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().userId);
export const SessionId = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().sessionId);
