-- ============================================================
-- 트랙 4-1: dead 컬럼 + 인덱스 정리 (2026-04-30)
-- ============================================================
-- members 테이블의 사용하지 않는 컬럼 4개 + pvp_battles 의 미사용 인덱스 2개 삭제.
-- 판단 근거:
--   * 컬럼: src/ + supabase/functions/ 코드 grep 매칭 0건
--   * 인덱스: pg_stat_user_indexes.idx_scan = 0 + 코드에 매칭 쿼리 패턴 없음
--
-- 보존 결정 (별도 트랙 4-2 또는 영구 보존):
--   * idx_crystal_tx_ref_unique — UNIQUE 제약 강제용 (멱등성 핵심)
--   * idx_pvp_battles_winner_ranked — 랭킹 쿼리 매칭, 데이터 늘면 활용
--   * idx_pvp_battles_finished_at — pg_cron 결정 보류 (Track 4-2)
--
-- 멱등성: IF EXISTS 로 재실행 안전.

-- ============================================================
-- ROLLBACK SQL (필요 시 아래 블록 SQL 그대로 실행하면 복구됨)
-- ============================================================
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS troop_count    BIGINT                   DEFAULT 0;
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS kill_points    BIGINT                   DEFAULT 0;
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS alliance_role  TEXT                     DEFAULT 'member';
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP WITH TIME ZONE;
-- CREATE INDEX IF NOT EXISTS idx_pvp_battles_attacker_created
--   ON pvp_battles (attacker_id, created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_pvp_battles_defender_created
--   ON pvp_battles (defender_id, created_at DESC);

-- ============================================================
-- DROP — members 의 dead 컬럼 4개
-- ============================================================
ALTER TABLE members DROP COLUMN IF EXISTS troop_count;
ALTER TABLE members DROP COLUMN IF EXISTS kill_points;
ALTER TABLE members DROP COLUMN IF EXISTS alliance_role;
ALTER TABLE members DROP COLUMN IF EXISTS last_active_at;

-- ============================================================
-- DROP — pvp_battles 의 dead 인덱스 2개
-- ============================================================
DROP INDEX IF EXISTS idx_pvp_battles_attacker_created;
DROP INDEX IF EXISTS idx_pvp_battles_defender_created;
