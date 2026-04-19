-- members에 쿠폰 자동 받기 옵션 추가
ALTER TABLE members ADD COLUMN IF NOT EXISTS auto_coupon BOOLEAN DEFAULT true;

-- 외부 계정 (부계정, 지인 등) 쿠폰 수령용
CREATE TABLE coupon_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kingshot_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  level INTEGER DEFAULT 0,
  kingdom INTEGER,
  profile_photo TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE coupon_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coupon_accounts_select" ON coupon_accounts FOR SELECT USING (true);
CREATE POLICY "coupon_accounts_insert" ON coupon_accounts FOR INSERT WITH CHECK (true);
CREATE POLICY "coupon_accounts_update" ON coupon_accounts FOR UPDATE USING (true);
CREATE POLICY "coupon_accounts_delete" ON coupon_accounts FOR DELETE USING (true);
