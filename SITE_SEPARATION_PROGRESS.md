# 사이트 도메인 분리 작업 — 진행 상황

> **시작**: 2026-05-27 · **현재 단계**: Phase 5 (도메인 전환) 진행 중
> 다른 PC 에서 이어 작업하기 위한 컨텍스트 SSOT. 작업 완료 후 삭제 대상.

---

## 1. 배경

기존 단일 repo `kingshot` 가 두 도메인 (PNX 연맹 + KvK 설문) 혼재.
서비스 격리 + 향후 신규 서비스 확장 (war-prediction 등) 위해 **두 repo + 두 도메인** 으로 분리.

| 측면 | 기존 (PNX) | 신규 (1767) |
|------|------------|-------------|
| GitHub | `hyeonseokhan/kingshot` (유지) | `hyeonseokhan/kingshot-1767` (신설) |
| 로컬 | `/Users/toycode/Documents/00.Private/05.github/kingshot` | `/Users/toycode/Documents/00.Private/05.github/kingshot-1767` |
| Supabase project ref | `cbzgmugtsustsxuqpznv` | `qbcpohhzfhaxzbuncsne` |
| Supabase URL | `https://cbzgmugtsustsxuqpznv.supabase.co` | `https://qbcpohhzfhaxzbuncsne.supabase.co` |
| 현재 도메인 | `kingshot.wooju-home.org` (활성) | github.io 임시 검증 끝, custom domain 등록 중 |
| 목표 도메인 | `pnx.kingshot.co.kr` | `1767.kingshot.co.kr` |

회원 데이터는 **완전 독립** (옵션 A) — 1767 사이트의 KvK 사용자는 PNX 와 별개 신규 등록.

---

## 2. 진행 완료

### 신규 repo `kingshot-1767` (push 된 commits)

| Commit | 내용 |
|--------|------|
| `b6b9229` | bootstrap (Astro 5 + Tailwind v4 + TS, placeholder index) |
| `bd52101` | KvK 코드 이관 (68 files, 13K LOC — pages/lib/supabase/EF/migrations) |
| `4a6b58a` | 임시 base 추가 (github.io 검증용) |
| `fbb7507` | `1767.kingshot.co.kr` site/CNAME 설정 + 임시 base 원복 |

### Supabase 신규 프로젝트 (`kingshot-1767` = ref `qbcpohhzfhaxzbuncsne`)

- 마이그레이션 34개 적용 (members + credentials + kvk_* + 신규 `survey-evidence` bucket)
- Edge Functions 3개 배포: `kvk-survey`, `kvk-buff`, `tile-match-auth`
- 동작 검증 통과 (PIN 인증, 등록, 인증샷 업로드, 목록 노출 — 사용자 시각 확인)

### 임시 github.io 호스팅 검증
- URL: `https://hyeonseokhan.github.io/kingshot-1767/` (base path `/kingshot-1767`)
- GitHub Pages workflow 통과, 페이지 정상 동작
- ⚠️ 임시 base 는 `fbb7507` commit 에서 원복됨

### 기존 repo `kingshot`
- KvK 관련 코드/EF/mig 는 아직 그대로 (Phase 6 에서 삭제 예정).
- 본 진행 파일만 추가.

---

## 3. 신규 repo 아키텍처 (요점)

**Feature-based modular monolith** — 헥사고날 정신을 가벼운 폴더 컨벤션으로 흡수.

```
src/
  pages/
    index.astro              — root → /survey/ redirect
    survey/index.astro       — KvK 설문 (buff 다이얼로그 통합)
    <new-service>/           — 추후 신규 서비스 위치
  scripts/pages/<name>.ts    — 페이지별 클라 로직
  lib/
    shared/                  — 모든 도메인 공유 (supabase, dialog, store, dom-diff, utils, ...)
    kvk-survey/              — KvK 도메인 모듈 (kvk-score, survey-deadline)
    <new-service>/           — 추후 도메인 모듈
  styles/<domain>/           — 도메인별 스타일
  i18n/ (전체 ko.ts/en.ts)   — 추후 도메인별로 분리 예정 (점진)

supabase/
  functions/{kvk-survey,kvk-buff,tile-match-auth}/
  migrations/                — KvK 관련 34개
```

**신규 도메인 추가 cookbook**:
1. `src/pages/<domain>/index.astro`
2. `src/scripts/pages/<domain>.ts`
3. `src/lib/<domain>/`
4. `src/styles/<domain>/`
5. (필요 시) `supabase/functions/<domain>-*/`, `migrations/...`
6. **`shared/` 는 절대 손대지 않음** — import 만

**Storage bucket 룰**:
- kingshot-1767: `survey-evidence` (prefix 없음, 파일명 `{kingshot_id}.webp`)
- kingshot: `blacklist-evidence` 그대로 (PNX 전용)

---

## 4. 남은 작업

### Phase 5a — 1767 도메인 전환

- [ ] **DNS CNAME 등록** (도메인 콘솔, AWS Route 53 추정):
  - `1767` CNAME → `hyeonseokhan.github.io.` (TTL 300, Simple, 별칭 아니오)
  - `pnx`  CNAME → `hyeonseokhan.github.io.` (동일)
- [ ] **GitHub Pages 설정** (`kingshot-1767` repo):
  - Settings → Pages → Custom domain = `1767.kingshot.co.kr` → Save
  - DNS check 통과 후 "Enforce HTTPS" 체크 (인증서 ~수십 분)
