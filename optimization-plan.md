# 연맹관리 최적화 작업 계획서

> 4 에이전트 분석 종합. 분석 일자: 2026-05-13. 검토자: Agent 4.
> 원본 자료 (프로젝트 루트):
> - [`optim-1-dead-and-scale.md`](optim-1-dead-and-scale.md) (Agent 1, 21 finding)
> - [`optim-2-separation-and-reuse.md`](optim-2-separation-and-reuse.md) (Agent 2, 16 finding)
> - [`optim-3-type-perf-ux.md`](optim-3-type-perf-ux.md) (Agent 3, 25 finding)

스코프: `src/pages/manage/{members,coupons,blacklist}.astro` + 같은 이름 `src/scripts/pages/*.ts`
+ 그들이 import 하는 `src/lib/*` + i18n 사전 + `supabase/functions/{redeem-coupon,gift-codes}`.

표기 — 노력: S(반나절 이내)/M(1~2일)/L(2일+). 리스크: S(회귀 가능성 거의 없음)/M(검증 필요)/L(설계 영향 큼).

---

## 검증 요약

- **총 분석 finding**: 62건 (Agent 1: 21, Agent 2: 16, Agent 3: 25)
- **검증 후 채택**: 41건 (Phase 0~3 작업 항목)
- **머지 (중복 제거)**: 11쌍 (다른 각도에서 본 같은 문제)
- **Reject / Defer**: 10건 (사유 기록)

검증 방법 — 임팩트 큰 finding 12건은 직접 read/grep 으로 확인. 나머지는 spot check + 분석가 근거 신뢰.

| 검증된 핵심 사실 | 결과 |
|---|---|
| `coupon_accounts_cache` 가 `membersStore` 와 중복 (A1.F4) | ✅ cache.ts:60-87 + members.ts 5곳 invalidate 호출 확인 |
| `window.Members` / `window.Coupons` 미사용 (A1.F3) | ✅ grep 결과 정의 사이트 외 0건 |
| `formatNum` / `truncate` 미사용 (A1.F5) | ✅ utils.ts 의 함수는 0 import. survey-kvk.ts 의 formatNum 은 로컬 정의 |
| `appConfirm/appAlert` 의 title/okLabel/cancelLabel 옵션 미사용 (A1.F10) | ✅ caller grep 0건. variant 만 1회 |
| `pruneStaleHistory()` 가 사용자 hot path 에서 DB DELETE (A1.F11) | ✅ coupons.ts:124,135 에서 매 페이지 진입 호출 |
| `redeem-coupon` 의 `captcha`/단일 `redeem` action 미사용 (A1.F6) | ✅ src grep 결과 클라가 player/redeem_batch 만 호출 |
| `RefreshButton.astro` 의 `legacy` prop 미사용 (A1.F14) | ✅ 사용처 1곳 (blacklist), legacy 인자 0회. RankingTable 은 자체 .rank-refresh |
| Cache 의 `total` / `ts` write-only 필드 (A1.F9) | ✅ cache.ts:13-23 정의 + set 시점만 채움, 읽기 0건 |
| `image-optimize.ts` 의 `mimeType: 'image/jpeg'` dead path (A1.F19) | ✅ caller(blacklist.ts) 가 항상 webp 명시. storage policy 도 webp only |
| blacklist.ts 가 supabase 클라이언트 0 사용 (A3.B1) | ✅ `sb.\|supabase\.` grep 0건. 전부 raw fetch |
| `PlayerInfoResponse` 타입 정의 후 0 사용 (A3.A1) | ✅ types.ts:45 정의 + 사용처 0건 |
| `fetchPlayerInfo` 패턴 4 사이트 인라인 중복 (A2.F10) | ✅ members/coupons(2)/blacklist(2) 5 호출처 확인 |
| 등록 모달 마크업 3 페이지 중복 (A2.F11) | ✅ 3 .astro 파일 모두 `<div class="modal-overlay">` 패턴 |
| native `alert/confirm` 잔재 14곳+ (A1.F20, A2.F18, A3.C2) | ✅ blacklist 11곳 + coupons 12곳 grep 매칭 |
| 중복 import (A1.F8) | ✅ members.ts:9-10 같은 모듈 두 줄 |

