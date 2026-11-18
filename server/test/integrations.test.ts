/**
 * 외부 연동 시험: 포트원 본인인증, Google Vision 사진 판별, FCM 발송.
 * 실제 사업자 대신 같은 규격으로 응답하는 모의 서버를 띄워, 우리 서버가 요청을 올바르게 만들고 응답을 올바르게 해석하는지 확인한다.
 * (사업자 계정으로 실제 호출하는 시험은 아니다.)
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { api, cid, nick, pair, resetDb, signup, sleep, sql, startServer, upload, WONJU } from './helpers';

// ── 모의 사업자 서버 ─────────────────────────────────────────────────────
interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }
const hits: Hit[] = [];
const identities = new Map<string, any>();
let visionVerdict: Record<string, string> | 'error' = { adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', racy: 'UNLIKELY', medical: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY' };
const deadTokens = new Set<string>();
let mock: http.Server;
let MOCK = '';

function startMock() {
  return new Promise<void>((resolve) => {
    mock = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: any = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* form */ }
        hits.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
        const url = new URL(req.url!, 'http://x');
        // 포트원: GET /identity-verifications/{id}
        const m = url.pathname.match(/^\/identity-verifications\/(.+)$/);
        if (m) {
          if (req.headers.authorization !== 'PortOne test-secret') return send(401, { type: 'UNAUTHORIZED' });
          const iv = identities.get(decodeURIComponent(m[1]));
          return iv ? send(200, iv) : send(404, { type: 'IDENTITY_VERIFICATION_NOT_FOUND' });
        }
        // Google Vision
        if (url.pathname === '/v1/images:annotate') {
          if (visionVerdict === 'error') return send(500, { error: 'down' });
          return send(200, { responses: [{ safeSearchAnnotation: visionVerdict }] });
        }
        // Google OAuth 토큰
        if (url.pathname === '/token') return send(200, { access_token: 'fcm-access', expires_in: 3600 });
        // FCM
        if (/^\/v1\/projects\/test-project\/messages:send$/.test(url.pathname)) {
          if (req.headers.authorization !== 'Bearer fcm-access') return send(401, {});
          if (deadTokens.has(body?.message?.token)) return send(404, { error: { status: 'NOT_FOUND' } });
          return send(200, { name: 'projects/test-project/messages/1' });
        }
        send(404, {});
      });
    });
    mock.listen(0, '127.0.0.1', () => {
      MOCK = `http://127.0.0.1:${(mock.address() as any).port}`;
      resolve();
    });
  });
}

let app: any;
let base = '';
let liveApp: any;
let liveBase = '';

