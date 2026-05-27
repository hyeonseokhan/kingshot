# 사이트 도메인 분리 작업 — 진행 상황

> **시작**: 2026-05-27 · **현재 단계**: Phase 6 진행 중 (코드 삭제 완료, GitHub/Supabase 정리 잔여)
> 다른 PC 에서 이어 작업하기 위한 컨텍스트 SSOT. 작업 완료 후 삭제 대상.

---

## 1. 배경

기존 단일 repo `kingshot` 가 두 도메인 (PNX 연맹 + KvK 설문) 혼재.
서비스 격리 + 향후 신규 서비스 확장 (war-prediction 등) 위해 **두 repo + 두 도메인** 으로 분리.

| 측면 | 기존 (PNX) | 신규 (1767) |
|------|------------|-------------|
| GitHub | `hyeonseokhan/kingshot` | `hyeonseokhan/kingshot-1767` |
| Supabase project ref | `cbzgmugtsustsxuqpznv` | `qbcpohhzfhaxzbuncsne` |
| Supabase URL | `https://cbzgmugtsustsxuqpznv.supabase.co` | `https://qbcpohhzfhaxzbuncsne.supabase.co` |
| 운영 도메인 | `pnx.kingshot.co.kr` ✅ | `1767.kingshot.co.kr` ✅ |

회원 데이터는 **완전 독립** (옵션 A) — 1767 사이트의 KvK 사용자는 PNX 와 별개 신규 등록.

---

## 2. 진행 완료

### Phase 1~4 (이전 PC)
- 신규 repo `kingshot-1767` 부트스트랩 + KvK 코드 이관 (commits `b6b9229` → `fbb7507`)
- Supabase 신규 프로젝트 (`qbcpohhzfhaxzbuncsne`) 마이그레이션 34개 + EF 3개 (`kvk-survey`, `kvk-buff`, `tile-match-auth`) 배포
- 임시 github.io 호스팅 검증 통과

### Phase 5 (현재 PC, 2026-05-27)
- ✅ DNS CNAME 등록 — `1767`, `pnx` 모두 `hyeonseokhan.github.io` 로
- ✅ GitHub Pages Custom domain 설정 — `kingshot` / `kingshot-1767` 양쪽
- ✅ SSL 인증서 정상 발급 (양쪽 도메인)
- ✅ 도메인 접속 검증 통과

### Phase 6 — 코드 삭제 (현재 PC, 2026-05-27)
- ✅ `kingshot` repo 에서 KvK 자산 12 파일 삭제 (commit `528f5c8`)
  - `src/pages/survey/`, `src/layouts/SurveyLayout.astro`
  - `src/scripts/pages/survey-kvk{,-buff}.ts`
  - `src/lib/{kvk-score,survey-deadline}.ts`
  - `src/styles/survey-kvk{,-buff}.css`
  - `supabase/functions/{kvk-survey,kvk-buff}/`
  - `.github/workflows/deploy-survey.yml`
  - `supabase/config.toml` 주석 정리
- ✅ 빌드 검증 통과 (24 페이지)

---

## 3. 남은 작업

### 3a. Claude 가 처리 가능 (다음 PC 세션에서)

- [ ] **i18n 키 정리** — `src/i18n/ko.ts` / `en.ts` 에서 `kvk*` / `survey*` 키 제거
  - `gameTools.kvkCalculator.*` 는 이미 이전 커밋에서 제거됨 — 잔여 키만 확인
  - 검색 명령: `grep -n "kvk\|survey" src/i18n/ko.ts src/i18n/en.ts`
- [ ] **CLAUDE.md 정비**
  - KvK 도메인 행 제거 (도메인 맵 표)
  - 신규 repo (`kingshot-1767`) 와의 관계 명시 — 분리 사이트 + 공유 lib 수동 동기화 룰
  - `SITE_SEPARATION_PROGRESS.md` 삭제 안내 추가
- [ ] **navigation.ts 잔여 점검** — `survey` 경로 흔적 없는지 재확인 (현재 없음 확인됨)
- [ ] **PNX Supabase KvK 테이블 drop 마이그레이션 작성** (정책 결정 후)
  - `kvk_speedup_survey`, `kvk_buff_state`, `kvk_buff_participants`
  - 파일 상단 ROLLBACK SQL 주석 보존