---

## 가장 임팩트 큰 Top 5 (Quick Wins, Phase 0)

| # | ID | 한 줄 요약 | 효과 | 노력 | 리스크 |
|---|---|---|---|---|---|
| 1 | **B1-1** (A3.B1) | blacklist.ts 의 supabase 청크 분리 → -200 KB | H | S | S |
| 2 | **P0-1** (A1.F1+F2+F3+F5+F8+F9+F14) | 명백한 dead code/임포트 일괄 정리 (i18n 키 7 + CSS 셀렉터 4 + window globals 2 + utils 2 + cache 필드 2 + RefreshButton legacy + 중복 import) | H | S | S |
| 3 | **P0-2** (A1.F10) | `appAlert/appConfirm` 옵션 슬림화 (title/okLabel/cancelLabel 제거) | M | S | S |
| 4 | **P1-1** (A2.F10 + A3.A1+A3.A2 + A3.C3) | `lib/api/centurygame.ts` 추출 — 4 사이트 중복 + 타입 안전 + 메시지 통일 | H | M | S |
| 5 | **P0-3** (A1.F20 + A2.F18 + A3.C2) | native `alert()/confirm()` → `appAlert/appConfirm` 일괄 swap (14곳+) | H | S~M | S |

> Top 5 핵심 가치: **B1-1 + P0-1 = 1 일 작업으로 -200 KB 첫 페인트 + 200 LOC 청소**.
> P1-1 은 후속 모든 작업의 기반 (Phase 2 의 PlayerSearchModal, Phase 3 의 타입 강화 모두 의존).

---

## Phase 별 실행 계획

### Phase 0 — Dead code + 즉시 가능한 정리 (PR 2~3 개)

**목표**: 회귀 위험 거의 없는 항목 일괄 정리. Phase 1+ 의 base.

**검증 방법**: `npm run build`, `astro check` (이미 pass 검증됨), 페이지별 brief manual.

#### PR-A: Dead code 일괄 정리 (한 commit, 1~2 시간)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P0-1.1 | A1.F1 | `src/i18n/{ko,en}.ts` | 미사용 i18n 키 7개 삭제 (`*.pageDescription` 3쌍 + `coupons.msg.searchFailed` + blacklist 3개) | S | S |
| P0-1.2 | A1.F2 | `src/styles/manage.css:251-280, 1053-1144, 1235-1245` | dead CSS 셀렉터 4개 + 미디어쿼리 변형 (~30 LOC) | S | S |
| P0-1.3 | A1.F3 | `members.ts:897-905`, `coupons.ts:1426-1436` | `window.Members` / `window.Coupons` 전역 노출 + declare 제거 | S | S |
| P0-1.4 | A1.F5 | `src/lib/utils.ts:64-67, 79-82` | 미사용 export `formatNum`, `truncate` 삭제 | S | S |
| P0-1.5 | A1.F8 | `members.ts:9-10` | 중복 import 한 줄로 합치기 | S | S |
| P0-1.6 | A1.F9 | `src/lib/cache.ts:13-23, 41-50, 100-109` | write-only 필드 `total`, `ts` 제거 | S | S |
| P0-1.7 | A1.F14 | `src/components/RefreshButton.astro:25-29` | `legacy` prop 삭제 + 분기 로직 제거 | S | S |
| P0-1.8 | A1.F19 | `src/lib/image-optimize.ts:18, 67-72` | `mimeType: 'image/jpeg'` 옵션/dead path 제거. 항상 webp | S | S |
| P0-1.9 | A1.F6 | `supabase/functions/redeem-coupon/index.ts:131-162` | 미사용 `captcha` + 단일 `redeem` action 제거 (~30 LOC) | S | S (사용자 재배포 필요) |

**검증**: build pass + astro check pass + 사용자 재배포 (P0-1.9). 각 페이지 1분 클릭 회귀.

