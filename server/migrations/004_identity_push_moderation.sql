-- 본인확인 사업자(포트원) 연동, 사진 판별 기록

-- 포트원 본인인증은 인증창에서 휴대폰 번호를 확인하므로, 시작 시점에는 번호가 없다.
ALTER TABLE signup_verifications ALTER COLUMN phone_hash DROP NOT NULL;
ALTER TABLE signup_verifications ALTER COLUMN phone_enc DROP NOT NULL;
ALTER TABLE signup_verifications ADD COLUMN provider_ref text UNIQUE;     -- 포트원 identityVerificationId
ALTER TABLE signup_verifications ADD COLUMN gender text;

-- 같은 사람(CI)이 번호를 바꿔 여러 계정을 만드는 것을 막는다(탈퇴하면 비워진다).
CREATE UNIQUE INDEX user_private_identity_ref_uq ON user_private (identity_ref_hash) WHERE identity_ref_hash IS NOT NULL;

-- 공개 사진 자동 판별 결과
ALTER TABLE media ADD COLUMN moderation jsonb;
