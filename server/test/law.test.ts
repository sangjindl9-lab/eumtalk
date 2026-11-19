/**
 * 수사기관 자료 제공: 접속 기록·닉네임 이력·보존 조치·근거별 범위 제한·자료 생성과 무결성·권한.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { adminLogin, api, cid, nick, pair, resetDb, signup, sleep, sql, startServer } from './helpers';

let app: any;
before(async () => {
  await resetDb();
  app = (await startServer()).app;
});
after(async () => {
  await app?.close();
});

test('수사기관 요청: 접수 → 보존 → 승인 → 자료 생성(해시 일치) → 제공 완료, 근거별 범위 제한과 권한 분리', async () => {
  const owner = await adminLogin();
  const suspect = await signup(nick('가해'));
  const victim = await signup(nick('피해'));
  const other = await signup(nick('제3자'));
  const conv = await pair(suspect, victim);
  const conv2 = await pair(suspect, other);
  await api('POST', `/v1/conversations/${conv}/messages`, suspect.token, { clientMsgId: cid(), text: '돈 보내면 사진 지워줄게' });
  await api('POST', `/v1/conversations/${conv}/messages`, victim.token, { clientMsgId: cid(), text: '그만하세요' });
  await api('POST', `/v1/conversations/${conv2}/messages`, suspect.token, { clientMsgId: cid(), text: '다른 사람과의 대화' });
  // 닉네임을 바꿔도 예전 닉네임으로 찾을 수 있어야 한다
  const oldNick = suspect.nickname;
  const newNick = nick('바뀐');
  assert.equal((await api('PATCH', '/v1/me', suspect.token, { nickname: newNick })).status, 200);
  await sleep(100);

  // 접속 기록이 남는다
  const logs = await sql('SELECT ip FROM access_logs WHERE user_id = $1', [suspect.userId]);
  assert.ok(logs.length >= 1);

  const found = await api('GET', `/v1/admin/law/users?q=${encodeURIComponent(oldNick)}`, owner);
  assert.equal(found.status, 200);
  assert.ok(found.body.items.some((u: any) => u.id === suspect.userId && u.nicknames.includes(oldNick) && u.nicknames.includes(newNick)));

  // 통신자료 제공요청으로는 대화 내용을 요청할 수 없다
  const tooMuch = await api('POST', '/v1/admin/law/requests', owner, { agency: '원주경찰서', basis: 'comm_data', scope: ['account', 'messages'], userIds: [suspect.userId] });
  assert.equal(tooMuch.body.error.code, 'SCOPE_NOT_ALLOWED');

  // 영장 접수 + 보존 조치, 대화는 피해자와의 대화로 한정
  const req = await api('POST', '/v1/admin/law/requests', owner, {
    agency: '원주경찰서 사이버수사팀',
    officer: '김수사',
    docNumber: '2026-압-1234',
    basis: 'warrant',
    scope: ['account', 'access', 'comm_meta', 'messages', 'reports'],
    userIds: [suspect.userId],
    counterpartIds: [victim.userId],
    hold: true,
  });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const id = req.body.id;

  // 보존 중 탈퇴해도 프로필 사본이 남는다
  assert.equal((await api('DELETE', '/v1/me', suspect.token, { confirm: '삭제', reason: '그냥' })).status, 200);
  const hold = await sql('SELECT snapshot FROM law_holds WHERE user_id = $1 AND released_at IS NULL', [suspect.userId]);
  assert.equal(hold[0].snapshot.nickname, newNick);

  // 승인 전에는 자료를 만들 수 없고, 확인 체크 없이 승인할 수 없다
  assert.equal((await api('POST', `/v1/admin/law/requests/${id}/exports`, owner)).body.error.code, 'INVALID_STATE');
  assert.equal((await api('POST', `/v1/admin/law/requests/${id}/approve`, owner, {})).body.error.code, 'CONFIRM_REQUIRED');
  assert.equal((await api('POST', `/v1/admin/law/requests/${id}/approve`, owner, { confirmed: true })).status, 200);

  const ex = await api('POST', `/v1/admin/law/requests/${id}/exports`, owner);
  assert.equal(ex.status, 201, JSON.stringify(ex.body));
  const json = await api('GET', `/v1/admin/law/requests/${id}/exports/${ex.body.id}?format=json`, owner);
  assert.equal(json.status, 200);
  assert.equal(createHash('sha256').update(json.body.content, 'utf8').digest('hex'), ex.body.sha256);
  const data = JSON.parse(json.body.content);
  const s = data.subjects[0];
  assert.equal(s.account.status, 'deleted');
  assert.deepEqual(s.account.nicknameHistory.map((h: any) => h.nickname), [oldNick, newNick]);
  assert.ok(s.accessLogs.length >= 1);
  const bodies = s.messages.map((m: any) => m.body);
  assert.ok(bodies.includes('돈 보내면 사진 지워줄게'));
  assert.ok(bodies.includes('그만하세요'));
  assert.ok(!bodies.includes('다른 사람과의 대화'), '대화 상대 한정 밖의 대화는 빠져야 한다');
  const html = await api('GET', `/v1/admin/law/requests/${id}/exports/${ex.body.id}`, owner);
  assert.match(html.body.content, /원주경찰서 사이버수사팀/);
  assert.match(html.body.content, new RegExp(ex.body.sha256));

  // 제공 완료 → 종결(보존 해제)
  assert.equal((await api('POST', `/v1/admin/law/requests/${id}/delivered`, owner, { method: '암호화 USB 직접 전달' })).body.status, 'delivered');
  assert.equal((await api('POST', `/v1/admin/law/requests/${id}/close`, owner, { releaseHolds: true })).body.status, 'closed');
  assert.equal((await sql('SELECT 1 FROM law_holds WHERE user_id = $1 AND released_at IS NULL', [suspect.userId])).length, 0);

  // 모든 단계가 기록된다
  const actions = (await sql(`SELECT action FROM admin_audit_log WHERE target_id = $1`, [id])).map((r: any) => r.action);
  for (const a of ['law.request.create', 'law.request.approve', 'law.export.create', 'law.export.download', 'law.request.delivered', 'law.request.close']) assert.ok(actions.includes(a), a);

  // 소유자가 아닌 관리자는 접근할 수 없다
  await api('POST', '/v1/admin/admins', owner, { email: 'lawmod@test.local', password: 'moderator-pass-1', role: 'moderator', name: '신고담당' });
  const mod = await adminLogin('lawmod@test.local', 'moderator-pass-1');
  assert.equal((await api('GET', '/v1/admin/law/requests', mod)).status, 403);
});

test('통신사실확인자료 요청은 대화 상대·일시만 주고 내용은 주지 않는다', async () => {
  const owner = await adminLogin();
  const a = await signup(nick('갑'));
  const b = await signup(nick('을'));
  const conv = await pair(a, b);
  await api('POST', `/v1/conversations/${conv}/messages`, a.token, { clientMsgId: cid(), text: '비밀 내용' });
  const req = await api('POST', '/v1/admin/law/requests', owner, { agency: '춘천경찰서', basis: 'comm_confirm', scope: ['access', 'comm_meta'], userIds: [a.userId] });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  await api('POST', `/v1/admin/law/requests/${req.body.id}/approve`, owner, { confirmed: true });
  const ex = await api('POST', `/v1/admin/law/requests/${req.body.id}/exports`, owner);
  const json = await api('GET', `/v1/admin/law/requests/${req.body.id}/exports/${ex.body.id}?format=json`, owner);
  const s = JSON.parse(json.body.content).subjects[0];
  assert.equal(s.messages, undefined);
  assert.equal(s.account, undefined);
  assert.ok(s.conversations.some((c: any) => c.otherUserIds.includes(b.userId)));
  assert.ok(!json.body.content.includes('비밀 내용'));
  assert.ok(!json.body.content.includes('안녕하세요'), '인사 내용도 빠져야 한다');
});
