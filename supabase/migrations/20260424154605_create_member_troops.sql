-- 연맹원 병과(부대) 구성 테이블
--  kingshot_id + tier + troop_type 조합으로 수량을 관리
CREATE TABLE IF NOT EXISTS member_troops (
  id BIGSERIAL PRIMARY KEY,
  kingshot_id TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 10),
  troop_type TEXT NOT NULL CHECK (troop_type IN ('infantry','cavalry','archer')),
  quantity BIGINT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (kingshot_id, tier, troop_type)
);

CREATE INDEX IF NOT EXISTS idx_member_troops_kingshot_id ON member_troops(kingshot_id);

CREATE TRIGGER member_troops_updated_at
  BEFORE UPDATE ON member_troops
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE member_troops ENABLE ROW LEVEL SECURITY;

CREATE POLICY "member_troops_select" ON member_troops FOR SELECT USING (true);
CREATE POLICY "member_troops_insert" ON member_troops FOR INSERT WITH CHECK (true);
CREATE POLICY "member_troops_update" ON member_troops FOR UPDATE USING (true);
CREATE POLICY "member_troops_delete" ON member_troops FOR DELETE USING (true);