#### PR-B: dialog 옵션 슬림화 + native alert/confirm swap (한 commit, 2~3 시간)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P0-2 | A1.F10 | `src/lib/dialog.ts:21-52` | `ConfirmOptions` 와 OpenOpts 슬림화 — title/okLabel/cancelLabel 제거. variant 만 유지 | S | S |
| P0-3.1 | A1.F20 + A2.F18 + A3.C2 | `blacklist.ts` 11곳, `coupons.ts` 12곳 | native `alert()` → `appAlert()`, native `confirm()` → `await appConfirm()` 일괄 | M | S~M (await 도입으로 일부 함수 async 화. 회귀 ripple 검증 필요) |
| P0-3.2 | A3.C3 | `members.ts/coupons.ts/blacklist.ts` 의 lookup 에러 메시지 | "lookup failed" raw 영어 → `t('common.playerLookupFailed')` 통일 | S | S |

**검증**: 각 페이지의 alert/confirm 트리거 (등록/삭제/갱신 등) 수동 클릭. native dialog 가 안 뜨는지 확인.

#### PR-C (선택): CORS TODO 정리 + admin grant regex 단순화
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P0-4 | A1.F7 | `redeem-coupon/index.ts:12-13`, `gift-codes/index.ts:9-10` | `*` 유지 + TODO 주석 명시화 (Open Q1 사용자 결정 후) | S | S |
| P0-5 | A1.F17 | `members.ts:818-825` | 정규식 → `parseInt` + 범위 체크 (3 LOC) | S | S |

---

### Phase 1 — 핵심 lib 추출 (PR 2~3 개)

**목표**: 후속 작업의 기반인 공통 lib 추출. Phase 2 의 PlayerSearchModal 과 Phase 3 의 타입 강화 모두 이 위에 build.

**검증 방법**: 빌드 + 타입 체크 + 5 호출 사이트 (members/coupons/blacklist) 의 등록/조회 회귀.

#### PR-D: `lib/api/centurygame.ts` + supabase config split (한 commit, 4~6 시간)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| **P1-1** | A2.F10 + A2.F14 + A3.A1 + A3.A2 + A3.C3 | 신규 `src/lib/api/centurygame.ts` | `lookupPlayer(id): Promise<PlayerLookupResult>` 추출. 4 사이트 인라인 → 단일 함수. `PlayerInfoResponse` 사용 + `level: stove_lv ?? stove_lv_content` 표준화 + `PlayerNotFoundError`/`PlayerLookupError` 클래스. 호출자 5곳 swap | M | S |
| **B1-1** | A3.B1 | `src/lib/supabase.ts` 분리 | `src/lib/supabase-config.ts` (URL/ANON_KEY 상수) + `src/lib/supabase.ts` (createClient). blacklist.ts 는 config 만 import | S | S |

**예상 효과**:
- P1-1: 5 사이트 ~150 LOC 감소 + 외부 API 변경 시 단일 수정 지점 + 타입 안전.
- B1-1: blacklist 페이지 첫 페인트 JS 220 KB → 17 KB (-92%). 모바일 4G ~300 ms 단축.

**검증**: blacklist/members/coupons 의 등록 모달 + 갱신 버튼 + 회원 등록 회귀. dist chunk 확인 (`dist/_astro/blacklist*.js` 가 supabase.* 청크 미참조).

#### PR-E: 배치 처리 헬퍼 + Supabase REST 헤더 추출 (한 commit, 3~4 시간)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P1-2 | A2.F12 + A2.F3 + A3.B5 | 신규 `src/lib/batch.ts` | `runBatched<T,R>({ items, batchSize, delayMs, handler, onBatchComplete })` 추출. members/coupons(refreshAllExtras + startBulkRedeem)/blacklist 4 호출처 swap | S~M | S |
| P1-3 | A2.F15 | `src/lib/supabase.ts` (또는 `lib/supabase-rest.ts` — B1-1 후 결정) | `restHeaders`, `restJsonHeaders`, `REST_BASE`, `FN_BASE`, `STORAGE_BASE` 상수화. blacklist/coupons/members 3+ 사이트 swap | S | S |

