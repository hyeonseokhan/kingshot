# 분석 결과 — Type Safety + Performance + UX (Agent 3)

스코프: `/manage/{members,coupons,blacklist}` 3 페이지 + `src/lib/{store,dom-diff,dialog,image-optimize,cache,types}.ts` + 빌드 결과 `dist/_astro/*.js`. 빌드는 `npm run build` 1.25 s, astro check pass.

## Summary

- 타입 9건, 성능 7건, UX/A11y 9건 — 총 25 finding.
- **가장 임팩트 큰 3건**:
  - **B1 (성능)**: blacklist.ts 가 상수 2개 (`SUPABASE_URL` / `SUPABASE_ANON_KEY`) import 만으로 **supabase 청크 203 KB** 를 강제 다운로드. 모듈 분리만으로 블랙리스트 페이지 -200 KB.
  - **C1 (UX/A11y)**: members/coupons 의 `<div class="modal-overlay">` 는 native `<dialog>` 가 아님 → ESC 닫힘 / focus trap / inert background 모두 부재. blacklist 의 `<dialog>` 와 일관성 없음.
  - **A1 (Type)**: `centurygame` API 응답을 `json: any` 로 받고 `json.code !== 0 || !json.data` 같은 ad-hoc 체크가 5 곳 산재. `PlayerInfoResponse` 타입은 이미 정의돼 있는데 사용처 0건.

---

## Section A — Type Safety

### F1. centurygame `player` API 응답 — 정의된 `PlayerInfoResponse` 타입 미사용
- **위치**: `src/scripts/pages/members.ts:64-79`, `coupons.ts:643-654, 1294-1303`, `blacklist.ts:186-198, 489-498`, `coupons.ts:716-731` (5곳)
- **현재**: `.then((json) => { if (json.code !== 0 || !json.data) ... })` 의 `json` 이 implicit any. `json.data.fid`, `json.data.stove_lv` 등을 그냥 dot access. `src/lib/types.ts:45-56` 에 `PlayerInfoResponse` 타입이 이미 있는데 어디서도 사용 안 함.
- **위험**: 외부 API 가 schema 깨지면 (예: `data: null` 대신 `data: {}` 빈 객체) `String(undefined).fid → "undefined"` 같은 나쁜 값이 silent 통과 → DB 에 `nickname: undefined` 저장 가능. members.ts:73 `String(json.data.fid)` 도 fid 가 number 로 와도 문자열 ID 로 변환되는 의도지만, 음수/빈 문자열일 때 검증 없음.
- **제안**: 단일 헬퍼 `lookupPlayer(id: string): Promise<PlayerLookup>` 를 `src/lib/api/centurygame.ts` 에 두고 `PlayerInfoResponse` 로 narrow + null 검증 (fid 가 truthy 인지 등). 5 호출처가 모두 같은 변환 로직 (nickname/avatar/level/kingdom) 을 복붙하고 있어 추출 가치 큼 (Agent 2 영역과 일부 겹침 — 본 finding 은 타입 안전성 측면).
- **노력**: M | **리스크**: S | **연쇄**: F2/F8 와 함께 처리 가능.

### F2. members.ts:75 `level` 폴백 우선순위가 page 마다 다름
- **위치**: members.ts:75 (`stove_lv || stove_lv_content || 0`), coupons.ts:651 (`stove_lv || 0`), coupons.ts:1300 (`stove_lv || 0`), blacklist.ts:194/497 (`stove_lv ?? stove_lv_content`)
- **현재**: 같은 API 의 같은 필드를 4 곳에서 4 가지 방식으로 처리. coupons.ts 는 `stove_lv_content` 폴백 자체가 없음 → API 가 `stove_lv` 빠뜨리면 0 으로 저장돼 버려 회원/extra 등록 시 레벨 손실.
- **위험**: silent 데이터 품질 저하 (level=0 인 row 가 끼어듬).
- **제안**: F1 의 헬퍼로 통일. `||` 와 `??` 혼용 (0 이 falsy 인 점) 검증.
- **노력**: S | **리스크**: S

