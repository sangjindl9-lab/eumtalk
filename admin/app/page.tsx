import AdminApp from './admin-app';

// API 주소는 빌드 시점이 아니라 실행 시점의 환경변수에서 읽는다.
export const dynamic = 'force-dynamic';

export default function Page() {
  return <AdminApp apiBase={(process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')} />;
}
