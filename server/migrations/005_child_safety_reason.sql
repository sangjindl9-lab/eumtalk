-- 신고 사유에 '아동 안전'을 추가한다(Google Play 아동 안전 기준).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'reports'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%reason%' LOOP
    EXECUTE format('ALTER TABLE reports DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE reports ADD CONSTRAINT reports_reason_check
  CHECK (reason IN ('child','sexual','scam','abuse','spam','impersonation','privacy','other'));
