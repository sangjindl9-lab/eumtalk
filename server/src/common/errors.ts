import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

/** 앱이 code 값으로 분기할 수 있는 오류. message는 그대로 사용자에게 보여줄 수 있는 한국어 문장이다. */
export class AppError extends HttpException {
  constructor(status: number, public readonly code: string, message: string, public readonly extra?: Record<string, unknown>) {
    super({ code, message }, status);
  }
}

export const bad = (code: string, message: string) => new AppError(400, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (message = '찾을 수 없습니다.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) => new AppError(409, code, message, extra);
export const tooMany = (message = '잠시 후 다시 시도해 주세요.') => new AppError(429, 'RATE_LIMITED', message);

@Catch()
export class AllErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof AppError) {
      return res.status(err.getStatus()).json({ error: { code: err.code, message: err.message, ...(err.extra || {}) } });
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return res.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message: status === 404 ? '찾을 수 없습니다.' : '요청을 처리할 수 없습니다.' } });
    }
    this.log.error(err instanceof Error ? err.stack || err.message : String(err));
    return res.status(500).json({ error: { code: 'INTERNAL', message: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' } });
  }
}
