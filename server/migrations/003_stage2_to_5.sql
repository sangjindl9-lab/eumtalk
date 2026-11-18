-- 2~5단계: 사진, 그룹방, 푸시, 게시판·장터, 신고 처리·관리자, 포인트·구독, 계정 삭제

-- ── 사진(비공개 저장소) ────────────────────────────────────────────────
CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id),
  purpose         text NOT NULL CHECK (purpose IN ('profile','chat','post','room')),
  conversation_id uuid REFERENCES conversations(id),   -- purpose='chat' 일 때 접근 범위
  storage_key     text NOT NULL,
  mime            text NOT NULL,
  bytes           int  NOT NULL,
  width           int,
  height          int,
  status          text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','hidden','deleted')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_owner_idx ON media (owner_id);

ALTER TABLE profiles ADD COLUMN photo_media_id uuid REFERENCES media(id);
ALTER TABLE profiles ADD COLUMN push_preview boolean NOT NULL DEFAULT true;
ALTER TABLE profiles ADD COLUMN browse_region_id text REFERENCES regions(id);
ALTER TABLE profiles ADD COLUMN browse_until timestamptz;

-- ── 메시지 확장 ────────────────────────────────────────────────────────
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','greeting','system','image'));
ALTER TABLE messages ADD COLUMN media_id uuid REFERENCES media(id);
ALTER TABLE messages ADD COLUMN meta jsonb;
ALTER TABLE messages ADD COLUMN hidden_at timestamptz;      -- 운영 조치로 숨김
ALTER TABLE greeting_requests ADD COLUMN context jsonb;     -- 장터 거래 문의 등
ALTER TABLE greeting_requests ADD COLUMN batch_id uuid;     -- 다중 인사

-- ── 그룹방 ────────────────────────────────────────────────────────────
CREATE TABLE rooms (
  conversation_id   uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('region','interest')),
  title             text NOT NULL,
  intro             text NOT NULL DEFAULT '',
  image_media_id    uuid REFERENCES media(id),
  tags              text[] NOT NULL DEFAULT '{}',
  region_id         text REFERENCES regions(id),
  capacity          int  NOT NULL DEFAULT 30 CHECK (capacity BETWEEN 2 AND 1000),
  member_count      int  NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  searchable        boolean NOT NULL DEFAULT true,
  is_private        boolean NOT NULL DEFAULT false,
  invite_code       text,
  require_approval  boolean NOT NULL DEFAULT false,
  owner_id          uuid REFERENCES users(id),
  pinned_message_id uuid REFERENCES messages(id),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (member_count <= capacity)
);
CREATE INDEX rooms_region_idx ON rooms (region_id) WHERE status = 'open';
CREATE INDEX rooms_tags_idx ON rooms USING gin (tags);

CREATE TABLE room_join_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
CREATE UNIQUE INDEX room_join_requests_pending_uq ON room_join_requests (conversation_id, user_id) WHERE status = 'pending';

