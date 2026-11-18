import { AppConfig } from '../config';
import { AppError, bad } from '../common/errors';
import { sha256 } from '../common/crypto';

/**
 * 본인확인 사업자 어댑터.
 *  - dev: 개발·시험 전용. 인증번호 000000, 출생 연도는 앱에서 입력한 값.
 *  - portone: 포트원 V2 본인인증(다날·KG이니시스·KCP 등 계약한 채널). 인증창에서 휴대폰 소유를 확인하고,
 *    서버가 포트원 API로 결과를 직접 다시 조회해 번호·생년월일을 얻는다. 앱이 보낸 값은 쓰지 않는다.
 * 휴대폰 번호 확인과 성인 여부 판단은 서로 다른 단계로 기록한다(phone_verified_at / adult_verified_at).
 */
export interface VerifiedIdentity {
  phone: string; // 숫자만
  birthYear: number;
  birthDate: string | null; // YYYY-MM-DD
  gender: 'male' | 'female' | null;
  refHash: string; // 사람 단위 식별값(CI)의 해시
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

export function assertIdentityConfigured(cfg: AppConfig) {
  if (cfg.identityMode === 'unconfigured') {
    throw new AppError(503, 'IDENTITY_NOT_CONFIGURED', '지금은 새로 가입할 수 없습니다. 본인확인 준비가 끝나는 대로 다시 열릴 예정입니다.');
  }
}

export const devIdentity = {
  code: '000000',
  verifyAdult(phoneHash: string, payload: Record<string, unknown>) {
    const y = Number(payload.devBirthYear);
    if (!Number.isInteger(y) || y < 1900 || y > new Date().getFullYear()) throw bad('INVALID_INPUT', '출생 연도를 확인해 주세요.');
    return { birthYear: y, refHash: sha256(`dev:${phoneHash}`) };
  },
};

/** 포트원 V2 본인인증 결과 조회 */
export async function fetchPortoneIdentity(cfg: AppConfig, identityVerificationId: string): Promise<VerifiedIdentity> {
  let res: Response;
  try {
    res = await fetch(`${cfg.portone.apiBase}/identity-verifications/${encodeURIComponent(identityVerificationId)}?storeId=${encodeURIComponent(cfg.portone.storeId)}`, {
      headers: { authorization: `PortOne ${cfg.portone.apiSecret}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new AppError(503, 'IDENTITY_UNAVAILABLE', '본인확인 기관에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) throw bad('IDENTITY_NOT_FOUND', '본인인증 내역을 찾을 수 없습니다. 다시 인증해 주세요.');
    throw new AppError(503, 'IDENTITY_UNAVAILABLE', '본인확인 결과를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  const iv = json.identityVerification ?? json;
  if (iv.status !== 'VERIFIED') throw bad('IDENTITY_NOT_VERIFIED', '본인인증이 완료되지 않았습니다.');
  const c = iv.verifiedCustomer ?? {};
  const phone = String(c.phoneNumber ?? '').replace(/\D/g, '');
  const birthDate = typeof c.birthDate === 'string' ? c.birthDate : null;
  const birthYear = birthDate ? Number(birthDate.slice(0, 4)) : NaN;
  if (!/^01[016789]\d{7,8}$/.test(phone) || !Number.isInteger(birthYear)) {
    throw bad('IDENTITY_INCOMPLETE', '본인인증 결과에 휴대폰 번호 또는 생년월일이 없습니다. 다시 인증해 주세요.');
  }
  if (c.isForeigner === true) {
    // 외국인 회원 허용 여부는 운영 정책에 따라 바꿀 수 있다. 출시 기본안은 국내 회원 전용.
    throw new AppError(403, 'FOREIGNER_NOT_SUPPORTED', '현재는 내국인 회원만 가입할 수 있습니다.');
  }
  const ref = String(c.ci || c.di || `${phone}:${birthDate}`);
  return {
    phone,
    birthYear,
    birthDate,
    gender: c.gender === 'MALE' ? 'male' : c.gender === 'FEMALE' ? 'female' : null,
    refHash: sha256(`portone:${ref}`),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** 앱 웹뷰가 여는 인증 페이지. 포트원 브라우저 SDK로 인증창을 띄우고 완료되면 done 주소로 이동한다. */
export function portonePage(cfg: AppConfig, identityVerificationId: string, appName: string): string {
  const params = {
    storeId: cfg.portone.storeId,
    identityVerificationId,
    channelKey: cfg.portone.channelKey,
    redirectUrl: `${cfg.publicUrl}/v1/auth/identity/done`,
    forceRedirect: true,
    // 다날 채널은 최소 나이를 인증창에서도 제한할 수 있다(서버에서도 다시 판단한다).
    bypass: { danal: { AGELIMIT: 19 } },
  };
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(appName)} 본인인증</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#1c1e1d}p{color:#5b605e}</style>
<script src="https://cdn.portone.io/v2/browser-sdk.js"></script></head>
<body><main><p id="msg">본인인증 창을 여는 중입니다</p></main>
<script>
(async function () {
  var params = ${JSON.stringify(params)};
  try {
    var r = await PortOne.requestIdentityVerification(params);
    var q = r && r.code ? '&code=' + encodeURIComponent(r.code) + '&message=' + encodeURIComponent(r.message || '') : '';
    location.replace(params.redirectUrl + '?identityVerificationId=' + encodeURIComponent(params.identityVerificationId) + q);
  } catch (e) {
    location.replace(params.redirectUrl + '?identityVerificationId=' + encodeURIComponent(params.identityVerificationId) + '&code=SDK_ERROR&message=' + encodeURIComponent(String(e && e.message || e)));
  }
})();
</script></body></html>`;
}

export const DONE_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>본인인증</title></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><p>본인인증 결과를 확인하고 있습니다. 앱으로 돌아가 주세요.</p></body></html>`;
