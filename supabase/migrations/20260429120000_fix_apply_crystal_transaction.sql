-- apply_crystal_transaction 버그 수정 (Phase A 마이그레이션의 회귀)
--
-- 원인:
--   원래 INSERT VALUES 의 balance 컬럼에 raw p_amount 를 그대로 넣었음.
--   PostgreSQL 의 INSERT...ON CONFLICT 는 row CHECK 제약을 ON CONFLICT 분기보다
--   먼저 검사하기 때문에, 음수 amount (예: -100) 시 CHECK(balance >= 0) 가 즉시 fail
--   → 함수 호출 측의 EXCEPTION WHEN check_violation 분기 → 'insufficient_crystals'.
--   결과: 잔액이 충분한 사용자도 강화 시도 시 무조건 부족하다고 응답.
--
-- 추가 보안 가드:
--   crystal_balances row 가 없는 player 가 음수 차감(p_amount < 0) 시도하면
--   원래는 INSERT 분기에서 balance=0, total_spent=N 으로 row 가 만들어져 무료 차감 가능했음.
--   해당 케이스를 명시적 check_violation 으로 차단.
--
-- 수정 포인트:
--   1) INSERT VALUES 의 balance/total_earned 를 GREATEST(p_amount, 0) 으로 보호
--   2) ON CONFLICT DO UPDATE SET 에서 EXCLUDED 대신 함수 매개변수 p_amount 직접 사용
--      (UPDATE 분기에서만 음수 차감이 일어나며, 이때 CHECK(balance>=0) 가 정상적으로 잔액부족 fail 함)
--   3) p_amount < 0 + row 미존재 케이스를 사전 차단

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
  -- 1) 거래 INSERT — ref_key 중복 시 멱등 처리
  BEGIN
    INSERT INTO crystal_transactions (player_id, amount, source, ref_key, ref_data)
    VALUES (p_player_id, p_amount, p_source, p_ref_key, p_ref_data)
    RETURNING id INTO v_tx_id;
  EXCEPTION WHEN unique_violation THEN
    v_was_dup := TRUE;
  END;

  IF v_was_dup THEN
    SELECT balance INTO v_balance FROM crystal_balances WHERE player_id = p_player_id;
    RETURN jsonb_build_object(
      'duplicate',      TRUE,
      'amount_applied', 0,
      'balance',        COALESCE(v_balance, 0)
    );
  END IF;

  -- 2) 보안 가드: 음수 amount + 잔액 row 미존재 = 무료 차감 차단
  IF p_amount < 0 THEN
    PERFORM 1 FROM crystal_balances WHERE player_id = p_player_id;
    IF NOT FOUND THEN
      RAISE check_violation USING MESSAGE = 'no balance row to spend from';
    END IF;
  END IF;

  -- 3) 잔액 UPSERT
  --    INSERT 분기 (신규 row): balance/earned 는 항상 양수만 (CHECK 보호)
  --    UPDATE 분기 (기존 row): 함수 변수 p_amount 직접 사용해서 raw 차감
  INSERT INTO crystal_balances (player_id, balance, total_earned, total_spent)
  VALUES (
    p_player_id,
    GREATEST(p_amount, 0),
    GREATEST(p_amount, 0),
    GREATEST(-p_amount, 0)
  )
  ON CONFLICT (player_id) DO UPDATE SET
    balance      = crystal_balances.balance      + p_amount,
    total_earned = crystal_balances.total_earned + GREATEST(p_amount, 0),
    total_spent  = crystal_balances.total_spent  + GREATEST(-p_amount, 0),
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

-- 권한은 CREATE OR REPLACE 시 보존되지만 멱등성 위해 명시
REVOKE ALL ON FUNCTION apply_crystal_transaction(TEXT, BIGINT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_crystal_transaction(TEXT, BIGINT, TEXT, TEXT, JSONB) TO service_role;
