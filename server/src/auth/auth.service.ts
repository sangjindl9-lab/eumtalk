import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { encrypt, hmac, randomToken, safeEqualHex, sha256 } from '../common/crypto';
import { AppError, bad, conflict, forbidden, tooMany } from '../common/errors';
import { str } from '../common/validate';
import { Db, Q } from '../db/db';
import { RateLimiter } from '../realtime/redis';
import { Realtime } from '../realtime/realtime';
import { ageBand, isAdult, resolveIdentityProvider } from './identity';

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
  ) {}

  status() {
    return { signupAvailable: this.cfg.identityMode !== 'unconfigured', identityMode: this.cfg.identityMode };
  }

  async startPhone(phoneRaw: unknown, ip: string) {
    const provider = resolveIdentityProvider(this.cfg);
    const phone = normalizePhone(phoneRaw);
    const phoneHash = hmac(this.cfg.phonePepper, phone);
    if (!(await this.rl.hit(`auth:phone:${phoneHash}`, 5, 600)) || !(await this.rl.hit(`auth:ip:${ip}`, 30, 600))) {
      throw tooMany('인증 요청이 많습니다. 10분 뒤에 다시 시도해 주세요.');
    }
    const sent = await provider.sendPhoneCode(phone);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO signup_verifications (phone_hash, phone_enc, provider, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval) RETURNING id`,
      [phoneHash, encrypt(this.cfg.dataKey, phone), provider.name, sha256(`${phoneHash}:${sent.code}`), String(CODE_TTL_MIN)],
    );
    return { verificationId: row!.id, expiresInSec: CODE_TTL_MIN * 60, ...(sent.devCode ? { devCode: sent.devCode } : {}) };
  }

  async verifyPhone(verificationId: string, codeRaw: unknown, platform: string | null) {
    const code = String(codeRaw ?? '').trim();
    const v = await this.db.one<any>(
      `UPDATE signup_verifications SET attempts = attempts + 1
        WHERE id = $1 AND phone_verified_at IS NULL AND expires_at > now() RETURNING *`,
      [verificationId],
    );
    if (!v) throw bad('CODE_EXPIRED', '인증 시간이 지났습니다. 인증번호를 다시 받아 주세요.');
    if (v.attempts > 5) throw tooMany('인증번호를 여러 번 잘못 입력했습니다. 다시 받아 주세요.');
    if (!safeEqualHex(v.code_hash, sha256(`${v.phone_hash}:${code}`))) throw bad('CODE_MISMATCH', '인증번호가 맞지 않습니다.');

    const user = await this.db.one<{ id: string; status: string }>('SELECT id, status FROM users WHERE phone_hash = $1', [v.phone_hash]);
    if (user) {
      await this.db.query('UPDATE signup_verifications SET phone_verified_at = now(), consumed_at = now() WHERE id = $1', [v.id]);
      if (user.status === 'suspended') throw forbidden('SUSPENDED', '이용이 정지된 계정입니다.');
      const token = await this.createSession(this.db, user.id, platform);
      return { status: 'login' as const, token, userId: user.id };
    }
    const signupToken = randomToken();
    await this.db.query(
      `UPDATE signup_verifications SET phone_verified_at = now(), signup_token_hash = $2,
              expires_at = now() + ($3 || ' minutes')::interval WHERE id = $1`,
      [v.id, sha256(signupToken), String(SIGNUP_TTL_MIN)],
    );
    return { status: 'signup' as const, signupToken };
  }

  private async pendingSignup(q: Q, signupToken: unknown, lock = false) {
    if (typeof signupToken !== 'string' || !signupToken) throw bad('INVALID_INPUT', '가입 정보가 올바르지 않습니다.');
    const v = await q.one<any>(
      `SELECT * FROM signup_verifications
        WHERE signup_token_hash = $1 AND consumed_at IS NULL AND expires_at > now() AND phone_verified_at IS NOT NULL
        ${lock ? 'FOR UPDATE' : ''}`,
      [sha256(signupToken)],
    );
    if (!v) throw bad('SIGNUP_EXPIRED', '가입 시간이 지났습니다. 휴대폰 인증부터 다시 진행해 주세요.');
    return v;
  }

  async verifyAdult(signupToken: unknown, payload: Record<string, unknown>) {
    const provider = resolveIdentityProvider(this.cfg);
    const v = await this.pendingSignup(this.db, signupToken);
    const result = await provider.verifyAdult(v.phone_hash, payload);
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
    resolveIdentityProvider(this.cfg); // 운영 환경 설정 누락 시 여기서 가입을 막는다.
    const nickname = str(body?.nickname, '닉네임', 2, 12);
    if (!NICKNAME.test(nickname)) throw bad('INVALID_NICKNAME', '닉네임은 한글·영문·숫자·밑줄 2~12자로 입력해 주세요.');
    const bio = typeof body?.bio === 'string' ? body.bio.trim().slice(0, 300) : '';
    const gender = ['male', 'female', 'other'].includes(body?.gender) ? body.gender : null;
    const genderPublic = gender ? body?.genderPublic === true : false;
    const regionId = String(body?.regionId || '');
    const interestIds: string[] = Array.isArray(body?.interestIds) ? [...new Set<string>(body.interestIds.map(String))].slice(0, 10) : [];

    return this.db.tx(async (q) => {
      const v = await this.pendingSignup(q, body?.signupToken, true);
      if (!v.adult_verified_at || !v.birth_year) throw forbidden('ADULT_REQUIRED', '성인 확인을 먼저 완료해 주세요.');
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
