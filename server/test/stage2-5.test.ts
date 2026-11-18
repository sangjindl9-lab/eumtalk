/** 2~5단계 통합 시험: 사진, 그룹방, 푸시, 게시판·장터, 포인트·구독, 신고 처리, 계정 삭제 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { adminLogin, api, buy, cid, Device, nick, pair, resetDb, signup, sleep, sql, startServer, upload, WONJU } from './helpers';

let app: any;
before(async () => {
  await resetDb();
  app = (await startServer()).app;
});
after(async () => {
  await app?.close();
});

const photoWithGps = () =>
  sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 140, b: 120 } } })
    .withExif({ IFD0: { Copyright: 'tester', Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 20/1 30/1', GPSLongitudeRef: 'E', GPSLongitude: '127/1 55/1 12/1' } })
    .jpeg()
    .toBuffer();

const pushCount = async (userId: string, kind?: string) =>
  Number((await sql('SELECT count(*) AS n FROM push_log WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)', [userId, kind ?? null]))[0].n);

test('② 사진: 참여자는 열 수 있고, 참여하지 않은 계정은 접근할 수 없으며, 촬영 위치 정보는 제거된다', async () => {
  const iphone = await signup(nick('사진가'));
  const galaxy = await signup(nick('사진나'));
  const outsider = await signup(nick('사진다'));
  const src = await photoWithGps();
  assert.ok((await sharp(src).metadata()).exif, '원본에는 EXIF(GPS)가 있다');

  // 수락 전(대화방 없음)에는 대화 사진을 올릴 수 없다.
  assert.equal((await upload(iphone.token, 'purpose=chat', src)).status, 403);
  const convId = await pair(iphone, galaxy);
  assert.equal((await upload(outsider.token, `purpose=chat&conversationId=${convId}`, src)).status, 403);
  assert.equal((await upload(iphone.token, `purpose=chat&conversationId=${convId}`, Buffer.from('이것은 사진이 아님'))).body.error.code, 'INVALID_IMAGE');

  const up = await upload(iphone.token, `purpose=chat&conversationId=${convId}`, src);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const dg = new Device(galaxy.token);
  await dg.connect();
  const sent = await api('POST', `/v1/conversations/${convId}/messages`, iphone.token, { clientMsgId: cid(), mediaId: up.body.id });
  assert.equal(sent.body.message.kind, 'image');
  const got = await dg.waitFor('message.new', (d) => d.message.id === sent.body.message.id);
  assert.equal(got.message.mediaId, up.body.id);

  // 갤럭시(참여자)가 연다.
  const link = await api('GET', `/v1/media/${up.body.id}/url`, galaxy.token);
  assert.equal(link.status, 200);
  const file = await fetch(link.body.url);
  assert.equal(file.status, 200);
  const meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.exif, undefined, '저장된 사진에는 EXIF(촬영 위치)가 없다');

  // 참여하지 않은 계정: 링크 발급 거부, 주소 추측·서명 변조·만료 모두 거부
  assert.equal((await api('GET', `/v1/media/${up.body.id}/url`, outsider.token)).status, 404);
  const u = new URL(link.body.url);
  assert.equal((await fetch(`${u.origin}${u.pathname}`)).status, 404);
  u.searchParams.set('sig', '0'.repeat(64));
  assert.equal((await fetch(u)).status, 404);
  const expired = new URL(link.body.url);
  expired.searchParams.set('exp', '1000');
  assert.equal((await fetch(expired)).status, 404);
  // 다른 대화방 사진을 내 메시지에 붙일 수 없다.
  const other = await pair(outsider, galaxy);
  assert.equal((await api('POST', `/v1/conversations/${other}/messages`, galaxy.token, { clientMsgId: cid(), mediaId: up.body.id })).body.error.code, 'INVALID_MEDIA');

  // 프로필 사진은 공개 범위(로그인 회원)지만 차단 관계에서는 열리지 않는다.
  const prof = await upload(iphone.token, 'purpose=profile', src);
  await api('PATCH', '/v1/me', iphone.token, { photoMediaId: prof.body.id });
  assert.equal((await api('GET', `/v1/media/${prof.body.id}/url`, outsider.token)).status, 200);
  await api('POST', '/v1/blocks', outsider.token, { userId: iphone.userId });
  assert.equal((await api('GET', `/v1/media/${prof.body.id}/url`, outsider.token)).status, 404);
  dg.disconnect();
});

test('⑤⑥ 그룹방: 위치 권한 없는 회원의 원주 지역방 참여, 마지막 한 자리 동시 입장, 승인·강퇴·위임·공지', async () => {
  const admin = await adminLogin();
  const region = await api('POST', '/v1/admin/rooms', admin, { title: '원주 지역방', intro: '원주 이야기', regionId: WONJU, tags: ['원주'] });
  assert.equal(region.status, 201, JSON.stringify(region.body));
  const a = await signup(nick('방가'));
  const b = await signup(nick('방나'));
  assert.equal((await api('GET', '/v1/me', a.token)).body.locationShared, false);
  const found = await api('GET', `/v1/rooms?regionId=${WONJU}`, a.token);
  assert.ok(found.body.items.some((r: any) => r.id === region.body.id && r.kind === 'region'));
  assert.equal((await api('POST', `/v1/rooms/${region.body.id}/join`, a.token, {})).body.status, 'joined');
  assert.equal((await api('POST', `/v1/rooms/${region.body.id}/join`, b.token, {})).body.status, 'joined');
  const db = new Device(b.token);
  await db.connect();
  const hello = await api('POST', `/v1/conversations/${region.body.id}/messages`, a.token, { clientMsgId: cid(), text: '원주 분들 안녕하세요' });
  const got = await db.waitFor('message.new', (d) => d.message.id === hello.body.message.id);
  assert.equal(got.message.senderNickname, a.nickname);

  // 그룹방에서 차단한 회원의 메시지는 내용 없이 가려져 오고 푸시도 가지 않는다.
  await api('POST', '/v1/blocks', b.token, { userId: a.userId });
  const before = await pushCount(b.userId, 'message');
  const masked = await api('POST', `/v1/conversations/${region.body.id}/messages`, a.token, { clientMsgId: cid(), text: '차단된 사람의 말' });
  const ev = await db.waitFor('message.new', (d) => d.message.id === masked.body.message.id);
  assert.equal(ev.message.masked, true);
  assert.equal(ev.message.body, '');
  const listed = (await api('GET', `/v1/conversations/${region.body.id}/messages`, b.token)).body.items.find((m: any) => m.id === masked.body.message.id);
  assert.equal(listed.masked, true);
  assert.equal(listed.body, '');
  assert.equal(await pushCount(b.userId, 'message'), before);
  db.disconnect();

  // 정원 2명(방장 포함) → 한 자리 남음. 두 계정이 동시에 입장.
  const owner = await signup(nick('방장'));
  const room = await api('POST', '/v1/rooms', owner.token, { title: '원주 주말 등산', intro: '치악산 갑니다', tags: ['#등산', '주말'], regionId: WONJU, capacity: 2 });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  const [c, d] = [await signup(nick('동시가')), await signup(nick('동시나'))];
  const [r1, r2] = await Promise.all([api('POST', `/v1/rooms/${room.body.id}/join`, c.token, {}), api('POST', `/v1/rooms/${room.body.id}/join`, d.token, {})]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal([r1, r2].find((r) => r.status === 409)!.body.error.code, 'ROOM_FULL');
  const state = (await sql('SELECT member_count, capacity FROM rooms WHERE conversation_id = $1', [room.body.id]))[0];
  assert.equal(state.member_count, 2);
  assert.equal(Number((await sql('SELECT count(*) AS n FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL', [room.body.id]))[0].n), 2);
  const winner = r1.status === 200 ? c : d;
  const loser = r1.status === 200 ? d : c;

  // 방장은 그냥 나갈 수 없다: 위임 또는 종료를 골라야 한다.
  assert.equal((await api('POST', `/v1/rooms/${room.body.id}/leave`, owner.token, {})).body.error.code, 'OWNER_MUST_CHOOSE');
  // 공지 고정, 검색(제목·태그), 내가 가입한 방
  const msg = await api('POST', `/v1/conversations/${room.body.id}/messages`, owner.token, { clientMsgId: cid(), text: '토요일 7시 구룡사 주차장' });
  await api('POST', `/v1/rooms/${room.body.id}/notice`, owner.token, { messageId: msg.body.message.id });
  assert.equal((await api('GET', `/v1/rooms/${room.body.id}`, winner.token)).body.notice.body, '토요일 7시 구룡사 주차장');
  assert.equal((await api('POST', `/v1/rooms/${room.body.id}/notice`, winner.token, { messageId: msg.body.message.id })).status, 403);
  assert.ok((await api('GET', `/v1/rooms?q=${encodeURIComponent('등산')}`, loser.token)).body.items.some((r: any) => r.id === room.body.id));
  assert.ok((await api('GET', '/v1/rooms?tag=주말', loser.token)).body.items.some((r: any) => r.id === room.body.id));
  assert.ok((await api('GET', '/v1/rooms?mine=true', winner.token)).body.items.some((r: any) => r.id === room.body.id));

  // 강퇴 + 재가입 제한
  await api('POST', `/v1/rooms/${room.body.id}/members/${winner.userId}/kick`, owner.token, { banDays: 7 });
  assert.equal((await api('POST', `/v1/rooms/${room.body.id}/join`, winner.token, {})).body.error.code, 'ROOM_BANNED');
  assert.equal((await api('GET', `/v1/conversations/${room.body.id}/messages`, winner.token)).status, 404);
  // 가입 승인제 + 방장 위임 후 나가기
  await api('PATCH', `/v1/rooms/${room.body.id}`, owner.token, { requireApproval: true });
  assert.equal((await api('POST', `/v1/rooms/${room.body.id}/join`, loser.token, {})).body.status, 'requested');
  const reqs = await api('GET', `/v1/rooms/${room.body.id}/requests`, owner.token);
  assert.equal(reqs.body.items.length, 1);
  await api('POST', `/v1/rooms/${room.body.id}/requests/${reqs.body.items[0].id}/approve`, owner.token);
  assert.equal((await api('GET', `/v1/rooms/${room.body.id}`, loser.token)).body.myRole, 'member');
  assert.equal((await api('POST', `/v1/rooms/${room.body.id}/leave`, owner.token, { transferTo: loser.userId })).status, 200);
  assert.equal((await api('GET', `/v1/rooms/${room.body.id}`, loser.token)).body.myRole, 'owner');
  // 혼자 남은 방장이 나가면 방이 종료된다.
  assert.equal((await api('POST', `/v1/rooms/${room.body.id}/leave`, loser.token, {})).body.closed, true);
  assert.ok(!(await api('GET', `/v1/rooms?q=${encodeURIComponent('등산')}`, c.token)).body.items.some((r: any) => r.id === room.body.id));
  // 비밀방은 검색에 나오지 않고 초대 코드가 있어야 들어간다.
  const secret = await api('POST', '/v1/rooms', owner.token, { title: '비밀 모임방', isPrivate: true, capacity: 5 });
  assert.ok(!(await api('GET', `/v1/rooms?q=${encodeURIComponent('비밀')}`, c.token)).body.items.length);
  assert.equal((await api('POST', `/v1/rooms/${secret.body.id}/join`, c.token, {})).body.error.code, 'INVITE_REQUIRED');
  assert.equal((await api('POST', `/v1/rooms/${secret.body.id}/join`, c.token, { inviteCode: secret.body.inviteCode })).body.status, 'joined');
});

test('④ 푸시: 새 메시지·인사에 발송되고, 차단 직후·알림 끄기에서는 발송되지 않으며, 미리보기를 끄면 내용이 빠진다', async () => {
  const a = await signup(nick('푸시가'));
  const b = await signup(nick('푸시나'));
  const c = await signup(nick('푸시다'));
  await api('POST', '/v1/devices', b.token, { token: 'device-token-b-0001', platform: 'ios' });
  const g = await api('POST', '/v1/greetings', a.token, { toUserId: b.userId, text: '안녕하세요' });
  assert.equal(await pushCount(b.userId, 'greeting'), 1);
  const convId = (await api('POST', `/v1/greetings/${g.body.greetingId}/accept`, b.token)).body.conversationId;
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '비밀 이야기' });
  let rows = await sql('SELECT * FROM push_log WHERE user_id = $1 AND kind = $2 ORDER BY id', [b.userId, 'message']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, '비밀 이야기');
  assert.equal(rows[0].data.conversationId, convId);

  await api('PATCH', '/v1/me', b.token, { settings: { pushPreview: false } });
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '잠금화면에 보이면 안 되는 말' });
  rows = await sql('SELECT * FROM push_log WHERE user_id = $1 AND kind = $2 ORDER BY id', [b.userId, 'message']);
  assert.equal(rows[1].body, '새 메시지가 도착했습니다.');
  assert.ok(!JSON.stringify(rows[1]).includes('잠금화면에'));

  await api('POST', `/v1/conversations/${convId}/mute`, b.token, { muted: true });
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '알림 끈 방' });
  assert.equal(await pushCount(b.userId, 'message'), 2);

  // 차단 직후: 새 인사도, 메시지도, 푸시도 오지 않는다.
  await api('POST', '/v1/blocks', b.token, { userId: c.userId });
  assert.equal((await api('POST', '/v1/greetings', c.token, { toUserId: b.userId, text: '안녕하세요' })).status, 403);
  assert.equal(await pushCount(b.userId, 'greeting'), 1);
  await api('POST', `/v1/conversations/${convId}/mute`, b.token, { muted: false });
  await api('POST', '/v1/blocks', b.token, { userId: a.userId });
  assert.equal((await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '차단 후' })).status, 403);
  assert.equal(await pushCount(b.userId), 3);
});

test('대화 부가 기능: 답장, 검색, 내보내기, 나가기 후 새 메시지로 복귀', async () => {
  const a = await signup(nick('부가가'));
  const b = await signup(nick('부가나'));
  const convId = await pair(a, b);
  const first = await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '치악산 등산 어때요' });
  const reply = await api('POST', `/v1/conversations/${convId}/messages`, b.token, { clientMsgId: cid(), text: '좋아요', replyToId: first.body.message.id });
  assert.equal(reply.body.message.replyToId, first.body.message.id);
  const found = await api('GET', `/v1/conversations/${convId}/messages?q=${encodeURIComponent('치악산')}`, b.token);
  assert.deepEqual(found.body.items.map((m: any) => m.body), ['치악산 등산 어때요']);
  const exp = await api('GET', `/v1/conversations/${convId}/export`, b.token);
  assert.ok(exp.body.text.includes(`${a.nickname}: 치악산 등산 어때요`) && exp.body.filename.endsWith('.txt'));
  await api('POST', `/v1/conversations/${convId}/leave`, b.token);
  assert.equal((await api('GET', '/v1/conversations', b.token)).body.items.length, 0);
  await api('POST', `/v1/conversations/${convId}/messages`, a.token, { clientMsgId: cid(), text: '다시 연락드려요' });
  assert.equal((await api('GET', '/v1/conversations', b.token)).body.items.length, 1);
});

test('게시판·장터: 게시 전 필터, 지역 목록, 댓글·공감·북마크, 거래 문의에 상품 정보가 붙는다', async () => {
  const seller = await signup(nick('판매자'));
  const buyer = await signup(nick('구매자'));
  const far = await signup(nick('서울회원'), { regionId: 'seoul-01' });
  assert.equal((await api('POST', '/v1/posts', seller.token, { kind: 'board', category: 'daily', title: '연락 주세요', body: '010-1234-5678 로 전화 주세요' })).body.error.code, 'CONTENT_BLOCKED');
  assert.equal((await api('POST', '/v1/posts', seller.token, { kind: 'board', category: 'daily', title: '조건만남 구함', body: '내용' })).body.error.code, 'CONTENT_BLOCKED');
  const post = await api('POST', '/v1/posts', seller.token, { kind: 'board', category: 'question', title: '단계동 맛집 추천', body: '점심 먹을 곳 알려주세요' });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.ok((await api('GET', '/v1/posts?kind=board', buyer.token)).body.items.some((p: any) => p.id === post.body.id));
  assert.ok(!(await api('GET', '/v1/posts?kind=board', far.token)).body.items.some((p: any) => p.id === post.body.id), '다른 지역 목록에는 나오지 않는다');
  assert.ok((await api('GET', '/v1/posts?kind=board&scope=all&category=question', far.token)).body.items.some((p: any) => p.id === post.body.id));
  const commented = await api('POST', `/v1/posts/${post.body.id}/comments`, buyer.token, { body: '무실동 칼국수집 좋아요' });
  assert.equal(commented.body.commentCount, 1);
  assert.equal((await api('POST', `/v1/posts/${post.body.id}/like`, buyer.token, {})).body.likeCount, 1);
  assert.equal((await api('POST', `/v1/posts/${post.body.id}/like`, buyer.token, {})).body.likeCount, 1, '공감은 한 번만');
  await api('POST', `/v1/posts/${post.body.id}/bookmark`, buyer.token, {});
  assert.equal((await api('GET', '/v1/posts?kind=board&bookmarked=true', buyer.token)).body.items.length, 1);

  const photo = await upload(seller.token, 'purpose=post', await photoWithGps());
  const item = await api('POST', '/v1/posts', seller.token, { kind: 'market', category: 'sell', title: '등산 스틱 한 쌍', body: '두 번 썼습니다', price: 25000, itemCondition: '거의 새것', mediaIds: [photo.body.id] });
  assert.equal(item.body.marketStatus, 'selling');
  const ds = new Device(seller.token);
  await ds.connect();
  const inq = await api('POST', `/v1/posts/${item.body.id}/inquiry`, buyer.token, { text: '아직 판매 중인가요?' });
  assert.equal(inq.body.status, 'sent');
  const got = await ds.waitFor('greeting.received');
  assert.equal(got.greeting.context.title, '등산 스틱 한 쌍');
  assert.equal(got.greeting.context.thumbMediaId, photo.body.id);
  assert.equal(got.greeting.context.price, 25000);
  const convId = (await api('POST', `/v1/greetings/${inq.body.greetingId}/accept`, seller.token)).body.conversationId;
  const first = (await api('GET', `/v1/conversations/${convId}/messages`, seller.token)).body.items[0];
  assert.equal(first.meta.context.postId, item.body.id);
  // 이미 대화 중이면 다른 물건 문의가 그 방에 상품 정보와 함께 들어간다.
  const item2 = await api('POST', '/v1/posts', seller.token, { kind: 'market', category: 'free', title: '화분 나눔' });
  assert.equal(item2.body.price, 0);
  const inq2 = await api('POST', `/v1/posts/${item2.body.id}/inquiry`, buyer.token, {});
  assert.equal(inq2.body.status, 'conversation');
  const last = (await api('GET', `/v1/conversations/${convId}/messages`, seller.token)).body.items.at(-1);
  assert.equal(last.meta.context.title, '화분 나눔');
  // 거래 상태 변경
  assert.equal((await api('PATCH', `/v1/posts/${item.body.id}`, seller.token, { marketStatus: 'reserved' })).body.marketStatus, 'reserved');
  assert.equal((await api('PATCH', `/v1/posts/${item.body.id}`, buyer.token, { marketStatus: 'done' })).status, 404);
  await api('PATCH', `/v1/posts/${item.body.id}`, seller.token, { marketStatus: 'done' });
  assert.equal((await api('POST', `/v1/posts/${item.body.id}/inquiry`, far.token, {})).body.error.code, 'TRADE_DONE');
  ds.disconnect();
});

test('⑦ 포인트: 같은 영수증 재처리에도 잔액이 늘지 않고, 글 고정이 실패하면 포인트가 그대로 남는다', async () => {
  const admin = await adminLogin();
  const u = await signup(nick('포인트'));
  const tx = `T${cid()}`;
  // 구매 이벤트 반복·결제 직후 앱 종료 후 재전송을 한꺼번에 흉내 낸다.
  const results = await Promise.all([buy(u.token, 'eumtalk.points.100', tx), buy(u.token, 'eumtalk.points.100', tx), buy(u.token, 'eumtalk.points.100', tx)]);
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
  assert.equal(results.filter((r) => r.body.granted === 100).length, 1, '지급은 한 번만');
  const again = await buy(u.token, 'eumtalk.points.100', tx);
  assert.equal(again.body.alreadyProcessed, true);
  assert.equal(again.body.balance, 100);
  // 다른 계정이 같은 영수증을 내밀어도 지급되지 않는다.
  const thief = await signup(nick('도용'));
  assert.equal((await buy(thief.token, 'eumtalk.points.100', tx)).status, 409);
  assert.equal((await api('GET', '/v1/points', thief.token)).body.balance, 0);

  const post = await api('POST', '/v1/posts', u.token, { kind: 'board', category: 'daily', title: '고정할 글', body: '내용' });
  const quote = await api('POST', `/v1/posts/${post.body.id}/pin/quote`, u.token, { days: 1 });
  assert.equal(quote.body.regionName, '강원 원주시');
  assert.equal(quote.body.cost, 50);
  assert.equal(quote.body.days, 1);
  // 잔액 부족: 3일 = 150P > 100P
  const poor = await api('POST', `/v1/posts/${post.body.id}/pin`, u.token, { days: 3 });
  assert.equal(poor.status, 402);
  assert.equal((await api('GET', '/v1/points', u.token)).body.balance, 100);

  // 고정 처리 도중 실패(운영자가 그 사이 글을 숨김): 차감이 되돌려져 잔액이 그대로다.
  await api('POST', `/v1/admin/posts/${post.body.id}/hidden`, admin, { hidden: true, reason: '시험' });
  const failed = await api('POST', `/v1/posts/${post.body.id}/pin`, u.token, { days: 1 });
  assert.equal(failed.body.error.code, 'PIN_FAILED');
  assert.equal((await api('GET', '/v1/points', u.token)).body.balance, 100, '실패한 고정은 포인트를 쓰지 않는다');
  assert.equal(Number((await sql(`SELECT count(*) AS n FROM point_ledger WHERE user_id = $1 AND type = 'spend'`, [u.userId]))[0].n), 0);

  // 정상 고정: 차감되고, 해당 지역 목록 맨 위로 올라가며, 기간이 지나면 일반 글로 돌아간다.
  await api('POST', `/v1/admin/posts/${post.body.id}/hidden`, admin, { hidden: false });
  await api('POST', '/v1/posts', thief.token, { kind: 'board', category: 'daily', title: '더 최근 글', body: '내용' });
  const pinned = await api('POST', `/v1/posts/${post.body.id}/pin`, u.token, { days: 1 });
  assert.equal(pinned.body.balance, 50);
  let list = (await api('GET', '/v1/posts?kind=board', thief.token)).body.items;
  assert.equal(list[0].id, post.body.id);
  assert.equal(list[0].pinned, true);
  await sql(`UPDATE posts SET pinned_until = now() - interval '1 minute' WHERE id = $1`, [post.body.id]);
  list = (await api('GET', '/v1/posts?kind=board', thief.token)).body.items;
  assert.equal(list[0].title, '더 최근 글');
  assert.equal(list.find((p: any) => p.id === post.body.id).pinned, false);

  const ledger = (await api('GET', '/v1/points/ledger', u.token)).body.items;
  assert.deepEqual(ledger.map((l: any) => [l.type, l.delta, l.balanceAfter]), [['spend', -50, 50], ['charge', 100, 100]]);
  // 관리자 조정도 원장에 건별로 남는다.
  await api('POST', '/v1/admin/points/adjust', admin, { userId: u.userId, delta: 30, reason: '시험 보상' });
  assert.equal((await api('GET', '/v1/points/ledger', u.token)).body.items[0].type, 'admin');
});

test('구독: 구매·갱신·복원·만료·환불이 각각 한 번씩만 반영된다', async () => {
  const u = await signup(nick('구독자'));
  const orig = `S${cid()}`;
  const in30 = new Date(Date.now() + 30 * 86400_000).toISOString();
  const in60 = new Date(Date.now() + 60 * 86400_000).toISOString();
  const first = await buy(u.token, 'eumtalk.premium.monthly', orig, `|${orig}|${in30}`);
  assert.equal(first.body.premium, true);
  assert.equal(first.body.balance, 300);
  // 복원(같은 거래 재전송): 추가 지급 없음
  const restore = await buy(u.token, 'eumtalk.premium.monthly', orig, `|${orig}|${in30}`);
  assert.equal(restore.body.balance, 300);
  assert.equal(restore.body.premium, true);
  // 갱신 알림(새 거래 ID, 같은 원거래): 한 번만 지급되고 만료일이 늘어난다.
  const renewTx = `S${cid()}`;
  const ev = { productId: 'eumtalk.premium.monthly', subscription: true, token: `dev|${renewTx}|${orig}|${in60}` };
  await api('POST', '/v1/dev/store-event', null, ev);
  await api('POST', '/v1/dev/store-event', null, ev);
  let ov = (await api('GET', '/v1/points', u.token)).body;
  assert.equal(ov.balance, 600);
  assert.equal(ov.subscription.status, 'active');
  assert.ok(new Date(ov.subscription.expiresAt).getTime() > Date.now() + 50 * 86400_000);
  // 프리미엄은 다른 지역 둘러보기가 무료
  assert.equal((await api('POST', '/v1/me/browse/quote', u.token)).body.cost, 0);
  // 환불: 해당 거래로 받은 포인트를 회수하고 혜택 종료
  await api('POST', '/v1/dev/store-event', null, { ...ev, token: `dev|${renewTx}|${orig}|${in60}|revoked` });
  await api('POST', '/v1/dev/store-event', null, { ...ev, token: `dev|${renewTx}|${orig}|${in60}|revoked` });
  ov = (await api('GET', '/v1/points', u.token)).body;
  assert.equal(ov.balance, 300, '환불 회수도 한 번만');
  assert.equal(ov.subscription.status, 'refunded');
  // 만료
  const u2 = await signup(nick('만료자'));
  const o2 = `S${cid()}`;
  await buy(u2.token, 'eumtalk.premium.monthly', o2, `|${o2}|${in30}`);
  await api('POST', '/v1/dev/store-event', null, { type: 'expire', originalTransactionId: o2 });
  assert.equal((await api('GET', '/v1/points', u2.token)).body.subscription.status, 'expired');
  assert.equal((await api('POST', '/v1/me/browse/quote', u2.token)).body.cost, 30);
});

test('다중 인사·다른 지역 둘러보기: 실제 발송분만 차감, 방문 지역을 현재 위치처럼 보이지 않게 표시', async () => {
  const sender = await signup(nick('다중'), { regionId: 'jeju-02' });
  const t1 = await signup(nick('대상가'), { regionId: 'jeju-02' });
  const t2 = await signup(nick('대상나'), { regionId: 'jeju-02' });
  const off = await signup(nick('수신거부'), { regionId: 'jeju-02' });
  const blocker = await signup(nick('차단함'), { regionId: 'jeju-02' });
  const already = await signup(nick('대기중'), { regionId: 'jeju-02' });
  await api('PATCH', '/v1/me', off.token, { settings: { acceptGreetings: false } });
  await api('POST', '/v1/blocks', blocker.token, { userId: sender.userId });
  await api('POST', '/v1/greetings', sender.token, { toUserId: already.userId, text: '먼저 보낸 인사' });
  await buy(sender.token, 'eumtalk.points.100', `T${cid()}`);

  const preview = await api('POST', '/v1/greetings/multi/preview', sender.token, { filter: { scope: 'near' } });
  assert.equal(preview.body.targetCount, 2, '수신 거부·차단·대기 중 대상은 제외');
  assert.equal(preview.body.cost, 20);
  const sent = await api('POST', '/v1/greetings/multi', sender.token, { text: '서귀포 러닝 같이 하실 분', filter: { scope: 'near' } });
  assert.equal(sent.body.sentCount, 2);
  assert.equal(sent.body.balance, 80);
  assert.equal((await api('GET', '/v1/greetings', t1.token)).body.items.length, 1);
  assert.equal((await api('GET', '/v1/greetings', t2.token)).body.items.length, 1);
  assert.equal((await api('GET', '/v1/greetings', off.token)).body.items.length, 0);
  assert.equal((await api('GET', '/v1/greetings', blocker.token)).body.items.length, 0);
  // 바로 다시 보내면 대상이 없으므로 차감도 없다.
  const again = await api('POST', '/v1/greetings/multi', sender.token, { text: '한 번 더', filter: { scope: 'near' } });
  assert.equal(again.body.sentCount, 0);
  assert.equal(again.body.balance, 80);

  // 다른 지역 둘러보기
  const local = await signup(nick('원주민'));
  assert.equal((await api('GET', `/v1/nearby?regionId=${WONJU}`, sender.token)).body.error.code, 'OTHER_REGION_LOCKED');
  const br = await api('POST', '/v1/me/browse', sender.token, { regionId: WONJU });
  assert.equal(br.body.cost, 30);
  assert.equal(br.body.balance, 50);
  assert.ok((await api('GET', `/v1/nearby?regionId=${WONJU}`, sender.token)).body.items.some((i: any) => i.userId === local.userId));
  const seen = (await api('GET', '/v1/nearby', local.token)).body.items.find((i: any) => i.userId === sender.userId);
  assert.equal(seen.proximity, 'visiting', "'이 지역 둘러보는 중'으로 표시");
  assert.equal(seen.regionName, '제주 서귀포시', '활동 지역은 실제 지역 그대로');
});

test('⑧ 신고 처리: 증거 열람 기록 → 조치 → 이용자 화면·통지·관리자 이력 반영 → 이의신청', async () => {
  const owner = await adminLogin();
  await api('POST', '/v1/admin/admins', owner, { email: 'mod@test.local', password: 'moderator-pass-1', role: 'moderator', name: '신고담당' });
  await api('POST', '/v1/admin/admins', owner, { email: 'fin@test.local', password: 'finance-pass-12', role: 'finance', name: '정산담당' });
  const mod = await adminLogin('mod@test.local', 'moderator-pass-1');
  const fin = await adminLogin('fin@test.local', 'finance-pass-12');

  const bad = await signup(nick('가해자'));
  const victim = await signup(nick('신고자'));
  const convId = await pair(bad, victim);
  const m = await api('POST', `/v1/conversations/${convId}/messages`, bad.token, { clientMsgId: cid(), text: '입에 담기 힘든 욕설' });
  const rep = await api('POST', '/v1/reports', victim.token, { targetType: 'message', targetId: m.body.message.id, reason: 'abuse', detail: '욕설을 들었습니다' });
  const dv = new Device(victim.token);
  await dv.connect();

  // 권한 분리: 정산 담당은 신고를 볼 수 없고, 신고 담당은 포인트를 볼 수 없다.
  assert.equal((await api('GET', '/v1/admin/reports', fin)).status, 403);
  assert.equal((await api('GET', `/v1/admin/reports/${rep.body.id}`, fin)).status, 403);
  assert.equal((await api('GET', '/v1/admin/points/ledger', mod)).status, 403);
  // 목록에는 신고된 내용이 실리지 않는다.
  const list = await api('GET', '/v1/admin/reports', mod);
  assert.ok(list.body.items.some((r: any) => r.id === rep.body.id));
  assert.ok(!JSON.stringify(list.body).includes('입에 담기 힘든'));
  // 건별 열람: 사본과 시점이 보이고, 열람 사실이 기록된다.
  const detail = await api('GET', `/v1/admin/reports/${rep.body.id}`, mod);
  assert.equal(detail.body.evidence.body, '입에 담기 힘든 욕설');
  assert.ok(detail.body.evidence.sentAt && detail.body.evidence.seq);
  assert.equal(Number((await sql(`SELECT count(*) AS n FROM admin_audit_log WHERE action = 'report.evidence.view' AND target_id = $1`, [rep.body.id]))[0].n), 1);
  // 개인 대화를 검색·열람하는 관리자 API는 없다.
  for (const path of [`/v1/admin/conversations/${convId}/messages`, `/v1/admin/messages?q=욕설`, `/v1/admin/conversations`]) {
    assert.equal((await api('GET', path, owner)).status, 404, path);
  }

  // 조치: 메시지 숨김
  const act = await api('POST', `/v1/admin/reports/${rep.body.id}/action`, mod, { action: 'hide', note: '욕설 확인' });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal((await api('POST', `/v1/admin/reports/${rep.body.id}/action`, mod, { action: 'warn' })).body.error.code, 'ALREADY_RESOLVED');
  // 이용자 화면: 실시간 반영 + 다시 불러와도 숨김
  const hid = await dv.waitFor('message.hidden', (d) => d.messageId === m.body.message.id);
  assert.equal(hid.hidden, true);
  for (const who of [victim, bad]) {
    const row = (await api('GET', `/v1/conversations/${convId}/messages`, who.token)).body.items.find((x: any) => x.id === m.body.message.id);
    assert.equal(row.hidden, true);
    assert.equal(row.body, '');
  }
  assert.equal((await api('GET', '/v1/conversations', victim.token)).body.items[0].lastMessage.body, '숨겨진 메시지');
  // 처리 결과 통지: 신고자와 대상자 모두
  assert.ok((await api('GET', '/v1/notices', victim.token)).body.items.some((n: any) => n.kind === 'report_result'));
  assert.ok((await api('GET', '/v1/notices', bad.token)).body.items.some((n: any) => n.kind === 'sanction' && n.title.includes('콘텐츠 숨김')));
  // 관리자 이력
  const after = await api('GET', `/v1/admin/reports/${rep.body.id}`, mod);
  assert.equal(after.body.status, 'resolved');
  assert.equal(after.body.resolution, '콘텐츠 숨김');
  assert.ok(after.body.history.some((h: any) => h.action === 'report.hide' && h.by === '신고담당'));
  assert.ok(after.body.history.filter((h: any) => h.action === 'report.evidence.view').length >= 2);

  // 이용 정지 → 정지 중에도 조치 확인·이의신청 가능 → 받아들여지면 해제
  const rep2 = await api('POST', '/v1/reports', victim.token, { targetType: 'profile', targetId: bad.userId, reason: 'abuse' });
  await api('POST', `/v1/admin/reports/${rep2.body.id}/action`, mod, { action: 'suspend', days: 7 });
  const blocked = await api('GET', '/v1/nearby', bad.token);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'SUSPENDED');
  assert.equal((await api('POST', `/v1/conversations/${convId}/messages`, bad.token, { clientMsgId: cid(), text: '정지 중' })).status, 403);
  const sanctions = await api('GET', '/v1/sanctions', bad.token);
  assert.equal(sanctions.status, 200);
  const suspension = sanctions.body.items.find((s: any) => s.type === 'suspension');
  assert.equal((await api('POST', '/v1/appeals', bad.token, { sanctionId: suspension.id, body: '오해가 있었습니다. 다시 확인 부탁드립니다.' })).status, 200);
  const appeals = await api('GET', '/v1/admin/appeals', mod);
  assert.equal(appeals.body.items.length, 1);
  await api('POST', `/v1/admin/appeals/${appeals.body.items[0].id}/decide`, mod, { accept: true, answer: '재검토 결과 정지를 해제합니다.' });
  assert.equal((await api('GET', '/v1/nearby', bad.token)).status, 200);
  assert.equal((await api('GET', '/v1/sanctions', bad.token)).body.items.find((s: any) => s.id === suspension.id).appeal.status, 'accepted');
  // 문의·공지
  await api('POST', '/v1/inquiries', victim.token, { body: '결제 관련 문의드립니다.' });
  const inq = await api('GET', '/v1/admin/inquiries', owner);
  await api('POST', `/v1/admin/inquiries/${inq.body.items[0].id}/answer`, owner, { answer: '확인 후 처리했습니다.' });
  assert.equal((await api('GET', '/v1/inquiries', victim.token)).body.items[0].answer, '확인 후 처리했습니다.');
  await api('POST', '/v1/admin/announcements', owner, { title: '점검 안내', body: '새벽 2시 점검이 있습니다.' });
  assert.equal((await api('GET', '/v1/announcements', victim.token)).body.items[0].title, '점검 안내');
  dv.disconnect();
});

test('⑨ 계정 삭제: 주변·검색·게시글에서 사라지고, 사진·푸시 토큰·세션이 정리되며, 보존 대상은 남는다', async () => {
  const gone = await signup(nick('탈퇴자'));
  const peer = await signup(nick('남은이'));
  const convId = await pair(gone, peer);
  await api('POST', `/v1/conversations/${convId}/messages`, gone.token, { clientMsgId: cid(), text: '탈퇴 전 메시지' });
  const photo = await upload(gone.token, 'purpose=profile', await photoWithGps());
  await api('PATCH', '/v1/me', gone.token, { photoMediaId: photo.body.id });
  const link = await api('GET', `/v1/media/${photo.body.id}/url`, peer.token);
  await api('POST', '/v1/devices', gone.token, { token: 'device-token-gone-0001', platform: 'android' });
  const post = await api('POST', '/v1/posts', gone.token, { kind: 'board', category: 'daily', title: '탈퇴자의 글', body: '내용' });
  const room = await api('POST', '/v1/rooms', gone.token, { title: '탈퇴자의 방', capacity: 10 });
  await buy(gone.token, 'eumtalk.points.100', `T${cid()}`);
  const rep = await api('POST', '/v1/reports', peer.token, { targetType: 'profile', targetId: gone.userId, reason: 'spam' });
  assert.ok((await api('GET', '/v1/nearby?scope=all', peer.token)).body.items.some((i: any) => i.userId === gone.userId));

  assert.equal((await api('DELETE', '/v1/me', gone.token, {})).body.error.code, 'CONFIRM_REQUIRED');
  const del = await api('DELETE', '/v1/me', gone.token, { confirm: '삭제', reason: '시험' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.detail.pushTokensDeleted, 1);
  assert.equal(del.body.detail.photosDeleted, 1);

  // 다른 회원의 주변 목록·프로필·게시글·방 검색에 나타나지 않는다.
  assert.ok(!(await api('GET', '/v1/nearby?scope=all', peer.token)).body.items.some((i: any) => i.userId === gone.userId));
  assert.ok(!(await api('GET', '/v1/nearby?scope=all&sort=recent', peer.token)).body.items.some((i: any) => i.nickname === gone.nickname));
  assert.equal((await api('GET', `/v1/users/${gone.userId}`, peer.token)).status, 404);
  assert.ok(!(await api('GET', '/v1/posts?kind=board&scope=all', peer.token)).body.items.some((p: any) => p.id === post.body.id));
  assert.equal((await api('GET', `/v1/posts/${post.body.id}`, peer.token)).status, 404);
  assert.ok(!(await api('GET', `/v1/rooms?q=${encodeURIComponent('탈퇴자')}`, peer.token)).body.items.length);
  assert.equal((await api('GET', `/v1/rooms/${room.body.id}`, peer.token)).body.closed, true);
  // 세션·푸시 토큰·사진·개인정보 정리
  assert.equal((await api('GET', '/v1/me', gone.token)).status, 401);
  assert.equal(Number((await sql('SELECT count(*) AS n FROM device_tokens WHERE user_id = $1', [gone.userId]))[0].n), 0);
  assert.equal((await api('GET', `/v1/media/${photo.body.id}/url`, peer.token)).status, 404);
  assert.equal((await fetch(link.body.url)).status, 404, '이미 발급된 링크로도 파일이 열리지 않는다');
  const priv = (await sql('SELECT u.phone_hash, p.phone_enc, p.birth_year, pr.bio, pr.nickname FROM users u JOIN user_private p ON p.user_id = u.id JOIN profiles pr ON pr.user_id = u.id WHERE u.id = $1', [gone.userId]))[0];
  assert.deepEqual([priv.phone_hash, priv.phone_enc, priv.birth_year, priv.bio], [null, null, null, '']);
  assert.notEqual(priv.nickname, gone.nickname);
  // 남은 사람의 대화방: 메시지는 남고 상대는 '탈퇴한 회원', 더 보낼 수 없다.
  const conv = (await api('GET', '/v1/conversations', peer.token)).body.items[0];
  assert.equal(conv.peer.nickname, '탈퇴한 회원');
  assert.equal(conv.canSend, false);
  assert.ok((await api('GET', `/v1/conversations/${convId}/messages`, peer.token)).body.items.some((m: any) => m.body === '탈퇴 전 메시지' && m.senderNickname === '탈퇴한 회원'));
  // 보존 대상: 신고 기록, 포인트 원장, 구매 기록, 삭제 처리 기록
  assert.equal((await sql('SELECT count(*) AS n FROM reports WHERE id = $1', [rep.body.id]))[0].n, '1');
  assert.equal((await sql('SELECT count(*) AS n FROM point_ledger WHERE user_id = $1', [gone.userId]))[0].n, '1');
  assert.equal((await sql('SELECT count(*) AS n FROM purchases WHERE user_id = $1', [gone.userId]))[0].n, '1');
  assert.ok((await sql('SELECT detail FROM account_deletions WHERE user_id = $1', [gone.userId]))[0].detail.retained.length > 0);
  // 같은 번호로 새로 가입할 수 있고(새 계정), 예전 닉네임도 다시 쓸 수 있다.
  const reborn = await signup(gone.nickname, {}, gone.phone);
  assert.notEqual(reborn.userId, gone.userId);
});
