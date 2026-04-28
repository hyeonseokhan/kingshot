-- 미니게임 장비 강화 (Phase B)
--   * equipment_levels:    플레이어×6슬롯 강화 상태
--   * enhance_equipment(): 잔액 차감 + 확률 굴림 + 레벨 갱신을 한 트랜잭션으로 처리
--
-- 보안 원칙:
--   * 테이블 SELECT 는 public (랭킹/프로필 표시), INSERT/UPDATE/DELETE 는 anon 차단
--   * enhance_equipment() 은 SECURITY DEFINER + service_role only
--   * cost/power/rate 등 비즈니스 상수는 Edge Function 이 인자로 전달.
--     RPC 는 단순 "이 비용으로 이 슬롯 강화 시도" 의 atomic 실행자 — 표 갱신 시 마이그레이션 불필요

-- ============================================================
-- 1) equipment_levels : 플레이어 × 6슬롯 강화 상태
-- ============================================================
CREATE TABLE IF NOT EXISTS equipment_levels (
  player_id        TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  slot             TEXT NOT NULL CHECK (slot IN ('crown','necklace','top','bottom','ring','staff')),
  level            INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  power            INTEGER NOT NULL DEFAULT 0 CHECK (power >= 0),
  last_attempt_at  TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, slot)
);

CREATE TRIGGER equipment_levels_updated_at
  BEFORE UPDATE ON equipment_levels
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- 플레이어별 전체 강화 상태 조회 인덱스 (랭킹/프로필)
CREATE INDEX IF NOT EXISTS idx_equipment_levels_player
  ON equipment_levels (player_id);

ALTER TABLE equipment_levels ENABLE ROW LEVEL SECURITY;

-- 누구나 조회 (랭킹/프로필)
CREATE POLICY "equipment_levels_select" ON equipment_levels
  FOR SELECT USING (true);

-- INSERT/UPDATE/DELETE 정책 없음 → anon 차단

-- ============================================================
-- 2) RPC : enhance_equipment
-- ============================================================
-- 한 번의 강화 시도를 atomic 하게 처리.
--   1) 현재 level 조회, target_level == current+1 검증 (race condition 방어)
--   2) apply_crystal_transaction 으로 잔액 차감 (잔액 부족 시 check_violation → 멈춤)
--   3) random() < rate 로 성공 판정
--   4) 성공: equipment_levels UPSERT (level / power 증가)
--      실패: last_attempt_at 만 갱신 (level / power 유지)
--   5) 갱신된 잔액 + 결과 반환
CREATE OR REPLACE FUNCTION enhance_equipment(
  p_player_id     TEXT,
  p_slot          TEXT,
  p_cost          BIGINT,
  p_power_delta   INTEGER,
  p_rate          NUMERIC,    -- 0.0 ~ 1.0
  p_target_level  INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_level INTEGER;
  v_current_power INTEGER;
  v_balance       BIGINT;
  v_success       BOOLEAN;
  v_new_level     INTEGER;
  v_new_power     INTEGER;
  v_now           TIMESTAMPTZ := now();
BEGIN
  -- 슬롯 검증 (CHECK 제약과 별도로 명확한 에러 메시지)
  IF p_slot NOT IN ('crown','necklace','top','bottom','ring','staff') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_slot');
  END IF;

  IF p_cost < 0 OR p_rate < 0 OR p_rate > 1 OR p_target_level < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_params');
  END IF;

  -- 1) 현재 강화 상태
  SELECT level, power INTO v_current_level, v_current_power
  FROM equipment_levels
  WHERE player_id = p_player_id AND slot = p_slot;

  v_current_level := COALESCE(v_current_level, 0);
  v_current_power := COALESCE(v_current_power, 0);

  -- 2) target_level 검증 — 정확히 current+1 이어야 함
  --    (race condition: 동시에 두 클릭 시 두번째 호출은 여기서 멈춤)
  IF p_target_level <> v_current_level + 1 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'level_mismatch',
      'current_level', v_current_level
    );
  END IF;

  -- 3) 잔액 차감 — check_violation = 잔액 부족
  BEGIN
    PERFORM apply_crystal_transaction(
      p_player_id,
      -p_cost,
      'equipment_enhance',
      NULL,
      jsonb_build_object('slot', p_slot, 'target_level', p_target_level)
    );
  EXCEPTION WHEN check_violation THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_crystals'
    );
  END;

  -- 4) 확률 굴림 (server-side random — 클라이언트 조작 차단)
  v_success := random() < p_rate;

  v_new_level := CASE WHEN v_success THEN p_target_level     ELSE v_current_level END;
  v_new_power := CASE WHEN v_success THEN v_current_power + p_power_delta ELSE v_current_power END;

  -- 5) equipment_levels UPSERT
  INSERT INTO equipment_levels (player_id, slot, level, power, last_attempt_at)
  VALUES (p_player_id, p_slot, v_new_level, v_new_power, v_now)
  ON CONFLICT (player_id, slot) DO UPDATE SET
    level           = v_new_level,
    power           = v_new_power,
    last_attempt_at = v_now,
    updated_at      = v_now;

  -- 6) 갱신된 잔액
  SELECT balance INTO v_balance FROM crystal_balances WHERE player_id = p_player_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'success',    v_success,
    'new_level',  v_new_level,
    'new_power',  v_new_power,
    'cost',       p_cost,
    'balance',    COALESCE(v_balance, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION enhance_equipment(TEXT, TEXT, BIGINT, INTEGER, NUMERIC, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enhance_equipment(TEXT, TEXT, BIGINT, INTEGER, NUMERIC, INTEGER) TO service_role;
