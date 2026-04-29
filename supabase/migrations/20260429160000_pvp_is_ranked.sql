-- PvP 랭킹/연습 모드 분리
--   * 일일 5회 안 = is_ranked = TRUE (보상 + 랭킹 승수 카운트)
--   * 일일 5회 후 = is_ranked = FALSE (연습. 보상 없음, 승수 카운트 X, 자유 매칭 가능)
--   * 기존 row 는 모두 is_ranked = TRUE (랭크 매치였음)

ALTER TABLE pvp_battles
  ADD COLUMN IF NOT EXISTS is_ranked BOOLEAN NOT NULL DEFAULT TRUE;

-- 랭킹 승수 집계 시 is_ranked 만 카운트할 수 있도록 인덱스
CREATE INDEX IF NOT EXISTS idx_pvp_battles_winner_ranked
  ON pvp_battles (winner_id, is_ranked) WHERE winner_id IS NOT NULL;
