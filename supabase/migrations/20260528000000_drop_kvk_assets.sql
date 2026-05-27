-- KvK 자산 일괄 제거 — 분리 작업 (kingshot-1767) 완료 후 PNX Supabase 정리.
--
-- 배경: KvK 설문/버프 도메인이 별도 repo + Supabase 프로젝트
-- (qbcpohhzfhaxzbuncsne) 로 이관됨 (2026-05). PNX 측은 더 이상 사용 안 하므로
-- 테이블 / RPC / Storage 객체 정리.
--
-- 정책: 즉시 drop (사용자 결정 2026-05-28). 백업 없이 진행.
-- 데이터 보존이 필요하다면 신규 프로젝트가 source of truth.
--
-- ROLLBACK: 불가. 데이터/스키마 모두 복구 X — 필요 시 백업 dump 에서 restore.
--
-- NOTE: Storage 객체 (blacklist-evidence/kvk-survey/*.webp) 는 본 mig 에서 다루지 않음.
--   Supabase 의 storage.objects 보호 트리거 (storage.protect_delete) 가 직접 DELETE 를
--   차단하기 때문. 별도 Storage API/CLI 로 처리한다 — 본 작업 종료 후 jobs:
--     supabase storage rm -r ss:///blacklist-evidence/kvk-survey/ --linked
--   bucket 자체는 /manage/blacklist 가 계속 사용하므로 보존.

-- 1) RPC 함수 — 테이블 의존 정리 (CASCADE 로 view/trigger 도 함께 drop).
--    동일 이름 overload 없음 (단일 시그니처씩 등록됨) — IF EXISTS + 이름만으로 충분.
DROP FUNCTION IF EXISTS kvk_buff_admin_replace_current CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_admin_replace_current_test CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_admin_skip CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_admin_skip_test CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_admin_swap CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_admin_swap_test CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_bootstrap CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_bootstrap_test CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_finalize CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_finalize_test CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_pick_slot CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_pick_slot_test CASCADE;
DROP FUNCTION IF EXISTS kvk_buff_reset_test CASCADE;
DROP FUNCTION IF EXISTS kvk_predicted_score CASCADE;

-- 2) 테이블 (FK 의존 역순). TEST_MODE 사본 먼저 → 운영 본진.
DROP TABLE IF EXISTS kvk_buff_participants_test CASCADE;
DROP TABLE IF EXISTS kvk_buff_state_test CASCADE;
DROP TABLE IF EXISTS kvk_buff_participants CASCADE;
DROP TABLE IF EXISTS kvk_buff_state CASCADE;
DROP TABLE IF EXISTS kvk_speedup_survey CASCADE;
