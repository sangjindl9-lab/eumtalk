/**
 * 성장 기능: 초대 코드(가입 시·가입 후), 초대한 회원 보상 조건(다음 날 출석·같은 IP 차단),
 * 출석 체크(하루 한 번·연속 보너스), 관리자 통계·설정, 공개 초대 페이지.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminLogin, api, BASE, nick, resetDb, signup, sql, startServer } from './helpers';

let app: any;
before(async () => {
  await resetDb();
  app = (await startServer()).app;
});
after(async () => {
  await app?.close();
});

const balance = async (token: string) => (await api('GET', '/v1/points', token)).body.balance as number;

test('친구 초대: 가입 보상, 다음 날 출석 시 초대한 회원 보상, 같은 IP 차단', async () => {
  const a = await signup(nick('초대'));
  const inv = await api('GET', '/v1/me/invite', a.token);
  assert.equal(inv.status, 200);
  assert.match(inv.body.code, /^[A-Z0-9]{6}$/);
  assert.ok(inv.body.link.endsWith(`/i/${inv.body.code}`));
  assert.ok(inv.body.shareText.includes(inv.body.code));

  // 가입 전 코드 확인(공개)
  assert.equal((await api('GET', `/v1/invite/check?code=${inv.body.code.toLowerCase()}`)).body.valid, true);
  assert.equal((await api('GET', '/v1/invite/check?code=ZZZZZZ')).body.valid, false);

  // 잘못된 코드로 가입해도 가입은 된다
  const x = await signup(nick('잘못'), { inviteCode: 'ZZZZZZ' });
  assert.equal((await api('GET', '/v1/me/invite', x.token)).body.redeemedCode, null);

  const b0 = await balance(a.token);
  const b = await signup(nick('친구'), { inviteCode: inv.body.code });
  const bInv = (await api('GET', '/v1/me/invite', b.token)).body;
  assert.equal(bInv.redeemedCode, inv.body.code);
  assert.equal(bInv.canRedeem, false);
  const ledgerB = (await api('GET', '/v1/points/ledger', b.token)).body.items;
  assert.ok(ledgerB.some((l: any) => l.reason === '친구 초대 가입 보상' && l.delta === 50));

  // 가입 당일 출석 → 아직 초대 보상 없음
  const c1 = await api('POST', '/v1/me/attendance', b.token);
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal((await api('GET', '/v1/me/invite', a.token)).body.pending, 1);
  assert.equal(await balance(a.token), b0);

  // 다음 날 다시 와서 출석했다고 가정. 같은 IP(로컬)라서 차단된다.
  await api('GET', '/v1/me', a.token); // 접속 기록(IP) 남기기
  await sql(`UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1`, [b.userId]);
  await sql(`UPDATE attendance SET day = day - 1 WHERE user_id = $1`, [b.userId]);
  assert.equal((await api('POST', '/v1/me/attendance', b.token)).status, 200);
  const [r1] = await sql<any>('SELECT status, note FROM referrals WHERE invitee_id = $1', [b.userId]);
  assert.equal(r1.status, 'blocked');
  assert.equal(r1.note, '같은 IP에서 가입');
  assert.equal(await balance(a.token), b0);

  // 다른 IP에서 가입한 친구는 보상
  const c = await signup(nick('친구둘'));
  const red = await api('POST', '/v1/me/invite/redeem', c.token, { code: inv.body.code });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  assert.equal(red.body.reward, 50);
  assert.equal((await api('POST', '/v1/me/invite/redeem', c.token, { code: inv.body.code })).body.error?.code ?? 'x', 'ALREADY_INVITED');
  await sql(`UPDATE referrals SET invitee_ip = '10.9.9.9' WHERE invitee_id = $1`, [c.userId]);
  await sql(`UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1`, [c.userId]);
  assert.equal((await api('POST', '/v1/me/attendance', c.token)).status, 200);
  assert.equal(await balance(a.token), b0 + 100);
  const aInv = (await api('GET', '/v1/me/invite', a.token)).body;
  assert.equal(aInv.rewarded, 1);
  assert.equal(aInv.earned, 100);

  // 자기 코드, 서로 초대, 기간 지난 입력은 거절
  assert.equal((await api('POST', '/v1/me/invite/redeem', x.token, { code: (await api('GET', '/v1/me/invite', x.token)).body.code })).status, 400);
  assert.equal((await api('POST', '/v1/me/invite/redeem', a.token, { code: bInv.code })).status, 400);
  await sql(`UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1`, [x.userId]);
  const late = await api('POST', '/v1/me/invite/redeem', x.token, { code: inv.body.code });
  assert.equal(late.status, 400);

  // 공개 초대 페이지
  const page = await fetch(`${BASE}/i/${inv.body.code}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes(inv.body.code));
  assert.ok(html.includes('play.google.com'));
});

test('출석 체크: 하루 한 번, 연속 보너스, 관리자 통계·설정·공지 푸시', async () => {
  const owner = await adminLogin();
  const set = await api('POST', '/v1/admin/growth/settings', owner, { streakDays: 3, streakBonus: 20, attendancePoints: 7 });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await api('POST', '/v1/admin/growth/settings', owner, { streakDays: 1 })).status, 400);

  const u = await signup(nick('출석'));
  const st0 = (await api('GET', '/v1/me/attendance', u.token)).body;
  assert.equal(st0.checkedToday, false);
  assert.equal(st0.week.length, 7);
  // 이틀 연속 출석한 상태를 만든다
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  await sql(`INSERT INTO attendance (user_id, day, streak, points) VALUES ($1, $2::date - 2, 1, 7), ($1, $2::date - 1, 2, 7)`, [u.userId, today]);
  assert.equal((await api('GET', '/v1/me/attendance', u.token)).body.daysToBonus, 1);
  const b0 = await balance(u.token);
  const r = await api('POST', '/v1/me/attendance', u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.streak, 3);
  assert.equal(r.body.points, 27);
  assert.equal(await balance(u.token), b0 + 27);
  assert.equal(r.body.status.checkedToday, true);
  assert.equal((await api('POST', '/v1/me/attendance', u.token)).status, 409);

  const stats = await api('GET', '/v1/admin/growth?days=7', owner);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.daily.length, 7);
  assert.ok(stats.body.daily[0].attendance >= 1);
  assert.equal(stats.body.settings.streakDays, 3);

  const ann = await api('POST', '/v1/admin/announcements', owner, { title: '출석 이벤트', body: '매일 출석하고 포인트 받으세요' });
  const id = ann.body.id;
  const p1 = await api('POST', `/v1/admin/announcements/${id}/push`, owner);
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.ok(p1.body.sent >= 1);
  assert.equal((await api('POST', `/v1/admin/announcements/${id}/push`, owner)).status, 409);
  const logs = await sql<any>(`SELECT count(*)::int AS n FROM push_log WHERE user_id = $1 AND kind = 'notice' AND title = '출석 이벤트'`, [u.userId]);
  assert.equal(logs[0].n, 1);
  // 회원은 관리자 통계를 볼 수 없다
  assert.equal((await api('GET', '/v1/admin/growth', u.token)).status, 401);
});
