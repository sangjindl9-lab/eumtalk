/**
 * 개발·시험 서버에 테스트 계정을 만든다. (운영 환경에서는 서버가 거부한다)
 *   npm run dev:accounts -- http://localhost:3000 4
 * 만든 계정은 앱에서 같은 번호 + 인증번호 000000 으로 로그인한다.
 */
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const count = Math.min(20, Number(process.argv[3] || 4));
const presets = [
  { nickname: '원주등산러', regionId: 'gangwon-02', interestIds: ['i01', 'i05', 'i09'], bio: '주말마다 치악산 갑니다. 같이 걸으실 분!' },
  { nickname: '단계동커피', regionId: 'gangwon-02', interestIds: ['i10', 'i12', 'i14'], bio: '카페 투어와 영화 이야기 좋아해요.' },
  { nickname: '무실동러너', regionId: 'gangwon-02', interestIds: ['i02', 'i03', 'i09'], bio: '저녁 러닝 크루 구합니다.' },
  { nickname: '횡성캠퍼', regionId: 'gangwon-09', interestIds: ['i05', 'i06', 'i24'], bio: '캠핑 장비 얘기 환영합니다.' },
  { nickname: '춘천라이더', regionId: 'gangwon-01', interestIds: ['i04', 'i16', 'i17'], bio: '의암호 자전거길 자주 탑니다.' },
];

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${json?.error?.message || ''}`);
  return json;
}

async function main() {
  console.log(`대상 서버: ${base}`);
  for (let i = 0; i < count; i++) {
    const phone = `0100000${String(1001 + i)}`;
    const p = presets[i % presets.length];
    const nickname = i < presets.length ? p.nickname : `${p.nickname}${i}`;
    try {
      const s = await post('/v1/auth/phone/start', { phone });
      if (!s.devCode) throw new Error('개발용 인증이 꺼져 있는 서버입니다.');
      const v = await post('/v1/auth/phone/verify', { verificationId: s.verificationId, code: s.devCode });
      if (v.status === 'login') {
        console.log(`이미 있음  ${phone}`);
        continue;
      }
      await post('/v1/auth/adult/verify', { signupToken: v.signupToken, devBirthYear: 1988 + (i % 8) });
      await post('/v1/auth/signup', { signupToken: v.signupToken, ...p, nickname });
      console.log(`생성 완료  ${phone}  닉네임 ${nickname}  (인증번호 000000)`);
    } catch (e) {
      console.log(`실패      ${phone}  ${(e as Error).message}`);
    }
  }
}
main();
