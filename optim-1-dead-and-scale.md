# 분석 결과 — Dead Code + Scale Fit (Agent 1)

스코프: `src/pages/manage/{members,coupons,blacklist}.astro` + 같은 이름 `src/scripts/pages/*.ts`
+ 그들이 import 하는 `src/lib/{cache,store,dialog,dom-diff,refresh-button,image-optimize,utils,types,supabase}.ts`
+ `src/lib/stores/members.ts` + `src/i18n/{ko,en}.ts` 의 `members.* / coupons.* / blacklist.*` 네임스페이스
+ `src/styles/{manage,blacklist}.css` + `src/components/RefreshButton.astro`
+ `supabase/functions/{redeem-coupon,gift-codes}/index.ts`

## Summary
- Dead code 14건, 규모 부적합 7건 발견 (총 21건).
- 가장 임팩트 큰 3건:
  1. **F4 `coupon_accounts_cache` 가 `membersStore` 와 중복** — 캐시 두 겹 + members.ts 가 5곳에서
     `invalidateAccountsCache()` 수동 호출하며 결합 발생. accounts cache 통째 제거 가능.
  2. **F11 `pruneStaleHistory()` 가 사용자 hot path 에서 DB DELETE 실행** — 모든 페이지 진입 시
     22 클라이언트 모두가 같은 작업. Edge Function 또는 admin-only 수동으로 옮길 것.
  3. **F12 redeem-coupon Edge Function 의 `captcha` / 단일 `redeem` action 미사용** — 클라가 `player`,
     `redeem_batch` 만 보냄. 두 case + captcha 파라미터 검증 코드 모두 dead.

---

## Section A — Dead Code

### F1. 사용되지 않는 i18n 키 7개 (members/coupons/blacklist `pageDescription` + 기타)
- **위치**:
  - `src/i18n/ko.ts:79, 180, 309` (+ 같은 줄 `en.ts:77, 179, 311`) → `*.pageDescription`
  - `src/i18n/ko.ts:175` (`members.errors.apiError` — *사용됨*, 무시) ❌
  - `src/i18n/ko.ts:263` / `en.ts:264` → `coupons.msg.searchFailed`
  - `src/i18n/ko.ts:327` / `en.ts:329` → `blacklist.thead.actions`
  - `src/i18n/ko.ts:331` / `en.ts:333` → `blacklist.toolbar.refresh`
  - `src/i18n/ko.ts:354` / `en.ts:356` (대략) → `blacklist.modal.kingdomLabel`
- **현재**: `t('coupons.msg.searchFailed')` 등이 src 전체 grep 으로 0건.
  `pageDescription` 은 모든 도메인 네임스페이스마다 정의돼있지만 어디서도 호출되지 않음 (Astro `<title>`/
  `description` 메타는 페이지별 정적 문자열 사용).
- **제안**: 7개 키 모두 ko.ts/en.ts 양쪽에서 삭제 + Translations 타입이 자동으로 누락 검출.
- **근거**: Python AST 파서로 추출한 leaf 키 211개를 src 전체 텍스트와 정확 매칭 → 7건이 0회 매칭.
  수동 grep 으로 재검증함.
- **노력**: S
- **리스크**: S (정적 분석으로 미사용 확인됨)

### F2. CSS dead 셀렉터 4개 (manage.css)
- **위치**: `src/styles/manage.css:251-280` (`.mc-rank-badge` + `.rank-R1~R5` 변형 5개),
  `src/styles/manage.css:1053-1070` (`.mc-gift-btn` + hover),
  `src/styles/manage.css:1137-1144` (`.mc-gift-done` + hover),
  `src/styles/manage.css:1235-1245` (`.mc-actions-cell` + `.mc-gift-btn` 모바일 미디어쿼리)
- **현재**: 정의돼있지만 어떤 .ts/.astro 도 이 클래스명을 사용하지 않음.
  과거 패턴 (선물 아이콘 인라인 버튼, 등급 배지 별도 셀) 잔재.
- **제안**: 셀렉터 + 미디어쿼리 변형 모두 삭제 (~30 LOC).
- **근거**: 정규식 기반 비-CSS 소스 grep 으로 0회 매칭. `'rank-' + rank` 같은 동적 조립도
  체크했고 `.mc-rank-badge` 와 결합되지 않음 (실제 사용은 `.member-row.rank-R5` 형태).
