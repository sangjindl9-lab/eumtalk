-- 이음톡 1단계 스키마: 회원, 프로필, 인사 요청, 1대1 대화, 차단, 신고
CREATE TABLE regions (
  id       text PRIMARY KEY,
  sido     text NOT NULL,
  sigungu  text NOT NULL,
  name     text NOT NULL,
  sort     int  NOT NULL
);
CREATE INDEX regions_sido_idx ON regions (sido, sort);

CREATE TABLE interests (
  id   text PRIMARY KEY,
  name text NOT NULL,
  sort int  NOT NULL
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  phone_hash  text UNIQUE,            -- 탈퇴 시 NULL 처리
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- 다른 회원에게 절대 노출하지 않는 정보. API 응답 조립 시 이 테이블을 조인하지 않는다.
CREATE TABLE user_private (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_enc          text,
  birth_year         int,
  adult_verified_at  timestamptz,
  identity_provider  text,
  identity_ref_hash  text
);

CREATE TABLE profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname         text NOT NULL,
  age_band         text NOT NULL,
  gender           text CHECK (gender IN ('male','female','other')),
  gender_public    boolean NOT NULL DEFAULT false,
  region_id        text NOT NULL REFERENCES regions(id),
  bio              text NOT NULL DEFAULT '',
  avatar_color     int  NOT NULL DEFAULT 0,
  photo_key        text,
  show_in_nearby   boolean NOT NULL DEFAULT true,
  show_last_active boolean NOT NULL DEFAULT true,
  accept_greetings boolean NOT NULL DEFAULT true,
  last_active_at   timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profiles_nickname_uq ON profiles (lower(nickname));
CREATE INDEX profiles_region_idx ON profiles (region_id, last_active_at DESC);

CREATE TABLE profile_interests (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_id text NOT NULL REFERENCES interests(id),
  PRIMARY KEY (user_id, interest_id)
);
CREATE INDEX profile_interests_interest_idx ON profile_interests (interest_id);

-- 좌표는 서버가 약 500m 격자로 뭉갠 값만 저장한다.
CREATE TABLE user_locations (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  platform     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- 휴대폰 인증과 성인 확인을 단계별로 기록하는 가입 진행 상태
CREATE TABLE signup_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash         text NOT NULL,
  phone_enc          text NOT NULL,
  provider           text NOT NULL,
  code_hash          text,
  attempts           int  NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  phone_verified_at  timestamptz,
  signup_token_hash  text UNIQUE,
  adult_verified_at  timestamptz,
  birth_year         int,
  identity_ref_hash  text,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signup_verifications_phone_idx ON signup_verifications (phone_hash, created_at DESC);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL DEFAULT 'direct' CHECK (type IN ('direct','group')),
  user_low        uuid REFERENCES users(id),
  user_high       uuid REFERENCES users(id),
  last_seq        bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'direct' OR (user_low IS NOT NULL AND user_high IS NOT NULL AND user_low < user_high))
);
-- 두 사람 사이의 1대1 대화방은 하나만 존재한다.
CREATE UNIQUE INDEX conversations_direct_pair_uq ON conversations (user_low, user_high) WHERE type = 'direct';

CREATE TABLE conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL DEFAULT 'member',
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  last_read_seq   bigint NOT NULL DEFAULT 0,   -- 읽음 위치
  muted           boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  sender_id       uuid NOT NULL REFERENCES users(id),
  client_msg_id   text NOT NULL,
  kind            text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','greeting','system')),
  body            text NOT NULL,
  reply_to_id     uuid REFERENCES messages(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, sender_id, client_msg_id)   -- 재전송 중복 방지
);

CREATE TABLE greeting_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id       uuid NOT NULL REFERENCES users(id),
  receiver_id     uuid NOT NULL REFERENCES users(id),
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  conversation_id uuid REFERENCES conversations(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  CHECK (sender_id <> receiver_id)
);
-- 같은 상대에게 대기 중인 요청은 한 건만 허용한다.
CREATE UNIQUE INDEX greeting_requests_pending_uq ON greeting_requests (sender_id, receiver_id) WHERE status = 'pending';
CREATE INDEX greeting_requests_receiver_idx ON greeting_requests (receiver_id, status, created_at DESC);
CREATE INDEX greeting_requests_sender_idx ON greeting_requests (sender_id, created_at DESC);

CREATE TABLE reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id    uuid NOT NULL REFERENCES users(id),
  target_type    text NOT NULL CHECK (target_type IN ('profile','message','greeting')),
  target_id      text NOT NULL,
  target_user_id uuid REFERENCES users(id),
  reason         text NOT NULL CHECK (reason IN ('sexual','scam','abuse','spam','impersonation','privacy','other')),
  detail         text NOT NULL DEFAULT '',
  snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 신고 시점의 문제 콘텐츠 사본
  status         text NOT NULL DEFAULT 'open',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);