---

### Phase 2 — 책임 분리 + 컴포넌트화 (PR 3~5 개)

**목표**: 페이지 controller 함수를 책임별로 분해 + 등록 모달 통합. 신규 페이지 추가/유지보수 비용 낮춤.

**검증 방법**: 함수 분리는 라이프사이클 미변경 → 빌드 + 페이지별 wide manual. PlayerSearchModal 은 등록 + 수정 + 회귀 검증.

#### PR-F: members.ts/coupons.ts initPage 책임 분리 (한 commit, 1~2 일)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P2-1 | A2.F1 + A2.F2 | `members.ts:515-759` | `initPage()` 245 lines → `initFilters/initSearch/initRowDelegation/initManageDialog/initAddModal/initBulkRefresh/initEscapeKey/initStoreBinding` 8 함수. `MemberManageDialog` 객체 추출 (refreshMember/saveChanges/deleteMember 메서드) | M | S |
| P2-2 | A2.F4 | `coupons.ts:1188-1423` | `initPage`/`bindEventListeners` 215 lines → 7 함수 분리 (members 패턴 그대로) | M | S |
| P2-3 | A2.F5 | `blacklist.ts:573-648` | `submitForm` 76 lines → `updateEntry/createEntry` 분리. dispatch | S | S |

#### PR-G: 등록/조회 모달 통합 — PlayerSearchModal (한 commit, 1~2 일)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| **P2-4** | A2.F11 + A2.F16 + A3.C9 | 신규 `src/lib/player-search-modal.ts` (컨트롤러) + `src/components/PlayerSearchModal.astro` 또는 페이지별 마크업 유지 | 3 페이지 등록 모달 컨트롤러 단일화. `bindPlayerSearchModal({ overlayId, inputId, searchBtnId, saveBtnId, onPreview, onReset, onSave })`. duplicate 감지 (`code === '23505'`) 헬퍼 별도. C9 (`inputmode="numeric"`) 도 같이 적용 | M | M (Open Q2 — Astro 컴포넌트화 vs JS 컨트롤러만. JS 컨트롤러 우선 권장) |

**의존성**: P1-1 (lookupPlayer) 필수. PR-D 후 진행.

#### PR-H: 모달을 native `<dialog>` 로 마이그레이션 + UX 마무리 (선택, 한 commit, 1 일)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P2-5 | A3.C1 | `members.astro/coupons.astro/blacklist.astro` 의 `<div class="modal-overlay">` 4곳 | `<dialog>` 로 마이그레이션. ESC/focus trap/inert background 자동 획득. `.open` class → `showModal/close()`. CSS overlay → ::backdrop | M | M (CSS 회귀 — 모달 크기/배경 디자인 검증 필요. PR-G 와 같이 처리 권장) |
| P2-6 | A3.C5 | `blacklist.ts:573-648` | submitForm 성공 시 toast 표시 (현재 silent) | S | S |
| P2-7 | A3.C8 | `blacklist.astro:167-169` 이미지 lightbox | visually hidden close 버튼 추가 (a11y) | S | S |

---

### Phase 3 — 타입 + 성능 + UX 강화 (지속, PR 3~5 개)

#### PR-I: 타입 안전 강화 (한 commit, 4~6 시간)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P3-1 | A3.A3 | `coupons.ts:282-291` | unsafe cast → `from<CouponAccount>('coupon_accounts').select('*')` generic 활용 | S | S |
| P3-2 | A3.A4 | `blacklist.ts:131` | REST 응답 status 체크 추가 (`r.ok`) + 4xx/5xx throw | S | S |
| P3-3 | A3.A5 | `members.ts:831-833` | `'randomUUID' in crypto` in-guard. tsconfig lib 확인 후 cast 제거 | S | S |
| P3-4 | A3.A6 | `blacklist.ts:81` 의 `$<T>` | members.ts 의 throw 패턴과 일관 (`$req`/`$opt` 분리) | S | S |
| P3-5 | A3.A7 | `coupons.ts:658-660` | unsafe cast 두 줄 → `if (res.error)` 단순화 | S | S |
| P3-6 | A3.A8 + A3.F8 | `members.ts:715`, `coupons.ts:1351` | duplicate 감지 substring → `res.error.code === '23505'` (PostgreSQL SQLSTATE) | S | S |
| P3-7 | A3.A9 | `coupons.ts:117-122` 등 | gift-codes Edge Function 응답 타입 정의 (`types.ts` 추가) | S | S |