### F3. coupons.ts:282-291 — `Array<Record<string, unknown>>` cast 후 모든 필드 `as string`
- **위치**: `src/scripts/pages/coupons.ts:282-291`
- **현재**: `(results[1].data as Array<Record<string, unknown>>).forEach((a) => { id: a.id as string, kingshot_id: a.kingshot_id as string, ... level: (a.level as number) ?? null })`
- **위험**: 7 개 필드 모두 unsafe cast. supabase typed client 를 안 쓰는 이유는 빠르게 이식했기 때문 (코드 주석). `null` 대비 ?? 가 있긴 하지만 type 자체가 거짓말 (number 라고 단언하고 그 다음 `?? null` 로 nullable 처리 → 모순).
- **제안**: `CouponAccount` 타입 (`src/lib/types.ts:23-30`) 을 generic 으로 `from<CouponAccount>('coupon_accounts').select('*')` — `@supabase/supabase-js` v2 가 generic 지원. 또는 한 번의 mapper 함수에서 unknown → typed 좁히기.
- **노력**: S | **리스크**: S

### F4. blacklist.ts:131 — REST API 응답을 `BlacklistEntry[]` 로 무검증 cast
- **위치**: `src/scripts/pages/blacklist.ts:131`
- **현재**: `.then((rows: BlacklistEntry[]) => { entries = Array.isArray(rows) ? rows : []; })` — `Array.isArray` 만 체크하고 각 row 의 필드 검증 없음. 만약 PostgREST 가 에러를 객체 형태로 돌려줄 경우 (`{ code, message, hint }` 등) Array 가 아니라 빈 array 로 fall through 하지만, supabase REST 가 row level 에러를 다른 shape 로 보내는 케이스는 없는지 확인 필요.
- **제안**: 서버 응답 status 체크 (`r.ok`) 를 추가 → 4xx/5xx 면 throw. 현재는 r.json() 을 무조건 파싱.
- **노력**: S | **리스크**: S

### F5. members.ts:831 `(crypto as Crypto & { randomUUID?: () => string })` 우회 패턴
- **위치**: `src/scripts/pages/members.ts:831-833`
- **현재**: `crypto.randomUUID` 가 미지원 환경 fallback 위해 type cast + 옵셔널 체크. 대상 사이트 (iOS Safari 16+, 모든 모던 브라우저) 가 `randomUUID` 지원 (Safari 15.4+ 부터 정식 지원). 폴백 자체는 좋지만 cast 가 lib.dom 타입 정의가 옛날이라 그렇다는 의미.
- **제안**: `tsconfig` lib 가 ES2022+ 면 `Crypto` 인터페이스에 `randomUUID(): string` 이 이미 정의됨. 확인 후 cast 제거 가능. 또는 `'randomUUID' in crypto` in-guard 로 type narrowing.
- **노력**: S | **리스크**: S

### F6. blacklist.ts:81 `$<T>` 가 `T | null` 반환 → 호출처마다 `!` 또는 `as HTMLElement`
- **위치**: `blacklist.ts:81` 정의, 호출처 25곳 (line 396/406/425/426/427/481/509 등)
- **현재**: `const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;` 후 거의 모든 호출이 `($('xxx') as HTMLElement).style.display = ''` 또는 `$('xxx')!.value = ...`. 타입 안전 의도였지만 사용 측에서 모두 우회.
- **제안**: members.ts:50 의 `$<T>` (throw on missing) 패턴과 일관. 페이지 진입 시 마크업 확정이라 throw 가 의미 있는 fail-fast. 또는 `$req`/`$opt` 두 변형 분리.
- **노력**: S | **리스크**: S

### F7. coupons.ts:658-660 — Supabase update 응답 narrowing 우회
- **위치**: `src/scripts/pages/coupons.ts:658-660`
- **현재**:
  ```ts
  if (res && (res as { error?: { message: string } }).error) {
    throw new Error((res as { error: { message: string } }).error.message);
  }
  ```
  같은 cast 가 두 번 반복. supabase-js 의 update 응답은 `{ data, error, status, ... }` 형태로 이미 typed 됨.
- **제안**: 미사용 cast 제거 — `if (res.error) throw new Error(res.error.message)` 면 충분. members.ts:430 패턴.
- **노력**: S | **리스크**: S

