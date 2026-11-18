import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type AppEnv = 'development' | 'staging' | 'production';
export type IdentityMode = 'dev' | 'live' | 'unconfigured';

export interface Brand {
  appName: string;
  appNameEn: string;
  tagline: string;
  seedColor: string;
  accentColor: string;
  operator: Record<string, string>;
}

export interface AppConfig {
  appEnv: AppEnv;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  redisUrl: string | null;
  dataKey: Buffer;
  phonePepper: string;
  identityProvider: string;
  identityMode: IdentityMode;
  adminToken: string | null;
  corsOrigins: string[];
  brand: Brand;
  problems: { key: string; message: string; blocking: boolean }[];
}

const DEV_DATA_KEY = '0'.repeat(64);
const DEV_PEPPER = 'dev-only-pepper';

function loadBrand(): Brand {
  const candidates = [
    process.env.BRAND_FILE,
    path.resolve(process.cwd(), '../brand/brand.json'),
    path.resolve(process.cwd(), 'brand/brand.json'),
    path.resolve(__dirname, '../../brand/brand.json'),
  ].filter(Boolean) as string[];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Brand;
    } catch {
      /* 다음 후보 확인 */
    }
  }
  return {
    appName: '이음톡',
    appNameEn: 'EUM TALK',
    tagline: '',
    seedColor: '#2F6B5E',
    accentColor: '#E8A33D',
    operator: {},
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = (env.APP_ENV || (env.NODE_ENV === 'production' ? 'production' : 'development')) as AppEnv;
  const appEnv: AppEnv = ['development', 'staging', 'production'].includes(raw) ? raw : 'development';
  const problems: AppConfig['problems'] = [];

  const identityProvider = (env.IDENTITY_PROVIDER || (appEnv === 'production' ? 'none' : 'dev')).toLowerCase();
  let identityMode: IdentityMode = 'unconfigured';
  if (identityProvider === 'dev') {
    if (appEnv === 'production') {
      problems.push({
        key: 'IDENTITY_PROVIDER',
        message: '운영 환경에서는 개발용 테스트 인증을 사용할 수 없습니다. 본인확인 사업자 연동 설정이 필요합니다.',
        blocking: true,
      });
    } else {
      identityMode = 'dev';
    }
  } else if (identityProvider === 'none' || identityProvider === '') {
    problems.push({
      key: 'IDENTITY_PROVIDER',
      message: '본인확인(휴대폰·성인 인증) 사업자 설정이 없어 신규 가입이 중단된 상태입니다.',
      blocking: true,
    });
  } else {
    // 실제 사업자 어댑터는 계약 후 src/auth/identity.ts 에 추가한다.
    problems.push({
      key: 'IDENTITY_PROVIDER',
      message: `본인확인 사업자 "${identityProvider}" 어댑터가 아직 구현되지 않아 신규 가입이 중단된 상태입니다.`,
      blocking: true,
    });
  }

  // DATA_KEY는 64자리 16진수를 그대로 쓰고, 그 밖의 32자 이상 문자열(Render 자동 생성값 등)은 SHA-256으로 키를 만든다.
  let dataKeyHex = env.DATA_KEY || '';
  let phonePepper = env.PHONE_PEPPER || '';
  if (dataKeyHex.length >= 32 && !/^[0-9a-fA-F]{64}$/.test(dataKeyHex)) {
    dataKeyHex = createHash('sha256').update(dataKeyHex).digest('hex');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(dataKeyHex)) {
    if (appEnv === 'production') throw new Error('DATA_KEY(64자리 16진수 또는 32자 이상 문자열)가 필요합니다.');
    if (appEnv === 'staging') problems.push({ key: 'DATA_KEY', message: 'DATA_KEY가 없어 개발용 기본 키를 사용 중입니다.', blocking: false });
    dataKeyHex = DEV_DATA_KEY;
  }
  if (!phonePepper) {
    if (appEnv === 'production') throw new Error('PHONE_PEPPER가 필요합니다.');
    if (appEnv === 'staging') problems.push({ key: 'PHONE_PEPPER', message: 'PHONE_PEPPER가 없어 개발용 기본값을 사용 중입니다.', blocking: false });
    phonePepper = DEV_PEPPER;
  }
  if (!env.REDIS_URL) {
    problems.push({
      key: 'REDIS_URL',
      message: 'Redis가 연결되지 않아 서버 1대 기준 메모리 방식으로 동작합니다. 서버를 2대 이상 운영하려면 필요합니다.',
      blocking: false,
    });
  }
  if (!env.ADMIN_TOKEN) {
    problems.push({ key: 'ADMIN_TOKEN', message: 'ADMIN_TOKEN이 없어 관리자 상태 API가 비활성화되어 있습니다.', blocking: false });
  }

  return {
    appEnv,
    port: Number(env.PORT || 3000),
    databaseUrl: env.DATABASE_URL || 'postgres://eumtalk:eumtalk@localhost:5432/eumtalk',
    databaseSsl: env.DATABASE_SSL === 'true',
    redisUrl: env.REDIS_URL || null,
    dataKey: Buffer.from(dataKeyHex, 'hex'),
    phonePepper,
    identityProvider,
    identityMode,
    adminToken: env.ADMIN_TOKEN || null,
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    brand: loadBrand(),
    problems,
  };
}

export const CONFIG = 'APP_CONFIG';