**의존성**: P1-1 후 진행 (centurygame 응답 타입은 거기서 처리).

#### PR-J: 쿠폰 페이지 데이터 흐름 정리 (한 commit, 1 일)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| **P3-8** | A1.F4 + A3.B4 | `cache.ts:60-87` 제거, `coupons.ts:loadAccounts` 재구성, `members.ts` 5 사이트의 `invalidateAccountsCache()` 제거 | accounts cache 전체 제거 → `membersStore` 단독 + `coupon_accounts` 직접 fetch | M | M (회귀 검증 필수 — 트랙 2 운영 메모의 force=true 패턴과 동일 종류 위험) |
| P3-9 | A1.F11 + A1.F16 (Open Q3) | `coupons.ts:131-155` | `pruneStaleHistory()` 클라이언트 hot path 제거. 두 옵션: (a) gift-codes Edge Function 안에서 service_role 처리, (b) admin 수동 정리. **권장 (b)** — 트랙 3-2 결정 일관 | M | M |
| P3-10 | A3.B3 | `coupons.ts:1330-1367` | extras 등록 시 members 중복 체크를 `membersStore.get()` 로 (1 round-trip 절약) | S | S |
| P3-11 | A3.B6 | `coupons.ts:1188-1196` | initPage 직렬 chain → `Promise.all([loadCouponsP(), loadAccountsP()]).then(() => loadHistoryP())` | S | M (callback hell → Promise 화 ripple) |
| P3-12 | A3.B2 | `members.ts:725-733` | 회원 등록 후 무조건 `coupon_accounts.delete` → 사전 select 후 조건부 delete | S | S |

#### PR-K: 모바일 UX + scale fit (한 commit, 4~6 시간)
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P3-13 | A3.C4 | `blacklist.css:89-114`, `manage.css:556, 1099` | 모바일 (max-width 640px) 에서 button 44×44 또는 padding hit area 확대 | S | S |
| P3-14 | A1.F15 | `coupons.ts:39, 1109-1184` | `HISTORY_PAGE_SIZE = 5 → 50` + pagination 단순화 또는 제거 (~75 LOC 절감) | M | S |
| P3-15 | A3.C6 | `src/lib/utils.ts:36-44` (esc) | single-quote escape 추가 (`'` → `&#39;`) | S | S |

#### PR-L (선택, Open Q): blacklist supabase SDK 통일 + 추가 계정 갱신 정리
| ID | Source | 위치 | 변경 | 노력 | 리스크 |
|---|---|---|---|---|---|
| P3-16 | A1.F21 | `blacklist.ts:34-41` 등 | raw fetch → `sb.from('blacklist').select/.update/.delete` 통일 | M | S (B1-1 의 효과 일부 상쇄 — supabase 청크 다시 들어옴. **B1-1 우선 → 본 작업은 보류 또는 reject 검토**) |
| P3-17 | A1.F18 (Open Q2) | `coupons.ts:574-667` | 추가 계정 일괄 갱신 — 사용 빈도 따라 (a) 헬퍼 추출 후 유지 vs (b) 1명씩 수동 단순화 | M | M |

---

## Reject / Defer

