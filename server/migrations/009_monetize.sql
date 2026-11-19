-- 수익·재방문 기능: 프로필 부스트, VIP 혜택, 포인트 선물, 나를 본 사람, 오늘의 추천 친구, 단체 알림.

ALTER TABLE profiles ADD COLUMN boost_until timestamptz;
CREATE INDEX profiles_boost_idx ON profiles (boost_until) WHERE boost_until IS NOT NULL;
-- 다른 회원 프로필을 볼 때 방문 기록을 남길지(끄면 내 방문자 목록도 열 수 없다)
ALTER TABLE profiles ADD COLUMN leave_footprints boolean NOT NULL DEFAULT true;
-- 광고성 정보(이벤트·쿠폰) 수신 동의 일시. 정보통신망법 제50조: 사전 동의 + 동의 사실 안내
ALTER TABLE profiles ADD COLUMN marketing_consent_at timestamptz;

INSERT INTO feature_prices (key, label, points, free_per_day, unit) VALUES
  ('profile_boost', '프로필 부스트', 50, 0, '30분'),
  ('visitor_unlock', '나를 본 사람 보기', 20, 0, '24시간')
ON CONFLICT (key) DO NOTHING;

UPDATE products SET title = 'VIP 월간', points = 3000 WHERE id = 'eumtalk.premium.monthly';

UPDATE growth_settings SET value = value || '{"vipDiscountPercent":30,"giftMin":10,"giftMax":1000,"giftDailyMax":3000,"recommendCount":3,"recommendHour":12,"recommendEnabled":true}'::jsonb;

ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','greeting','system','image','gift'));

CREATE TABLE gifts (
  id              bigserial PRIMARY KEY,
  sender_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  points          int NOT NULL CHECK (points > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gifts_sender_idx ON gifts (sender_id, created_at DESC);

CREATE TABLE profile_views (
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day       date NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewed_id, day, viewer_id)
);
CREATE TABLE visitor_unlocks (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  until   timestamptz NOT NULL
);

CREATE TABLE daily_picks (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      date NOT NULL,
  picks    uuid[] NOT NULL,
  pushed   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE job_runs (
  name text NOT NULL,
  day  date NOT NULL,
  at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, day)
);

CREATE TABLE push_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  advertising boolean NOT NULL,
  target      jsonb NOT NULL,
  sent        int NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES admins(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
