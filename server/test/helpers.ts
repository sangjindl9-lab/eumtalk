/** 통합 시험 공용 도구: 실제 PostgreSQL(+선택적 Redis)에 서버를 띄우고 HTTP·WebSocket으로 접속한다. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { createServer } from '../src/bootstrap';
import { loadConfig } from '../src/config';

export const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/eumtalk_test';
export const REDIS_URL = process.env.TEST_REDIS_URL || '';
export const WONJU = 'gangwon-02';
export const ADMIN = { email: 'owner@test.local', password: 'owner-password-1' };

export let PORT = 0;
export let BASE = '';
let phoneSeq = Math.floor(Math.random() * 9000000) + 1000000;
export const nextPhone = () => `010${String(phoneSeq++).padStart(8, '0')}`;

export async function resetDb() {
  const pool = new Pool({ connectionString: DB_URL });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.end();
}

/** 비어 있는 포트를 운영체제가 고르게 한다(포트 충돌로 시험이 흔들리지 않도록). opts.port 는 하위 호환용으로 무시한다. */
export async function startServer(env: Record<string, string> = {}, opts: { autoMigrate?: boolean; port?: number; primary?: boolean } = {}) {
  const cfg = loadConfig({
    APP_ENV: 'development', PORT: '0', DATABASE_URL: DB_URL, REDIS_URL, ADMIN_TOKEN: 'test-admin',
    ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, MEDIA_DIR: `/tmp/eumtalk-test-media-${process.pid}`, ...env,
  } as any);
  const app = await createServer(cfg, { logger: false, autoMigrate: opts.autoMigrate });
  const port = (app.getHttpServer().address() as any).port as number;
  cfg.port = port;
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  if (opts.primary ?? !opts.port) {
    PORT = port;
    BASE = `http://127.0.0.1:${port}`;
  }
  return { app, port, base: `http://127.0.0.1:${port}` };
}

export async function api(method: string, path: string, token?: string | null, body?: unknown, base = BASE, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-platform': 'android', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

export async function upload(token: string, query: string, bytes: Buffer, type = 'image/jpeg') {
  const res = await fetch(`${BASE}/v1/media?${query}`, { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${token}` }, body: new Uint8Array(bytes) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

export interface Account {
  token: string;
  userId: string;
  nickname: string;
  phone: string;
}

export async function signup(nickname: string, extra: Record<string, unknown> = {}, phone = nextPhone()): Promise<Account> {
  const start = await api('POST', '/v1/auth/phone/start', null, { phone });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const verify = await api('POST', '/v1/auth/phone/verify', null, { verificationId: start.body.verificationId, code: start.body.devCode });
  assert.equal(verify.body.status, 'signup');
  const adult = await api('POST', '/v1/auth/adult/verify', null, { signupToken: verify.body.signupToken, devBirthYear: 1990 });
  assert.equal(adult.status, 200, JSON.stringify(adult.body));
  const done = await api('POST', '/v1/auth/signup', null, { signupToken: verify.body.signupToken, nickname, regionId: WONJU, interestIds: ['i01', 'i09'], bio: `${nickname} 소개`, ...extra });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  return { token: done.body.token, userId: done.body.userId, nickname, phone };
}

export class Device {
  events: any[] = [];
  ws!: WebSocket;
  constructor(private readonly token: string) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/ws`);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'auth', token: this.token })));
      this.ws.on('message', (raw) => {
        const ev = JSON.parse(raw.toString());
        if (ev.type === 'ready') resolve();
        else this.events.push(ev);
      });
      this.ws.on('error', reject);
      this.ws.on('close', (code) => code === 4401 && reject(new Error('unauthorized')));
    });
  }
  disconnect() {
    this.ws.terminate();
  }
  async waitFor(type: string, pred: (d: any) => boolean = () => true, ms = 3000): Promise<any> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = this.events.find((e) => e.type === type && pred(e.data));
      if (hit) return hit.data;
      await sleep(20);
    }
    throw new Error(`이벤트 미수신: ${type}`);
  }
  count(type: string, pred: (d: any) => boolean = () => true) {
    return this.events.filter((e) => e.type === type && pred(e.data)).length;
  }
}

export const cid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nick = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;

/** a 가 인사하고 b 가 수락해 1대1 대화방을 만든다. */
export async function pair(a: Account, b: Account): Promise<string> {
  const g = await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요' });
  assert.equal(g.body.status, 'sent', JSON.stringify(g.body));
  const acc = await api('POST', `/v1/greetings/${g.body.greetingId}/accept`, b.token);
  assert.equal(acc.status, 200);
  return acc.body.conversationId;
}

export async function adminLogin(email = ADMIN.email, password = ADMIN.password): Promise<string> {
  const r = await api('POST', '/v1/admin/login', null, { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: DB_URL });
  try {
    return (await pool.query(text, params as any[])).rows;
  } finally {
    await pool.end();
  }
}

/** 시험 환경 결제: 스토어 대신 개발용 검증기를 쓴다. */
export const buy = (token: string, productId: string, tx: string, extra = '') => api('POST', '/v1/purchases/verify', token, { store: 'dev', productId, token: `dev|${tx}${extra}` });
