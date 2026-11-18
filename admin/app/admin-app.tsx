'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';

type Row = Record<string, any>;
interface Admin {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'moderator' | 'support' | 'finance';
}
type Call = (method: string, path: string, body?: unknown) => Promise<any>;

const ROLE_LABEL: Record<string, string> = { owner: '소유자', moderator: '신고 처리', support: '고객 지원', finance: '정산' };
const ENV_LABEL: Record<string, string> = { development: '개발', staging: '시험', production: '운영' };
const TARGET_LABEL: Record<string, string> = { profile: '프로필', message: '메시지', greeting: '인사말', post: '게시글', comment: '댓글', room: '그룹방', photo: '사진' };
const SECTIONS: { id: string; label: string; roles: string[] }[] = [
  { id: 'status', label: '시스템 상태', roles: ['moderator', 'support', 'finance'] },
  { id: 'reports', label: '신고', roles: ['moderator'] },
  { id: 'appeals', label: '이의신청', roles: ['moderator'] },
  { id: 'users', label: '회원', roles: ['moderator', 'support'] },
  { id: 'rooms', label: '그룹방', roles: ['moderator'] },
  { id: 'posts', label: '게시물', roles: ['moderator'] },
  { id: 'ledger', label: '포인트 원장', roles: ['finance'] },
  { id: 'purchases', label: '결제·환불', roles: ['finance'] },
  { id: 'prices', label: '가격 설정', roles: ['finance'] },
  { id: 'announcements', label: '운영 공지', roles: ['support'] },
  { id: 'inquiries', label: '문의', roles: ['support'] },
  { id: 'admins', label: '관리자 계정', roles: [] },
  { id: 'audit', label: '열람·조치 기록', roles: [] },
];
const num = new Intl.NumberFormat('ko-KR');
const when = (v?: string | null) => (v ? new Date(v).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '');