CREATE TABLE room_bans (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  until           timestamptz,           -- NULL = 무기한 재가입 제한
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- ── 푸시 ──────────────────────────────────────────────────────────────
CREATE TABLE device_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_tokens_user_idx ON device_tokens (user_id);

-- 발송 기록(개발용 발송기는 여기에만 남긴다. 시험에서 "푸시가 가지 않았다"를 확인하는 근거)
CREATE TABLE push_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_log_user_idx ON push_log (user_id, id DESC);

-- ── 게시판·장터 ───────────────────────────────────────────────────────
CREATE TABLE posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id        uuid NOT NULL REFERENCES users(id),
  kind             text NOT NULL CHECK (kind IN ('board','market')),
  category         text NOT NULL CHECK (category IN ('daily','question','hobby','meetup','sell','buy','free')),
  region_id        text NOT NULL REFERENCES regions(id),
  title            text NOT NULL,
  body             text NOT NULL DEFAULT '',
  price            int CHECK (price IS NULL OR price >= 0),
  item_condition   text,
  market_status    text CHECK (market_status IN ('selling','reserved','done')),
  media_ids        uuid[] NOT NULL DEFAULT '{}',
  like_count       int NOT NULL DEFAULT 0,
  comment_count    int NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','deleted')),
  pinned_until     timestamptz,
  pinned_region_id text REFERENCES regions(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_list_idx ON posts (kind, region_id, created_at DESC) WHERE status = 'visible';
CREATE INDEX posts_author_idx ON posts (author_id, created_at DESC);

CREATE TABLE post_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_comments_post_idx ON post_comments (post_id, created_at);

CREATE TABLE post_likes (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE post_bookmarks (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- ── 포인트·상품·구독 ──────────────────────────────────────────────────
CREATE TABLE point_wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  balance int NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

CREATE TABLE point_ledger (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  delta         int  NOT NULL,
  balance_after int  NOT NULL,
  type          text NOT NULL CHECK (type IN ('charge','spend','refund','admin','grant')),
  reason        text NOT NULL,
  ref_type      text,
  ref_id        text,
  idem_key      text UNIQUE,          -- 같은 사건이 두 번 반영되지 않게 한다
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX point_ledger_user_idx ON point_ledger (user_id, id DESC);

CREATE TABLE products (
  id               text PRIMARY KEY,           -- 스토어 상품 ID와 동일
  kind             text NOT NULL CHECK (kind IN ('points','subscription')),
  title            text NOT NULL,
  points           int  NOT NULL DEFAULT 0,    -- 포인트 상품: 지급량 / 구독: 갱신 때마다 지급하는 포인트
  active           boolean NOT NULL DEFAULT true,
  sort             int NOT NULL DEFAULT 0
);

CREATE TABLE purchases (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id),
  store                   text NOT NULL CHECK (store IN ('google','apple','dev')),
  product_id              text NOT NULL REFERENCES products(id),
  transaction_id          text NOT NULL,
  original_transaction_id text,
  status                  text NOT NULL DEFAULT 'granted' CHECK (status IN ('granted','refunded')),
  points_granted          int NOT NULL DEFAULT 0,
  raw                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  refunded_at             timestamptz,
  UNIQUE (store, transaction_id)             -- 같은 영수증을 다시 처리해도 한 번만 지급
);
CREATE INDEX purchases_user_idx ON purchases (user_id, created_at DESC);

CREATE TABLE subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id),
  store                   text NOT NULL,
  product_id              text NOT NULL REFERENCES products(id),
  original_transaction_id text NOT NULL,
  status                  text NOT NULL CHECK (status IN ('active','expired','refunded')),
  expires_at              timestamptz NOT NULL,
  auto_renew              boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store, original_transaction_id)
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);

-- 유료 기능 가격·무료 제공량 (관리자에서 수정)
CREATE TABLE feature_prices (
  key          text PRIMARY KEY,
  label        text NOT NULL,
  points       int  NOT NULL CHECK (points >= 0),
  free_per_day int  NOT NULL DEFAULT 0 CHECK (free_per_day >= 0),
  unit         text NOT NULL DEFAULT ''
);
INSERT INTO feature_prices (key, label, points, free_per_day, unit) VALUES
  ('multi_greeting', '다중 인사', 10, 0, '받는 사람 1명당'),
  ('post_pin', '게시글 상단 고정', 50, 0, '1일당'),
  ('room_expand', '그룹방 정원 확장', 100, 0, '10명당'),
  ('region_browse', '다른 지역 둘러보기', 30, 0, '24시간');

CREATE TABLE feature_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     text NOT NULL,
  day     date NOT NULL,
  used    int  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key, day)
);

INSERT INTO products (id, kind, title, points, sort) VALUES
  ('eumtalk.points.100', 'points', '포인트 100', 100, 1),
  ('eumtalk.points.550', 'points', '포인트 550', 550, 2),
  ('eumtalk.points.1200', 'points', '포인트 1,200', 1200, 3),
  ('eumtalk.premium.monthly', 'subscription', '프리미엄 월간', 300, 10);

-- ── 관리자·신고 처리 ──────────────────────────────────────────────────
CREATE TABLE admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','moderator','support','finance')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,
  admin_id   uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 관리자의 열람·조치 기록. 신고 증거 열람도 모두 여기에 남는다.
CREATE TABLE admin_audit_log (
  id          bigserial PRIMARY KEY,
  admin_id    uuid REFERENCES admins(id),
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_target_idx ON admin_audit_log (target_type, target_id, id DESC);

ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('profile','message','greeting','post','comment','room','photo'));
ALTER TABLE reports ADD COLUMN resolution text;
ALTER TABLE reports ADD COLUMN resolved_by uuid REFERENCES admins(id);
ALTER TABLE reports ADD COLUMN resolved_at timestamptz;

CREATE TABLE sanctions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  type       text NOT NULL CHECK (type IN ('warning','content_hidden','suspension')),
  reason     text NOT NULL,
  report_id  uuid REFERENCES reports(id),
  until      timestamptz,
  lifted_at  timestamptz,
  created_by uuid REFERENCES admins(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sanctions_user_idx ON sanctions (user_id, created_at DESC);

CREATE TABLE appeals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sanction_id uuid NOT NULL REFERENCES sanctions(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  answer      text,
  decided_by  uuid REFERENCES admins(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX appeals_one_pending_uq ON appeals (sanction_id) WHERE status = 'pending';

-- 이용자에게 보내는 처리 결과 통지
CREATE TABLE user_notices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  ref        jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_notices_user_idx ON user_notices (user_id, created_at DESC);

CREATE TABLE announcements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  body         text NOT NULL,
  published    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES admins(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inquiries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  answer      text,
  answered_by uuid REFERENCES admins(id),
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 계정 삭제 처리 기록(무엇을 지우고 무엇을 보존했는지)
CREATE TABLE account_deletions (
  user_id    uuid PRIMARY KEY REFERENCES users(id),
  reason     text NOT NULL DEFAULT '',
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN suspended_until timestamptz;