- [ ] **검증**: `https://1767.kingshot.co.kr/` → `/survey/` redirect + PIN 인증 + 등록 동작

### Phase 5b — PNX 도메인 전환

- [ ] **`kingshot` repo** 수정:
  - `astro.config.mjs` `site:` → `https://pnx.kingshot.co.kr`
  - `public/CNAME` → `pnx.kingshot.co.kr` (기존 파일이 있으면 교체)
- [ ] **GitHub Pages 설정** (`kingshot` repo): Custom domain 변경
- [ ] **검증**: `https://pnx.kingshot.co.kr/` 접속

### Phase 6 — 기존 repo 정리 (Phase 5 둘 다 검증 통과 후)

> ⚠️ 순서 엄수 — 검증 전에 하면 KvK 사이트 다운.

- [ ] `kingshot` repo 에서 KvK 자산 삭제:
  - `src/pages/survey/`
  - `src/scripts/pages/survey-kvk*.ts`
  - `src/lib/kvk-score.ts`, `src/lib/survey-deadline.ts`
  - `src/styles/survey-kvk*.css`
  - `supabase/functions/kvk-survey/`, `supabase/functions/kvk-buff/`
  - `.github/workflows/deploy-survey.yml`
  - i18n 키 (점진 — 별도 세션)
- [ ] `kingshot` Settings → Secrets 의 `SURVEY_DEPLOY_TOKEN` 삭제
- [ ] `kingshot-survey-site` repo archive (1~2주 두고 → delete)
- [ ] 기존 PNX Supabase 의 KvK 테이블 drop (데이터 보존 정책 결정 필요)
- [ ] CLAUDE.md 양쪽 정비:
  - `kingshot`: KvK 도메인 행 제거 + 신규 repo 와의 관계 명시 + 본 파일 삭제
  - `kingshot-1767`: 자체 CLAUDE.md 신설 (분리 아키텍처 + cookbook 흡수)

### 기타 결정 필요
- [ ] 기존 도메인 (`kingshot.wooju-home.org`, `survey.kingshot.wooju-home.org`) 처리:
  - redirect vs 운영 종료 vs 양쪽 유지 중 택

---

## 5. 새 PC 에서 setup

```bash
# kingshot repo (이미 있을 가능성 — 없으면 clone)
cd /Users/toycode/Documents/00.Private/05.github/kingshot
git pull origin main

# kingshot-1767 repo (신규, clone 필요)
cd /Users/toycode/Documents/00.Private/05.github/
git clone https://github.com/hyeonseokhan/kingshot-1767.git
cd kingshot-1767
npm install
```

### `.env` 양쪽 모두 작성 필요 (gitignore)

**kingshot/.env** — 기존 PC 의 .env 그대로 복사.

**kingshot-1767/.env** — 다음 3개:
```
PUBLIC_SUPABASE_URL=https://qbcpohhzfhaxzbuncsne.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<dashboard 또는 CLI 로 조회>
SUPABASE_ACCESS_TOKEN=<kingshot/.env 와 동일 값 — 계정 토큰>
```

`PUBLIC_SUPABASE_ANON_KEY` 조회:
- Dashboard: https://supabase.com/dashboard/project/qbcpohhzfhaxzbuncsne/settings/api
- 또는 CLI: `supabase projects api-keys --project-ref qbcpohhzfhaxzbuncsne`

### Supabase CLI link (kingshot-1767)

`supabase/.temp/` 는 .gitignore 라 새 PC 에서 다시 link 필요:

```bash
cd /Users/toycode/Documents/00.Private/05.github/kingshot-1767
set -a && source .env && set +a
export SUPABASE_DB_PASSWORD='<별도 보관소에서 가져오기>'
/Users/toycode/bin/supabase link --project-ref qbcpohhzfhaxzbuncsne
```

⚠️ DB password 와 service_role key 는 본 파일에 박지 않음 — 본인 1Password/Keepass 등에서 가져올 것.

---

## 6. 분리 작업의 결정 사항 / 컨벤션

(다음 세션에서 헷갈리지 말 것)

- **회원 데이터**: 완전 독립 (옵션 A). 1767 사용자는 PNX 와 별개 PIN 등록.
- **공통 lib 동기화**: 양쪽 repo 에 복붙. npm 패키지 X. 변경 시 양쪽 수동 동기화.
- **i18n 사전**: 일단 전체 복사. 추후 `common/` + `<domain>/` 으로 분리 (점진).
- **마이그레이션**: KvK 관련 시간순 그대로 이관 (압축 X).
- **Storage bucket**: `survey-evidence` 신규 (`blacklist-evidence` 의존 제거).
- **URL 경로**: `/survey/` path 기반 (root 는 `/survey/` redirect). 신규 서비스도 `/<service>/` path.
- **EF `tile-match-auth`**: PIN 검증 공유 — 양쪽 모두 보존.

---

## 7. 다음 세션 시작 시 첫 액션

1. 본 파일 통독 (이미 자동 로드되는 CLAUDE.md 의 보조)
2. 사용자에게 어느 단계부터 이어갈지 확인:
   - Phase 5a 진행 중? (DNS / Pages settings 어디까지?)
   - Phase 5b 시작 시점?
3. Phase 5/6 진행 후 본 파일 삭제 (작업 완료 표시)

---

_마지막 업데이트: 2026-05-27_
