-- 수사기관 자료 제공 대비: 접속 기록, 탈퇴 회원 식별 기록, 보존 조치, 요청 대장, 제공 자료.

-- 접속 기록(통신비밀보호법상 통신사실확인자료 대상). 90일 보관 후 자동 삭제.
CREATE TABLE access_logs (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid,
  ip          text NOT NULL,
  user_agent  text NOT NULL DEFAULT '',
  platform    text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_logs_user_at_idx ON access_logs (user_id, at DESC);
CREATE INDEX access_logs_at_idx ON access_logs (at);

-- 닉네임 이력: 수사기관은 보통 사건 당시 닉네임으로 회원을 특정한다.
CREATE TABLE nickname_history (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname    text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX nickname_history_user_idx ON nickname_history (user_id);
CREATE INDEX nickname_history_nick_idx ON nickname_history (lower(nickname));
INSERT INTO nickname_history (user_id, nickname, started_at)
  SELECT p.user_id, p.nickname, u.created_at FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.status <> 'deleted';

-- 보존 조치: 걸려 있는 동안 회원이 탈퇴해도 사진·프로필 원본을 지우지 않고 사본을 남긴다.
CREATE TABLE law_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  request_id   uuid,
  reason       text NOT NULL,
  created_by   uuid REFERENCES admins(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  released_by  uuid REFERENCES admins(id),
  snapshot     jsonb          -- 보존 중 탈퇴한 경우 탈퇴 직전 회원 정보 사본
);
CREATE INDEX law_holds_user_idx ON law_holds (user_id) WHERE released_at IS NULL;

-- 수사기관 요청 대장
CREATE TABLE law_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency           text NOT NULL,            -- 요청 기관(예: ○○경찰서 사이버수사팀)
  officer          text NOT NULL DEFAULT '',  -- 담당 수사관
  officer_contact  text NOT NULL DEFAULT '',
  doc_number       text NOT NULL DEFAULT '',  -- 공문·영장 번호
  basis            text NOT NULL CHECK (basis IN ('warrant','comm_confirm','comm_data','emergency','preservation')),
  received_at      date NOT NULL DEFAULT current_date,
  due_at           date,
  period_from      timestamptz,
  period_to        timestamptz,
  scope            text[] NOT NULL DEFAULT '{}',
  counterpart_ids  uuid[] NOT NULL DEFAULT '{}', -- 대화 내용을 특정 상대와의 대화로 한정할 때
  note             text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received','approved','exported','delivered','closed','rejected')),
  created_by       uuid REFERENCES admins(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by      uuid REFERENCES admins(id),
  approved_at      timestamptz,
  delivered_at     timestamptz,
  delivery_method  text NOT NULL DEFAULT '',
  closed_at        timestamptz,
  close_note       text NOT NULL DEFAULT ''
);
ALTER TABLE law_holds ADD CONSTRAINT law_holds_request_fk FOREIGN KEY (request_id) REFERENCES law_requests(id);

CREATE TABLE law_request_targets (
  request_id  uuid NOT NULL REFERENCES law_requests(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (request_id, user_id)
);

-- 생성한 제공 자료. 내용과 SHA-256 을 함께 보관해 제공 후에도 동일성을 증명한다.
CREATE TABLE law_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES law_requests(id),
  created_by  uuid REFERENCES admins(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sha256      text NOT NULL,
  byte_size   int NOT NULL,
  content     jsonb NOT NULL
);
CREATE INDEX law_exports_request_idx ON law_exports (request_id);

-- 보존 조치 중 탈퇴한 회원의 사진은 'held' 로 남긴다(서비스에는 노출되지 않음).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'media'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE media DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE media ADD CONSTRAINT media_status_check CHECK (status IN ('ready','hidden','deleted','held'));
