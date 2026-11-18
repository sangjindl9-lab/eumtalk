/**
 * 1단계 통합 시험. 실제 PostgreSQL(+선택적으로 Redis)에 서버를 띄우고
 * 서로 다른 두 계정이 HTTP + WebSocket으로 연결되는 흐름을 검증한다.
 *
 *   TEST_DATABASE_URL=postgres://... [TEST_REDIS_URL=redis://...] npm test
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ADMIN, api, cid, Device, nextPhone, nick, PORT, resetDb, signup, sleep, sql, startServer, WONJU } from './helpers';

let app: any;
let prodApp: any;

before(async () => {
  await resetDb();
  app = (await startServer()).app;
});

after(async () => {
  await prodApp?.close();
  await app?.close();
});

test('가입: 휴대폰 인증과 성인 확인을 각각 거쳐야 하고, 미성년은 가입할 수 없다', async () => {
  const phone = nextPhone();
  const start = await api('POST', '/v1/auth/phone/start', null, { phone });
  const wrong = await api('POST', '/v1/auth/phone/verify', null, { verificationId: start.body.verificationId, code: '123456' });
  assert.equal(wrong.body.error.code, 'CODE_MISMATCH');
  const verify = await api('POST', '/v1/auth/phone/verify', null, { verificationId: start.body.verificationId, code: '000000' });
  const token = verify.body.signupToken;

  const early = await api('POST', '/v1/auth/signup', null, { signupToken: token, nickname: nick('미인증'), regionId: WONJU });
  assert.equal(early.body.error.code, 'ADULT_REQUIRED');

  const minor = await api('POST', '/v1/auth/adult/verify', null, { signupToken: token, devBirthYear: new Date().getFullYear() - 17 });
  assert.equal(minor.status, 403);
  assert.equal(minor.body.error.code, 'NOT_ADULT');
  const after = await api('POST', '/v1/auth/signup', null, { signupToken: token, nickname: nick('미성년'), regionId: WONJU });
  assert.equal(after.body.error.code, 'SIGNUP_EXPIRED');
});

test('가입 후 같은 번호로 다시 인증하면 로그인된다', async () => {
  const phone = nextPhone();
  const s1 = await api('POST', '/v1/auth/phone/start', null, { phone });
  const v1 = await api('POST', '/v1/auth/phone/verify', null, { verificationId: s1.body.verificationId, code: '000000' });
  await api('POST', '/v1/auth/adult/verify', null, { signupToken: v1.body.signupToken, devBirthYear: 1985 });
  const done = await api('POST', '/v1/auth/signup', null, { signupToken: v1.body.signupToken, nickname: nick('재로그인'), regionId: WONJU });
  assert.equal(done.status, 201);
  const s2 = await api('POST', '/v1/auth/phone/start', null, { phone });
  const v2 = await api('POST', '/v1/auth/phone/verify', null, { verificationId: s2.body.verificationId, code: '000000' });
  assert.equal(v2.body.status, 'login');
  assert.equal(v2.body.userId, done.body.userId);
  const me = await api('GET', '/v1/me', v2.body.token);
  assert.equal(me.body.ageBand, '40대');
  await api('POST', '/v1/auth/logout', v2.body.token);
  assert.equal((await api('GET', '/v1/me', v2.body.token)).status, 401);
});

test('운영 환경에 본인확인 설정이 없으면 가입이 중단되고 관리자 상태에 누락이 표시된다', async () => {
  const started = await startServer(
    { APP_ENV: 'production', DATA_KEY: 'ab'.repeat(32), PHONE_PEPPER: 'pepper', IDENTITY_PROVIDER: 'dev' },
    { autoMigrate: false, port: PORT + 600 },
  );
  prodApp = started.app;
  const base = started.base;
  const start = await api('POST', '/v1/auth/phone/start', null, { phone: '01012345678' }, base);
  assert.equal(start.status, 503);
  assert.equal(start.body.error.code, 'IDENTITY_NOT_CONFIGURED');
  assert.equal((await api('GET', '/v1/app-config', null, undefined, base)).body.signupAvailable, false);
  const login = await api('POST', '/v1/admin/login', null, ADMIN, base);
  const status = await api('GET', '/v1/admin/system-status', login.body.token, undefined, base);
  assert.equal(status.body.signupAvailable, false);
  assert.ok(status.body.problems.some((p: any) => p.key === 'IDENTITY_PROVIDER' && p.blocking));
  assert.ok(status.body.problems.some((p: any) => p.key === 'IAP_MODE' && p.blocking), '운영 환경에서 결제 검증 미설정도 표시');
  assert.equal((await api('GET', '/v1/admin/system-status', 'wrong', undefined, base)).status, 401);
  // 운영 환경에서는 개발용 결제 검증도 거부된다.
});

test('주변: 위치 권한 없이 원주시를 고른 회원도 서로 보이고, 좌표·거리·전화번호는 응답에 없다', async () => {
  const a = await signup(nick('주변가'));
  const b = await signup(nick('주변나'), { gender: 'female', genderPublic: false });
  const list = await api('GET', '/v1/nearby', a.token);
  const hit = list.body.items.find((i: any) => i.userId === b.userId);
  assert.ok(hit, '같은 지역 회원이 목록에 있어야 한다');
  assert.equal(hit.regionName, '강원 원주시');
  assert.equal(hit.proximity, 'same_region');
  assert.equal(hit.gender, null, '비공개 성별은 내려가지 않는다');
  assert.deepEqual(hit.commonInterests, ['등산', '맛집']);
  const raw = JSON.stringify(list.body) + JSON.stringify((await api('GET', `/v1/users/${b.userId}`, a.token)).body);
  for (const key of ['"lat"', '"lng"', 'dist', 'phone', 'birth', 'last_active', 'seen_at']) assert.ok(!raw.includes(key), `응답에 ${key} 포함`);

  // 두 사람 모두 위치를 켜면 넓은 구간 표시만 바뀐다.
  await api('PUT', '/v1/me/location', a.token, { lat: 37.3422, lng: 127.9202 });
  await api('PUT', '/v1/me/location', b.token, { lat: 37.3519, lng: 127.9457 });
  const near = (await api('GET', '/v1/nearby', a.token)).body.items.find((i: any) => i.userId === b.userId);
  assert.equal(near.proximity, 'same_neighborhood');
  assert.ok(!JSON.stringify(near).match(/37\.3|127\.9/));

  // '주변에 나 표시'를 끄면 목록에서 빠진다.
  await api('PATCH', '/v1/me', b.token, { settings: { showInNearby: false } });
  assert.ok(!(await api('GET', '/v1/nearby', a.token)).body.items.some((i: any) => i.userId === b.userId));
  // 다른 시·도 둘러보기는 잠겨 있다.
  assert.equal((await api('GET', '/v1/nearby?regionId=seoul-01', a.token)).body.error.code, 'OTHER_REGION_LOCKED');
});

test('① 인사 → 수락: 두 단말에 같은 대화방이 하나만 생기고 첫 메시지가 도착한다', async () => {
  const galaxy = await signup(nick('갤럭시'));
  const iphone = await signup(nick('아이폰'));
  const dg = new Device(galaxy.token);
  const di = new Device(iphone.token);
  await dg.connect();
  await di.connect();

  assert.equal((await api('POST', '/v1/greetings', galaxy.token, { toUserId: iphone.userId, text: '구경 오세요 http://spam.example.com' })).body.error.code, 'LINK_NOT_ALLOWED');
  const sent = await api('POST', '/v1/greetings', galaxy.token, { toUserId: iphone.userId, text: '안녕하세요, 등산 좋아하신다길래 인사드려요.' });
  assert.equal(sent.body.status, 'sent');
  const again = await api('POST', '/v1/greetings', galaxy.token, { toUserId: iphone.userId, text: '한 번 더' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'GREETING_PENDING');

  const got = await di.waitFor('greeting.received');
  assert.equal(got.greeting.sender.nickname, galaxy.nickname);
  const inbox = await api('GET', '/v1/greetings', iphone.token);
  assert.equal(inbox.body.items.length, 1);

  // 수락 버튼을 동시에 두 번 누른 상황
  const [r1, r2] = await Promise.all([
    api('POST', `/v1/greetings/${sent.body.greetingId}/accept`, iphone.token),
    api('POST', `/v1/greetings/${sent.body.greetingId}/accept`, iphone.token),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.conversationId, r2.body.conversationId);
  const convId = r1.body.conversationId;

  const cg = await dg.waitFor('conversation.created');
  const ci = await di.waitFor('conversation.created');
  assert.equal(cg.conversation.id, convId);
  assert.equal(ci.conversation.id, convId);
  assert.equal(cg.conversation.peer.nickname, iphone.nickname);
  await sleep(200);
  assert.equal(dg.count('conversation.created'), 1, '방 생성 알림은 한 번만');

  const lg = await api('GET', '/v1/conversations', galaxy.token);
  const li = await api('GET', '/v1/conversations', iphone.token);
  assert.equal(lg.body.items.length, 1);
  assert.equal(li.body.items.length, 1);
  assert.equal(li.body.items[0].unreadCount, 1);
  const msgs = await api('GET', `/v1/conversations/${convId}/messages`, iphone.token);
  assert.equal(msgs.body.items.length, 1, '인사말이 첫 메시지로 한 번만 들어간다');
  assert.equal(msgs.body.items[0].kind, 'greeting');

  // 첫 메시지 수신 (아이폰 → 갤럭시)
  const first = await api('POST', `/v1/conversations/${convId}/messages`, iphone.token, { clientMsgId: cid(), text: '반갑습니다! 치악산 자주 가세요?' });
  assert.equal(first.status, 200);
  const pushed = await dg.waitFor('message.new', (d) => d.message.id === first.body.message.id);
  assert.equal(pushed.message.body, '반갑습니다! 치악산 자주 가세요?');
  assert.equal(pushed.message.seq, 2);

  // 읽음 표시
  await api('POST', `/v1/conversations/${convId}/read`, galaxy.token, { seq: 2 });
  const read = await di.waitFor('conversation.read', (d) => d.userId === galaxy.userId);
  assert.equal(read.seq, 2);
  assert.equal((await api('GET', '/v1/conversations', galaxy.token)).body.items[0].unreadCount, 0);

  // 대화에 참여하지 않은 계정은 접근할 수 없다.
  const outsider = await signup(nick('외부인'));
  assert.equal((await api('GET', `/v1/conversations/${convId}/messages`, outsider.token)).status, 404);
  assert.equal((await api('POST', `/v1/conversations/${convId}/messages`, outsider.token, { clientMsgId: cid(), text: '침입' })).status, 404);
  dg.disconnect();
  di.disconnect();
});

test('서로 동시에 인사를 보내도 대화방은 하나만 생긴다', async () => {
  const a = await signup(nick('동시가'));
  const b = await signup(nick('동시나'));
  const [x, y] = await Promise.all([
    api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요 A입니다' }),
    api('POST', '/v1/greetings', b.token, { toUserId: a.userId, text: '안녕하세요 B입니다' }),
  ]);
  assert.deepEqual([x.body.status, y.body.status].sort(), ['matched', 'sent']);
  const la = await api('GET', '/v1/conversations', a.token);
  const lb = await api('GET', '/v1/conversations', b.token);
  assert.equal(la.body.items.length, 1);
  assert.equal(lb.body.items.length, 1);
  assert.equal(la.body.items[0].id, lb.body.items[0].id);
  const msgs = await api('GET', `/v1/conversations/${la.body.items[0].id}/messages`, a.token);
  assert.equal(msgs.body.items.length, 2);
  // 이미 방이 있으면 인사 대신 그 방을 알려준다.
  const third = await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '또 인사' });
  assert.equal(third.body.status, 'conversation');
  assert.equal(third.body.conversationId, la.body.items[0].id);
});

test('③ 통신이 끊겼다 복구돼도 메시지 누락·중복이 없다', async () => {
  const a = await signup(nick('끊김가'));
  const b = await signup(nick('끊김나'));
  const g = await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요' });
  const convId = (await api('POST', `/v1/greetings/${g.body.greetingId}/accept`, b.token)).body.conversationId;
  const db = new Device(b.token);
  await db.connect();

  const m1 = cid();
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: m1, text: '1번' });
  await db.waitFor('message.new', (d) => d.message.body === '1번');
  const lastSeen = 2;

  db.disconnect(); // 지하철 진입
  await sleep(100);
  for (const t of ['2번', '3번', '4번']) await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: t });
  // 응답을 못 받은 줄 알고 같은 메시지를 다시 보낸 상황(재전송)
  const retryId = cid();
  const [p, q] = await Promise.all([
    api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: retryId, text: '5번' }),
    api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: retryId, text: '5번' }),
  ]);
  const r = await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: retryId, text: '5번' });
  assert.equal(p.body.message.id, q.body.message.id);
  assert.equal(r.body.message.id, p.body.message.id);
  assert.equal(r.body.duplicate, true);

  const db2 = new Device(b.token); // 복구
  await db2.connect();
  const sync = await api('GET', `/v1/conversations/${convId}/messages?afterSeq=${lastSeen}`, b.token);
  assert.deepEqual(sync.body.items.map((m: any) => m.body), ['2번', '3번', '4번', '5번']);
  assert.deepEqual(sync.body.items.map((m: any) => m.seq), [3, 4, 5, 6]);
  assert.equal(sync.body.lastSeq, 6);
  assert.equal((await api('GET', '/v1/conversations', b.token)).body.items[0].unreadCount, 6); // 인사말 1 + 메시지 5, 아직 읽지 않음
  db2.disconnect();
});

test('④ 차단 직후부터 새 인사·메시지·주변 노출이 막힌다', async () => {
  const a = await signup(nick('차단가'));
  const b = await signup(nick('차단나'));
  const c = await signup(nick('차단다'));
  const db = new Device(b.token);
  await db.connect();

  // 대화 중이던 상대를 차단
  const g = await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요' });
  const convId = (await api('POST', `/v1/greetings/${g.body.greetingId}/accept`, b.token)).body.conversationId;
  await api('POST', '/v1/blocks', b.token, { userId: a.userId });
  const blockedSend = await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '차단 후 메시지' });
  assert.equal(blockedSend.status, 403);
  await sleep(200);
  assert.equal(db.count('message.new', (d) => d.message.body === '차단 후 메시지'), 0);
  assert.equal((await api('GET', '/v1/conversations', a.token)).body.items[0].canSend, false);

  // 인사 요청 화면에서 바로 차단
  const g2 = await api('POST', '/v1/greetings', c.token, { toUserId: b.userId, text: '안녕하세요' });
  await db.waitFor('greeting.received', (d) => d.greeting.id === g2.body.greetingId);
  await api('POST', `/v1/greetings/${g2.body.greetingId}/block`, b.token);
  const before = db.count('greeting.received');
  const retry = await api('POST', '/v1/greetings', c.token, { toUserId: b.userId, text: '다시 인사' });
  assert.equal(retry.status, 403);
  assert.equal(retry.body.error.code, 'CANNOT_GREET');
  await sleep(200);
  assert.equal(db.count('greeting.received'), before, '차단 후에는 인사 알림이 오지 않는다');
  assert.equal((await api('GET', '/v1/greetings', b.token)).body.items.length, 0);

  // 서로의 주변 목록과 프로필에서 빠진다.
  assert.ok(!(await api('GET', '/v1/nearby?scope=all', c.token)).body.items.some((i: any) => i.userId === b.userId));
  assert.ok(!(await api('GET', '/v1/nearby?scope=all', b.token)).body.items.some((i: any) => i.userId === c.userId));
  assert.equal((await api('GET', `/v1/users/${b.userId}`, c.token)).status, 404);
  assert.equal((await api('GET', '/v1/blocks', b.token)).body.items.length, 2);
  db.disconnect();
});

test("'새 인사 받기'를 끈 회원에게는 인사가 가지 않고, 거절 후 재발송도 막힌다", async () => {
  const a = await signup(nick('설정가'));
  const b = await signup(nick('설정나'));
  await api('PATCH', '/v1/me', b.token, { settings: { acceptGreetings: false } });
  assert.equal((await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요' })).body.error.code, 'GREETINGS_OFF');
  await api('PATCH', '/v1/me', b.token, { settings: { acceptGreetings: true } });
  const g = await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요' });
  await api('POST', `/v1/greetings/${g.body.greetingId}/decline`, b.token);
  assert.equal((await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '다시' })).body.error.code, 'CANNOT_GREET');
  const sent = await api('GET', '/v1/greetings?box=sent', a.token);
  assert.equal(sent.body.items[0].status, 'closed');
});

test('신고: 서버가 문제 메시지와 시점을 사본으로 남긴다', async () => {
  const a = await signup(nick('신고가'));
  const b = await signup(nick('신고나'));
  const g = await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요' });
  const convId = (await api('POST', `/v1/greetings/${g.body.greetingId}/accept`, b.token)).body.conversationId;
  const m = await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '문제가 되는 메시지' });
  const rep = await api('POST', '/v1/reports', b.token, { targetType: 'message', targetId: m.body.message.id, reason: 'abuse', detail: '욕설' });
  assert.equal(rep.status, 201);
  const row = (await sql('SELECT * FROM reports WHERE id = $1', [rep.body.id]))[0];
  assert.equal(row.target_user_id, a.userId);
  assert.equal(row.snapshot.body, '문제가 되는 메시지');
  assert.ok(row.snapshot.sentAt && row.snapshot.reportedAt);
  // 참여하지 않은 대화의 메시지는 신고 대상으로 조회되지 않는다.
  const c = await signup(nick('신고다'));
  assert.equal((await api('POST', '/v1/reports', c.token, { targetType: 'message', targetId: m.body.message.id, reason: 'abuse' })).status, 404);
});