### F8. members.ts:715 / coupons.ts:1351 — duplicate 감지가 string includes
- **위치**: members.ts:715-716, coupons.ts:1351-1354
- **현재**: `if (res.error.message.indexOf('duplicate') !== -1 || res.error.message.indexOf('unique') !== -1)` — Postgres 에러 메시지 본문을 substring 매칭.
- **위험**: locale 변경 / supabase-js 버전 업데이트로 메시지 포맷 바뀌면 falsethrough → "저장 실패" generic 이 노출. supabase 는 `error.code` 로 PostgreSQL SQLSTATE (예: `23505 unique_violation`) 를 노출함.
- **제안**: `res.error.code === '23505'` 로 분기. 부수적으로 discriminated union (`type SaveResult = { ok: true } | { ok: false; reason: 'duplicate' | 'other'; message: string }`) 로 wrapping.
- **노력**: S | **리스크**: S

### F9. members.ts:763 `AdminGrantResp` 정의돼 있는데 다른 Edge Function 응답은 untyped
- **위치**: members.ts:855 `r.json() as Promise<AdminGrantResp>` 만 typed. 반면 coupons.ts:730 (`RedeemBatchResponse`) 도 typed. 그러나 gift-codes 응답 (coupons.ts:117-122) 은 untyped.
- **현재**: `if (json.status === 'success' && json.data)` 체크 후 `json.data.giftCodes || []` 를 그대로 cast.
- **제안**: 해당 함수도 `interface GiftCodesResponse { status: 'success' | 'error'; data?: { giftCodes: ActiveCoupon[] } }` 추가. types.ts 에 모든 Edge Function 응답을 한 곳에 모으면 후속 schema validation 도입(zod 등) 시 한 점에서 집행.
- **노력**: S | **리스크**: S | **연쇄**: F1 와 함께 묶음.

---

## Section B — Performance

### B1. blacklist.ts 가 상수 2개를 위해 supabase 청크 203 KB 동반 다운로드 ⭐
- **위치**: `src/scripts/pages/blacklist.ts:15` (`import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase'`), `src/lib/supabase.ts:12` (`export const supabase = createClient(...)` — 모듈 로드 즉시 실행)
- **측정**:
  - blacklist 페이지 chunk import 그래프: `blacklist.OQb1WTFt.js (14.4 KB) → supabase.DQaduQ27.js (203 KB) + index.DvGHqQdd.js (46 KB) + tile-match-auth.CLk2Omqn.js (5.7 KB)` (dist/_astro/blacklist 의 `__vite__mapDeps` 헤더로 확인)
  - blacklist 는 코드 전체에서 `sb.from(...)` 를 한 번도 안 부름 (전부 `fetch(REST_BASE+'/rest/v1/blacklist...')` 직접). 즉 supabase client 0 사용.
- **제안**: `src/lib/supabase.ts` 를 두 개로 split:
  - `src/lib/supabase-config.ts` — `SUPABASE_URL`, `SUPABASE_ANON_KEY` 상수만 (1 KB 미만)
  - `src/lib/supabase.ts` — `createClient` 호출 + supabase client export (현재대로)
  - blacklist.ts 는 config 만 import.
  - 같은 패턴이 `LoginedUserInfo` (3.8 KB) 등 supabase client 안 쓰는 컴포넌트에도 도움. coupons/members 는 client 쓰니까 변화 없음.
- **예상 효과**: blacklist 페이지 첫 진입 JS 다운로드 **220 KB → 17 KB (≈ -92%)**. 모바일 4G 로 예상 -300 ms 단축. parseHTML/eval 비용도 감소.
- **노력**: S | **리스크**: S | **연쇄**: 같은 split 으로 트랙 2 의 store 독립성 제고.

### B2. members 등록 후 `coupon_accounts.delete().eq('kingshot_id', ...)` — 매 등록마다 1 SQL
- **위치**: `members.ts:725-733`
- **현재**: 회원 신규 INSERT 성공 후 무조건 `coupon_accounts` 에서 같은 ID 가 있는지 모르는 채로 DELETE. 99% 케이스에서 0 row affected (삭제 대상 없음). 깨끗한 코드지만 N+1 까지는 아니어도 *불필요한 round-trip*.
- **제안**: 등록 모달의 "조회" 단계에서 이미 `members + coupon_accounts` 양쪽을 one-shot 로 체크 → 결과 UI 에 "기존 추가 계정으로 등록되어 있어요. 회원 등록 시 이전 계정은 자동 삭제됩니다" 안내. 또는 SQL trigger 로 server side 처리 (복잡도↑). 가장 단순한 fix: `select` 로 존재 확인 후 있을 때만 delete (round-trip 1→1 최악, 평균 1).
- **예상 효과**: 회원 1명 등록당 1 round-trip 절약 (대량 등록 시).
- **노력**: S | **리스크**: S

