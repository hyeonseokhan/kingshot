-- 만료된(혹은 더 이상 유효하지 않은) 쿠폰 코드 영구 차단 목록.
--
-- 배경: kingshot.net /api/gift-codes 가 expiresAt=null(무기한) 으로 알려주는 코드 중
-- centurygame /gift_code 가 err_code=40007 (만료) 응답을 주는 케이스가 있음. 두 데이터
-- 소스 간 동기화 지연/누락이 원인.
--
-- 자동 학습:
--   * redeem-coupon Edge Function 의 redeem/redeem_batch 응답 처리 시
--     err_code === 40007 발견 → 본 테이블 INSERT (ON CONFLICT DO NOTHING)
--   * gift-codes Edge Function 이 외부 list 응답 후 본 테이블과 비교 → 일치 코드 제외
--
-- 차단 정책: 영구. (만료된 쿠폰이 부활하는 케이스 거의 없음. 운영자가 수동 DELETE 가능.)
--
-- ROLLBACK:
-- DROP TABLE IF EXISTS expired_coupon_codes;

CREATE TABLE IF NOT EXISTS expired_coupon_codes (
  code        TEXT PRIMARY KEY,
  err_code    INTEGER NOT NULL,                        -- 발견 당시 centurygame err_code (현재는 40007 만)
  reason      TEXT,                                    -- 응답 msg raw (감사용)
  detected_by TEXT,                                    -- 최초 감지된 kingshot_id (감사용, FK 없음)
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expired_coupon_codes_detected_at
  ON expired_coupon_codes (detected_at DESC);

-- RLS 활성화 + 정책 0개 = anon 차단. service_role (Edge Function) 만 read/write.
ALTER TABLE expired_coupon_codes ENABLE ROW LEVEL SECURITY;
