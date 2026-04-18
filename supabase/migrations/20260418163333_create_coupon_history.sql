-- 쿠폰 수령 이력 테이블
CREATE TABLE coupon_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kingshot_id TEXT NOT NULL,
  coupon_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  message TEXT,
  redeemed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(kingshot_id, coupon_code)
);

ALTER TABLE coupon_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "coupon_history_select" ON coupon_history FOR SELECT USING (true);
CREATE POLICY "coupon_history_insert" ON coupon_history FOR INSERT WITH CHECK (true);
CREATE POLICY "coupon_history_update" ON coupon_history FOR UPDATE USING (true);
