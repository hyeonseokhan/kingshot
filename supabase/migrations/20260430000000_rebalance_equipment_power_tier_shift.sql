-- 등급 구간 1단계 시프트 (2026-04-30) — 기존 equipment_levels.power 재계산.
--
-- 등급 boundary 변경:
--   common(+0)
--   uncommon  +1~10  → +1~9
--   rare      +11~25 → +10~24
--   epic      +26~45 → +25~44
--   legendary +46~70 → +45~69
--   mythic    +71~100 → +70~100
--
-- ENHANCE_RANGES 의 from/to 가 시프트되어 같은 level 의 step power 보간값이 달라짐.
-- 기존 equipment_levels.power 는 OLD 곡선 누적 → NEW 곡선 누적으로 재계산해야 일관성 유지.
--
-- 멱등성: 본 마이그레이션은 항상 NEW 곡선 기준 누적값으로 power 를 덮어쓰므로 재실행 안전.
-- 재실행 시 같은 결과.

DO $$
DECLARE
  v_row RECORD;
  v_lvl INT;
  v_step INT;
  v_total INT;
  v_updated_count INT := 0;
BEGIN
  FOR v_row IN
    SELECT player_id, slot, level FROM equipment_levels WHERE level > 0
  LOOP
    v_total := 0;
    FOR v_lvl IN 1..v_row.level LOOP
      -- NEW ENHANCE_RANGES 의 step power 보간 (서버 enhanceStepFor 와 동일 로직)
      IF v_lvl = 1 THEN v_step := 50;
      ELSIF v_lvl = 2 THEN v_step := 60;
      ELSIF v_lvl BETWEEN 3 AND 9 THEN
        v_step := ROUND(80 + (200 - 80) * ((v_lvl - 3)::NUMERIC / GREATEST(1, 9 - 3)));
      ELSIF v_lvl BETWEEN 10 AND 24 THEN
        v_step := ROUND(250 + (600 - 250) * ((v_lvl - 10)::NUMERIC / GREATEST(1, 24 - 10)));
      ELSIF v_lvl BETWEEN 25 AND 44 THEN
        v_step := ROUND(700 + (2000 - 700) * ((v_lvl - 25)::NUMERIC / GREATEST(1, 44 - 25)));
      ELSIF v_lvl BETWEEN 45 AND 69 THEN
        v_step := ROUND(2500 + (8000 - 2500) * ((v_lvl - 45)::NUMERIC / GREATEST(1, 69 - 45)));
      ELSIF v_lvl BETWEEN 70 AND 100 THEN
        v_step := ROUND(10000 + (50000 - 10000) * ((v_lvl - 70)::NUMERIC / GREATEST(1, 100 - 70)));
      ELSE
        v_step := 0;
      END IF;
      v_total := v_total + v_step;
    END LOOP;

    UPDATE equipment_levels
    SET power = v_total
    WHERE player_id = v_row.player_id AND slot = v_row.slot;
    v_updated_count := v_updated_count + 1;
  END LOOP;

  RAISE NOTICE 'Equipment tier shift rebalance: % rows recomputed under new ENHANCE_RANGES.', v_updated_count;
END $$;