### B3. coupons.ts:1330-1366 — extras 등록 시 `members select → coupon_accounts insert` 직렬
- **위치**: `coupons.ts:1330-1367`
- **현재**: `sb.from('members').select(...).eq('kingshot_id', data.kingshot_id)` 후 `.then` 안에서 다시 `sb.from('coupon_accounts').insert(...)`. 두 query 직렬 → 약 2× DB latency.
- **제안**: `members` 중복 체크는 클라이언트에서 `membersStore.get()` (이미 store 있음) 로 즉시 확인 가능. `kingshot_id` lookup 0 round-trip. `coupon_accounts` insert 만 진행.
- **예상 효과**: extras 등록당 -1 round-trip (서버 ~150 ms). 트랙 2 의 store 활용 누락 사례.
- **노력**: S | **리스크**: S | **연쇄**: B5 와 같은 패턴.

### B4. coupons.ts `getAccountsCache()` — TTL 없음 (영구)
- **위치**: `src/lib/cache.ts:63-69`, 사용처 `coupons.ts:257-262`
- **현재**: `getAccountsCache()` 가 sessionStorage 에 저장된 `RedeemAccount[]` 를 ts/만료 검사 없이 무조건 반환. invalidate 호출되기 전까지 영구 cache. 같은 프로젝트의 `gift_codes_cache` 는 만료 코드 자동 무효화 (cache.ts:34) 가 있는데 accounts 는 없음.
- **위험**: 다른 페이지 (members 페이지) 에서 회원 추가/삭제 후 invalidate 호출 빠뜨린 경로 있으면 coupons 가 stale. members.ts 에서는 5 곳 모두 `invalidateAccountsCache()` 호출 잘 되어있어 현재 안전하지만, future 회귀 위험.
- **제안**: TTL 부여 (예: 5분, 다른 cache 와 동일) 또는 `membersStore` 처럼 `createStore<RedeemAccount[]>({ ttlMs: 60_000 })` 화 (트랙 2 의 후속 영역으로 CLAUDE.md 에 이미 명시).
- **노력**: S | **리스크**: S

### B5. blacklist.ts 의 player 갱신 — extras 갱신과 동일 코드 3중 중복
- **위치**: blacklist.ts:176-209 (`refreshSingleEntry`), coupons.ts:633-667 (`refreshSingleExtra`), members.ts:417-440 (`refreshSingleMember`)
- **현재**: 3개 페이지가 같은 패턴 (centurygame `player` API → DB UPDATE) 을 각자 구현. 5명 batch + 1s delay 도 동일. 코드 중복 외에 각 페이지가 5개씩 묶고 1s 쉼 → 페이지 간 묶지는 못해도 적어도 함수 1개로 통합 가능.
- **제안**: `src/lib/api/refresh-player.ts` 에 통합. (Agent 2 영역과 겹침 — 본 finding 은 N+1 fetch 제거가 아니라 일관성 + future 변경 단일 점 측면).
- **노력**: M | **리스크**: S

### B6. coupons.ts:1188-1196 — 페이지 진입 시 `loadCoupons → loadAccounts → loadHistory` 직렬 chain
- **위치**: `coupons.ts:initPage`
- **현재**: 콜백 chain 으로 3개 fetch 가 직렬 (1초 가량 직렬). loadCoupons 는 gift-codes Edge Function (300+ ms), loadAccounts 는 members store + coupon_accounts (300 ms), loadHistory 는 coupon_history (200 ms). 합 ~800 ms.
- **제약**: loadHistory 는 loadCoupons 결과 (active codes 목록) 가 필요. 그러나 loadAccounts 는 둘 다와 무관 → loadCoupons 와 병렬 가능.
- **제안**: `Promise.all([loadCouponsP(), loadAccountsP()]).then(() => loadHistoryP()).then(() => { renderAccounts(); checkAutoRedeem(); })` 형태로 loadAccounts 를 loadCoupons 와 병렬화.
- **예상 효과**: 첫 페인트 ~300 ms 단축 (모바일 회선).
- **노력**: S | **리스크**: M (callback hell 을 Promise 화 하는 ripple — 함수 시그니처 변경)

