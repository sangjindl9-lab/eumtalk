import { createHash, createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../config';
import { hmac, safeEqualHex } from '../common/crypto';

/** 비공개 저장소. 공개 주소는 없고, 권한 확인 뒤 제한 시간 링크만 발급한다. */
export interface Storage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  remove(key: string): Promise<void>;
  signedUrl(key: string, ttlSec: number): string;
}

/** 개발·시험용: 서버 디스크에 저장하고 서버가 서명 검증 후 직접 내려준다. */
export class LocalStorage implements Storage {
  constructor(private readonly cfg: AppConfig) {
    fs.mkdirSync(cfg.storage.localDir, { recursive: true });
  }
  private file(key: string) {
    return path.join(this.cfg.storage.localDir, key.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }
  private sign(key: string, exp: number) {
    return hmac(this.cfg.phonePepper + ':media', `${key}:${exp}`);
  }
  async put(key: string, body: Buffer) {
    await fs.promises.writeFile(this.file(key), body);
  }
  async remove(key: string) {
    await fs.promises.unlink(this.file(key)).catch(() => undefined);
  }
  signedUrl(key: string, ttlSec: number) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `${this.cfg.publicUrl}/v1/media-file/${encodeURIComponent(key)}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }
  /** 서명과 만료를 확인하고 파일 경로를 돌려준다. */
  verify(key: string, exp: string, sig: string): string | null {
    const e = Number(exp);
    if (!Number.isFinite(e) || e < Date.now() / 1000) return null;
    if (!/^[0-9a-f]{64}$/.test(sig || '') || !safeEqualHex(sig, this.sign(key, e))) return null;
    const f = this.file(key);
    return fs.existsSync(f) ? f : null;
  }
}

/** S3 호환 저장소(AWS S3, Cloudflare R2, MinIO 등). SigV4 사전 서명 주소를 직접 만든다. */
export class S3Storage implements Storage {
  constructor(private readonly cfg: AppConfig) {}

  private presign(method: string, key: string, ttlSec: number): string {
    const { endpoint, region, bucket, accessKey, secretKey } = this.cfg.storage.s3;
    const url = new URL(`${endpoint}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${region}/s3/aws4_request`;
    const q: [string, string][] = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${accessKey}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(ttlSec)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    const canonicalQuery = q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join('&');
    const canonical = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const h = (k: Buffer | string, v: string) => createHmac('sha256', k).update(v).digest();
    const signingKey = h(h(h(h(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async put(key: string, body: Buffer, mime: string) {
    const res = await fetch(this.presign('PUT', key, 300), { method: 'PUT', body: new Uint8Array(body), headers: { 'content-type': mime } });
    if (!res.ok) throw new Error(`저장소 업로드 실패: ${res.status}`);
  }
  async remove(key: string) {
    await fetch(this.presign('DELETE', key, 300), { method: 'DELETE' }).catch(() => undefined);
  }
  signedUrl(key: string, ttlSec: number) {
    return this.presign('GET', key, ttlSec);
  }
}

export function createStorage(cfg: AppConfig): Storage {
  return cfg.storage.driver === 's3' ? new S3Storage(cfg) : new LocalStorage(cfg);
}
