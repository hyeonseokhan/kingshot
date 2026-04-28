-- 병과 분석(Troops Analysis) 서비스 제거
-- member_troops 테이블 + 관련 trigger/policy 모두 정리.
-- ON DELETE CASCADE 가 members 에 걸려있던 외래키도 함께 사라진다.

DROP TABLE IF EXISTS member_troops CASCADE;
