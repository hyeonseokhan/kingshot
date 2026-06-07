-- 부대 계산기 프로필 (game-tools/troops-calculator)
--   * 여러 계정의 보유 병력/설정을 슬롯 1~5 에 저장 → 한 번에 불러와 재계산.
--   * 이 도구는 관리자 전용(270680423)이라 player_id 구분 없이 "전역 슬롯 5개".
--   * 입력값 전체(병과 T9/T10 6개 + 출정상한 + 편대수 + 분배모드) + 표시용 이름(label) 저장.
--   * 쓰기는 troops-profiles Edge Function (service_role) 만 → anon write 차단.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS troops_profiles;
CREATE TABLE IF NOT EXISTS troops_profiles (
  slot          SMALLINT PRIMARY KEY CHECK (slot BETWEEN 1 AND 5),
  label         TEXT NOT NULL DEFAULT '',     -- 표시용 이름 (계정 별칭 등)
  cap           BIGINT NOT NULL DEFAULT 0,
  infantry_t10  BIGINT NOT NULL DEFAULT 0,
  infantry_t9   BIGINT NOT NULL DEFAULT 0,
  cavalry_t10   BIGINT NOT NULL DEFAULT 0,
  cavalry_t9    BIGINT NOT NULL DEFAULT 0,
  archers_t10   BIGINT NOT NULL DEFAULT 0,
  archers_t9    BIGINT NOT NULL DEFAULT 0,
  squad_count   SMALLINT NOT NULL DEFAULT 2,
  distribution  TEXT NOT NULL DEFAULT 'bear-stack',  -- 'bear' | 'bear-stack' | 'even'
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER troops_profiles_updated_at
  BEFORE UPDATE ON troops_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE troops_profiles ENABLE ROW LEVEL SECURITY;

-- 조회는 anon 허용 (관리자 클라이언트가 anon key 로 슬롯 로드). 쓰기 정책 없음 →
-- service_role(Edge Function) 만 INSERT/UPDATE/DELETE 가능.
CREATE POLICY "troops_profiles_select" ON troops_profiles
  FOR SELECT USING (true);
