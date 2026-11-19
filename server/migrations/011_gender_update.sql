-- 남녀 구분: 성별은 필수·항상 표시. 기존 회원 중 성별을 넣은 회원은 공개로 맞춘다(비공개 선택지 폐지).
UPDATE profiles SET gender_public = true WHERE gender IN ('male', 'female');
UPDATE profiles SET gender = NULL, gender_public = false WHERE gender NOT IN ('male', 'female');

-- 앱 최신 버전·필수 업데이트 기준(관리자 화면에서 바꾼다)
CREATE TABLE app_release (
  platform     text PRIMARY KEY CHECK (platform IN ('android', 'ios')),
  latest_build int NOT NULL DEFAULT 0,
  latest_name  text NOT NULL DEFAULT '',
  min_build    int NOT NULL DEFAULT 0,
  notes        text NOT NULL DEFAULT '',
  store_url    text NOT NULL DEFAULT '',
  notified_build int NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_release (platform, latest_build, latest_name, store_url) VALUES
  ('android', 0, '', 'https://play.google.com/store/apps/details?id=kr.eumsoft.eumtalk'),
  ('ios', 0, '', '');
