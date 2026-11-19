-- 성장(마케팅) 기능: 친구 초대, 출석 체크, 설정값.

-- 회원마다 초대 코드 하나(대문자·숫자 6자, 헷갈리는 0/O/1/I 제외)
ALTER TABLE profiles ADD COLUMN invite_code text;
DO $$
DECLARE r record; c text; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  FOR r IN SELECT user_id FROM profiles WHERE invite_code IS NULL LOOP
    LOOP
      c := '';
      FOR i IN 1..6 LOOP c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE invite_code = c);
    END LOOP;
    UPDATE profiles SET invite_code = c WHERE user_id = r.user_id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX profiles_invite_code_idx ON profiles (invite_code);

CREATE TABLE referrals (
  id           bigserial PRIMARY KEY,
  inviter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id   uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code         text NOT NULL,
  -- pending: 초대받은 회원이 다음 날 다시 와서 출석하면 초대한 회원에게 보상
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded', 'blocked')),
  note         text,
  invitee_ip   text,
  invitee_reward int NOT NULL DEFAULT 0,
  inviter_reward int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rewarded_at  timestamptz
);
CREATE INDEX referrals_inviter_idx ON referrals (inviter_id, created_at DESC);

CREATE TABLE attendance (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      date NOT NULL,
  streak   int NOT NULL,
  points   int NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX attendance_day_idx ON attendance (day);

CREATE TABLE growth_settings (
  id    boolean PRIMARY KEY DEFAULT true CHECK (id),
  value jsonb NOT NULL
);
INSERT INTO growth_settings (value) VALUES (
  '{"inviteEnabled":true,"inviteeReward":50,"inviterReward":100,"inviterMonthlyCap":30,"redeemWindowDays":7,
    "attendanceEnabled":true,"attendancePoints":5,"streakDays":7,"streakBonus":30}'::jsonb
);

ALTER TABLE announcements ADD COLUMN pushed_at timestamptz;
ALTER TABLE announcements ADD COLUMN push_count int NOT NULL DEFAULT 0;
