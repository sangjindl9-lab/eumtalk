import { AppConfig } from '../config';
import { AppError, bad } from '../common/errors';
import { sha256 } from '../common/crypto';

/**
 * 본인확인 사업자 어댑터.
 * 휴대폰 번호 인증과 성인 여부 확인은 서로 다른 단계로 처리한다.
 * 운영 환경에서는 인증기관이 서버로 돌려준 결과만 신뢰하고, 앱이 보낸 생년 값은 사용하지 않는다.
 */
export interface IdentityProvider {
  readonly name: string;
  /** 인증번호 발송. 개발용 구현만 devCode를 돌려준다. */
  sendPhoneCode(phone: string): Promise<{ code: string; devCode?: string }>;
  /** 성인 확인 결과 조회. payload는 사업자별 거래 토큰 등을 담는다. */
  verifyAdult(phone: string, payload: Record<string, unknown>): Promise<{ birthYear: number; refHash: string }>;
}

/** 개발·시험 환경 전용. 인증번호는 000000 고정, 생년은 앱에서 입력한 값을 쓴다. */
class DevIdentityProvider implements IdentityProvider {
  readonly name = 'dev';
  async sendPhoneCode() {
    return { code: '000000', devCode: '000000' };
  }
  async verifyAdult(phone: string, payload: Record<string, unknown>) {
    const y = Number(payload.devBirthYear);
    if (!Number.isInteger(y) || y < 1900 || y > new Date().getFullYear()) {
      throw bad('INVALID_INPUT', '출생 연도를 확인해 주세요.');
    }
    return { birthYear: y, refHash: sha256(`dev:${phone}`) };
  }
}

export function resolveIdentityProvider(cfg: AppConfig): IdentityProvider {
  if (cfg.identityMode === 'dev') return new DevIdentityProvider();
  throw new AppError(
    503,
    'IDENTITY_NOT_CONFIGURED',
    '지금은 새로 가입할 수 없습니다. 본인확인 준비가 끝나는 대로 다시 열릴 예정입니다.',
  );
}

/** 청소년 보호법 기준(연 나이 19세 이상)으로 성인 여부를 판단한다. */
export function isAdult(birthYear: number, now = new Date()): boolean {
  return now.getFullYear() - birthYear >= 19;
}

export function ageBand(birthYear: number, now = new Date()): string {
  const age = now.getFullYear() - birthYear;
  if (age < 30) return '20대';
  if (age >= 60) return '60대 이상';
  return `${Math.floor(age / 10) * 10}대`;
}