before(async () => {
  await startMock();
  await resetDb();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = JSON.stringify({ project_id: 'test-project', client_email: 'push@test-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  // 개발용 인증(가입 편의) + Vision + FCM 이 켜진 서버
  const s = await startServer({ GOOGLE_VISION_API_KEY: 'vision-key', GOOGLE_VISION_API_BASE: MOCK, PUSH_PROVIDER: 'fcm', FCM_SERVICE_ACCOUNT: sa, GOOGLE_TOKEN_URL: `${MOCK}/token`, FCM_API_BASE: MOCK });
  app = s.app;
  base = s.base;
  // 포트원 본인인증이 켜진 서버(같은 DB)
  const l = await startServer(
    { APP_ENV: 'staging', IDENTITY_PROVIDER: 'portone', PORTONE_STORE_ID: 'store-test', PORTONE_IDV_CHANNEL_KEY: 'channel-key-test', PORTONE_API_SECRET: 'test-secret', PORTONE_API_BASE: MOCK, DATA_KEY: '0'.repeat(64), PHONE_PEPPER: 'dev-only-pepper' },
    { autoMigrate: false, port: s.port + 700 },
  );
  liveApp = l.app;
  liveBase = l.base;
});

after(async () => {
  await liveApp?.close();
  await app?.close();
  mock?.close();
});

const verified = (phone: string, birthDate: string, extra: Record<string, unknown> = {}) => ({
  id: 'x',
  status: 'VERIFIED',
  verifiedCustomer: { name: '홍길동', phoneNumber: phone, birthDate, gender: 'FEMALE', isForeigner: false, ci: `ci-${phone}-${birthDate}`, di: 'di', ...extra },
});

async function startIdv() {
  const r = await api('POST', '/v1/auth/identity/start', null, {}, liveBase);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ref = new URL(r.body.pageUrl).searchParams.get('id')!;
  return { verificationId: r.body.verificationId as string, ref, pageUrl: r.body.pageUrl as string };
}

test('본인인증(포트원): 인증 페이지 → 서버가 결과를 직접 조회 → 휴대폰 확인·성인 확인을 각각 기록하고 가입', async () => {
  const cfg = await api('GET', '/v1/app-config', null, undefined, liveBase);
  assert.equal(cfg.body.identityFlow, 'web');
  // 개발용 인증번호 방식은 막힌다.
  assert.equal((await api('POST', '/v1/auth/phone/start', null, { phone: '01011112222' }, liveBase)).body.error.code, 'USE_IDENTITY_WEB');

  const s = await startIdv();
  const page = await fetch(s.pageUrl);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes('cdn.portone.io/v2/browser-sdk.js'));
  assert.ok(html.includes('"storeId":"store-test"') && html.includes('"channelKey":"channel-key-test"') && html.includes(`"identityVerificationId":"${s.ref}"`));
  assert.ok(html.includes('/v1/auth/identity/done'));
  assert.ok(!html.includes('test-secret'), 'API 비밀값은 페이지에 들어가지 않는다');

  // 인증창을 닫고 돌아온 경우(포트원에 내역 없음)
  assert.equal((await api('POST', '/v1/auth/identity/complete', null, { verificationId: s.verificationId }, liveBase)).body.error.code, 'IDENTITY_NOT_FOUND');
  // 진행 중
  identities.set(s.ref, { status: 'READY' });
  assert.equal((await api('POST', '/v1/auth/identity/complete', null, { verificationId: s.verificationId }, liveBase)).body.error.code, 'IDENTITY_NOT_VERIFIED');
  // 완료
  identities.set(s.ref, verified('010-7777-1001', '1991-05-20'));
  const done = await api('POST', '/v1/auth/identity/complete', null, { verificationId: s.verificationId }, liveBase);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'signup');
  assert.equal(done.body.adultVerified, true);
  const hit = hits.find((h) => h.url.startsWith(`/identity-verifications/${s.ref}`))!;
  assert.equal(hit.headers.authorization, 'PortOne test-secret');
  const row = (await sql('SELECT phone_verified_at, adult_verified_at, birth_year, phone_hash FROM signup_verifications WHERE id = $1', [s.verificationId]))[0];
  assert.ok(row.phone_verified_at && row.adult_verified_at && row.phone_hash, '휴대폰 확인과 성인 확인이 각각 기록된다');
  assert.equal(row.birth_year, 1991);

  const nickname = nick('본인인증');
  const sign = await api('POST', '/v1/auth/signup', null, { signupToken: done.body.signupToken, nickname, regionId: WONJU }, liveBase);
  assert.equal(sign.status, 201, JSON.stringify(sign.body));
  const me = await api('GET', '/v1/me', sign.body.token, undefined, liveBase);
  assert.equal(me.body.ageBand, '30대');
  assert.equal(me.body.gender, 'female');
  assert.equal(me.body.genderPublic, false, '본인인증의 성별은 기본 비공개');
  // 실명·생년월일·번호는 다른 회원에게 보이지 않는다.
  const other = await signup(nick('관찰자'));
  const view = await api('GET', `/v1/users/${sign.body.userId}`, other.token, undefined, base);
  assert.ok(!JSON.stringify(view.body).match(/홍길동|1991|7777/));

  // 같은 번호로 다시 인증하면 로그인
  const s2 = await startIdv();
  identities.set(s2.ref, verified('01077771001', '1991-05-20'));
  const again = await api('POST', '/v1/auth/identity/complete', null, { verificationId: s2.verificationId }, liveBase);
  assert.equal(again.body.status, 'login');
  assert.equal(again.body.userId, sign.body.userId);
  // 이미 쓴 인증 건은 다시 쓸 수 없다.
  assert.equal((await api('POST', '/v1/auth/identity/complete', null, { verificationId: s2.verificationId }, liveBase)).body.error.code, 'CODE_EXPIRED');
  // 같은 사람(CI)이 다른 번호로 또 가입하려는 경우
  const s3 = await startIdv();
  identities.set(s3.ref, verified('01077779999', '1991-05-20', { ci: 'ci-010-7777-1001-1991-05-20' }));
  assert.equal((await api('POST', '/v1/auth/identity/complete', null, { verificationId: s3.verificationId }, liveBase)).body.error.code, 'ALREADY_MEMBER');
});