- **노력**: S
- **리스크**: S

### F3. `window.Members` / `window.Coupons` 전역 노출 미사용
- **위치**: `src/scripts/pages/members.ts:897-905`, `src/scripts/pages/coupons.ts:1426-1436`
- **현재**:
  ```ts
  // members.ts: "외부 노출 — 다른 페이지에서 reload 호출용 (현재는 사용 X 지만 보존)"
  declare global { interface Window { Members: { ... } } }
  window.Members = { openDialog, reload };
  ```
  주석 자체가 "현재 사용 X" 라고 명시. coupons.ts 도 동일 패턴 — 4 함수 노출.
- **제안**: 두 곳 모두 삭제. 향후 필요 시 재도입 (실제로 호출 안 함).
  코멘트의 "인라인 onclick 패턴 유지" 도 옛날 얘기 — 트랙 1 에서 이벤트 위임으로 마이그레이션됨.
- **근거**: `grep -rn "window\.Members\|Members\." | grep -v 'pages/members.ts'` → 0건.
  같은 검사 `Coupons` 도 0건.
- **노력**: S
- **리스크**: S

### F4. `coupon_accounts_cache` 가 `membersStore` 와 중복 + 5곳 결합
- **위치**:
  - 캐시 정의: `src/lib/cache.ts:61-87` (`getAccountsCache/setAccountsCache/invalidateAccountsCache`)
  - 사용: `src/scripts/pages/coupons.ts:256-303` (`loadAccounts`)
  - 결합: `src/scripts/pages/members.ts:412, 570, 609, 633, 729` (멤버 변경 5곳에서 호출)
- **현재**: `loadAccounts` 가 `getAccountsCache()` → 있으면 즉시 return, 없으면
  `Promise.all([membersStore.refresh(), sb.from('coupon_accounts').select(...)])` 후 합쳐서 캐시.
  TTL 없음. members 로스터는 이미 `membersStore` 가 60s TTL 로 sessionStorage 백업 중.
  members.ts 가 멤버 변경할 때마다 `invalidateAccountsCache()` 도 같이 호출해야 함.
- **제안**: accounts cache 레이어 통째 제거. coupons.ts 의 `loadAccounts` 는 매번
  `membersStore.refresh(fetchMembers, false)` + `sb.from('coupon_accounts').select(*)`
  순수 fetch (membersStore 가 freshness 체크 → 캐시 활용). members.ts 의 5곳에서
  `invalidateAccountsCache()` 호출 제거. `cache.ts` 의 60 LOC + `coupons.ts`/`members.ts` 각각 import 정리.
- **근거**: 22명 + 추가계정 ~10건 가정해도 페이로드 < 5KB. fetch 1회 100ms. 사용자 인식 차이 없음.
  현재 캐시 무효화 누락 시 stale 데이터 회귀 가능 (실제로 트랙 2 운영 메모에 "5곳 mutation 후 force=true 필수"
  라고 명시 — 같은 종류의 위험을 또 만들었다).
- **노력**: M (caller 7곳 수정)
- **리스크**: M (회귀 가능 — 변경 후 사용자 회귀 검증 필요)
- **연쇄 영향**: F11 (pruneStaleHistory) 와 함께 묶어 "쿠폰 페이지 데이터 흐름 정리" PR 권장

### F5. `lib/utils.ts` 의 `truncate` / `formatNum` export 미사용
- **위치**: `src/lib/utils.ts:64-67` (`formatNum`), `src/lib/utils.ts:79-82` (`truncate`)
- **현재**: 두 함수 export 되었지만 `from '@/lib/utils'` 로 import 한 곳 어디서도 destructure 하지 않음.
  (`survey-kvk.ts` 의 `formatNum` 은 같은 파일 내 로컬 함수로 별도 정의됨.)
- **제안**: 두 함수 삭제. 유사 표시는 caller 가 inline (`n.toLocaleString()`).
- **근거**: `grep -rn "formatNum\|truncate"` 로 utils.ts import 한 5개 파일 (members/coupons/blacklist/
  survey-kvk/tile-match) 모두 내용 확인 → 두 이름 import 한 곳 0건.