| ID | Source | 사유 |
|---|---|---|
| R1 | A1.F12 | `economy/` `verify_jwt` 정책 — 본 분석가도 "스코프 외, 후속" 명시. **defer** |
| R2 | A1.F13 | `currentDialogId` non-null assertion — cosmetic. P3-3 (A3.A5) 와 묶여 자연스럽게 정리 가능. 단독 작업 X |
| R3 | A2.F7 | `setBannerStatus` 분리 — 분석가 본인이 "premature 가능, 권장 안 함" 결론. **유지** |
| R4 | A2.F13 | `syncPhoto` 추출 — 사이트 2곳, premature. tile-match 도 같은 패턴 마커 있으나 *함수 호출이 아닌 inline*. **defer** |
| R5 | A2.F19 | `.player-card` vs `.bl-pill` 통합 — 분석가 본인이 "추출 비권장" 결론. 의도된 디자인 차이 |
| R6 | A2.F17 | `$<T>(id)` DOM helper 통합 — 단독 PR 가치 낮음, P3-4 와 묶음 (이미 P3-4 가 처리) |
| R7 | A3.B7 | members 검색 input debounce — 22명 규모면 false alarm. 분석가도 defer 권장 |
| R8 | A3.C7 | mc-pos 색 의미 전달 — 색 + 텍스트/아이콘 둘 다 사용 중. WCAG pass. 분석가 false alarm 자체 결론 |
| R9 | A3 (i18n 청크 split) | 빌드 메트릭 노트의 i18n 46 KB lang 별 split — 본 분석 스코프 외, 별도 작업 |
| R10 | P3-16 (A1.F21) | blacklist supabase SDK 통일 — B1-1 의 -200 KB 효과를 상쇄. **B1-1 우선 → 본 항목은 보류**. 실행하려면 다른 페이지에 미치는 영향까지 봐야 함 |

---

## 머지된 finding (중복 정리)

| 새 ID | 원본 ID들 | 사유 |
|---|---|---|
| **M1 = P1-1** | A2.F10 + A2.F14 + A3.A1 + A3.A2 + A3.C3 | "centurygame player API 호출 + 응답 정규화 + 에러 메시지" 를 4 각도에서 본 것. 단일 lib 추출로 일괄 |
| **M2 = P1-2** | A2.F12 + A2.F3 + A3.B5 | "배치 처리 (BATCH_SIZE + Promise.all + delay) 3+ 사이트 중복" — 책임 분리 + 컴포넌트화 + 성능 일관성 측면 |
| **M3 = P0-3** | A1.F20 + A2.F18 + A3.C2 | "native alert/confirm → appAlert/appConfirm" — dead code(혼용) + 컴포넌트화(이미 lib 존재) + UX(디자인 일관성) |
| **M4 = P3-8** | A1.F4 + A3.B4 | "coupon_accounts cache 중복 + TTL 없음" — dead code (membersStore 중복) + 성능 (영구 캐시) 측면 |
| **M5 = P3-9** | A1.F11 + A1.F16 | F16 가 F11 의 "트랙 3-2 자동 청소 포기 결정과 일관" 강조 |
| **M6 = P0-1.6** | A1.F9 (단일이지만 cache.ts 의 두 인터페이스에 같은 패턴 적용) | GiftCodesCache.total + FailedRefresh.ts 같은 write-only 필드 |
| **M7 = P3-6** | A3.A8 + A3.F8 (A1) | "duplicate 감지 substring 매칭" 같은 issue 를 Type 과 Scale 두 각도 |
| **M8 = P2-4** | A2.F11 + A2.F16 + A3.C9 | PlayerSearchModal 컨트롤러 + save flow + inputmode numeric — 모두 등록 모달 통합 작업 안 |
| **M9 = P2-5** | A3.C1 | (단독이지만) Modal 마이그레이션 — A2.F11 의 "Astro 컴포넌트로 추출" 결정과 같은 PR 에서 처리 가능 |
| **M10 = P3-13** | A3.C4 (단독) | 모바일 hit area — `bl-icon-btn`/`mc-manage-btn`/`cp-btn` 3 영역에 같은 변경 |
| **M11 = P3-3** | A3.A5 + A1.F13 | crypto.randomUUID 와 currentDialogId non-null — 둘 다 cosmetic 타입 강화 |