### B7. members.ts 의 검색 input — debounce 없음, 22명 규모라 OK
- **위치**: members.ts:528-531
- **현재**: 키 입력마다 `renderMembers()` 호출 (전체 정렬+필터+patchList). 22명이라 0.5 ms 미만이지만 100명 이상 데이터가 들어오면 keystroke 마다 sort+render 로 과해질 수 있음.
- **제안**: 현재 22명 이라 change 불필요. CLAUDE.md 가 22명 규모라 명시. **defer 권장** — 멤버 100명 넘으면 그때.
- **노력**: S | **리스크**: S — **현재는 false alarm, defer**

---

## Section C — UX / Error / A11y

### C1. members/coupons 의 모달 = `<div class="modal-overlay">` (native dialog 아님) ⭐
- **위치**: members.astro:44, 124, coupons.astro:43, 147 / blacklist.astro:80 (등록 모달도 동일하게 `<div>`)
- **현재**: `<div class="modal-overlay">` 위에 `<div class="modal">` 구조. JS 가 `.classList.add('open')` 로 표시. `<dialog>` 가 아니라:
  - **ESC 닫힘 X** (members.ts:744-750 이 별도 keydown listener 로 .open 토글, blacklist.ts 는 ESC 처리 자체 없음 — modal-overlay 에)
  - **focus trap X** — Tab 으로 background 로 탈출
  - **inert background X** — 스크린리더가 뒤 콘텐츠도 읽음
  - **role/aria-modal 부재** — `aria-modal="true"` 마크업 없음
- **사용자 영향**: 키보드 only / 스크린리더 사용자가 모달 안에 갇히지 못하고 background 와 섞임. 스마트폰의 외부 keyboard 사용자 (iPad+키보드) 도.
- **제안**: 같은 페이지 내 grant-dialog 와 history-dialog 일부는 이미 `<dialog>` 사용 중 — 패턴 일관성. 본 modal-overlay 도 native `<dialog>` 로 통일 (members 등록 모달, coupons 계정 등록, blacklist 등록/수정). 약 4 곳.
- **노력**: M | **리스크**: M (CSS overlay 스타일 → ::backdrop 으로 마이그레이션, .open class 토글 → showModal/close)

### C2. `alert()` / `confirm()` 잔존 — appAlert/appConfirm 와 혼용 ⭐
- **위치 (총 14곳)**: blacklist.ts:368, 469, 474, 540, 576, 644, 657, 660, 675, 720; coupons.ts:577, 580, 620, 622, 679, 685, 699, 814, 978, 1338, 1355, 1357
- **현재**: members.ts 는 거의 모두 `appAlert`/`appConfirm` 로 이전 완료. blacklist/coupons 는 native `alert()`/`confirm()` 그대로 사용. 사이트 디자인 일관성 깨짐 + 모바일에서 OS UI 어색 + 다국어 라벨도 OS locale 가 결정 (확인 / OK 등이 영문 환경 시 영어).
- **사용자 영향**: 디자인 일관성 깨짐 + 다국어 confirm 시 button 라벨이 OS locale 이라 한국어 사이트인데 confirm 버튼이 "OK/Cancel" 노출 가능.
- **제안**: 14곳 모두 `appAlert`/`appConfirm` (lib/dialog.ts) 으로 일괄 교체.
- **노력**: S | **리스크**: S — single-find-and-replace 가 가능한 깔끔한 작업. confirm 은 await 으로 바뀌므로 함수 async 화 필요한 곳 (coupons.ts:574 `refreshAllExtras` 같은) 은 약간의 재배열.
- **연쇄**: C3 의 진단 토스트 도입 시 같이 정리 권장.