### 3b. 사용자 작업 (Claude 불가)

- [ ] **GitHub Secrets 삭제** — `kingshot` repo → Settings → Secrets and variables → Actions → `SURVEY_DEPLOY_TOKEN` 삭제
- [ ] **`kingshot-survey-site` repo archive**
  - GitHub → 해당 repo → Settings → Danger Zone → Archive
  - 1~2주 모니터링 후 delete
- [ ] **PNX Supabase KvK 테이블 drop 정책 결정**
  - 옵션: 즉시 drop / 1~2주 보관 후 drop / 백업 후 drop
  - 결정되면 Claude 에게 알려서 마이그레이션 작성 의뢰
- [ ] **기존 도메인 정리 결정**
  - `kingshot.wooju-home.org` (구 PNX)
  - `survey.kingshot.wooju-home.org` (구 설문)
  - redirect / 종료 / 양쪽 유지 중 택

### 3c. 완료 후 마무리

- [ ] 본 파일 (`SITE_SEPARATION_PROGRESS.md`) 삭제 + 커밋

---

## 4. 신규 repo 아키텍처 (참고용 — 다음 세션 헷갈리지 말 것)

**Feature-based modular monolith** — 헥사고날 정신을 가벼운 폴더 컨벤션으로 흡수.

```
src/
  pages/
    index.astro              — root → /survey/ redirect
    survey/index.astro       — KvK 설문 (buff 다이얼로그 통합)
  scripts/pages/<name>.ts    — 페이지별 클라 로직
  lib/
    shared/                  — 모든 도메인 공유 (supabase, dialog, store, dom-diff, utils, ...)
    kvk-survey/              — KvK 도메인 모듈 (kvk-score, survey-deadline)
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
- kingshot: `blacklist-evidence` (PNX 전용)

---

## 5. 다른 PC 에서 setup (참고)

```bash
# 양쪽 repo pull
cd <kingshot 경로>      && git pull origin main
cd <kingshot-1767 경로> && git pull origin main && npm install
```

`.env` 가 새 PC 에 없으면:
- `kingshot/.env` — Supabase URL `https://cbzgmugtsustsxuqpznv.supabase.co` + ANON_KEY + ACCESS_TOKEN
- `kingshot-1767/.env` — Supabase URL `https://qbcpohhzfhaxzbuncsne.supabase.co` + ANON_KEY + ACCESS_TOKEN (계정 토큰은 양쪽 동일)

ANON_KEY 조회: 각 Supabase Dashboard → Settings → API → `anon public` 값 또는 `supabase projects api-keys --project-ref <ref>`.

Supabase CLI link 는 DB push / functions deploy 필요할 때만:
```bash
supabase link --project-ref qbcpohhzfhaxzbuncsne   # kingshot-1767
supabase link --project-ref cbzgmugtsustsxuqpznv   # kingshot
```

---

## 6. 분리 작업 컨벤션 (다음 세션 헷갈리지 말 것)

- **회원 데이터**: 완전 독립 (옵션 A). 1767 사용자는 PNX 와 별개 PIN 등록.
- **공통 lib 동기화**: 양쪽 repo 에 복붙. npm 패키지 X. 변경 시 양쪽 수동 동기화.
- **i18n 사전**: 일단 전체 복사. 추후 `common/` + `<domain>/` 으로 분리 (점진).
- **마이그레이션**: KvK 관련 시간순 그대로 이관 (압축 X).
- **EF `tile-match-auth`**: PIN 검증 공유 — 양쪽 모두 보존.

---

## 7. 다음 세션 첫 액션

1. 본 파일 통독
2. 사용자에게 어느 항목부터 이어갈지 확인:
   - 3a (i18n 정리 / CLAUDE.md 정비) — Claude 가 바로 진행 가능
   - 3b (사용자 수동 작업) 진행 상황 확인
   - PNX Supabase 테이블 drop 정책 결정됐는지
3. 3a + 3b 둘 다 완료되면 본 파일 삭제 + 커밋

---

_마지막 업데이트: 2026-05-27 (Phase 6 코드 삭제 완료)_