test('본인인증(포트원): 미성년·외국인·정보 누락은 가입할 수 없다', async () => {
  const thisYear = new Date().getFullYear();
  const minor = await startIdv();
  identities.set(minor.ref, verified('01077772001', `${thisYear - 18}-12-31`));
  const r = await api('POST', '/v1/auth/identity/complete', null, { verificationId: minor.verificationId }, liveBase);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'NOT_ADULT');
  const row = (await sql('SELECT phone_verified_at, adult_verified_at, consumed_at FROM signup_verifications WHERE id = $1', [minor.verificationId]))[0];
  assert.ok(row.phone_verified_at && !row.adult_verified_at && row.consumed_at, '휴대폰은 확인됐지만 성인 확인은 기록되지 않는다');

  const fg = await startIdv();
  identities.set(fg.ref, verified('01077772002', '1990-01-01', { isForeigner: true }));
  assert.equal((await api('POST', '/v1/auth/identity/complete', null, { verificationId: fg.verificationId }, liveBase)).body.error.code, 'FOREIGNER_NOT_SUPPORTED');

  const bad = await startIdv();
  identities.set(bad.ref, { status: 'VERIFIED', verifiedCustomer: { name: '이름만' } });
  assert.equal((await api('POST', '/v1/auth/identity/complete', null, { verificationId: bad.verificationId }, liveBase)).body.error.code, 'IDENTITY_INCOMPLETE');
});

test('사진 판별(Vision): 공개 사진은 게시 전에 검사하고, 선정적이거나 검사에 실패하면 올라가지 않는다', async () => {
  const u = await signup(nick('사진판별'), {}, undefined);
  const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 120, b: 80 } } }).jpeg().toBuffer();
  visionVerdict = { adult: 'VERY_UNLIKELY', violence: 'UNLIKELY', racy: 'POSSIBLE', medical: 'VERY_UNLIKELY', spoof: 'UNLIKELY' };
  const okUp = await upload(u.token, 'purpose=profile', photo);
  assert.equal(okUp.status, 201, JSON.stringify(okUp.body));
  const call = hits.filter((h) => h.url.startsWith('/v1/images:annotate')).at(-1)!;
  assert.ok(call.url.includes('key=vision-key'));
  assert.equal(call.body.requests[0].features[0].type, 'SAFE_SEARCH_DETECTION');
  // 서버가 다시 인코딩한(EXIF 제거된) 사진을 보낸다.
  assert.equal((await sharp(Buffer.from(call.body.requests[0].image.content, 'base64')).metadata()).format, 'jpeg');
  assert.equal((await sql('SELECT moderation FROM media WHERE id = $1', [okUp.body.id]))[0].moderation.racy, 'POSSIBLE');

  visionVerdict = { adult: 'LIKELY', violence: 'VERY_UNLIKELY', racy: 'LIKELY', medical: 'UNLIKELY', spoof: 'UNLIKELY' };
  const blocked = await upload(u.token, 'purpose=post', photo);
  assert.equal(blocked.body.error.code, 'CONTENT_BLOCKED');
  assert.equal(blocked.body.error.message, '선정적인 사진은 올릴 수 없습니다.');
  visionVerdict = { adult: 'UNLIKELY', violence: 'VERY_LIKELY', racy: 'UNLIKELY', medical: 'UNLIKELY', spoof: 'UNLIKELY' };
  assert.equal((await upload(u.token, 'purpose=room', photo)).body.error.message, '폭력적인 사진은 올릴 수 없습니다.');
  visionVerdict = 'error';
  assert.equal((await upload(u.token, 'purpose=profile', photo)).body.error.code, 'CONTENT_BLOCKED', '판별 서비스 장애 시에도 공개 사진은 막힌다');
  // 대화 사진(비공개)은 판별하지 않는다.
  const peer = await signup(nick('사진상대'));
  const conv = await pair(u, peer);
  const before = hits.filter((h) => h.url.startsWith('/v1/images:annotate')).length;
  assert.equal((await upload(u.token, `purpose=chat&conversationId=${conv}`, photo)).status, 201);
  assert.equal(hits.filter((h) => h.url.startsWith('/v1/images:annotate')).length, before);
  assert.equal(Number((await sql(`SELECT count(*) AS n FROM media WHERE owner_id = $1`, [u.userId]))[0].n), 2, '막힌 사진은 저장되지 않는다');
  visionVerdict = { adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', racy: 'UNLIKELY', medical: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY' };
});

