-- 알림 설정: 전체 켜기/끄기, 종류별 켜기/끄기, 방해 금지 시간(한국 시각).
ALTER TABLE profiles ADD COLUMN notify jsonb NOT NULL DEFAULT
  '{"all":true,"direct":true,"greeting":true,"room":true,"comment":true,"notice":true,"quiet":false,"quietStart":"23:00","quietEnd":"08:00"}'::jsonb;
ALTER TABLE push_log ADD COLUMN skipped text;   -- 'off'(꺼 둠) / 'quiet'(방해 금지 시간)
