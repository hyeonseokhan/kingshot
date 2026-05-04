-- Track 7: 주간 랭킹 보상 — 박제 테이블 + 자동 지급 함수 + pg_cron 스케줄
--
-- 설계:
--   - 매주 월요일 09:00 KST (= 00:00 UTC) 에 pg_cron 이 process_weekly_rank_rewards() 호출
--   - 누적 기준: tile_match_records.best_stage / pvp_battles 의 ranked 누적 승수
--   - 같은 인물이 매주 1등 가능 (의도)
--   - 동률: 먼저 도달자 우선 (best_stage_at / MAX(finished_at) ASC)
--   - 보상: 1등 30,000 / 2등 10,000 / 3등 5,000 / 4~10등 2,000 (두 게임 별도 지급)
--   - 멱등: ref_key='weekly_rank:<game>:<year>-W<week>:rank:<n>' UNIQUE → 같은 주 재실행 시 중복 차단
--   - 박제: weekly_rankings INSERT 로 표시용 데이터 영구 보존 → pvp_battles 시즌 정리와 분리
--
-- 주차 계산 (단순 카운팅):
--   "그 해 1월 1일이 속한 주가 1주차" — week_no = ceil(day_of_year / 7)
--   2026-01-01 ~ 2026-01-07 = 1주차, 2026-05-04 = 18주차

-- ============================================================
-- 1) pg_cron 확장 (Supabase managed: pre-installed, 멱등)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- 2) weekly_rankings 박제 테이블
-- ============================================================
CREATE TABLE IF NOT EXISTS weekly_rankings (
  game           TEXT NOT NULL CHECK (game IN ('tile_match', 'pvp')),
  year           INT  NOT NULL,
  week_no        INT  NOT NULL CHECK (week_no BETWEEN 1 AND 53),
  rank           INT  NOT NULL CHECK (rank BETWEEN 1 AND 10),
  player_id      TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  score          BIGINT NOT NULL,          -- best_stage 또는 wins
  achieved_at    TIMESTAMPTZ,              -- tie-break 시각 (best_stage_at / 마지막 ranked 승리)
  reward_amount  INT  NOT NULL,
  reward_tx_id   UUID REFERENCES crystal_transactions(id) ON DELETE SET NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game, year, week_no, rank)
);

CREATE INDEX IF NOT EXISTS idx_weekly_rankings_period
  ON weekly_rankings (game, year DESC, week_no DESC, rank);

ALTER TABLE weekly_rankings ENABLE ROW LEVEL SECURITY;

-- 누구나 조회 가능 (랭킹 표시용 — 공개 데이터)
CREATE POLICY "weekly_rankings_select_all" ON weekly_rankings
  FOR SELECT USING (true);
-- INSERT/UPDATE/DELETE 정책 없음 → service_role 만 가능

-- ============================================================
-- 3) 보상 매핑 (등수 → 크리스탈)
-- ============================================================
CREATE OR REPLACE FUNCTION reward_for_rank(p_rank INT) RETURNS INT
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_rank = 1 THEN RETURN 30000; END IF;
  IF p_rank = 2 THEN RETURN 10000; END IF;
  IF p_rank = 3 THEN RETURN 5000; END IF;
  IF p_rank BETWEEN 4 AND 10 THEN RETURN 2000; END IF;
  RETURN 0;
END;
$$;