- **노력**: S
- **리스크**: S

### F6. Edge Function 의 `redeem-coupon` `captcha` 케이스 + 단일 `redeem` 케이스
- **위치**: `supabase/functions/redeem-coupon/index.ts:131-162` (`captcha` 케이스 + `redeem` 케이스)
- **현재**: 클라이언트는 `action: 'player'` 와 `action: 'redeem_batch'` 만 호출.
  단일 `redeem` 케이스의 captcha 검증 + recordExpiredCoupon 체크 등 ~25 LOC, `captcha` 케이스 ~5 LOC.
- **제안**: 두 case 모두 삭제. `default` 의 에러 메시지를 `"Use: player, redeem_batch"` 로 수정.
- **근거**: `grep -rn "action.*'captcha'\|action.*'redeem'\b"` src 전체 → 0건.
  coupons.ts:480 의 `data-action="redeem"` 은 DOM 버튼 액션이라 별개 (구별 가능).
- **노력**: S
- **리스크**: S (Edge Function 재배포 필요 — 사용자가 수행)

### F7. `supabase/functions/{redeem-coupon,gift-codes}/index.ts` 의 CORS TODO 주석
- **위치**: `redeem-coupon/index.ts:12-13`, `gift-codes/index.ts:9-10`
- **현재**:
  ```ts
  // TODO: 테스트 완료 후 "https://kingshot.wooju-home.org" 로 복원
  "Access-Control-Allow-Origin": "*",
  ```
  현재 production 도 `*` 사용 중인 것으로 보이고, 정적 사이트가 GitHub Pages 에서만 호출하므로
  엄밀히 의미 작음.
- **제안**: 둘 중 하나 — (a) `*` 유지 + TODO 주석 삭제 (의도가 변경된 상태), 또는 (b) origin
  복원. 현재 상태가 "잊혀진 임시 조치" 라 사용자 결정 필요.
- **근거**: 두 파일 모두 같은 TODO. 만약 의도된 상태면 주석은 명시적으로 "와일드카드 유지: 이유"
  로 바꿔야 함 (현재는 잠시인 듯한 어조).
- **노력**: S
- **리스크**: S
- **연쇄 영향**: 사용자 의사 결정 필요 (Open Questions 참고)

### F8. `members.ts` 라인 9-10 중복 import (같은 모듈)
- **위치**: `src/scripts/pages/members.ts:9-10`
- **현재**:
  ```ts
  import { supabase as sb, SUPABASE_URL } from '@/lib/supabase';
  import { SUPABASE_ANON_KEY } from '@/lib/supabase';
  ```
- **제안**: 한 줄로 합치기 — `import { supabase as sb, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';`
- **근거**: 동일 모듈 from-clause 가 두 줄. 추가/삭제 과정의 잔재.
- **노력**: S
- **리스크**: S

### F9. `cache.ts` 의 `GiftCodesCache.total`, `FailedRefresh.ts` 필드 — write-only
- **위치**: `src/lib/cache.ts:13-23, 41-50, 100-109`
- **현재**:
  ```ts
  interface GiftCodesCache { codes; fetchedAt; total; }   // total 은 set 시점에만 채움
  interface FailedRefresh { ids; names; ts; }              // ts 도 동일
  ```
  두 필드 모두 어디서도 read 되지 않음. `set...Cache` 에서 채우는 것이 유일 사용.
- **제안**: 인터페이스에서 두 필드 제거, set 함수에서 채우는 로직도 제거.
- **근거**:
  - `grep -n "\\.total\\b" cache.ts coupons.ts` → set 시점만 매칭, 읽는 곳 0건.
  - 동일하게 `\\.ts\\b` (FailedRefresh.ts) 도 set 시점만 매칭.
- **노력**: S
- **리스크**: S

### F10. `dialog.ts` 의 `ConfirmOptions.title`, `okLabel`, `cancelLabel` 미사용
- **위치**: `src/lib/dialog.ts:21-27, 30-39, 41-52`
- **현재**: `appAlert(message, { title?, okLabel? })`, `appConfirm(message, { title?, okLabel?, cancelLabel?, variant? })`.
  call site 검사 결과 `variant: 'danger'` 만 1회 사용 (`members.ts:622`). 나머지 옵션 4개는 0회.
