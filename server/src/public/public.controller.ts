import { Controller, Get, Inject, Res } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * 스토어 등록에 필요한 공개 웹 페이지: 개인정보처리방침, 이용약관, 계정 삭제 안내.
 * 운영사 정보는 brand/brand.json 한 곳에서 바꾼다.
 */
@Controller()
export class PublicController {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  private page(res: any, title: string, body: string) {
    const b = this.cfg.brand;
    const op = b.operator || {};
    const contact = [op.company && `운영: ${esc(op.company)}`, op.email && `문의: <a href="mailto:${esc(op.email)}">${esc(op.email)}</a>`, op.phone && `전화: ${esc(op.phone)}`]
      .filter(Boolean)
      .join(' · ');
    res.type('html').setHeader('cache-control', 'public, max-age=300');
    res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(b.appName)}</title>
<style>
body{font:16px/1.7 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#1c1e1d;background:#f6f6f5;margin:0}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:24px;font-weight:600;margin:0 0 4px}h2{font-size:18px;font-weight:600;margin:32px 0 8px}
p,li{color:#3d413f}table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
th,td{border:1px solid rgba(28,30,29,.12);padding:8px 10px;text-align:left;vertical-align:top}th{background:#f0f0ee;font-weight:500}
.meta{color:#8a8f8d;font-size:14px}a{color:#2f6b5e}footer{margin-top:40px;color:#5b605e;font-size:14px}
</style></head><body><main><h1>${esc(title)}</h1><p class="meta">${esc(b.appName)} (${esc(b.appNameEn)})</p>${body}<footer>${contact}</footer></main></body></html>`);
  }

  @Get(['privacy', 'v1/privacy'])
  privacy(@Res() res: any) {
    const b = this.cfg.brand;
    const op = b.operator || {};
    this.page(
      res,
      '개인정보처리방침',
      `<p class="meta">시행일: 2026년 11월 18일</p>
<p>${esc(op.company || b.appName)}(이하 "운영자")는 ${esc(b.appName)} 서비스(이하 "서비스")를 제공하면서 이용자의 개인정보를 「개인정보 보호법」에 따라 다음과 같이 처리합니다.</p>
<h2>1. 처리하는 개인정보와 목적</h2>
<table><tr><th>구분</th><th>항목</th><th>목적</th></tr>
<tr><td>회원가입·본인확인</td><td>휴대폰 번호, 출생 연도(성인 여부·연령대 판단), 본인확인기관의 연계정보(CI) 해시</td><td>회원 식별, 성인 회원 확인, 중복 가입 방지</td></tr>
<tr><td>프로필</td><td>닉네임, 프로필 사진, 연령대, 성별(선택), 활동 지역(시·군·구), 관심사, 자기소개</td><td>주변 회원·모임 찾기, 프로필 표시</td></tr>
<tr><td>위치(선택)</td><td>'내 주변 찾기'를 켠 경우 약 500m 단위로 뭉갠 대략적 위치</td><td>가까운 회원 순서 정렬. 좌표와 정확한 거리는 다른 회원에게 제공하지 않습니다</td></tr>
<tr><td>서비스 이용</td><td>인사·대화 메시지, 대화 사진, 게시글·댓글·장터 글과 사진, 차단·신고 내역</td><td>메시지·게시 기능 제공, 안전한 이용 환경 유지</td></tr>
<tr><td>알림</td><td>기기 푸시 토큰</td><td>새 메시지·인사 알림 발송</td></tr>
<tr><td>결제</td><td>스토어 거래 번호, 구매 상품, 포인트 내역</td><td>포인트 지급·환불·구독 관리</td></tr>
<tr><td>자동 수집</td><td>접속 기록, 기기 종류(Android·iOS)</td><td>부정 이용 방지, 오류 대응</td></tr></table>
<p>휴대폰 번호, 실명, 생년월일은 다른 회원에게 표시하지 않습니다. 휴대폰 번호는 암호화하여 보관합니다.</p>
<h2>2. 보유 및 이용 기간</h2>
<p>회원 탈퇴(계정 삭제) 시 프로필·사진·위치·푸시 토큰·휴대폰 번호·출생 연도는 즉시 삭제하고, 게시글·댓글은 비공개 처리합니다. 다만 다음 정보는 관련 법령 또는 분쟁 대응을 위해 보존합니다.</p>
<ul><li>신고·운영 조치 기록: 3년(부정 이용 재발 방지)</li><li>결제·포인트 내역: 5년(전자상거래 등에서의 소비자보호에 관한 법률)</li><li>접속 기록: 3개월(통신비밀보호법)</li><li>상대방 대화방에 남은 메시지는 상대방의 대화 기록으로 남으며, 보낸 사람은 "탈퇴한 회원"으로 표시됩니다.</li></ul>
<h2>3. 개인 대화의 열람</h2>
<p>운영자는 개인 대화를 임의로 검색하거나 열람하지 않습니다. 이용자가 특정 메시지를 신고한 경우에만, 신고 처리 권한이 있는 담당자가 그 신고에 첨부된 내용을 확인하며 열람 기록이 남습니다.</p>
<h2>4. 제3자 제공 및 처리 위탁</h2>
<p>운영자는 이용자의 개인정보를 제3자에게 제공하지 않습니다. 서비스 운영을 위해 다음 업무를 위탁할 수 있습니다.</p>
<table><tr><th>수탁자</th><th>업무</th></tr>
<tr><td>Render Services, Inc.</td><td>서버·데이터베이스 운영(해외 이전: 미국 등, 서비스 이용 기간 동안 보관)</td></tr>
<tr><td>Google LLC(Firebase Cloud Messaging, Cloud Vision)</td><td>푸시 알림 발송, 공개 사진 유해성 판별</td></tr>
<tr><td>(주)코리아포트원 및 본인확인기관</td><td>휴대폰 본인확인</td></tr>
<tr><td>Google Play, Apple App Store</td><td>인앱 결제</td></tr></table>
<h2>5. 이용자의 권리</h2>
<p>이용자는 앱의 '내 정보'에서 언제든지 프로필을 열람·수정하고, 위치 정보를 끄고 삭제하며, 계정 삭제를 신청할 수 있습니다. 앱을 쓸 수 없는 경우 <a href="/account-deletion">계정 삭제 안내</a>에 따라 이메일로 요청할 수 있습니다.</p>
<h2>6. 만 19세 미만</h2>
<p>서비스는 성인 회원 전용이며, 만 19세 미만(연 나이 기준)의 가입을 받지 않습니다.</p>
<h2>7. 안전성 확보 조치</h2>
<p>휴대폰 번호 암호화, 비공개 사진 저장소와 제한 시간 링크, 사진의 촬영 위치 정보(EXIF) 제거, 관리자 권한 분리와 열람 기록, 전송 구간 암호화(HTTPS)를 적용합니다.</p>
<h2>8. 개인정보 보호책임자</h2>
<p>${esc(op.company || '')} ${op.representative ? esc(op.representative) : ''}<br>이메일: <a href="mailto:${esc(op.email || '')}">${esc(op.email || '')}</a></p>
<p>개인정보 침해 신고·상담은 개인정보침해신고센터(privacy.kisa.or.kr, 국번 없이 118)에 할 수 있습니다.</p>`,
    );
  }

  @Get(['terms', 'v1/terms'])
  terms(@Res() res: any) {
    const b = this.cfg.brand;
    this.page(
      res,
      '이용약관',
      `<p class="meta">시행일: 2026년 11월 18일</p>
<h2>1. 서비스</h2><p>${esc(b.appName)}은 내 주변 사람과 관심사 모임을 찾고, 동네 소식을 나누고, 서로 동의한 회원끼리 대화하는 성인 회원 전용 서비스입니다.</p>
<h2>2. 가입 자격</h2><p>휴대폰 본인확인과 성인 확인을 마친 만 19세 이상(연 나이 기준) 내국인만 가입할 수 있습니다. 한 사람은 하나의 계정만 쓸 수 있습니다.</p>
<h2>3. 금지 행위</h2><ul><li>성적 접근, 성매매·조건만남 등 거래 유도</li><li>사기, 금전 요구, 불법 상품 거래</li><li>욕설·혐오·괴롭힘</li><li>스팸·광고, 외부 연락처·링크로의 유도</li><li>타인 사칭, 타인의 개인정보 노출</li></ul>
<h2>4. 운영 조치</h2><p>신고를 확인해 경고, 콘텐츠 숨김, 이용 정지를 할 수 있으며, 결과는 앱 알림으로 알려 드립니다. 조치에 이의가 있으면 앱의 '조치 내역'에서 이의신청할 수 있습니다.</p>
<h2>5. 유료 서비스</h2><p>포인트와 프리미엄 구독은 Google Play·App Store 결제로 구매합니다. 환불과 구독 해지는 각 스토어의 정책과 절차를 따르며, 환불된 구매로 받은 포인트는 회수됩니다. 기본 1대1 대화와 신고·차단은 무료입니다.</p>
<h2>6. 계정 삭제</h2><p>앱의 '내 정보 &gt; 계정 삭제 신청'에서 언제든지 삭제할 수 있습니다. 남은 포인트는 사라집니다.</p>`,
    );
  }

  @Get(['account-deletion', 'v1/account-deletion'])
  deletion(@Res() res: any) {
    const b = this.cfg.brand;
    const email = b.operator?.email || '';
    this.page(
      res,
      '계정 삭제 안내',
      `<h2>앱에서 삭제하기</h2><ol><li>${esc(b.appName)} 앱을 열고 하단 '내 정보' 탭으로 이동합니다.</li><li>'계정 삭제 신청'을 누릅니다.</li><li>삭제되는 항목과 보존되는 항목을 확인한 뒤 "삭제"를 입력하고 '계정 삭제'를 누릅니다.</li></ol>
<h2>앱을 쓸 수 없는 경우</h2><p><a href="mailto:${esc(email)}?subject=${encodeURIComponent(`[${b.appName}] 계정 삭제 요청`)}">${esc(email)}</a>로 가입한 휴대폰 번호와 닉네임을 적어 보내 주세요. 본인 확인 후 7일 이내에 처리하고 결과를 회신합니다.</p>
<h2>삭제되는 정보</h2><ul><li>프로필(닉네임·사진·자기소개·관심사·활동 지역), 위치 정보</li><li>휴대폰 번호, 출생 연도, 본인확인 연계정보</li><li>푸시 알림 토큰, 로그인 상태, 차단 목록·북마크·공감</li><li>게시글·댓글은 즉시 비공개 처리됩니다.</li></ul>
<h2>보존되는 정보</h2><ul><li>신고·운영 조치 기록: 3년</li><li>결제·포인트 내역: 5년(전자상거래법)</li><li>상대방 대화방에 남은 메시지(보낸 사람은 "탈퇴한 회원"으로 표시)</li></ul>`,
    );
  }
}