export default function AdminApp({ apiBase }: { apiBase: string }) {
  const [token, setToken] = useState('');
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [section, setSection] = useState('status');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const raw = useCallback(
    async (t: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      let res: Response;
      try {
        res = await fetch(`${apiBase}/v1/admin${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
        });
      } catch {
        throw new Error('서버에 연결하지 못했습니다');
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401 && t) {
          sessionStorage.removeItem('adminSession');
          setToken('');
          setAdmin(null);
        }
        throw new Error(json?.error?.message || `서버 응답 ${res.status}`);
      }
      return json;
    },
    [apiBase],
  );
  const call: Call = useCallback((method, path, body) => raw(token, method, path, body), [raw, token]);

  useEffect(() => {
    const saved = sessionStorage.getItem('adminSession');
    if (saved) {
      raw(saved, 'GET', '/me')
        .then((a) => {
          setToken(saved);
          setAdmin(a);
        })
        .catch(() => undefined);
    }
    raw('', 'GET', '/setup')
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch((e) => setError(e.message));
  }, [raw]);

  if (!admin) {
    const submit = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      setError(null);
      try {
        const body = { email: f.get('email'), password: f.get('password'), name: f.get('name') || undefined };
        const r = needsSetup ? await raw('', 'POST', '/bootstrap', body, { 'x-admin-token': String(f.get('adminToken') || '') }) : await raw('', 'POST', '/login', body);
        sessionStorage.setItem('adminSession', r.token);
        setToken(r.token);
        setAdmin(r.admin);
        setNeedsSetup(false);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    return (
      <main className="login">
        <form className="panel" onSubmit={submit}>
          <h1>이음톡 관리자</h1>
          <p className="secondary">{needsSetup ? '처음 사용하는 서버입니다. 소유자 계정을 만들어 주세요' : '관리자 계정으로 로그인하세요'}</p>
          {needsSetup && (
            <>
              <label htmlFor="adminToken">서버의 ADMIN_TOKEN</label>
              <input id="adminToken" name="adminToken" type="password" autoComplete="off" required />
              <label htmlFor="name">이름</label>
              <input id="name" name="name" />
            </>
          )}
          <label htmlFor="email">이메일</label>
          <input id="email" name="email" type="email" required />
          <label htmlFor="password">비밀번호{needsSetup ? ' (10자 이상)' : ''}</label>
          <input id="password" name="password" type="password" required minLength={needsSetup ? 10 : 1} />
          {error && <p className="bad">{error}</p>}
          <button type="submit" className="primary">
            {needsSetup ? '계정 만들고 시작' : '로그인'}
          </button>
          <p className="muted mono">{apiBase}</p>
        </form>
      </main>
    );
  }

  const visible = SECTIONS.filter((s) => admin.role === 'owner' || s.roles.includes(admin.role));
  const current = visible.find((s) => s.id === section) ?? visible[0];
  return (
    <div className="shell">
      <aside>
        <div className="brand">이음톡 관리자</div>
        <nav>
          {visible.map((s) => (
            <a key={s.id} className={s.id === current.id ? 'active' : ''} onClick={() => setSection(s.id)}>
              {s.label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>{admin.name || admin.email}</span>
          <span className="muted">{ROLE_LABEL[admin.role]}</span>
        </div>
        <button
          className="quiet"
          onClick={() => {
            call('POST', '/logout').catch(() => undefined);
            sessionStorage.removeItem('adminSession');
            setToken('');
            setAdmin(null);
          }}
        >
          로그아웃
        </button>
      </aside>
      <main key={current.id}>
        {current.id === 'status' && <Status call={call} />}
        {current.id === 'reports' && <Reports call={call} />}
        {current.id === 'appeals' && <Appeals call={call} />}
        {current.id === 'users' && <Users call={call} canSanction={admin.role !== 'support'} />}
        {current.id === 'rooms' && <Rooms call={call} />}
        {current.id === 'posts' && <Posts call={call} />}
        {current.id === 'ledger' && <Ledger call={call} />}
        {current.id === 'purchases' && <Purchases call={call} />}
        {current.id === 'prices' && <Prices call={call} />}
        {current.id === 'announcements' && <Announcements call={call} />}
        {current.id === 'inquiries' && <Inquiries call={call} />}
        {current.id === 'admins' && <Admins call={call} />}
        {current.id === 'audit' && <Audit call={call} />}
      </main>
    </div>
  );
}

// ── 공통 ────────────────────────────────────────────────────────────────

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    fn()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

function Page({ title, sub, actions, error, children }: { title: string; sub?: ReactNode; actions?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <>
      <header>
        <div>
          <h1>{title}</h1>
          {sub && <p className="secondary">{sub}</p>}
        </div>
        <div className="actions">{actions}</div>
      </header>
      {error && <div className="alert">{error}</div>}
      {children}
    </>
  );
}

function Table({ cols, rows, empty }: { cols: [string, (r: Row) => ReactNode, string?][]; rows: Row[] | undefined; empty: string }) {
  if (!rows) return <div className="panel muted">불러오는 중</div>;
  if (rows.length === 0) return <div className="panel muted">{empty}</div>;
  return (
    <div className="panel table">
      <table>
        <thead>
          <tr>
            {cols.map(([h, , cls]) => (
              <th key={h} className={cls}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? r.key ?? i}>
              {cols.map(([h, f, cls]) => (
                <td key={h} className={cls}>
                  {f(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tabs({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="tabs">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** 실행 후 목록을 다시 불러오고, 실패하면 사유를 보여준다. */
function useAction(reload: () => void) {
  const [error, setError] = useState<string | null>(null);
  const run = async (job: () => Promise<unknown>) => {
    setError(null);
    try {
      await job();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { error, run };
}

// ── 화면 ────────────────────────────────────────────────────────────────

function Status({ call }: { call: Call }) {
  const { data: s, error, reload } = useLoad(() => call('GET', '/system-status'), []);
  const blocking = (s?.problems ?? []).filter((p: Row) => p.blocking);
  const notes = (s?.problems ?? []).filter((p: Row) => !p.blocking);
  const checks: [string, boolean, string][] = s
    ? [
        ['신규 가입', s.signupAvailable, s.signupAvailable ? '가능' : '중단됨'],
        ['본인확인', s.identityMode === 'live' || (s.identityMode === 'dev' && s.environment !== 'production'), s.identityMode === 'dev' ? '개발용 테스트 인증' : s.identityMode === 'live' ? '인증기관 연동' : '설정 없음'],
        ['데이터베이스', s.database === 'ok', s.database === 'ok' ? '정상' : '오류'],
        ['Redis', s.redis === 'ok', s.redis === 'ok' ? '정상' : s.redis === 'not_configured' ? '미연결(서버 1대 방식)' : '오류'],
        ['사진 저장소', s.storage === 's3', s.storage === 's3' ? 'S3 호환 저장소' : '서버 디스크(임시)'],
        ['푸시 발송', s.push === 'fcm', s.push === 'fcm' ? 'FCM' : '기록만 남김'],
        ['결제 검증', s.iap === 'live', s.iap === 'live' ? '스토어 연동' : '개발용 검증'],
      ]
    : [];
  const counts: [string, string][] = [
    ['users', '회원'],
    ['rooms', '그룹방'],
    ['posts', '게시물'],
    ['open_reports', '처리 전 신고'],
    ['pending_appeals', '이의신청'],
    ['open_inquiries', '답변 전 문의'],
  ];
  return (
    <Page title="시스템 상태" sub={s ? `${ENV_LABEL[s.environment] ?? s.environment} 환경` : '확인 중'} error={error} actions={<button onClick={reload}>다시 확인</button>}>
      {blocking.length > 0 && (
        <section className="alert">
          <h2>조치가 필요한 설정 {blocking.length}건</h2>
          <ul className="kv">
            {blocking.map((p: Row) => (
              <li key={p.key}>
                <span className="mono">{p.key}</span>
                {p.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {s && (
        <>
          <section className="stats">
            {counts.map(([k, l]) => (
              <div key={k}>
                <span className="secondary">{l}</span>
                <strong>{num.format(s.counts[k] ?? 0)}</strong>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>점검 항목</h2>
            <ul className="checks">
              {checks.map(([label, ok, value]) => (
                <li key={label}>
                  <i className={ok ? 'dot ok' : 'dot off'} aria-hidden />
                  <span>{label}</span>
                  <span className={ok ? 'secondary' : 'bad'}>{value}</span>
                </li>
              ))}
            </ul>
          </section>
          {notes.length > 0 && (
            <section className="panel">
              <h2>참고</h2>
              <ul className="kv secondary">
                {notes.map((p: Row) => (
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
    </Page>
  );
}

function Reports({ call }: { call: Call }) {
  const [status, setStatus] = useState('open');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(() => call('GET', `/reports?status=${status}`), [status]);
  if (open) return <ReportDetail call={call} id={open} back={() => (setOpen(null), reload())} />;
  return (
    <Page title="신고" sub="목록에는 신고된 내용이 표시되지 않습니다. 건별로 열면 증거가 보이고 열람 기록이 남습니다" error={error}>
      <Tabs value={status} onChange={setStatus} options={[['open', '처리 전'], ['resolved', '조치함'], ['dismissed', '종결'], ['all', '전체']]} />
      <Table
        empty="해당하는 신고가 없습니다"
        rows={data?.items}
        cols={[
          ['접수', (r) => when(r.createdAt), 'nowrap'],
          ['대상', (r) => TARGET_LABEL[r.targetType] ?? r.targetType],
          ['사유', (r) => r.reasonLabel],
          ['신고된 회원', (r) => `${r.target ?? '-'}${r.targetReports > 1 ? ` (누적 ${r.targetReports})` : ''}`],
          ['신고자', (r) => r.reporter ?? '-'],
          ['결과', (r) => r.resolution ?? '처리 전'],
          ['', (r) => <button onClick={() => setOpen(r.id)}>{r.status === 'open' ? '증거 확인' : '보기'}</button>, 'right'],
        ]}
      />
    </Page>
  );
}

function ReportDetail({ call, id, back }: { call: Call; id: string; back: () => void }) {
  const { data: r, error, reload } = useLoad(() => call('GET', `/reports/${id}`), [id]);
  const act = useAction(reload);
  const [note, setNote] = useState('');
  const [days, setDays] = useState('7');
  const ev: Row = r?.evidence ?? {};
  const text = ev.body ?? ev.bio ?? ev.intro ?? null;
  const send = (action: string, extra: Row = {}) => {
    const label = { dismiss: '조치 없이 종결', warn: '경고', hide: '콘텐츠 숨김', suspend: '이용 정지' }[action];
    if (window.confirm(`"${label}" 처리할까요? 대상자와 신고자에게 결과가 통지됩니다.`)) act.run(() => call('POST', `/reports/${id}/action`, { action, note, ...extra }));
  };
  return (
    <Page title="신고 상세" sub={r ? `${TARGET_LABEL[r.targetType] ?? r.targetType} · ${r.reasonLabel} · ${when(r.createdAt)}` : '불러오는 중'} error={error || act.error} actions={<button onClick={back}>목록으로</button>}>
      {r && (
        <>
          <section className="panel">
            <h2>신고 내용</h2>
            <ul className="kv">
              <li>
                <span className="secondary">신고자</span>
                {r.reporter ?? '-'}
              </li>
              <li>
                <span className="secondary">신고된 회원</span>
                {r.target ?? '-'} {r.targetStatus === 'suspended' && <span className="bad">정지 중</span>}
              </li>
              {r.detail && (
                <li>
                  <span className="secondary">신고자 설명</span>
                  {r.detail}
                </li>
              )}
            </ul>
          </section>
          <section className="panel">
            <h2>증거 (신고 시점의 사본)</h2>
            {ev.title && <p>{ev.title}</p>}
            {text ? <blockquote>{text}</blockquote> : !r.photos.length && <p className="muted">글 내용이 없는 신고입니다</p>}
            {r.photos.length > 0 && (
              <div className="photos">
                {r.photos.map((p: Row) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={p.mediaId} src={p.url} alt="신고된 사진" />
                ))}
              </div>
            )}
            <p className="muted mono">
              {ev.sentAt && `작성 ${when(ev.sentAt)} · `}
              {ev.postedAt && `게시 ${when(ev.postedAt)} · `}신고 {when(ev.reportedAt)}
            </p>
          </section>
          {r.status === 'open' ? (
            <section className="panel">
              <h2>조치</h2>
              <label htmlFor="note">처리 메모 (대상자 통지의 사유에 포함됩니다)</label>
              <input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="actions wrap">
                <button onClick={() => send('dismiss')}>조치 없이 종결</button>
                <button onClick={() => send('warn')}>경고</button>
                <button onClick={() => send('hide')}>콘텐츠 숨김</button>
                <span className="inline">
                  <input className="short" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" aria-label="정지 일수" />일
                  <button className="danger" onClick={() => send('suspend', { days: Number(days) || undefined })}>
                    이용 정지
                  </button>
                </span>
              </div>
            </section>
          ) : (
            <section className="panel">
              <h2>처리 결과</h2>
              <p>
                {r.resolution} · {when(r.resolvedAt)}
              </p>
            </section>
          )}
          {r.priorSanctions.length > 0 && (
            <section className="panel">
              <h2>이 회원의 이전 조치</h2>
              <ul className="kv">
                {r.priorSanctions.map((s: Row, i: number) => (
                  <li key={i}>
                    <span className="mono">{when(s.createdAt)}</span>
                    {s.type === 'warning' ? '경고' : s.type === 'suspension' ? '이용 정지' : '콘텐츠 숨김'} — {s.reason}
                    {s.lifted && ' (해제됨)'}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="panel">
            <h2>열람·조치 이력</h2>
            <ul className="kv secondary">
              {r.history.map((h: Row, i: number) => (
                <li key={i}>
                  <span className="mono">{when(h.at)}</span>
                  {h.by} · {h.action === 'report.evidence.view' ? '증거 열람' : h.action.replace('report.', '조치: ').replace('appeal.', '이의신청: ')}
                  {h.detail?.resolution ? ` (${h.detail.resolution})` : ''}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Page>
  );
}

function Appeals({ call }: { call: Call }) {
  const [status, setStatus] = useState('pending');
  const { data, error, reload } = useLoad(() => call('GET', `/appeals?status=${status}`), [status]);
  const act = useAction(reload);
  const decide = (id: string, accept: boolean) => {
    const answer = window.prompt(accept ? '받아들이는 이유(이용자에게 전달됩니다)' : '기각 사유(이용자에게 전달됩니다)');
    if (answer) act.run(() => call('POST', `/appeals/${id}/decide`, { accept, answer }));
  };
  return (
    <Page title="이의신청" sub="받아들이면 정지가 풀리고 숨긴 콘텐츠가 복구됩니다" error={error || act.error}>
      <Tabs value={status} onChange={setStatus} options={[['pending', '검토 전'], ['all', '전체']]} />
      <Table
        empty="이의신청이 없습니다"
        rows={data?.items}
        cols={[
          ['접수', (r) => when(r.createdAt), 'nowrap'],
          ['회원', (r) => r.nickname ?? '-'],
          ['받은 조치', (r) => `${r.sanctionType === 'suspension' ? '이용 정지' : r.sanctionType === 'warning' ? '경고' : '콘텐츠 숨김'} — ${r.sanctionReason}`],
          ['이의 내용', (r) => r.body],
          ['', (r) => (r.status === 'pending' ? (<span className="inline"><button onClick={() => decide(r.id, false)}>기각</button><button className="primary" onClick={() => decide(r.id, true)}>받아들임</button></span>) : (r.status === 'accepted' ? `받아들임: ${r.answer}` : `기각: ${r.answer}`)), 'right'],
        ]}
      />
    </Page>
  );
}

function Users({ call, canSanction }: { call: Call; canSanction: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const { data, error, reload } = useLoad(() => call('GET', `/users?q=${encodeURIComponent(query)}&status=${status}`), [query, status]);
  const act = useAction(reload);
  const suspend = (r: Row) => {
    const reason = window.prompt(`${r.nickname} 님을 정지하는 사유`);
    if (!reason) return;
    const days = Number(window.prompt('정지 일수 (비우면 무기한)', '7')) || undefined;
    act.run(() => call('POST', `/users/${r.id}/suspension`, { suspended: true, reason, days }));
  };
  return (
    <Page title="회원" sub="휴대폰 번호·실명·생년은 이 화면에도 표시되지 않습니다" error={error || act.error}>
      <form className="search" onSubmit={(e) => (e.preventDefault(), setQuery(q))}>
        <input placeholder="닉네임 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">검색</button>
      </form>
      <Tabs value={status} onChange={setStatus} options={[['all', '전체'], ['active', '이용 중'], ['suspended', '정지'], ['deleted', '탈퇴']]} />
      <Table
        empty="회원이 없습니다"
        rows={data?.items}
        cols={[
          ['닉네임', (r) => r.nickname ?? '-'],
          ['연령대', (r) => r.ageBand ?? ''],
          ['지역', (r) => r.region ?? ''],
          ['상태', (r) => (r.status === 'suspended' ? <span className="bad">정지{r.suspendedUntil ? ` ~${when(r.suspendedUntil)}` : '(무기한)'}</span> : r.status === 'deleted' ? '탈퇴' : '이용 중')],
          ['신고', (r) => num.format(r.reports), 'num'],
          ['포인트', (r) => num.format(r.balance), 'num'],
          ['가입', (r) => when(r.createdAt), 'nowrap'],
          ['', (r) => canSanction && (r.status === 'active' ? <button onClick={() => suspend(r)}>정지</button> : r.status === 'suspended' ? <button onClick={() => act.run(() => call('POST', `/users/${r.id}/suspension`, { suspended: false }))}>정지 해제</button> : null), 'right'],
        ]}
      />
    </Page>
  );
}

function Rooms({ call }: { call: Call }) {
  const { data, error, reload } = useLoad(() => call('GET', '/rooms'), []);
  const act = useAction(reload);
  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    act.run(async () => {
      await call('POST', '/rooms', { title: f.get('title'), intro: f.get('intro'), regionId: f.get('regionId') || undefined, capacity: Number(f.get('capacity')) || 300 });
      form.reset();
    });
  };
  return (
    <Page title="그룹방" error={error || act.error}>
      <form className="panel inlineform" onSubmit={create}>
        <h2>상설 지역방 개설</h2>
        <input name="title" placeholder="방 제목 (예: 원주 지역방)" required />
        <input name="regionId" placeholder="지역 코드 (예: gangwon-02)" />
        <input name="intro" placeholder="소개" />
        <input name="capacity" className="short" placeholder="정원" defaultValue="300" inputMode="numeric" />
        <button className="primary" type="submit">
          개설
        </button>
      </form>
      <Table
        empty="그룹방이 없습니다"
        rows={data?.items}
        cols={[
          ['제목', (r) => r.title],
          ['종류', (r) => (r.kind === 'region' ? '상설 지역방' : r.isPrivate ? '관심사(비밀)' : '관심사')],
          ['지역', (r) => r.region ?? ''],
          ['방장', (r) => r.owner ?? '운영자'],
          ['인원', (r) => `${r.memberCount} / ${r.capacity}`, 'num'],
          ['최근 활동', (r) => when(r.lastActivityAt), 'nowrap'],
          ['', (r) => <button onClick={() => act.run(() => call('POST', `/rooms/${r.id}/status`, { open: r.status !== 'open' }))}>{r.status === 'open' ? '종료' : '다시 열기'}</button>, 'right'],
        ]}
      />
    </Page>
  );
}

function Posts({ call }: { call: Call }) {
  const [status, setStatus] = useState('all');
  const { data, error, reload } = useLoad(() => call('GET', `/posts?status=${status}`), [status]);
  const act = useAction(reload);
  return (
    <Page title="게시물" error={error || act.error}>
      <Tabs value={status} onChange={setStatus} options={[['all', '전체'], ['visible', '게시 중'], ['hidden', '숨김']]} />
      <Table
        empty="게시물이 없습니다"
        rows={data?.items}
        cols={[
          ['작성', (r) => when(r.createdAt), 'nowrap'],
          ['구분', (r) => (r.kind === 'market' ? '장터' : '게시판')],
          ['제목', (r) => r.title],
          ['작성자', (r) => r.author ?? '-'],
          ['지역', (r) => r.region],
          ['신고', (r) => num.format(r.reports), 'num'],
          ['고정', (r) => (r.pinnedUntil && new Date(r.pinnedUntil) > new Date() ? `~${when(r.pinnedUntil)}` : '')],
          ['', (r) => r.status !== 'deleted' ? <button onClick={() => { const hidden = r.status === 'visible'; const reason = hidden ? window.prompt('숨김 사유 (작성자에게 통지됩니다)') : ''; if (reason !== null) act.run(() => call('POST', `/posts/${r.id}/hidden`, { hidden, reason })); }}>{r.status === 'visible' ? '숨김' : '복구'}</button> : '삭제됨', 'right'],
        ]}
      />
    </Page>
  );
}

function Ledger({ call }: { call: Call }) {
  const [userId, setUserId] = useState('');
  const [applied, setApplied] = useState('');
  const { data, error, reload } = useLoad(() => call('GET', `/points/ledger${applied ? `?userId=${applied}` : ''}`), [applied]);
  const act = useAction(reload);
  const TYPE: Record<string, string> = { charge: '충전', spend: '사용', refund: '환불', admin: '관리자 조정', grant: '지급' };
  const adjust = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    act.run(() => call('POST', '/points/adjust', { userId: f.get('userId'), delta: Number(f.get('delta')), reason: f.get('reason') }));
  };
  return (
    <Page title="포인트 원장" sub="충전·사용·환불·관리자 조정이 건별로 남습니다" error={error || act.error}>
      <form className="search" onSubmit={(e) => (e.preventDefault(), setApplied(userId.trim()))}>
        <input placeholder="회원 ID로 좁혀 보기 (회원 화면에서 복사)" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <button type="submit">조회</button>
      </form>
      <form className="panel inlineform" onSubmit={adjust}>
        <h2>관리자 조정</h2>
        <input name="userId" placeholder="회원 ID" required defaultValue={applied} />
        <input name="delta" className="short" placeholder="+100 / -50" required />
        <input name="reason" placeholder="사유 (원장에 기록)" required />
        <button className="primary" type="submit">
          반영
        </button>
      </form>
      <Table
        empty="내역이 없습니다"
        rows={data?.items}
        cols={[
          ['시각', (r) => when(r.createdAt), 'nowrap'],
          ['회원', (r) => <span title={r.userId}>{r.nickname ?? r.userId.slice(0, 8)}</span>],
          ['구분', (r) => TYPE[r.type] ?? r.type],
          ['내용', (r) => r.reason],
          ['증감', (r) => `${r.delta > 0 ? '+' : ''}${num.format(r.delta)}`, 'num'],
          ['잔액', (r) => num.format(r.balanceAfter), 'num'],
          ['처리자', (r) => r.by ?? ''],
        ]}
      />
    </Page>
  );
}

function Purchases({ call }: { call: Call }) {
  const { data, error } = useLoad(() => call('GET', '/purchases'), []);
  const SUB: Record<string, string> = { active: '이용 중', expired: '만료', refunded: '환불' };
  return (
    <Page title="결제·환불" error={error}>
      <h2 className="sub">구매</h2>
      <Table
        empty="구매 내역이 없습니다"
        rows={data?.purchases}
        cols={[
          ['시각', (r) => when(r.createdAt), 'nowrap'],
          ['회원', (r) => r.nickname ?? '-'],
          ['스토어', (r) => r.store],
          ['상품', (r) => r.product],
          ['지급', (r) => `${num.format(r.points)}P`, 'num'],
          ['상태', (r) => (r.status === 'refunded' ? <span className="bad">환불 {when(r.refundedAt)}</span> : '지급 완료')],
          ['거래 ID', (r) => <span className="mono">{r.transactionId}</span>],
        ]}
      />
      <h2 className="sub">구독</h2>
      <Table
        empty="구독이 없습니다"
        rows={data?.subscriptions}
        cols={[
          ['회원', (r) => r.nickname ?? '-'],
          ['스토어', (r) => r.store],
          ['상품', (r) => <span className="mono">{r.productId}</span>],
          ['상태', (r) => SUB[r.status] ?? r.status],
          ['만료', (r) => when(r.expiresAt), 'nowrap'],
          ['자동 갱신', (r) => (r.autoRenew ? '예' : '아니오')],
        ]}
      />
    </Page>
  );
}

function Prices({ call }: { call: Call }) {
  const { data, error, reload } = useLoad(() => call('GET', '/prices'), []);
  const act = useAction(reload);
  const edit = (r: Row) => {
    const points = window.prompt(`${r.label} — 포인트 (${r.unit})`, String(r.points));
    if (points === null) return;
    const free = window.prompt('하루 무료 제공 횟수', String(r.freePerDay));
    if (free === null) return;
    act.run(() => call('PUT', `/prices/${r.key}`, { points: Number(points), freePerDay: Number(free) }));
  };
  const editProduct = (r: Row) => {
    const points = window.prompt(`${r.title} — 지급 포인트`, String(r.points));
    if (points !== null) act.run(() => call('PUT', `/products/${r.id}`, { points: Number(points), active: r.active }));
  };
  return (
    <Page title="가격 설정" sub="기본 1대1 대화와 신고·차단은 항상 무료입니다. 실제 결제 금액은 스토어 상품에 설정합니다" error={error || act.error}>
      <h2 className="sub">유료 기능</h2>
      <Table
        empty=""
        rows={data?.prices}
        cols={[
          ['기능', (r) => r.label],
          ['단위', (r) => r.unit],
          ['포인트', (r) => num.format(r.points), 'num'],
          ['하루 무료', (r) => num.format(r.freePerDay), 'num'],
          ['', (r) => <button onClick={() => edit(r)}>변경</button>, 'right'],
        ]}
      />
      <h2 className="sub">스토어 상품</h2>
      <Table
        empty=""
        rows={data?.products}
        cols={[
          ['상품 ID', (r) => <span className="mono">{r.id}</span>],
          ['이름', (r) => r.title],
          ['종류', (r) => (r.kind === 'subscription' ? '구독' : '포인트')],
          ['지급 포인트', (r) => num.format(r.points), 'num'],
          ['판매', (r) => (r.active ? '판매 중' : '중지')],
          ['', (r) => (<span className="inline"><button onClick={() => editProduct(r)}>포인트 변경</button><button onClick={() => act.run(() => call('PUT', `/products/${r.id}`, { points: r.points, active: !r.active }))}>{r.active ? '판매 중지' : '판매 재개'}</button></span>), 'right'],
        ]}
      />
    </Page>
  );
}

function Announcements({ call }: { call: Call }) {
  const { data, error, reload } = useLoad(() => call('GET', '/announcements'), []);
  const act = useAction(reload);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    act.run(async () => {
      await call('POST', '/announcements', { title: f.get('title'), body: f.get('body') });
      form.reset();
    });
  };
  return (
    <Page title="운영 공지" error={error || act.error}>
      <form className="panel stack" onSubmit={submit}>
        <h2>새 공지</h2>
        <input name="title" placeholder="제목" required />
        <textarea name="body" placeholder="내용" rows={4} required />
        <div className="actions">
          <button className="primary" type="submit">
            등록
          </button>
        </div>
      </form>
      <Table
        empty="공지가 없습니다"
        rows={data?.items}
        cols={[
          ['등록', (r) => when(r.createdAt), 'nowrap'],
          ['제목', (r) => r.title],
          ['내용', (r) => r.body],
          ['', (r) => <button onClick={() => act.run(() => call('POST', `/announcements/${r.id}/published`, { published: !r.published }))}>{r.published ? '내리기' : '다시 게시'}</button>, 'right'],
        ]}
      />
    </Page>
  );
}

function Inquiries({ call }: { call: Call }) {
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad(() => call('GET', `/inquiries?status=${status}`), [status]);
  const act = useAction(reload);
  return (
    <Page title="문의" error={error || act.error}>
      <Tabs value={status} onChange={setStatus} options={[['open', '답변 전'], ['answered', '답변 완료'], ['all', '전체']]} />
      <Table
        empty="문의가 없습니다"
        rows={data?.items}
        cols={[
          ['접수', (r) => when(r.createdAt), 'nowrap'],
          ['회원', (r) => r.nickname ?? '-'],
          ['내용', (r) => r.body],
          ['답변', (r) => r.answer ?? <button onClick={() => { const answer = window.prompt('답변 (이용자에게 알림으로 전달됩니다)'); if (answer) act.run(() => call('POST', `/inquiries/${r.id}/answer`, { answer })); }}>답변하기</button>],
        ]}
      />
    </Page>
  );
}

function Admins({ call }: { call: Call }) {
  const { data, error, reload } = useLoad(() => call('GET', '/admins'), []);
  const act = useAction(reload);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    act.run(async () => {
      await call('POST', '/admins', { email: f.get('email'), name: f.get('name'), password: f.get('password'), role: f.get('role') });
      form.reset();
    });
  };
  return (
    <Page title="관리자 계정" sub="신고 처리 담당만 신고 증거를 볼 수 있고, 정산 담당만 포인트·결제를 다룹니다" error={error || act.error}>
      <form className="panel inlineform" onSubmit={submit}>
        <h2>관리자 추가</h2>
        <input name="email" type="email" placeholder="이메일" required />
        <input name="name" placeholder="이름" />
        <input name="password" type="password" placeholder="비밀번호 (10자 이상)" minLength={10} required />
        <select name="role" defaultValue="moderator" aria-label="역할">
          {Object.entries(ROLE_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button className="primary" type="submit">
          추가
        </button>
      </form>
      <Table
        empty=""
        rows={data?.items}
        cols={[
          ['이메일', (r) => r.email],
          ['이름', (r) => r.name],
          ['역할', (r) => (<select value={r.role} aria-label="역할" onChange={(e) => act.run(() => call('POST', `/admins/${r.id}`, { role: e.target.value }))}>{Object.entries(ROLE_LABEL).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}</select>)],
          ['상태', (r) => (r.active ? '사용 중' : '중지')],
          ['', (r) => <button onClick={() => act.run(() => call('POST', `/admins/${r.id}`, { active: !r.active }))}>{r.active ? '사용 중지' : '다시 사용'}</button>, 'right'],
        ]}
      />
    </Page>
  );
}

function Audit({ call }: { call: Call }) {
  const { data, error } = useLoad(() => call('GET', '/audit'), []);
  return (
    <Page title="열람·조치 기록" sub="신고 증거 열람과 모든 관리자 조치가 남습니다" error={error}>
      <Table
        empty="기록이 없습니다"
        rows={data?.items}
        cols={[
          ['시각', (r) => when(r.at), 'nowrap'],
          ['관리자', (r) => r.by ?? '-'],
          ['행동', (r) => <span className="mono">{r.action}</span>],
          ['대상', (r) => (r.targetType ? `${r.targetType} ${String(r.targetId ?? '').slice(0, 8)}` : '')],
          ['내용', (r) => <span className="mono">{Object.keys(r.detail ?? {}).length ? JSON.stringify(r.detail) : ''}</span>],
        ]}
      />
    </Page>
  );
}