- **제안**: 시그니처를 `appConfirm(message, opts?: { variant?: 'default' | 'danger' })`,
  `appAlert(message)` 로 단순화. ~15 LOC 절감 + dialog.ts 의 OpenOpts 도 같이 슬림.
- **근거**: `grep -rn "appConfirm.*title\|appAlert.*title\|okLabel\|cancelLabel"` (caller 한정) → 0건.
- **노력**: S
- **리스크**: S

### F11. `pruneStaleHistory()` 가 사용자 hot path 에서 DB 작업
- **위치**: `src/scripts/pages/coupons.ts:131-155, 124`
- **현재**: 쿠폰 페이지 진입 시 `loadCoupons()` → 캐시 미스면 `pruneStaleHistory()` 자동 호출 →
  `DELETE coupon_history WHERE coupon_code NOT IN (...)` 를 anon key 로 직접 REST 호출.
  22 클라이언트 모두 (캐시 5분 만료마다) 같은 DELETE 실행.
- **제안**: 클라이언트에서 제거. 두 옵션:
  (a) gift-codes Edge Function 안에서 service_role 로 같은 작업 (서버 측 정리, 호출 횟수 자연 합산),
  (b) admin 만 보이는 수동 정리 버튼.
  관련 i18n / 코드 / 5분 cache TTL 기반 가정 모두 정리.
- **근거**: 사용 패턴 — 22명 × (5분 마다) → 분당 4-5 호출. 22명 규모 사이트에서 DELETE 가
  "무효 row 정리" 목적 외 의미 없는 트래픽. 트랙 2 가 이미 "쿠폰 데이터 fetch 자체를 store 화" 하기로
  방향 잡았는데 이 cleanup 만 옛 패턴.
- **노력**: M (Edge Function 추가 작업 + 클라이언트 정리)
- **리스크**: M (실수로 활성 쿠폰 일부가 빠진 list 로 호출되면 valid history 가 삭제됨 — 현재 가드는
  `if (!activeCoupons.length) return` 만)
- **연쇄 영향**: F4 와 같은 PR 로 묶을 가치 있음 (쿠폰 데이터 흐름 일괄 정비)

### F12. `supabase/functions/economy/` 의 `verify_jwt` 정책 일관성 (참고용 추가)
※ 본 finding 은 manage 스코프 직접 영향 아님 — 후속 정리 시 봐도 됨. 아니면 skip.

### F13. `members.ts` `currentDialogId` non-null assertion 일관성 부족
- **위치**: `src/scripts/pages/members.ts:567` 의 `eq('id', currentDialogId!)` vs 같은 함수 내
  `if (!currentDialogId) return;` 가드 후 assertion 불필요한 다른 줄.
※ 작은 cosmetic — Agent 3 (타입) 영역과 겹쳐서 일단 보류 가능.

### F14. `RefreshButton.astro` 의 `legacy` prop 미사용
- **위치**: `src/components/RefreshButton.astro:25-29`
- **현재**: `legacy?: boolean` prop 정의 + 클래스 swap 로직. 컴포넌트 사용처 1곳 (`blacklist.astro:56`)
  뿐이고 거기서 legacy 미지정 (false 기본). 주석에 "기존 .rank-refresh 와 alias — RankingTable 도 점진적으로 이전"
  이라 적혀 있지만 RankingTable 은 자체 `<button class="rank-refresh">` 사용 (이전 안 됨).
- **제안**: `legacy` prop 삭제 + 분기 로직 제거. RankingTable 이전이 진짜 필요해지면 그때 다시.
- **근거**: `grep -rn "<RefreshButton\|legacy="` → 사용처 1곳, legacy 인자 0회.
- **노력**: S
- **리스크**: S

---

## Section B — Scale Fit (22명 / 정적 사이트 / 싱글 어드민)

