-- 미니게임 크리스탈 경제 (Phase A)
--   * crystal_balances:     플레이어별 크리스탈 잔액 요약
--   * crystal_transactions: 거래 원장 (감사용 + 멱등성 보장)
--   * apply_crystal_transaction(): 잔액 갱신 + 거래 INSERT 를 한 트랜잭션으로 처리하는 RPC
--
-- 보안 원칙:
--   * 두 테이블 모두 SELECT 는 public, INSERT/UPDATE/DELETE 는 anon 차단 (Edge Function 만 변경 가능)
--   * apply_crystal_transaction() 은 SECURITY DEFINER 로 service_role 만 EXECUTE 가능
--   * 보상 중복 청구 방지: (player_id, ref_key) UNIQUE → ref_key 동일 거래 재요청 시 멱등 처리

-- ============================================================
-- 1) crystal_balances : 잔액 요약 (한 사람당 1행)
-- ============================================================
CREATE TABLE IF NOT EXISTS crystal_balances (
  player_id     TEXT PRIMARY KEY REFERENCES members(kingshot_id) ON DELETE CASCADE,
  balance       BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_earned  BIGINT NOT NULL DEFAULT 0 CHECK (total_earned >= 0),
  total_spent   BIGINT NOT NULL DEFAULT 0 CHECK (total_spent >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER crystal_balances_updated_at
  BEFORE UPDATE ON crystal_balances
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE crystal_balances ENABLE ROW LEVEL SECURITY;

-- 누구나 잔액 조회 가능 (랭킹/프로필 표시 등)
CREATE POLICY "crystal_balances_select" ON crystal_balances
  FOR SELECT USING (true);

-- INSERT/UPDATE/DELETE 정책 없음 → anon 차단, service_role 만 가능

-- ============================================================
-- 2) crystal_transactions : 거래 원장
-- ============================================================
--   * amount > 0  : 획득 (예: stage 클리어 보상)
--   * amount < 0  : 소모 (예: 장비 강화 비용)
--   * source      : 거래 분류 (tile_match_clear, equipment_enhance, pvp_win, ...)
--   * ref_key     : 멱등성 키 (예: 'tile_match:stage_5:first_clear')
--                   동일 (player_id, ref_key) 재요청 시 INSERT 실패 → 중복 청구 방지
--   * ref_data    : 부가 정보 JSONB (stage 번호, 장비 슬롯 등)
CREATE TABLE IF NOT EXISTS crystal_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  amount      BIGINT NOT NULL,
  source      TEXT NOT NULL,
  ref_key     TEXT,
  ref_data    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 멱등성: 동일 ref_key 재청구 차단 (NULL 인 경우는 UNIQUE 제약 받지 않음 — 일회성 거래용)
CREATE UNIQUE INDEX IF NOT EXISTS idx_crystal_tx_ref_unique
  ON crystal_transactions (player_id, ref_key)
  WHERE ref_key IS NOT NULL;

-- 플레이어별 최근 거래 조회용
CREATE INDEX IF NOT EXISTS idx_crystal_tx_player_created
  ON crystal_transactions (player_id, created_at DESC);

ALTER TABLE crystal_transactions ENABLE ROW LEVEL SECURITY;

-- 본인 거래 조회는 일단 public 으로 (감사 + 디버깅 용이성). 필요시 추후 제한.
CREATE POLICY "crystal_transactions_select" ON crystal_transactions
  FOR SELECT USING (true);

-- INSERT/UPDATE/DELETE 정책 없음 → anon 차단

-- ============================================================
-- 3) RPC : apply_crystal_transaction
-- ============================================================
-- 잔액 갱신 + 거래 기록을 한 트랜잭션으로 묶음.
-- ref_key 중복 시 멱등(no-op) 처리하고 현재 잔액 반환.
-- 음수 amount (소모) 인 경우 잔액 부족하면 CHECK constraint 위반으로 트랜잭션 전체 롤백.
CREATE OR REPLACE FUNCTION apply_crystal_transaction(
  p_player_id TEXT,
  p_amount    BIGINT,
  p_source    TEXT,
  p_ref_key   TEXT DEFAULT NULL,
  p_ref_data  JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_id      UUID;
  v_balance    BIGINT;
  v_was_dup    BOOLEAN := FALSE;
BEGIN
  -- 1) 거래 INSERT 시도 — ref_key 중복 시 unique_violation
  BEGIN
    INSERT INTO crystal_transactions (player_id, amount, source, ref_key, ref_data)
    VALUES (p_player_id, p_amount, p_source, p_ref_key, p_ref_data)
    RETURNING id INTO v_tx_id;
  EXCEPTION WHEN unique_violation THEN
    v_was_dup := TRUE;
  END;

  -- 2) 중복이면 잔액만 조회 후 반환 (멱등)
  IF v_was_dup THEN
    SELECT balance INTO v_balance FROM crystal_balances WHERE player_id = p_player_id;
    RETURN jsonb_build_object(
      'duplicate',      TRUE,
      'amount_applied', 0,
      'balance',        COALESCE(v_balance, 0)
    );
  END IF;

  -- 3) 잔액 UPSERT
  INSERT INTO crystal_balances (player_id, balance, total_earned, total_spent)
  VALUES (
    p_player_id,
    p_amount,
    GREATEST(p_amount, 0),
    GREATEST(-p_amount, 0)
  )
  ON CONFLICT (player_id) DO UPDATE SET
    balance      = crystal_balances.balance      + EXCLUDED.balance,
    total_earned = crystal_balances.total_earned + EXCLUDED.total_earned,
    total_spent  = crystal_balances.total_spent  + EXCLUDED.total_spent,
    updated_at   = now()
  RETURNING balance INTO v_balance;

  RETURN jsonb_build_object(
    'duplicate',      FALSE,
    'amount_applied', p_amount,
    'balance',        v_balance,
    'transaction_id', v_tx_id
  );
END;
$$;

-- 이 함수는 service_role (Edge Function) 만 호출 가능
REVOKE ALL ON FUNCTION apply_crystal_transaction(TEXT, BIGINT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_crystal_transaction(TEXT, BIGINT, TEXT, TEXT, JSONB) TO service_role;
