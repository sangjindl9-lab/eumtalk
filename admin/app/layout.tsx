import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '이음톡 관리자', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
