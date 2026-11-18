'use client';

import { useCallback, useEffect, useState } from 'react';

interface Problem {
  key: string;
  message: string;
  blocking: boolean;
}
interface Status {
  environment: string;
  identityMode: string;
  identityProvider: string;
  signupAvailable: boolean;
  database: string;
  redis: string;
  problems: Problem[];
  counts: Record<string, number>;
}

const ENV_LABEL: Record<string, string> = { development: '개발', staging: '시험', production: '운영' };
const COUNT_LABEL: [string, string][] = [
  ['users', '회원'],
  ['conversations', '대화방'],
  ['messages', '메시지'],
  ['pending_greetings', '대기 중 인사'],
  ['open_reports', '처리 전 신고'],
];
const UPCOMING = ['신고 처리(증거 열람·조치·이의신청)', '회원·그룹방·게시물 관리', '포인트 원장과 결제·환불', '운영 공지·문의', '관리자 권한 분리'];
const fmt = new Intl.NumberFormat('ko-KR');

export default function StatusClient({ apiBase }: { apiBase: string }) {
  const [token, setToken] = useState('');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const load = useCallback(
    async (t: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/v1/admin/system-status`, { headers: { authorization: `Bearer ${t}` }, cache: 'no-store' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            sessionStorage.removeItem('adminToken');
            setToken('');
          }
          throw new Error(json?.error?.message || `서버 응답 ${res.status}`);
        }
        setStatus(json);
        setCheckedAt(new Date());
      } catch (e) {
        setStatus(null);
        setError(e instanceof TypeError ? '서버에 연결하지 못했습니다' : (e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [apiBase],
  );

  useEffect(() => {
    const saved = sessionStorage.getItem('adminToken');
    if (saved) {
      setToken(saved);
      load(saved);
    }
  }, [load]);

  if (!token) {
    return (
      <main className="login">
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            const t = input.trim();
            if (!t) return;
            sessionStorage.setItem('adminToken', t);
            setToken(t);
            load(t);
          }}
        >
          <h1>이음톡 관리자</h1>
          <p className="secondary">서버의 ADMIN_TOKEN 값을 입력하면 시스템 상태를 확인할 수 있습니다</p>
          <label htmlFor="token">관리자 토큰</label>
          <input id="token" type="password" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} />
          {error && <p className="bad">{error}</p>}
          <button type="submit" className="primary">
            접속
          </button>
          <p className="muted mono">{apiBase}</p>
        </form>
      </main>
    );
  }

  const checks: { label: string; ok: boolean; value: string }[] = status
    ? [
        { label: '신규 가입', ok: status.signupAvailable, value: status.signupAvailable ? '가능' : '중단됨' },
        {
          label: '본인확인',
          ok: status.identityMode === 'live' || (status.identityMode === 'dev' && status.environment !== 'production'),
          value: status.identityMode === 'dev' ? '개발용 테스트 인증' : status.identityMode === 'live' ? '인증기관 연동' : '설정 없음',
        },
        { label: '데이터베이스', ok: status.database === 'ok', value: status.database === 'ok' ? '정상' : '오류' },
        { label: 'Redis', ok: status.redis === 'ok', value: status.redis === 'ok' ? '정상' : status.redis === 'not_configured' ? '미연결(서버 1대 방식)' : '오류' },
      ]
    : [];
  const blocking = status?.problems.filter((p) => p.blocking) ?? [];
  const notes = status?.problems.filter((p) => !p.blocking) ?? [];

  return (
    <div className="shell">
      <aside>
        <div className="brand">이음톡 관리자</div>
        <nav>
          <a className="active">시스템 상태</a>
          <div className="group">다음 단계에서 열림</div>
          {UPCOMING.map((u) => (
            <span key={u}>{u}</span>
          ))}
        </nav>
        <button
          className="quiet"
          onClick={() => {
            sessionStorage.removeItem('adminToken');
            setToken('');
            setStatus(null);
          }}
        >
          접속 종료
        </button>
      </aside>
      <main>
        <header>
          <div>
            <h1>시스템 상태</h1>
            <p className="secondary">
              {status ? `${ENV_LABEL[status.environment] ?? status.environment} 환경` : '확인 중'}
              {checkedAt && <span className="mono muted"> · {checkedAt.toLocaleTimeString('ko-KR')} 확인</span>}
            </p>
          </div>
          <button className="primary" onClick={() => load(token)} disabled={loading}>
            {loading ? '확인 중' : '다시 확인'}
          </button>
        </header>

        {error && <div className="alert">{error}</div>}

        {blocking.length > 0 && (
          <section className="alert">
            <h2>조치가 필요한 설정 {blocking.length}건</h2>
            <ul>
              {blocking.map((p) => (
                <li key={p.key}>
                  <span className="mono">{p.key}</span>
                  {p.message}
                </li>
              ))}
            </ul>
          </section>
        )}

        {status && (
          <>
            <section className="panel">
              <h2>점검 항목</h2>
              <ul className="checks">
                {checks.map((c) => (
                  <li key={c.label}>
                    <i className={c.ok ? 'dot ok' : 'dot off'} aria-hidden />
                    <span>{c.label}</span>
                    <span className={c.ok ? 'secondary' : 'bad'}>{c.value}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="stats">
              {COUNT_LABEL.map(([k, label]) => (
                <div key={k}>
                  <span className="secondary">{label}</span>
                  <strong>{fmt.format(status.counts[k] ?? 0)}</strong>
                </div>
              ))}
            </section>

            {notes.length > 0 && (
              <section className="panel">
                <h2>참고</h2>
                <ul className="notes">
                  {notes.map((p) => (
                    <li key={p.key}>
                      <span className="mono">{p.key}</span>
                      {p.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
