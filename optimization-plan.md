# 연맹관리 최적화 — 완료 상태 + 잔여 작업

> 원본 분석/계획 (62 finding, 4 에이전트, 2026-05-13) 은 Phase 0~3 으로 8 PR 에 걸쳐 실행 완료.
> 본 문서는 **잔여 작업 + 의도적 skip 이력** 만 보존. 완료된 세부 변경은 `git log` 가 진실.

---

## 완료된 PR (2026-05-19, 커밋 8개)

| PR | 커밋 | 주요 변경 |
|---|---|---|
| **PR-A** | `977d7ba` | Dead code 9 항목 (i18n keys, CSS 셀렉터, window globals, utils 미사용 export, 중복 import, cache write-only 필드, RefreshButton legacy prop, image-optimize mimeType 옵션, redeem-coupon EF captcha/redeem action) |
| **PR-B** | `21d01c2` | native `alert/confirm` 일괄 `appAlert/appConfirm` swap (22 곳) + dialog 옵션 슬림화 |
| **PR-D** | `f139c23` | `lib/api/centurygame.ts` 신규 (`lookupPlayer` + `PlayerNotFoundError`) + 5 사이트 swap. **blacklist 청크 -200 KB / -54 KB gzip** (supabase-js 의존 분리) |
| **PR-E** | `19de3a6` | `lib/batch.ts` (`runBatched`) + `lib/supabase-rest.ts` (`REST_BASE`/`FN_BASE`/`STORAGE_BASE`/`restHeaders`/`restJsonHeaders`) |
| **PR-F** | `49f707b` | members.ts `initPage` (245줄) / coupons.ts `bindEventListeners` (207줄) / blacklist.ts `submitForm` (76줄) 책임별 함수 분해 |
| **PR-G** | `5836c75` | `lib/player-search-modal.ts` — 3 페이지 등록 모달 컨트롤러 통합. Enter 키 단축키 3 페이지 일관. `SearchData` 모듈 변수 2개 제거 |
| **PR-I** | `bb261f2` | 타입 안전 7항목 — Supabase select `.returns<T>()`, REST `r.ok` 가드, `crypto.randomUUID` in-guard, `$req/$opt` infra, SQLSTATE 23505, `GiftCodesResponse` 타입 |
| **PR-J/K** | `d1b3406` | 쿠폰 등록 시 `membersStore.get()` 활용 + 모바일 hit area 40×40 + `HISTORY_PAGE_SIZE` 5→50 + `esc()` single-quote escape |

전체 효과: dead code 정리 + 책임 분리 + lib 추출 + 청크 분리 (-200 KB) + 타입 안전 + 모바일 UX.

---

## 잔여 작업 (Open Question 결정 필요)

### P3-8 — `coupon_accounts_cache` 제거
- **현재**: `cache.ts:60-87` 의 sessionStorage 캐시 + `members.ts` 5 사이트의 `invalidateAccountsCache()` 호출
- **목표**: `membersStore` 단독 + `coupon_accounts` 직접 fetch
- **위험**: 트랙 2 운영 메모의 `force=true` 누락 패턴과 동일 종류 — 회귀 검증 필수
- **결정 보류**: 안전성 vs DRY 트레이드

### P3-9 — `pruneStaleHistory()` 클라이언트 hot path 제거
- **현재**: `coupons.ts` 의 페이지 진입 시 매번 DB DELETE (활성 쿠폰에 없는 history row)
- **옵션 (a)**: gift-codes Edge Function 안에서 service_role 처리
- **옵션 (b)**: admin 수동 정리 (트랙 3-2 결정과 일관 — **권장**)
- **Open Q3**: 어느 쪽?

### PR-H — `<div class="modal-overlay">` → native `<dialog>` 마이그레이션
- **대상**: members/coupons/blacklist.astro 의 모달 4 개
- **이득**: ESC / focus trap / inert background 자동, CSS overlay → `::backdrop`
- **위험**: CSS 회귀 (모달 크기/배경 디자인 검증 필요)
- **plan 분류**: 선택 — 즉시 가치보다 native API 정합 차원

### P3-4 — blacklist `$req`/`$opt` caller swap
- **현재**: `$req`/`$opt` infra 도입 완료 (PR-I), 기존 `$` 는 `$opt` alias
- **남은 작업**: 19 곳의 `$('foo')!` 패턴을 `$req('foo')` 로 swap → `$` alias 제거
- **분류**: mechanical, 단독 PR 가치 미세

### CORS / 기타 (Open Q1, Q4, Q6, Q7)
- **Q1** `Access-Control-Allow-Origin: "*"` 가 production 의도인가?
- **Q4** i18n `*.pageDescription` 미니게임 4쌍도 dead (manage 3쌍만 PR-A 에서 삭제) — 향후 `<meta name="description">` 동적 채울 계획이면 보존
- **Q6** blacklist 의 raw fetch → supabase SDK 통일 — **reject 유지** (B1-1 청크 -200 KB 효과 상쇄)
- **Q7** zod 같은 런타임 타입 검증 — **defer** (22명 규모면 inline 으로 충분)

---

## 의도적 Reject / Skip (변경 안 함)

| ID | 사유 |
|---|---|
| P3-11 직렬 chain → Promise.all 병렬 | callback→Promise ripple 위험 (plan 의 리스크 M) |
| P3-12 사전 select + 조건부 delete | 평균 round-trip 동일, 코드 복잡도 증가 |
| R1 `economy/` `verify_jwt` | 본 스코프 외 |
| R3 `setBannerStatus` 분리 | premature, 가치 낮음 |
| R4 `syncPhoto` 추출 | 사이트 2곳, premature |
| R5 `.player-card` vs `.bl-pill` 통합 | 의도된 디자인 차이 |
| R7 members 검색 debounce | 22명 규모면 false alarm |
| R8 mc-pos 색 의미 전달 | WCAG pass (색 + 텍스트/아이콘) |
| R9 i18n 청크 split | 스코프 외, 별도 작업 |