### C3. 동일 상황에 다른 메시지 — "lookup failed" / "조회 실패" / "일시 문제" 혼용
- **위치**: blacklist.ts:188 `'lookup failed'` (영어 raw, i18n 안 됨), blacklist.ts:490 `t('blacklist.msg.apiSearchFailed')`, members.ts:687 `t('common.playerLookupFailed')`, coupons.ts:645 `'lookup failed'` (영어 raw)
- **현재**: 같은 centurygame `player` API 실패를 4 가지 다른 메시지 (그 중 2개는 i18n 미적용 영어 raw string).
- **사용자 영향**: 혼란. 영어 사용자가 한국어 사이트 일부 화면에서 영어 raw 메시지 (`'lookup failed'`) 만 보는 케이스. 무엇보다 silent dialog text 혼선.
- **제안**: F1 의 헬퍼에서 동일한 `t('common.playerLookupFailed')` 로 통일. raw string 제거.
- **노력**: S | **리스크**: S | **연쇄**: F1 와 동시 처리.

### C4. blacklist `bl-icon-btn` (32×32) — 모바일 터치 영역 부족
- **위치**: `src/styles/blacklist.css:89-114` (`width: 32px; height: 32px`)
- **현재**: 행 우측의 이미지 버튼 32×32. iOS HIG 권장 44×44. `mc-manage-btn` (manage.css:556 `width:32px; height:32px`), `cp-btn` (manage.css:1099 `width:30px; height:30px`) 도 동일.
- **사용자 영향**: 모바일에서 row 작은 버튼 (수령/삭제/이미지) 정확 탭 어려움. 옆 버튼 오탭 가능.
- **제안**: 모바일 (max-width: 640px) media query 에서 44×44 로 확대 또는 padding 으로 hit area 확대 (`::before { content: ''; position:absolute; inset:-6px }` trick). cp-btn 은 두 버튼 (수령/삭제) 가 인접해 더 위험.
- **노력**: S | **리스크**: S

### C5. blacklist 등록 모달 — 결과 후 사용자 피드백 없음 (silent 성공)
- **위치**: blacklist.ts:573-648 `submitForm`
- **현재**: 성공 시 `closeModal(); loadEntries();` 만 — toast/알림 0건. 등록/수정 결과를 사용자가 row 에 반영된 걸로만 알 수 있음. 실패 시는 alert 띄움 → 비대칭.
- **사용자 영향**: 사용자가 "저장된 거 맞나?" 의심. 특히 이미지 업로드 시 (느린 회선) 무엇이 일어나는지 불명확.
- **제안**: 성공 시 `appAlert` 또는 화면 우상단 toast (간단 fadeIn/Out span). members.ts 의 `md-refresh` 패턴 (성공 시 ✓ 1.5s 표시) 준용 가능.
- **노력**: S | **리스크**: S

### C6. coupons.ts 의 `selectedCouponCode` — `esc()` 가 single-quote 미인코딩
- **위치**: utils.ts:36-44 (`esc` 함수), coupons.ts:248 `hintEl.innerHTML = t('coupons.hint.selected', { code: esc(selectedCouponCode) })`
- **현재**: `esc` 가 `&`, `<`, `>`, `"` 만 escape. `'` (apostrophe) 은 escape 안 함. coupon code 는 외부 API (kingshot.net) 응답이라 사용자 입력 아님. 그래도 hint 가 `<strong>{code}</strong>` 같은 attr 컨텍스트 안에 있으면 single-quote 가 attr break 가능.
- **위험**: 현재는 이론적 — coupon code 가 보통 alphanumeric. 그러나 esc 의 약속이 깨진 상태.
- **제안**: utils.ts:36-44 의 `esc` 에 `.replace(/'/g, '&#39;')` 추가 + esc 사용처 모두 안전.
- **노력**: S | **리스크**: S

### C7. members 의 `mc-pos`, blacklist 의 등급 표시 — 컬러만으로 의미 전달
- **위치**: members.ts:140 `wrap.className = 'mc-photo-wrap' + lvClass;` (`lv-28`/`lv-29`/`lv-30` CSS 클래스), members.ts:136 `'member-row rank-' + rank` (R5/R4/R3/R2/R1 색)
- **현재**: 등급/레벨이 색상 + 라벨 텍스트 (Lv.30) 로 둘 다 노출 — 일단 양호. 그러나 `cp-btn-redeem` (수령 가능) vs `cp-btn-done` (수령 완료) 는 색 (accent vs green) 외에 SVG 아이콘 (gift vs check) 은 다르므로 OK. 면밀 검토 결과 contrast 확보됨 — false alarm.
- **결정**: defer — 현 구현은 색 + 텍스트/아이콘 둘 다 사용, WCAG 2.1.1 통과. 향후 새 위젯 추가 시 패턴 유지하면 됨.

