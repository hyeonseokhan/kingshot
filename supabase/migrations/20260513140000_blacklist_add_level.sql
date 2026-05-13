-- blacklist 테이블에 city center level 컬럼 추가.
--
-- 외부 centurygame API 의 stove_lv 값을 보존. 등록/수정 시 lookupResult.level 로 채워짐.
-- 기존 row 는 NULL — UI 에서 '-' 표시. 이후 갱신 시 자동 채워짐.
--
-- ROLLBACK:
--   ALTER TABLE blacklist DROP COLUMN level;

ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS level INTEGER;