---

## 검증된 vs 미검증

| ID | 검증 상태 | 메모 |
|---|---|---|
| A1.F1 (i18n keys) | ✅ grep 0 매칭 | 7 키 안전 삭제 가능 |
| A1.F2 (CSS 셀렉터) | ⚠ 분석가 grep 신뢰 | spot check 권고 — `.mc-rank-badge` 동적 조립 가능성 한 번 더 |
| A1.F3 (window globals) | ✅ grep 0 매칭 | 안전 |
| A1.F4 (accounts cache) | ✅ Read 검증 | cache.ts:60-87 + members 5곳 invalidate 모두 확인 |
| A1.F5 (utils dead) | ✅ grep 0 import | survey-kvk 의 동명 함수는 로컬 |
| A1.F6 (redeem-coupon dead actions) | ✅ Read 검증 | captcha + 단일 redeem 클라 호출 0건 |
| A1.F7 (CORS TODO) | ✅ Read 검증 | 결정 필요 (Open Q1) |
| A1.F8 (중복 import) | ✅ Read 검증 | members.ts:9-10 |
| A1.F9 (cache write-only) | ✅ Read 검증 | total/ts 읽기 0건 |
| A1.F10 (dialog options) | ✅ grep + Read 검증 | title/okLabel/cancelLabel 0 caller |
| A1.F11 (pruneStaleHistory) | ✅ Read 검증 | coupons.ts:124, 135 |
| A1.F14 (RefreshButton legacy) | ✅ grep 검증 | 사용처 1곳, legacy 인자 0회 |
| A1.F15 (HISTORY_PAGE_SIZE) | ⚠ 미검증 (시간 제약) | 분석가 LOC 평가 신뢰. spot check 권고 |
| A1.F17 (regex) | ⚠ 미검증 | 자명 |
| A1.F18 (extras 갱신) | ⚠ 미검증 (Open Q2) | 사용 빈도 사용자 답변 필요 |
| A1.F19 (image-optimize webp) | ✅ Read 검증 | DEFAULT_OPTIONS + 분기 확인 |
| A1.F20 (alert/confirm) | ✅ grep 검증 | blacklist 11 + coupons 12 |
| A1.F21 (blacklist raw fetch) | ✅ Read 검증 | 단 B1-1 와 trade-off (Reject) |
| A2.F1 (initPage 분해) | ✅ Read 검증 | members.ts:515-759 245 lines 확인 |
| A2.F2 (manage dialog 분리) | ✅ Read 검증 | md-refresh 44 lines 확인 |
| A2.F3 (refreshMembersByIds) | ⚠ 미검증 — P1-2 와 묶음 | 분석가 책임 분해 평가 신뢰 |
| A2.F4 (coupons.initPage) | ✅ Read 검증 | bindEventListeners 215 lines 확인 |
| A2.F5 (submitForm 분기) | ✅ Read 검증 | 76 lines 확인 |
| A2.F6 (redeemForMember) | ⚠ 미검증 (시간 제약) | 책임 8개 평가 신뢰 |
| A2.F10 (fetchPlayerInfo) | ✅ grep 검증 | 5 호출처 확인 |
| A2.F11 (등록 모달) | ✅ grep 검증 | 3 .astro 모달 마크업 확인 |
| A2.F12 (배치 처리) | ⚠ 분석가 평가 신뢰 | 패턴 일관성 spot check 권고 |
| A2.F15 (REST 헤더) | ✅ Read 검증 | blacklist 의 restHeaders 패턴 확인 |
| A2.F18 (alert/confirm) | A1.F20 과 동일 | ✅ |
| A3.A1 (PlayerInfoResponse) | ✅ grep 검증 | 정의만 + 0 사용 |
| A3.B1 (supabase 청크) | ✅ grep + Read 검증 | blacklist 가 sb. 0 호출 |
| A3.B3 (extras 등록 직렬) | ⚠ 미검증 | 분석가 평가 신뢰 |
| A3.C1 (modal-overlay) | ✅ grep 검증 | 3 페이지 div 패턴 확인 |
| A3.C2 (alert/confirm) | A1.F20 과 동일 | ✅ |
| 기타 A3 finding (A2~A9, B2/B6, C5~C9) | ⚠ 미검증 (시간 제약) | 분석가의 위치 + 코드 인용 신뢰 |

