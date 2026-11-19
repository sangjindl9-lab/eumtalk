/**
 * 알림 설정: 저장·검증, 전체/종류별 끄기, 방해 금지 시간, 댓글 알림.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { inQuietHours, mergeNotify, NOTIFY_DEFAULTS } from '../src/push/push.service';
import { api, nick, resetDb, signup, sleep, sql, startServer } from './helpers';

let app: any;
before(async () => {
  await resetDb();
  app = (await startServer()).app;
});
after(async () => {
  await app?.close();
});

test('방해 금지 시간 계산(한국 시각, 자정 넘김)', () => {
  const p = { ...NOTIFY_DEFAULTS, quiet: true, quietStart: '23:00', quietEnd: '08:00' };
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, (h - 9 + 24) % 24, 30));
  assert.equal(inQuietHours(p, at(23)), true);
  assert.equal(inQuietHours(p, at(3)), true);
  assert.equal(inQuietHours(p, at(8)), false);
  assert.equal(inQuietHours(p, at(15)), false);
  assert.equal(inQuietHours({ ...p, quiet: false }, at(3)), false);
  const day = { ...p, quietStart: '13:00', quietEnd: '14:00' };
  assert.equal(inQuietHours(day, at(13)), true);
  assert.equal(inQuietHours(day, at(14)), false);
  // 잘못된 값은 무시
  const m = mergeNotify(null, { all: 'no', quietStart: '25:00', comment: false });
  assert.equal(m.all, true);
  assert.equal(m.quietStart, '23:00');
  assert.equal(m.comment, false);
});

test('알림 설정 저장과 발송 건너뛰기', async () => {
  const a = await signup(nick('알림'));
  const me0 = await api('GET', '/v1/me', a.token);
  assert.equal(me0.body.notify.all, true);
  const me1 = await api('PATCH', '/v1/me', a.token, { notify: { comment: false, quiet: true, quietStart: '22:30' } });
  assert.equal(me1.status, 200);
  assert.equal(me1.body.notify.comment, false);
  assert.equal(me1.body.notify.quiet, true);
  assert.equal(me1.body.notify.quietStart, '22:30');
  assert.equal(me1.body.notify.direct, true);

  const push = app.get(require('../src/push/push.service').PushService);
  await sql(`UPDATE profiles SET notify = jsonb_set(notify, '{quiet}', 'false') WHERE user_id = $1`, [a.userId]);
  await push.send([{ userId: a.userId, kind: 'comment', title: 't', body: 'b', privateBody: 'p', data: {} }]);
  await push.send([{ userId: a.userId, kind: 'message', title: 't', body: 'b', privateBody: 'p', data: {} }]);
  await api('PATCH', '/v1/me', a.token, { notify: { all: false } });
  await push.send([{ userId: a.userId, kind: 'message', title: 't', body: 'b', privateBody: 'p', data: {} }]);
  await sleep(100);
  const logs = await sql<{ kind: string; skipped: string | null }>('SELECT kind, skipped FROM push_log WHERE user_id = $1 ORDER BY id', [a.userId]);
  assert.deepEqual(logs.map((l) => [l.kind, l.skipped]), [['comment', 'off'], ['message', null], ['message', 'off']]);
});