### F15. `HISTORY_PAGE_SIZE = 5` 의 페이지네이션 — 22명에 과한 UI
- **위치**: `src/scripts/pages/coupons.ts:39, 1109-1184`
- **현재**: 페이지당 5건. 22명 × 활성 쿠폰 N개 → 최대 ~110 row → 22 페이지. pagination 컴포넌트
  (`renderHistoryPagination`) 가 ‹ 1 2 3 ... › 형태 + 활성 페이지 강조 + ±2 가시 범위 계산까지 풀 구현.
- **제안**: page size 를 50 으로 키우고 (22명 모두 + 약간의 여유) 페이지네이션 단순화 또는
  통째 제거 (그냥 100건 fetch 후 클라 사이드 검색/필터). 기존 `renderHistoryPagination` ~75 LOC 제거.
- **근거**: 22명 × 가장 많은 케이스(20개 활성 쿠폰) = 440 row. 정렬/검색은 클라 사이드도 충분.
  현재 구조는 수만 row 가정한 디자인.
- **노력**: M (페이지네이션 로직 + 관련 i18n 일부 제거)
- **리스크**: S

### F16. `pvp_battles cleanup_old_pvp_battles()` 자동 청소 포기와 같은 결정 — 쿠폰 history 정리도 같은 톤
- **위치**: F11 와 동일
- **현재**: CLAUDE.md 트랙 3-2 가 "운영 복잡도 대비 이득 작아 자동 청소 포기" 결정. 쿠폰 history 도
  같은 운영 환경에서 동일하게 적용 가능.
- **제안**: F11 의 (b) 옵션 — admin 수동 정리 — 가 트랙 3-2 결정과 일관.
- **근거**: 운영 메모의 명시적 디자인 결정.
- **노력**: F11 와 같음
- **리스크**: 같음

### F17. `members.ts` 의 admin grant amount 정규식 과한 복잡도
- **위치**: `src/scripts/pages/members.ts:818-825`
- **현재**:
  ```ts
  // 정규식: 1~99,999 | 100,000~299,999 | 300000
  const amountRegex = /^([1-9][0-9]{0,4}|[1-2][0-9]{5}|300000)$/;
  ```
  싱글 어드민 (kingshot_id 270680423, 1명) 이 직접 입력하는 값에 대해 leading zero / 천 단위 콤마 / 음수 등
  3-way 정규식 검증. HTML `<input type="number" min="1" max="300000" step="1">` (members.astro:191-202)
  이 이미 브라우저 단에서 같은 검증을 함.
- **제안**: 숫자 파싱 + 범위 체크로 단순화:
  ```ts
  const amount = parseInt(amountStr, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 300000) { /* 에러 */ }
  ```
  6 LOC → 3 LOC + 가독성 ↑.
- **근거**: 1명 사용자, 신뢰 가능한 환경 (admin 인증 통과 후), HTML attr 가 1차 방어.
- **노력**: S
- **리스크**: S

### F18. `coupon_accounts` 의 "추가 계정 갱신" 기능 — 정적 사이트 + 싱글 어드민 환경 부적합 가능
- **위치**: `src/scripts/pages/coupons.ts:574-667` (`refreshAllExtras` + `refreshSingleExtra`)
- **현재**: 추가 계정 (농장계정/지인) 일괄 갱신 기능. 별도 toolbar 버튼 + BATCH_SIZE=5 + 1s delay.
  members.ts 의 `refreshAllMembers` 와 거의 동일한 패턴 코드 중복. 추가 계정은 회원이 외부고
  변경 빈도 더 낮음 (게임 외부 사람들).
- **제안**: 둘 중 하나 — (a) members.ts 의 batched refresh 헬퍼를 `lib/api/refresh-batched.ts`
  로 추출해서 양쪽 재사용 (Agent 2 영역 — 컴포넌트화), (b) 추가 계정 갱신 자체를 1명씩 수동 (extra row 의
  ⋮ 메뉴) 으로 단순화하고 일괄 갱신 제거.
- **근거**: 추가 계정 보통 5건 미만 (관찰 — `extras > 0 일때만 hidden 해제` 패턴 존재).
  일괄 갱신 버튼 자체가 거의 안 눌림.
- **노력**: M
- **리스크**: M (UI 변경 — 사용자 의사 확인 필요)