**요약**: 임팩트 큰 finding 12건은 직접 검증 완료. 미검증 항목은 분석가의 위치 정보 + 인용 신뢰. 모든 미검증 finding 도 위치(파일:라인)가 명시되어 있어 PR 작업 시 자연스럽게 검증됨.

---

## Open Questions / 사용자 결정 필요

- **Q1 (P0-4)**: `Access-Control-Allow-Origin: "*"` 가 의도된 production 상태인가? 외부 도메인에서 호출할 일이 있는가?
- **Q2 (P3-17)**: 추가 계정 일괄 갱신 버튼 사용 빈도? 자주 안 쓰면 1명씩 수동 단순화 + 코드 제거.
- **Q3 (P3-9)**: 쿠폰 history 자동 청소 — 트랙 3-2 처럼 "포기 + 수동 정리" vs Edge Function?
- **Q4 (P0-1.1)**: i18n `*.pageDescription` 키 7개 — 향후 `<meta name="description">` 동적 채우기 계획? 있으면 보존, 없으면 삭제.
- **Q5 (P2-4)**: PlayerSearchModal 추출 단위 — Astro 컴포넌트 vs JS 컨트롤러만? **권장: JS 컨트롤러 우선** (마크업 ID 가 CSS/i18n 셀렉터에 박혀있어 swap 비용 큼).
- **Q6 (R10)**: blacklist 의 raw fetch → supabase SDK 통일 — B1-1 의 -200 KB 효과를 상쇄하므로 **권장: reject**. 다른 강한 이유 있으면 알려주세요.
- **Q7 (Phase 3 일반)**: zod 같은 런타임 타입 검증 라이브러리 도입? 22명 규모면 inline validator 가 비용 효율 더 큼 — **권장: defer**.

---

## Phase 별 예상 일정

> 사용자가 "수정 후 커밋까지만 → 로컬 테스트 → 배포 요청" 패턴이라 작은 PR 단위 친화.

| Phase | PR 수 | 예상 작업 시간 (Claude) | 회귀 검증 (사용자) |
|---|---|---|---|
| **Phase 0** (Dead code + dialog) | PR-A, PR-B, (PR-C) | 4~6 시간 | 30분 (페이지별 클릭 회귀) |
| **Phase 1** (lib 추출) | PR-D, PR-E | 1~2 일 | 1 시간 (등록/조회/갱신 회귀) |
| **Phase 2** (책임 분리 + 모달 통합) | PR-F, PR-G, (PR-H) | 3~5 일 | 1~2 시간 (모달 + 등록 + 다이얼로그 회귀) |
| **Phase 3** (타입 + 성능 + UX) | PR-I~PR-K | 2~4 일 | 1~2 시간 (페이지별 + 모바일 confirm) |

총 **약 1~2 주 + 회귀 검증 시간**. Phase 0+1 만 (4~6일) 해도 임팩트 80% 도달 — 본 분석의 가장 강한 항목 (B1-1, P1-1, dead code 정리, 모달 통합) 모두 거기.

---

## 권장 진행 순서

1. **이번 주**: Phase 0 (PR-A → PR-B → PR-C 순서, 각각 검증 후 다음).
2. **다음 주**: Phase 1 (PR-D 우선 → PR-E). PR-D 의 lookupPlayer 가 Phase 2 PlayerSearchModal 의 base.
3. **그다음 주**: Phase 2 (PR-F 책임 분리 → PR-G 모달 통합 → 선택적 PR-H).
4. **여유 있을 때**: Phase 3 (PR-I 타입 → PR-J 쿠폰 데이터 흐름 → PR-K 모바일 UX).

각 Phase 전에 Open Questions 의 해당 항목 (Q1~Q7) 결정.
