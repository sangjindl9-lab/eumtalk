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
    const row = await this.db.one<{ id: string; user_id: string; status: string; suspended_until: Date | null }>(
      `SELECT s.id, s.user_id, u.status, u.suspended_until FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      [sha256(token)],
    );
    if (!row || row.status === 'deleted') throw new AppError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    if (row.status === 'suspended') {
      if (row.suspended_until && new Date(row.suspended_until) <= new Date()) {
        // 정지 기간이 끝났으면 다음 요청에서 바로 풀린다.
        await this.db.query(`UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1 AND status = 'suspended'`, [row.user_id]);
      } else {
        // 정지 중에도 조치 내용 확인, 이의신청, 문의, 로그아웃, 계정 삭제는 할 수 있다.
        const path: string = (req.originalUrl || req.url || '').split('?')[0];
        const allowed = ['/v1/me', '/v1/notices', '/v1/sanctions', '/v1/appeals', '/v1/inquiries', '/v1/announcements', '/v1/auth/logout'];
        const ok = allowed.includes(path) || path.startsWith('/v1/notices/') || (path === '/v1/me' && ['GET', 'DELETE'].includes(req.method));
        if (!ok || (path === '/v1/me' && !['GET', 'DELETE'].includes(req.method))) {
          const until = row.suspended_until ? new Date(row.suspended_until).toISOString() : null;
          throw new AppError(403, 'SUSPENDED', '이용이 정지된 계정입니다. 내 정보에서 조치 내용을 확인하고 이의신청할 수 있습니다.', { until });
        }
      }
    }
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
