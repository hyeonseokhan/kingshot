-- 연맹 블랙리스트
--
-- 게임 내 적대관계가 된 사용자(외부 + 내부 모두)를 등록·관리.
-- "쿠폰 받기 + 농장계정 등록" 패턴 재사용 — 클라가 anon key 로 직접 CRUD.
-- members 와 FK 분리 (외부 유저 등록 가능해야 함, kvk_speedup_survey 와 동일 패턴).
--
-- 이미지 첨부:
--   * Storage bucket "blacklist-evidence" (public) — 클라가 직접 업로드
--   * 클라 측 Canvas 로 1080px @ WebP q80 변환 후 업로드 → 평균 ~100 KB/장
--   * blacklist.image_path 에는 storage 경로만 저장 (URL 은 클라가 조립)
--
-- ROLLBACK:
--   DELETE FROM storage.objects WHERE bucket_id = 'blacklist-evidence';
--   DELETE FROM storage.buckets WHERE id = 'blacklist-evidence';
--   DROP TABLE IF EXISTS blacklist;

CREATE TABLE IF NOT EXISTS blacklist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kingshot_id TEXT NOT NULL UNIQUE,
  nickname    TEXT NOT NULL,
  avatar_url  TEXT,
  kingdom     INTEGER,
  note        TEXT,
  image_path  TEXT,                                          -- storage 경로 (없으면 NULL)
  created_by  TEXT,                                          -- 등록자 kingshot_id (members FK 없음 — 외부도 가능)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blacklist_created_at
  ON blacklist (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_nickname_lower
  ON blacklist (LOWER(nickname));

CREATE TRIGGER blacklist_updated_at
  BEFORE UPDATE ON blacklist
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS — coupon_accounts 등 기존 패턴과 동일 (anon key 가 직접 CRUD).
-- 권한 분기 (관리자 + 본인만 수정/삭제) 는 클라 측에서 검증.
-- 향후 service_role 통과 패턴으로 이전 가능 (Edge Function 분리 시).
ALTER TABLE blacklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blacklist_select" ON blacklist FOR SELECT USING (true);
CREATE POLICY "blacklist_insert" ON blacklist FOR INSERT WITH CHECK (true);
CREATE POLICY "blacklist_update" ON blacklist FOR UPDATE USING (true);
CREATE POLICY "blacklist_delete" ON blacklist FOR DELETE USING (true);

-- ============================================================
-- Storage bucket — public read, upload via anon key
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'blacklist-evidence',
  'blacklist-evidence',
  true,                                       -- 누구나 URL 로 읽기 가능 (URL 은 unguessable)
  524288,                                     -- 단일 파일 max 512 KB (1080@q80 평균 ~100KB 의 5배 여유)
  ARRAY['image/webp']                         -- WebP 만 허용 — 클라가 변환해 올림
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS 정책 — 모든 작업 anon 허용 (블랙리스트 페이지는 인증된 연맹원만 사용하지만
-- 인증은 클라 가드 + members 존재 확인 패턴. coupon_accounts 와 같은 layer.)
CREATE POLICY "blacklist_evidence_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'blacklist-evidence');
CREATE POLICY "blacklist_evidence_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'blacklist-evidence');
CREATE POLICY "blacklist_evidence_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'blacklist-evidence');
CREATE POLICY "blacklist_evidence_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'blacklist-evidence');
