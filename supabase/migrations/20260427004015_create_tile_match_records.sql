-- 타일 매치 미니게임 기록 (랭킹용)
--   * 클리어 시에만 best_stage, total_clears 갱신 (중간 종료는 기록 X)
--   * 랭킹 표시: PNX 연맹원만 (members 테이블에 등록된 사람)
CREATE TABLE IF NOT EXISTS tile_match_records (
  player_id      TEXT PRIMARY KEY REFERENCES members(kingshot_id) ON DELETE CASCADE,
  best_stage     INTEGER NOT NULL DEFAULT 0,
  total_clears   INTEGER NOT NULL DEFAULT 0,
  best_stage_at  TIMESTAMPTZ,           -- 최고 기록 갱신 시점
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tile_match_records_best_stage
  ON tile_match_records (best_stage DESC, best_stage_at ASC);

CREATE TRIGGER tile_match_records_updated_at
  BEFORE UPDATE ON tile_match_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE tile_match_records ENABLE ROW LEVEL SECURITY;

-- 누구나 랭킹 조회 가능 (공개 가이드 사이트)
CREATE POLICY "tile_match_records_select" ON tile_match_records
  FOR SELECT USING (true);

-- INSERT/UPDATE 는 anon 도 허용 (게임 중에 사용자가 자기 기록 갱신).
-- player_id 가 members 에 존재해야 하므로 (FK) 외부에서 임의 ID 로 인서트 불가.
-- 자기 자신의 기록만 업데이트해야 한다는 보장은 sessionStorage 인증 후에만 호출하는 클라이언트 흐름으로 처리.
CREATE POLICY "tile_match_records_insert" ON tile_match_records
  FOR INSERT WITH CHECK (true);
CREATE POLICY "tile_match_records_update" ON tile_match_records
  FOR UPDATE USING (true);