test('FCM 발송: 기기 토큰으로 보내고, 미리보기 끄면 내용 없이, 차단·알림 끄기면 보내지 않으며, 만료 토큰은 지운다', async () => {
  const a = await signup(nick('푸시보냄'));
  const b = await signup(nick('푸시받음'));
  const token = `fcm-${cid()}-device-token`;
  await api('POST', '/v1/devices', b.token, { token, platform: 'android' });
  const convId = await pair(a, b);
  const fcmFor = () => hits.filter((h) => h.url.endsWith('/messages:send') && h.body?.message?.token === token);
  const waitFcm = async (n: number) => {
    for (let i = 0; i < 100 && fcmFor().length < n; i++) await sleep(20);
    return fcmFor();
  };
  assert.equal((await waitFcm(1)).length, 1, '인사 알림');
  const g = fcmFor()[0].body.message;
  assert.equal(g.data.kind, 'greeting');

  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '치악산 가실래요?' });
  const m = (await waitFcm(2))[1].body.message;
  assert.equal(m.notification.title, a.nickname);
  assert.equal(m.notification.body, '치악산 가실래요?');
  assert.equal(m.data.conversationId, convId, '알림을 누르면 열 방');
  assert.equal(m.data.kind, 'message');
  const tokenCall = hits.find((h) => h.url === '/token')!;
  assert.ok(String(tokenCall.body).includes('grant_type=') && String(tokenCall.body).includes('assertion='), '서비스 계정 JWT로 접근 토큰을 받는다');

  await api('PATCH', '/v1/me', b.token, { settings: { pushPreview: false } });
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '잠금화면 비밀' });
  const p = (await waitFcm(3))[2].body.message;
  assert.equal(p.notification.body, '새 메시지가 도착했습니다.');
  assert.ok(!JSON.stringify(p).includes('잠금화면 비밀'));

  await api('POST', `/v1/conversations/${convId}/mute`, b.token, { muted: true });
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '알림 끈 방' });
  await api('POST', `/v1/conversations/${convId}/mute`, b.token, { muted: false });
  await api('POST', '/v1/blocks', b.token, { userId: a.userId });
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '차단 후' });
  await sleep(300);
  assert.equal(fcmFor().length, 3, '알림 끄기·차단 이후에는 발송되지 않는다');

  // 만료된 토큰은 지운다.
  const c = await signup(nick('푸시셋'));
  const dead = `fcm-${cid()}-dead-token`;
  deadTokens.add(dead);
  await api('POST', '/v1/devices', c.token, { token: dead, platform: 'ios' });
  await api('POST', '/v1/greetings', a.token, { toUserId: c.userId, text: '안녕하세요' });
  for (let i = 0; i < 100 && (await sql('SELECT 1 FROM device_tokens WHERE token = $1', [dead])).length; i++) await sleep(20);
  assert.equal((await sql('SELECT 1 FROM device_tokens WHERE token = $1', [dead])).length, 0);
});

test('익명 가입: 본인인증 없이 출생 연도·성인 확인(자기 신고)만으로 가입하고, 미성년·확인 누락은 막는다', async () => {
  const a = await startServer({ APP_ENV: 'production', IDENTITY_PROVIDER: 'anonymous', DATA_KEY: '1'.repeat(64), PHONE_PEPPER: 'anon-pepper', ADMIN_TOKEN: 'x'.repeat(32) }, { autoMigrate: false, port: 1 });
  try {
    const cfg = await api('GET', '/v1/auth/status', null, undefined, a.base);
    assert.equal(cfg.body.identityFlow, 'anonymous');
    assert.equal(cfg.body.signupAvailable, true);
    assert.equal((await api('POST', '/v1/auth/phone/start', null, { phone: '01011113333' }, a.base)).status, 400);
    const minorYear = new Date().getFullYear() - 17;
    assert.equal((await api('POST', '/v1/auth/anonymous/start', null, { birthYear: minorYear, adultConfirmed: true }, a.base)).body.error.code, 'NOT_ADULT');
    assert.equal((await api('POST', '/v1/auth/anonymous/start', null, { birthYear: 1990 }, a.base)).body.error.code, 'ADULT_CONFIRM_REQUIRED');
    const st = await api('POST', '/v1/auth/anonymous/start', null, { birthYear: 1990, adultConfirmed: true }, a.base);
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.status, 'signup');
    const su = await api('POST', '/v1/auth/signup', null, { signupToken: st.body.signupToken, nickname: nick('익명'), regionId: WONJU, interestIds: [] }, a.base);
    assert.equal(su.status, 201, JSON.stringify(su.body));
    const me = await api('GET', '/v1/me', su.body.token, undefined, a.base);
    assert.equal(me.status, 200);
    const priv = await sql('SELECT p.identity_provider, p.phone_enc, u.phone_hash FROM user_private p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1', [su.body.userId]);
    assert.equal(priv[0].identity_provider, 'anonymous');
    assert.equal(priv[0].phone_enc, null);
    assert.equal(priv[0].phone_hash, null);
    // 같은 가입 토큰은 다시 쓸 수 없다
    assert.equal((await api('POST', '/v1/auth/signup', null, { signupToken: st.body.signupToken, nickname: nick('익명'), regionId: WONJU }, a.base)).status, 400);
  } finally {
    await a.app.close();
  }
});
