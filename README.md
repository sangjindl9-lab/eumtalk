# 이음톡 EUM TALK

내 주변 사람과 관심사 모임을 찾고, 서로 동의하면 1대1 대화를 이어가는 국내 성인 회원 전용 채팅 앱입니다.
Android·iOS 앱(Flutter)이 같은 서버(NestJS + PostgreSQL + WebSocket)를 사용합니다.

> 1~5단계 구현 완료(서버 통합 시험 20건 통과). 실기기 시험과 외부 계정이 필요한 연동(본인확인·FCM·스토어 결제·S3)은 `docs/시험-결과.md` 의 미검증 항목 참고

## 폴더 구성

| 폴더 | 내용 |
|---|---|
| `brand/` | 앱 이름·색상·아이콘·운영사 정보 (**여기 한 곳만 고치면** 서버·앱에 반영) |
| `server/` | NestJS 서버, DB 마이그레이션(`migrations/`), 통합 시험(`test/`) |
| `mobile/` | Flutter 앱 (`lib/`), 플랫폼 폴더 준비 스크립트(`tool/bootstrap.py`) |
| `admin/` | Next.js 관리자 웹 (신고 처리, 회원·그룹방·게시물, 포인트·결제, 공지·문의, 권한 분리) |
| `docs/` | 설치·운영 설명서, 시험 시나리오, 시험 결과표 |
| `render.yaml` | Render 배포 구성 |
| `.github/workflows/ci.yml` | 서버 시험, 관리자 빌드, Android 테스트 APK 빌드 |

## 5분 실행

```bash
docker compose up -d db redis                 # PostgreSQL + Redis
cd server && cp .env.example .env && npm ci
npm run start:dev                             # http://localhost:3000 (마이그레이션 자동 적용)
npm run dev:accounts -- http://localhost:3000 4   # 테스트 계정 4개 (인증번호 000000)

cd ../mobile && python3 tool/bootstrap.py && flutter pub get
flutter run --dart-define=API_BASE_URL=http://<PC의 IP>:3000
```

자세한 내용은 [docs/설치-운영.md](docs/설치-운영.md), 검수 방법은 [docs/시험-시나리오.md](docs/시험-시나리오.md),
지금까지의 실제 시험 결과는 [docs/시험-결과.md](docs/시험-결과.md)를 보세요.

## 구현 범위

1. 가입(휴대폰 인증·성인 확인)·프로필·주변·인사·1대1 메시지
2. 그룹방(지역방·관심사방, 정원·승인·강퇴·위임·공지), 사진(비공개 저장소·제한 시간 링크·EXIF 제거), 푸시(서버)
3. 동네 게시판·장터(게시 전 필터, 거래 문의, 유료 상단 고정)
4. 신고 → 증거 확인 → 경고·숨김·정지 → 통지 → 이의신청, 관리자 권한 분리, 계정 삭제
5. 포인트 원장, 인앱결제 검증·구독(복원·갱신·만료·환불), 다중 인사, 정원 확장, 다른 지역 둘러보기
