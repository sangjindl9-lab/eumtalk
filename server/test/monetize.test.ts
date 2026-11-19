/**
 * 수익·재방문 기능: 프로필 부스트, VIP 할인·배지, 포인트 선물, 나를 본 사람, 오늘의 추천 친구, 단체 알림.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminLogin, api, cid, nick, pair, resetDb, signup, sql, startServer } from './helpers';

let app: any;
before(async () => {
  await resetDb();
  app = (await startServer()).app;
});
after(async () => {
  await app?.close();
});

const give = (userId: string, n: number) =>
  sql(`INSERT INTO point_wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = $2`, [userId, n]);
const balance = async (token: string) => (await api('GET', '/v1/points', token)).body.balance as number;
const vip = (userId: string) =>
  sql(`INSERT INTO subscriptions (user_id, store, product_id, original_transaction_id, status, expires_at) VALUES ($1, 'dev', 'eumtalk.premium.monthly', $2, 'active', now() + interval '30 days')`, [userId, `t-${userId}`]);

test('프로필 부스트·VIP: 목록 맨 위, VIP 할인·배지, 숨김 프로필은 부스트 불가', async () => {
  const a = await signup(nick('부스트'));
  const others = [await signup(nick('이웃1')), await signup(nick('이웃2'))];
  const viewer = await signup(nick('보는이'));
  await give(a.userId, 500);
  const q0 = await api('GET', '/v1/me/boost', a.token);
  assert.equal(q0.body.unitPrice, 50);
  assert.equal(q0.body.boostUntil, null);
  const b = await api('POST', '/v1/me/boost', a.token);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.cost, 50);
  assert.equal(await balance(a.token), 450);
  // 다른 회원이 더 최근에 활동했어도 부스트한 회원이 맨 위
  for (const o of others) await api('GET', '/v1/me', o.token);
  const list = await api('GET', '/v1/nearby?sort=recent', viewer.token);
  assert.equal(list.body.items[0].userId, a.userId);
  assert.equal(list.body.items[0].boosted, true);
  assert.equal((await api('GET', '/v1/me', a.token)).body.boostUntil !== null, true);

  // VIP: 30% 할인, 배지, 나를 본 사람 무료
  await vip(a.userId);
  assert.equal((await api('GET', '/v1/me/boost', a.token)).body.unitPrice, 35);
  assert.equal((await api('GET', '/v1/me', a.token)).body.vip, true);
  const prof = await api('GET', `/v1/users/${a.userId}`, viewer.token);
  assert.equal(prof.body.profile.vip, true);

  // 주변에 내 프로필을 숨기면 부스트할 수 없다
  await api('PATCH', '/v1/me', others[0].token, { settings: { showInNearby: false } });
  await give(others[0].userId, 500);
  assert.equal((await api('POST', '/v1/me/boost', others[0].token)).status, 400);
  // 포인트 부족
  assert.equal((await api('POST', '/v1/me/boost', viewer.token)).status, 402);
});

test('포인트 선물: 1대1 대화, 한도, 차단, 메시지 표시', async () => {
  const a = await signup(nick('선물'));
  const b = await signup(nick('받는이'));
  const conv = await pair(a, b);
  await give(a.userId, 5000);
  const b0 = await balance(b.token);
  const g = await api('POST', `/v1/conversations/${conv}/gift`, a.token, { points: 100, note: '고마워요', clientMsgId: cid() });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.message.kind, 'gift');
  assert.ok(g.body.message.body.startsWith('100P를 선물했어요'));
  assert.equal(await balance(a.token), 4900);
  assert.equal(await balance(b.token), b0 + 100);
  assert.equal((await api('POST', `/v1/conversations/${conv}/gift`, a.token, { points: 5 })).status, 400);
  assert.equal((await api('POST', `/v1/conversations/${conv}/gift`, a.token, { points: 1001 })).status, 400);
  // 하루 한도 3000P
  for (let i = 0; i < 2; i++) assert.equal((await api('POST', `/v1/conversations/${conv}/gift`, a.token, { points: 1000 })).status, 200);
  assert.equal((await api('POST', `/v1/conversations/${conv}/gift`, a.token, { points: 1000 })).status, 429);
  // 차단하면 선물 불가
  await api('POST', '/v1/blocks', b.token, { userId: a.userId });
  assert.equal((await api('POST', `/v1/conversations/${conv}/gift`, a.token, { points: 10 })).status, 403);
});

test('나를 본 사람: 수는 무료, 목록은 열람권(또는 VIP), 방문 기록 끄기', async () => {
  const me = await signup(nick('주인공'));
  const v1 = await signup(nick('방문1'));
  const v2 = await signup(nick('방문2'));
  await api('GET', `/v1/users/${me.userId}`, v1.token);
  await api('GET', `/v1/users/${me.userId}`, v1.token);
  await api('PATCH', '/v1/me', v2.token, { settings: { leaveFootprints: false } });
  await api('GET', `/v1/users/${me.userId}`, v2.token);
  const s0 = await api('GET', '/v1/me/visitors', me.token);
  assert.equal(s0.body.today, 1);
  assert.equal(s0.body.unlocked, false);
  assert.equal(s0.body.items.length, 0);
  assert.equal(s0.body.price, 20);
  await give(me.userId, 100);
  const u = await api('POST', '/v1/me/visitors/unlock', me.token);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.unlocked, true);
  assert.equal(u.body.items.length, 1);
  assert.equal(u.body.items[0].profile.userId, v1.userId);
  assert.equal(await balance(me.token), 80);
  // 방문 기록을 끈 회원은 남의 방문자도 볼 수 없다
  assert.equal((await api('POST', '/v1/me/visitors/unlock', v2.token)).status, 400);
});

test('오늘의 추천 친구와 단체 알림(광고성은 동의자만·(광고) 표시)', async () => {
  const owner = await adminLogin();
  const u = await signup(nick('추천받는'));
  const c1 = await signup(nick('후보1'));
  const c2 = await signup(nick('후보2'));
  await sql(`UPDATE profiles SET last_active_at = now()`);
  await sql(`UPDATE profiles SET show_in_nearby = false WHERE user_id <> ALL($1::uuid[])`, [[u.userId, c1.userId, c2.userId]]);
  const picks = await api('GET', '/v1/me/picks', u.token);
  assert.equal(picks.status, 200);
  const ids = picks.body.items.map((p: any) => p.userId);
  assert.ok(ids.includes(c1.userId) && ids.includes(c2.userId));
  assert.ok(!ids.includes(u.userId));
  // 같은 날 다시 불러도 같은 추천
  assert.deepEqual((await api('GET', '/v1/me/picks', u.token)).body.items.map((p: any) => p.userId), ids);
  const run = await api('POST', '/v1/admin/picks/run', owner);
  assert.equal(run.status, 200);
  assert.ok(run.body.sent >= 1);
  const rec = await sql<any>(`SELECT count(*)::int AS n FROM push_log WHERE user_id = $1 AND kind = 'recommend'`, [c1.userId]);
  assert.equal(rec[0].n, 1);
  assert.equal((await api('POST', '/v1/admin/picks/run', owner)).body.sent, 0); // 하루 한 번

  // 광고성 단체 알림: 동의한 회원만
  assert.equal((await api('POST', '/v1/admin/campaigns/preview', owner, { advertising: true, target: { segment: 'all' } })).body.count, 0);
  const consent = await api('PATCH', '/v1/me', u.token, { notify: { marketing: true } });
  assert.ok(consent.body.marketingConsentAt);
  const pv = await api('POST', '/v1/admin/campaigns/preview', owner, { advertising: true, target: { segment: 'all' } });
  assert.equal(pv.body.count, 1);
  const send = await api('POST', '/v1/admin/campaigns', owner, { advertising: true, title: '주말 이벤트', body: '포인트 2배', target: { segment: 'all' } });
  if (pv.body.nightBlocked) {
    assert.equal(send.status, 400);
    assert.equal(send.body.error.code, 'NIGHT_BLOCKED');
  } else {
    assert.equal(send.status, 200, JSON.stringify(send.body));
    assert.equal(send.body.sent, 1);
    const log = await sql<any>(`SELECT title, skipped FROM push_log WHERE user_id = $1 AND kind = 'marketing'`, [u.userId]);
    assert.equal(log[0].title, '(광고) 주말 이벤트');
  }
  // 서비스 안내(비광고)는 전체, 시간 제한 없음
  const svc = await api('POST', '/v1/admin/campaigns', owner, { advertising: false, title: '점검 안내', body: '오늘 밤 점검', target: { segment: 'active', days: 7 } });
  assert.equal(svc.status, 200, JSON.stringify(svc.body));
  assert.ok(svc.body.sent >= 3);
  assert.ok((await api('GET', '/v1/admin/campaigns', owner)).body.items.length >= 1);
  // 동의 철회 시 일시가 지워진다
  assert.equal((await api('PATCH', '/v1/me', u.token, { notify: { marketing: false } })).body.marketingConsentAt, null);
});