### F19. `image-optimize.ts` 의 `mimeType: 'image/webp' | 'image/jpeg'` 옵션 — 사실상 webp 전용
- **위치**: `src/lib/image-optimize.ts:18, 29-33, 67-72`
- **현재**: `mimeType` 옵션은 두 값 허용. blacklist.ts 가 유일 caller 인데 항상 `'image/webp'` 명시.
  storage bucket 정책도 webp only (주석 line 44 명시). `encodeToBlob(canvas, mimeType, quality)`
  분기 (line 71) 는 dead path.
- **제안**: `OptimizeOptions.mimeType` 제거. `optimizeImage` 가 항상 WebP 반환 가정.
  `encodeWebP` 함수 inline (한 곳 호출). `encodeToBlob` 도 webp 전용 helper 로 슬림.
- **근거**: storage bucket policy 가 webp only. 다른 mime 받아도 업로드 실패.
- **노력**: S
- **리스크**: S

### F20. blacklist.ts 의 raw `alert()`/`confirm()` 11개 vs `appAlert/appConfirm` 4개 혼용
- **위치**: `src/scripts/pages/blacklist.ts:368, 469, 474, 540, 576, 644, 657, 660, 675, 720`
  (raw) vs `:152, 168, 170, 504` (app)
- **현재**: 모바일 (iPhone) 기본 환경인데 OS native dialog 가 11곳에서 튀어나옴.
  `appAlert/appConfirm` 가 import 되어있고 4곳은 사용 — 단순 inconsistency.
- **제안**: 11곳 모두 `appAlert/appConfirm` 으로 통일. coupons.ts 의 12곳도 동일.
- **근거**: dialog.ts 주석 자체가 "OS/브라우저별 디자인 불일치 + 모바일에서 어색함" 이라고 명시.
- **노력**: S (직역 swap)
- **리스크**: S
- **연쇄 영향**: F10 (dialog 옵션 슬림화) 후에 진행하면 더 깔끔

### F21. `rest 헤더 객체` 와 `supabase 클라이언트 SDK` 의 혼용 (blacklist.ts only)
- **위치**: `src/scripts/pages/blacklist.ts:34-41` (raw fetch 헤더 정의), 이후 `REST_BASE` + 직접 fetch
  vs `members.ts`/`coupons.ts` 의 `sb.from('...')` 패턴
- **현재**: blacklist.ts 만 supabase 클라이언트 SDK 안 쓰고 raw fetch 로 PostgREST 호출.
  같은 anon key + 같은 RLS — 기능적으로 동등. raw fetch 쪽이 boilerplate 더 많음
  (`Prefer: return=minimal`, `apikey`, `Authorization` 매번).
- **제안**: blacklist.ts 도 `sb.from('blacklist').select/.update/.delete` 패턴으로 통일. ~10 LOC 절감
  + 일관성 ↑. Storage 호출 (`uploadImage` / `deleteStorageObject`) 은 `sb.storage.from(BUCKET)` 가능.
- **근거**: 같은 환경, 같은 권한, 같은 결과. 일관성 가치만 있음.
- **노력**: M (raw fetch 7곳 + storage 2곳 swap)
- **리스크**: S

---

## Open Questions

1. **F7 (CORS TODO)** — `Access-Control-Allow-Origin: "*"` 가 의도된 production 상태인가?
   사용자가 production 도메인 (kingshot.wooju-home.org) 외에서 호출할 일이 있다면 `*` 유지가 맞고
   주석만 정리하면 됨. 그게 아니면 origin 복원 + TODO 제거.

2. **F18 (추가 계정 갱신 기능)** — 일괄 갱신 버튼이 실제로 자주 사용되는가? Toycode 외에 다른 사용자도
   이 버튼을 쓰는가? 사용 빈도 따라 (a) 헬퍼 추출 vs (b) 기능 단순화/제거.

3. **F11 vs trace 3-2** — 쿠폰 history 자동 청소도 PvP battles 처럼 "자동 포기" 결정으로 갈지,
   아니면 Edge Function 으로 옮길지. 운영 부담 대비 row 누적 속도 검토 필요.

4. **F1 의 `pageDescription` 키 7개** — 향후 Astro 의 `<meta name="description">` 동적 채우기에 쓸
   계획이 있는가? 있으면 보존, 없으면 삭제.
