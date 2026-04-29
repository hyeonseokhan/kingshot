-- 미니게임 PvP 카드 대결 (Phase C)
--   * pvp_battles:     전투 로그 (30일 후 자동 청소)
--   * pvp_daily_state: 일일 공격 횟수 (KST 자정 리셋)
--   * cleanup_old_pvp_battles(): 30일 이상 지난 finished battle 삭제 함수
--
-- 보안 원칙:
--   * 두 테이블 모두 SELECT public, INSERT/UPDATE/DELETE 차단 (Edge Function 만 변경)
--   * 모든 비즈니스 로직 (데미지 계산, 카드 효과, 턴 진행) 은 Edge Function 에서

-- ============================================================
-- 1) pvp_battles : 전투 로그
-- ============================================================
--   status: 'in_progress' | 'done'
--   turns_log: [{ turn, attacker_card, defender_card, attacker_dmg, defender_dmg, attacker_hp, defender_hp, crit_a, crit_d }]
CREATE TABLE IF NOT EXISTS pvp_battles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id     TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  defender_id     TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  attacker_power  INTEGER NOT NULL,
  defender_power  INTEGER NOT NULL,
  winner_id       TEXT,
  turns_log       JSONB NOT NULL DEFAULT '[]'::jsonb,
  reward_crystals INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  CHECK (attacker_id <> defender_id)
);

CREATE INDEX IF NOT EXISTS idx_pvp_battles_attacker_created
  ON pvp_battles (attacker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_battles_defender_created
  ON pvp_battles (defender_id, created_at DESC);
-- 청소용
CREATE INDEX IF NOT EXISTS idx_pvp_battles_finished_at
  ON pvp_battles (finished_at) WHERE finished_at IS NOT NULL;

ALTER TABLE pvp_battles ENABLE ROW LEVEL SECURITY;

-- 누구나 전적 조회 (랭킹/통계)
CREATE POLICY "pvp_battles_select" ON pvp_battles
  FOR SELECT USING (true);
-- INSERT/UPDATE/DELETE 정책 없음 → service_role only

-- ============================================================
-- 2) pvp_daily_state : 일일 공격 횟수 (KST 자정 리셋)
-- ============================================================
CREATE TABLE IF NOT EXISTS pvp_daily_state (
  player_id     TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  date_kst      DATE NOT NULL,
  attacks_used  INTEGER NOT NULL DEFAULT 0 CHECK (attacks_used >= 0),
  PRIMARY KEY (player_id, date_kst)
);

ALTER TABLE pvp_daily_state ENABLE ROW LEVEL SECURITY;

-- 본인 일일 상태 조회 — 남은 횟수 표시 등
CREATE POLICY "pvp_daily_state_select" ON pvp_daily_state
  FOR SELECT USING (true);

-- ============================================================
-- 3) cleanup_old_pvp_battles : 30일 지난 finished battle 삭제
-- ============================================================
-- 호출은 외부 cron (또는 pg_cron extension 활성화 시 자동) 또는 admin 수동.
CREATE OR REPLACE FUNCTION cleanup_old_pvp_battles()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM pvp_battles
  WHERE finished_at IS NOT NULL
    AND finished_at < (now() - interval '30 days');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_old_pvp_battles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_old_pvp_battles() TO service_role;