### C8. blacklist `<dialog class="bl-image-dialog">` — close 버튼 없음, 키보드 사용자 ESC 만으로 닫기
- **위치**: blacklist.astro:167-169, blacklist.ts:108-110
- **현재**: 이미지 lightbox 의도적으로 X 버튼 없음 (KvK 가이드 패턴 차용 — 주석 명시). 클릭/ESC 만. 마우스 사용자에겐 직관적이지만 *키보드 only 사용자가 dialog 안에서 Tab 이동 시 닫기 트리거 부재*.
- **사용자 영향**: 키보드 only 사용자가 탈출하려면 ESC 만. 키보드/스크린리더 사용자에 특히 불친절. dialog 자체엔 focusable 자식 없음 → focus 가 어디 있는지 모호.
- **제안**: visually hidden 한 close 버튼 추가 (ESC 와 동등 동작), 또는 dialog 자체에 `tabindex="0"` 부여 + role="dialog".
- **노력**: S | **리스크**: S

### C9. members 등록 모달 검색 input — `inputmode="numeric"` 부재
- **위치**: members.astro:51-58 (input-kingshot-id), coupons.astro:60-65 (coupon-input-id), blacklist.astro:91-97 (blacklist 는 `inputmode="numeric"` 있음)
- **현재**: kingshot_id 는 숫자만 (4-15자리, blacklist.ts:468 정규식 `^\d{4,15}$`). 그러나 members/coupons 의 입력은 `type="text"` + inputmode 미지정 → 모바일에서 일반 키보드 노출.
- **사용자 영향**: 모바일에서 숫자 키보드 대신 일반 키보드 → 입력 시간 길어짐.
- **제안**: `inputmode="numeric"` + `pattern="[0-9]*"` 추가. blacklist 패턴 따라가기.
- **노력**: S | **리스크**: S

---

## 빌드 메트릭 (참고)

```
청크 크기 (dist/_astro/*.js, 큰 순서):
  supabase.DQaduQ27.js                 203,129 B  ← 거대 dependency
  index.DvGHqQdd.js                     46,030 B  ← i18n 사전 (ko + en) 추정
  coupons (page chunk)                  22,502 B
  webp_enc.js                           20,208 B  ← @jsquash/webp WASM glue (lazy import 정상)
  webp_enc_simd.js                      20,163 B
  pvp                                   16,354 B
  tile-match                            15,157 B
  members                               15,143 B
  kvk                                   14,751 B
  blacklist                             14,431 B
  ...
```

- **i18n 사전 (46 KB)** 이 모든 페이지에 포함됨 (트랙 4 결과). lang 별 split 검토 가능 (ko 만 22 KB, en 만 22 KB) — 첫 페인트 50% 절약. lang switch 시 다른 lang lazy load. 단, 이 작업은 manage 영역과 무관 — 본 분석 범위 외, 노트만.
- **webp WASM (40 KB)** 는 dynamic import (image-optimize.ts:99) 로 lazy → blacklist 페이지에서도 첫 페인트 비포함. iOS Safari 18 이상은 native WebP 지원이라 WASM 다운로드 0 — 좋은 패턴.

---

## Open Questions

- **zod / runtime validator 도입?** F1 ~ F4 의 외부 API/DB 응답 검증을 inline 함수로 충분히 커버 가능 vs zod (~10 KB gzipped) 도입 가치 있는지. 현 22명 규모 + 페이지 8개 정도엔 inline validator 가 비용 효율 더 큼 — defer 추천.
- **B1 의 supabase split** — `LoginedUserInfo`, `tile-match-auth` 등 supabase client 사용 페이지/컴포넌트가 많아 의존성 그래프 매핑 필요. 잘못하면 dual-bundle (split 두 번) 가능.
- **C1 의 `<dialog>` 마이그레이션 범위** — manage 페이지 4 모달이 가장 영향 큼. Agent 2 의 컴포넌트화 권고와 합치면 `<Modal>` Astro 컴포넌트 1 개로 통합 가능 (격리된 native dialog wrapper).
- **C4 의 모바일 hit area 확대 시점** — 디자인 회귀 위험 있음 (테이블 row 높이 영향). 미니게임 PvP/장비 강화 등 다른 페이지의 작은 버튼들과 일괄 결정 권장.
