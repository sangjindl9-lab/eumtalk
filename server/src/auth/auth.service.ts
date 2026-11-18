import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { randomUUID } from 'crypto';
import { encrypt, hmac, randomToken, safeEqualHex, sha256 } from '../common/crypto';
import { AppError, bad, conflict, forbidden, tooMany } from '../common/errors';
import { str } from '../common/validate';
import { ContentFilter } from '../common/content-filter';
import { Db, Q } from '../db/db';
import { RateLimiter } from '../realtime/redis';
import { Realtime } from '../realtime/realtime';
import { ageBand, assertIdentityConfigured, devIdentity, fetchPortoneIdentity, isAdult, portonePage } from './identity';

const CODE_TTL_MIN = 5;
const SIGNUP_TTL_MIN = 30;
const NICKNAME = /^[가-힣a-zA-Z0-9_]{2,12}$/;

export function normalizePhone(v: unknown): string {
  const digits = String(v ?? '').replace(/\D/g, '');
  if (!/^01[016789]\d{7,8}$/.test(digits)) throw bad('INVALID_PHONE', '휴대폰 번호를 확인해 주세요.');
  return digits;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
    @Inject(Realtime) private readonly rt: Realtime,
    @Inject(ContentFilter) private readonly filter: ContentFilter,
  ) {}

  status() {
    return { signupAvailable: this.cfg.identityMode !== 'unconfigured', identityMode: this.cfg.identityMode, identityFlow: this.flow() };
  }

  /** 앱이 어떤 가입 화면을 보여줄지: code(인증번호 입력, 개발용) / web(본인인증 사업자 화면) */
  flow(): 'code' | 'web' | 'anonymous' | 'none' {
    if (this.cfg.identityMode === 'anonymous') return 'anonymous';
    if (this.cfg.identityMode === 'dev') return 'code';
    if (this.cfg.identityMode === 'live') return 'web';
    return 'none';
  }

  private requireDev() {
    assertIdentityConfigured(this.cfg);
    if (this.cfg.identityMode !== 'dev') throw bad('USE_IDENTITY_WEB', '본인인증 화면에서 인증해 주세요. 앱을 최신 버전으로 업데이트해 주세요.');
  }

  async startPhone(phoneRaw: unknown, ip: string) {
    this.requireDev();
    const phone = normalizePhone(phoneRaw);
    const phoneHash = hmac(this.cfg.phonePepper, phone);
    if (!(await this.rl.hit(`auth:phone:${phoneHash}`, 5, 600)) || !(await this.rl.hit(`auth:ip:${ip}`, this.cfg.appEnv === 'production' ? 30 : 2000, 600))) {
      throw tooMany('인증 요청이 많습니다. 10분 뒤에 다시 시도해 주세요.');
    }
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO signup_verifications (phone_hash, phone_enc, provider, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval) RETURNING id`,
      [phoneHash, encrypt(this.cfg.dataKey, phone), 'dev', sha256(`${phoneHash}:${devIdentity.code}`), String(CODE_TTL_MIN)],
    );
    return { verificationId: row!.id, expiresInSec: CODE_TTL_MIN * 60, devCode: devIdentity.code };
  }

  async verifyPhone(verificationId: string, codeRaw: unknown, platform: string | null) {
    this.requireDev();
    const code = String(codeRaw ?? '').trim();
    const v = await this.db.one<any>(
      `UPDATE signup_verifications SET attempts = attempts + 1
        WHERE id = $1 AND phone_verified_at IS NULL AND expires_at > now() RETURNING *`,
      [verificationId],
    );
    if (!v) throw bad('CODE_EXPIRED', '인증 시간이 지났습니다. 인증번호를 다시 받아 주세요.');
    if (v.attempts > 5) throw tooMany('인증번호를 여러 번 잘못 입력했습니다. 다시 받아 주세요.');
    if (!safeEqualHex(v.code_hash, sha256(`${v.phone_hash}:${code}`))) throw bad('CODE_MISMATCH', '인증번호가 맞지 않습니다.');

    return this.loginOrSignup(v.id, v.phone_hash, platform);
  }

  /** 휴대폰 확인이 끝난 뒤: 가입된 번호면 로그인, 아니면 가입 진행 토큰을 준다. */
  private async loginOrSignup(verificationId: string, phoneHash: string, platform: string | null, adult?: { birthYear: number; refHash: string; gender: string | null }) {
    const user = await this.db.one<{ id: string; status: string }>(`SELECT id, status FROM users WHERE phone_hash = $1 AND status <> 'deleted'`, [phoneHash]);
    if (user) {
      await this.db.query('UPDATE signup_verifications SET phone_verified_at = now(), consumed_at = now() WHERE id = $1', [verificationId]);
      // 정지된 회원도 로그인은 된다. 정지 중에는 조치 확인·이의신청만 할 수 있다(AuthGuard).
      const token = await this.createSession(this.db, user.id, platform);
      return { status: 'login' as const, token, userId: user.id };
    }
    const signupToken = randomToken();
    await this.db.query(
      `UPDATE signup_verifications SET phone_verified_at = now(), signup_token_hash = $2,
              expires_at = now() + ($3 || ' minutes')::interval WHERE id = $1`,
      [verificationId, sha256(signupToken), String(SIGNUP_TTL_MIN)],
    );
    if (!adult) return { status: 'signup' as const, signupToken };
    // 성인 여부는 별도 단계로 판단·기록한다.
    if (!isAdult(adult.birthYear)) {
      await this.db.query('UPDATE signup_verifications SET consumed_at = now() WHERE id = $1', [verificationId]);
      throw forbidden('NOT_ADULT', '성인 회원만 이용할 수 있는 서비스입니다.');
    }
    if (await this.db.one('SELECT 1 FROM user_private p JOIN users u ON u.id = p.user_id WHERE p.identity_ref_hash = $1 AND u.status <> $2', [adult.refHash, 'deleted'])) {
      await this.db.query('UPDATE signup_verifications SET consumed_at = now() WHERE id = $1', [verificationId]);
      throw conflict('ALREADY_MEMBER', '이미 다른 번호로 가입한 회원입니다. 기존 번호로 로그인해 주세요.');
    }
    await this.db.query(
      'UPDATE signup_verifications SET adult_verified_at = now(), birth_year = $2, identity_ref_hash = $3, gender = $4 WHERE id = $1',
      [verificationId, adult.birthYear, adult.refHash, adult.gender],
    );
    return { status: 'signup' as const, signupToken, adultVerified: true, ageBand: ageBand(adult.birthYear) };
  }

  // ── 익명 가입: 휴대폰·본인인증 없이 출생 연도와 성인 확인(자기 신고)만 받는다 ─────
  async startAnonymous(body: any, ip: string) {
    assertIdentityConfigured(this.cfg);
    if (this.cfg.identityMode !== 'anonymous') throw bad('USE_IDENTITY', '이 서버는 익명 가입을 받지 않습니다.');
    if (!(await this.rl.hit(`auth:anon:${ip}`, this.cfg.appEnv === 'production' ? 20 : 2000, 3600))) throw tooMany('가입 요청이 많습니다. 잠시 뒤에 다시 시도해 주세요.');
    const birthYear = Number(body?.birthYear);
    if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > new Date().getFullYear()) throw bad('INVALID_INPUT', '출생 연도를 확인해 주세요.');
    if (body?.adultConfirmed !== true) throw bad('ADULT_CONFIRM_REQUIRED', '성인 확인에 동의해 주세요.');
    if (!isAdult(birthYear)) throw forbidden('NOT_ADULT', '성인 회원만 이용할 수 있는 서비스입니다.');
    const signupToken = randomToken();
    await this.db.query(
      `INSERT INTO signup_verifications (provider, phone_verified_at, adult_verified_at, birth_year, signup_token_hash, expires_at)
       VALUES ('anonymous', now(), now(), $1, $2, now() + ($3 || ' minutes')::interval)`,
      [birthYear, sha256(signupToken), String(SIGNUP_TTL_MIN)],
    );
    return { status: 'signup' as const, signupToken, adultVerified: true, ageBand: ageBand(birthYear) };
  }

  // ── 본인확인 사업자(포트원) 흐름 ───────────────────────────────────────

  /** 1) 인증 시작: 앱이 열 웹 페이지 주소를 돌려준다. */
  async startIdentity(ip: string) {
    assertIdentityConfigured(this.cfg);
    if (this.cfg.identityMode !== 'live') throw bad('USE_CODE_FLOW', '시험 서버에서는 인증번호 방식으로 가입합니다.');
    if (!(await this.rl.hit(`auth:idv:${ip}`, this.cfg.appEnv === 'production' ? 30 : 2000, 600))) throw tooMany('인증 요청이 많습니다. 10분 뒤에 다시 시도해 주세요.');
    const ref = `eumtalk-${randomUUID()}`;
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO signup_verifications (provider, provider_ref, expires_at) VALUES ('portone', $1, now() + interval '20 minutes') RETURNING id`,
      [ref],
    );
    return { verificationId: row!.id, pageUrl: `${this.cfg.publicUrl}/v1/auth/identity/page?id=${encodeURIComponent(ref)}`, doneUrlPrefix: `${this.cfg.publicUrl}/v1/auth/identity/done` };
  }

  async identityPage(ref: string) {
    const v = await this.db.one(`SELECT 1 FROM signup_verifications WHERE provider_ref = $1 AND phone_verified_at IS NULL AND expires_at > now()`, [ref]);
    if (!v) return null;
    return portonePage(this.cfg, ref, this.cfg.brand.appName);
  }

  /** 2) 인증 완료: 서버가 포트원에 결과를 직접 조회하고, 휴대폰 확인 → 성인 확인을 각각 기록한다. */
  async completeIdentity(verificationId: string, platform: string | null) {
    assertIdentityConfigured(this.cfg);
    const v = await this.db.one<any>(
      `UPDATE signup_verifications SET attempts = attempts + 1
        WHERE id = $1 AND provider = 'portone' AND phone_verified_at IS NULL AND consumed_at IS NULL AND expires_at > now() RETURNING *`,
      [verificationId],
    );
    if (!v) throw bad('CODE_EXPIRED', '인증 시간이 지났습니다. 처음부터 다시 인증해 주세요.');
    if (v.attempts > 10) throw tooMany('확인 요청이 너무 많습니다. 다시 인증해 주세요.');
    const id = await fetchPortoneIdentity(this.cfg, v.provider_ref);
    const phoneHash = hmac(this.cfg.phonePepper, id.phone);
    await this.db.query('UPDATE signup_verifications SET phone_hash = $2, phone_enc = $3 WHERE id = $1', [v.id, phoneHash, encrypt(this.cfg.dataKey, id.phone)]);
    return this.loginOrSignup(v.id, phoneHash, platform, { birthYear: id.birthYear, refHash: id.refHash, gender: id.gender });
  }

  private async pendingSignup(q: Q, signupToken: unknown, lock = false) {
    if (typeof signupToken !== 'string' || !signupToken) throw bad('INVALID_INPUT', '가입 정보가 올바르지 않습니다.');
    const v = await q.one<any>(
      `SELECT * FROM signup_verifications
        WHERE signup_token_hash = $1 AND consumed_at IS NULL AND expires_at > now() AND phone_verified_at IS NOT NULL
        ${lock ? 'FOR UPDATE' : ''}`,
      [sha256(signupToken)],
    );
    if (!v) throw bad('SIGNUP_EXPIRED', '가입 시간이 지났습니다. 처음부터 다시 진행해 주세요.');
    return v;
  }

  async verifyAdult(signupToken: unknown, payload: Record<string, unknown>) {
    this.requireDev();
    const v = await this.pendingSignup(this.db, signupToken);
    const result = devIdentity.verifyAdult(v.phone_hash, payload);
    if (!isAdult(result.birthYear)) {
      await this.db.query('UPDATE signup_verifications SET consumed_at = now() WHERE id = $1', [v.id]);
      throw forbidden('NOT_ADULT', '성인 회원만 이용할 수 있는 서비스입니다.');
    }
    await this.db.query(
      'UPDATE signup_verifications SET adult_verified_at = now(), birth_year = $2, identity_ref_hash = $3 WHERE id = $1',
      [v.id, result.birthYear, result.refHash],
    );
    return { adultVerified: true, ageBand: ageBand(result.birthYear) };
  }

  async signup(body: any, platform: string | null) {
    assertIdentityConfigured(this.cfg); // 운영 환경 설정 누락 시 여기서 가입을 막는다.
    const nickname = str(body?.nickname, '닉네임', 2, 12);
    if (!NICKNAME.test(nickname)) throw bad('INVALID_NICKNAME', '닉네임은 한글·영문·숫자·밑줄 2~12자로 입력해 주세요.');
    const bio = typeof body?.bio === 'string' ? body.bio.trim().slice(0, 300) : '';
    this.filter.assertText(bio);
    let gender = ['male', 'female', 'other'].includes(body?.gender) ? body.gender : null;
    const genderPublic = gender ? body?.genderPublic === true : false;
    const regionId = String(body?.regionId || '');
    const interestIds: string[] = Array.isArray(body?.interestIds) ? [...new Set<string>(body.interestIds.map(String))].slice(0, 10) : [];

    return this.db.tx(async (q) => {
      const v = await this.pendingSignup(q, body?.signupToken, true);
      if (!v.adult_verified_at || !v.birth_year) throw forbidden('ADULT_REQUIRED', '성인 확인을 먼저 완료해 주세요.');
      if (!gender && v.gender) gender = v.gender; // 본인확인 결과의 성별(공개 여부는 회원이 정한다)
      if (!(await q.one('SELECT 1 FROM regions WHERE id = $1', [regionId]))) throw bad('INVALID_REGION', '활동 지역을 선택해 주세요.');
      if (await q.one('SELECT 1 FROM profiles WHERE lower(nickname) = lower($1)', [nickname])) {
        throw conflict('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다.');
      }
      let user: { id: string } | null;
      try {
        user = await q.one<{ id: string }>('INSERT INTO users (phone_hash) VALUES ($1) ON CONFLICT (phone_hash) DO NOTHING RETURNING id', [v.phone_hash]);
      } catch (e) {
        throw e;
      }
      if (!user) throw conflict('ALREADY_MEMBER', '이미 가입된 번호입니다. 다시 로그인해 주세요.');
      if (v.identity_ref_hash && (await q.one(`SELECT 1 FROM user_private p JOIN users u ON u.id = p.user_id WHERE p.identity_ref_hash = $1 AND u.status <> 'deleted'`, [v.identity_ref_hash]))) {
        throw conflict('ALREADY_MEMBER', '이미 다른 번호로 가입한 회원입니다. 기존 번호로 로그인해 주세요.');
      }
      await q.query(
        `INSERT INTO user_private (user_id, phone_enc, birth_year, adult_verified_at, identity_provider, identity_ref_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, v.phone_enc, v.birth_year, v.adult_verified_at, v.provider, v.identity_ref_hash],
      );
      await q.query(
        `INSERT INTO profiles (user_id, nickname, age_band, gender, gender_public, region_id, bio, avatar_color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [user.id, nickname, ageBand(v.birth_year), gender, genderPublic, regionId, bio, Math.floor(Math.random() * 8)],
      );
      if (interestIds.length) {
        await q.query(
          `INSERT INTO profile_interests (user_id, interest_id)
           SELECT $1, i.id FROM interests i WHERE i.id = ANY($2::text[])`,
          [user.id, interestIds],
        );
      }
      if (this.cfg.signupGrantPoints > 0) {
        const pts = this.cfg.signupGrantPoints;
        await q.query('INSERT INTO point_wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = point_wallets.balance + $2', [user.id, pts]);
        await q.query(
          `INSERT INTO point_ledger (user_id, delta, balance_after, type, reason, idem_key)
           VALUES ($1, $2, $2, 'grant', '시험 서버 가입 포인트', $3)`,
          [user.id, pts, `signup-grant:${user.id}`],
        );
      }
      await q.query('UPDATE signup_verifications SET consumed_at = now() WHERE id = $1', [v.id]);
      const token = await this.createSession(q, user.id, platform);
      return { token, userId: user.id };
    });
  }

  async createSession(q: Q, userId: string, platform: string | null): Promise<string> {
    const token = randomToken();
    await q.query('INSERT INTO sessions (user_id, token_hash, platform) VALUES ($1, $2, $3)', [userId, sha256(token), platform]);
    return token;
  }

  async logout(sessionId: string) {
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
    return { ok: true };
  }
}

export { AppError };