-- ============================================================
-- 4) 주간 랭킹 자동 지급 함수
--    cron 호출 또는 수동 호출 (소급 지급) 둘 다 안전 (멱등)
-- ============================================================
CREATE OR REPLACE FUNCTION process_weekly_rank_rewards()
RETURNS TABLE(
  out_game       TEXT,
  out_rank       INT,
  out_player_id  TEXT,
  out_score      BIGINT,
  out_reward     INT,
  out_status     TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now_kst TIMESTAMP := (now() AT TIME ZONE 'Asia/Seoul');
  v_year    INT       := EXTRACT(YEAR FROM v_now_kst)::INT;
  v_doy     INT       := EXTRACT(DOY  FROM v_now_kst)::INT;
  v_week_no INT       := CEIL(v_doy::FLOAT / 7.0)::INT;
  v_reward  INT;
  v_ref_key TEXT;
  v_tx      JSONB;
  v_tx_id   UUID;
  r         RECORD;
BEGIN
  -- ===== 타일매치 1~10등 (누적 best_stage) =====
  FOR r IN
    SELECT
      player_id,
      best_stage::BIGINT AS score,
      best_stage_at AS achieved_at,
      ROW_NUMBER() OVER (ORDER BY best_stage DESC, best_stage_at ASC NULLS LAST)::INT AS rank
    FROM tile_match_records
    WHERE best_stage > 0
    LIMIT 10
  LOOP
    v_reward  := reward_for_rank(r.rank);
    v_ref_key := 'weekly_rank:tile_match:' || v_year || '-W' || v_week_no || ':rank:' || r.rank;

    v_tx := apply_crystal_transaction(
      r.player_id,
      v_reward::BIGINT,
      'weekly_rank',
      v_ref_key,
      jsonb_build_object(
        'game', 'tile_match',
        'year', v_year,
        'week_no', v_week_no,
        'rank', r.rank,
        'score', r.score
      )
    );
    v_tx_id := NULLIF(v_tx->>'transaction_id', '')::UUID;

    INSERT INTO weekly_rankings (game, year, week_no, rank, player_id, score, achieved_at, reward_amount, reward_tx_id)
    VALUES ('tile_match', v_year, v_week_no, r.rank, r.player_id, r.score, r.achieved_at, v_reward, v_tx_id)
    ON CONFLICT (game, year, week_no, rank) DO UPDATE SET
      player_id     = EXCLUDED.player_id,
      score         = EXCLUDED.score,
      achieved_at   = EXCLUDED.achieved_at,
      reward_amount = EXCLUDED.reward_amount,
      reward_tx_id  = COALESCE(weekly_rankings.reward_tx_id, EXCLUDED.reward_tx_id),
      granted_at    = now();

    out_game      := 'tile_match';
    out_rank      := r.rank;
    out_player_id := r.player_id;
    out_score     := r.score;
    out_reward    := v_reward;
    out_status    := CASE WHEN (v_tx->>'duplicate')::BOOLEAN THEN 'duplicate' ELSE 'paid' END;
    RETURN NEXT;
  END LOOP;

  -- ===== PvP 1~10등 (시즌 시작 이후 누적 ranked 승수) =====
  FOR r IN
    SELECT
      winner_id AS player_id,
      COUNT(*)::BIGINT AS score,
      MAX(finished_at) AS achieved_at,
      ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(finished_at) ASC)::INT AS rank
    FROM pvp_battles
    WHERE is_ranked = true AND winner_id IS NOT NULL
    GROUP BY winner_id
    ORDER BY COUNT(*) DESC, MAX(finished_at) ASC
    LIMIT 10
  LOOP
    v_reward  := reward_for_rank(r.rank);
    v_ref_key := 'weekly_rank:pvp:' || v_year || '-W' || v_week_no || ':rank:' || r.rank;

    v_tx := apply_crystal_transaction(
      r.player_id,
      v_reward::BIGINT,
      'weekly_rank',
      v_ref_key,
      jsonb_build_object(
        'game', 'pvp',
        'year', v_year,
        'week_no', v_week_no,
        'rank', r.rank,
        'score', r.score
      )
    );
    v_tx_id := NULLIF(v_tx->>'transaction_id', '')::UUID;

    INSERT INTO weekly_rankings (game, year, week_no, rank, player_id, score, achieved_at, reward_amount, reward_tx_id)
    VALUES ('pvp', v_year, v_week_no, r.rank, r.player_id, r.score, r.achieved_at, v_reward, v_tx_id)
    ON CONFLICT (game, year, week_no, rank) DO UPDATE SET
      player_id     = EXCLUDED.player_id,
      score         = EXCLUDED.score,
      achieved_at   = EXCLUDED.achieved_at,
      reward_amount = EXCLUDED.reward_amount,
      reward_tx_id  = COALESCE(weekly_rankings.reward_tx_id, EXCLUDED.reward_tx_id),
      granted_at    = now();

    out_game      := 'pvp';
    out_rank      := r.rank;
    out_player_id := r.player_id;
    out_score     := r.score;
    out_reward    := v_reward;
    out_status    := CASE WHEN (v_tx->>'duplicate')::BOOLEAN THEN 'duplicate' ELSE 'paid' END;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION process_weekly_rank_rewards() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION process_weekly_rank_rewards() TO service_role;

-- ============================================================
-- 5) pg_cron 스케줄 등록 (멱등 — 같은 jobname 재등록 시 기존 unschedule 후 재생성)
-- ============================================================
DO $$
DECLARE
  v_jobid BIGINT;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'weekly-rank-rewards';
  IF FOUND THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule(
    'weekly-rank-rewards',
    '0 0 * * 1',  -- 매주 월요일 00:00 UTC = 09:00 KST
    'SELECT process_weekly_rank_rewards();'
  );
END;
$$;

-- ROLLBACK (필요 시 수동 실행):
-- DO $$ DECLARE v_jobid BIGINT; BEGIN
--   SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'weekly-rank-rewards';
--   IF FOUND THEN PERFORM cron.unschedule(v_jobid); END IF;
-- END; $$;
-- DROP FUNCTION IF EXISTS process_weekly_rank_rewards();
-- DROP FUNCTION IF EXISTS reward_for_rank(INT);
-- DROP TABLE IF EXISTS weekly_rankings;
-- 주의: pg_cron 자체는 다른 잡이 있을 수 있어 DROP EXTENSION 안 함
