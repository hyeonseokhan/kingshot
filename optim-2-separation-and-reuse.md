# 분석 결과 — Role Separation + Componentization (Agent 2)

## Summary
- 책임 분리 후보 7건, 컴포넌트화 후보 9건 발견
- 가장 임팩트 큰 3건:
  1. **F10 — `fetchPlayerInfo` (centurygame `action:'player'` 호출 + 정규화 + not-found 분기)** 가 4 사이트 (members 1 + coupons 2 + blacklist 2)에 인라인 중복. `src/lib/player-lookup.ts` 추출 시 향후 외부 API 변경(필드명, 라벨 매핑) 1곳만 수정.
  2. **F11 — "kingshot ID 입력 → 조회 → preview" 등록 모달 (members + coupons + blacklist)** 마크업/스크립트가 거의 동일. preview UI 자체는 두 변형(`player-card` vs `bl-pill`)으로 분기되지만, 컨트롤러는 단일화 가능 (`SearchModalController`).
  3. **F1 — `members.ts/initPage()` (236 lines)** 이 등록/관리/저장/삭제/갱신/admin-grant/Esc handler 까지 모두 inline. 책임 4개 이상 — 컨트롤러 분리 후 본 파일은 30~50 lines.
- 대부분의 finding 은 트랙 1/2 (store 도입) 가 데이터 레이어를 한 차례 정리한 후 *남아있는* UI/외부 IO 레이어 중복. 트랙 3 (DB 정리) 직후 자연스러운 다음 라운드.

---

## Section A — Role Separation

### F1. `members.ts/initPage()` 가 7개 책임 이상 한 함수에 inline
- **위치**: `src/scripts/pages/members.ts:515-759` (245 lines)
- **현재 책임 다중**:
  1. 필터 select option 30→1 동적 생성 (`517-523`)
  2. 검색 input wiring (`527-531`)
  3. row 클릭 위임 → openDialog (`534-540`)
  4. 관리 다이얼로그 wiring (refresh / save / delete) (`543-637`)
  5. 등록 모달 wiring (open / close / search / save) (`640-735`)
  6. 전체 갱신 button + admin grant init (`738-741`)
  7. Esc 키 글로벌 핸들러 (`744-750`)
  8. store subscribe + 초기 fetch + onLangChange (`753-758`)
- **제안 분리** (한 모듈 내 함수 단위, 다른 파일까지 갈 필요 X):
  - `initFilters()`, `initSearch()`, `initManageDialog()`, `initAddModal()`, `initEscapeKey()`, `initStoreBinding()`
  - 책임 8개를 함수 8개 + `initPage()` 가 8줄 호출만
- **근거**: 핵심은 "이 페이지에 새 기능 추가 시 어디 손대야 하나?" 질문에 답이 명확해짐. 현재는 `initPage()` 245 lines 전체를 스캐닝해야 modal save handler 가 어디 있는지 보임. 함수 분리 후 `initAddModal()` 만 보면 됨. 테스트 용이성은 부차적 (E2E 위주의 프로젝트).
- **노력**: S (같은 파일 내 함수 추출 + initPage 호출 8줄)
- **리스크**: S (closure 변수 `currentDialogId`, `searchData` 만 module-level 유지하면 됨 — 이미 그렇게 되어 있음)
- **연쇄 영향**: F2 (다이얼로그 추출), F11 (등록 모달 추출) 의 전제 조건. 먼저 안 해도 되지만 같이 처리하면 한 commit 으로 깔끔.

### F2. `openDialog` + `renderDialog` + `md-refresh handler` — "관리 다이얼로그" 책임이 3 곳에 흩어짐
- **위치**: `src/scripts/pages/members.ts`
  - `openDialog`/`renderDialog`/`closeDialog`: `282-328`
  - `md-refresh` 클릭 핸들러: `550-593` (44 lines, 인라인 fetch + DB update + DOM patch + SVG swap)
  - `md-save` / `md-delete` 핸들러: `596-637`
- **현재 책임 다중**: 다이얼로그 라이프사이클(open/render/close) 과 다이얼로그 안의 액션(refresh/save/delete) 이 같은 `initPage()` 안에 평면으로 나열. `md-refresh` 핸들러는 fetch + DB write + DOM patch (SVG 체크마크 swap setTimeout 1500ms) + 백그라운드 store refresh 까지 한 함수에서 동시에 함.
- **제안 분리**:
  - `manage-dialog.ts` (또는 같은 파일 내 섹션) — `MemberManageDialog` 객체에 `open(id)`, `close()`, `refreshMember()`, `saveChanges()`, `deleteMember()` 메서드.
  - SVG 체크 swap 패턴은 `flashSuccess(btn, ms)` 헬퍼로 별도 (코드 그대로 다른 곳에서도 쓸 수 있음).
- **근거**: 현재 `md-refresh` 핸들러 단독 44 lines 인데, 중간 `// 갱신된 필드만 m 에 적용...` 같은 8줄 주석이 회귀 발생 이력을 설명함 — 한 함수가 너무 많은 일을 하니 미묘한 회귀가 발생했고 그 흉터가 코드에 남음. 분리하면 `refreshMember` 가 한 책임만 하게 됨.
- **노력**: M (3개 핸들러 추출 + 시그니처 정리)
- **리스크**: S (현재도 module-level state `currentDialogId` 가 명확)

### F3. `members.ts/refreshMembersByIds` — batch orchestration + UI feedback + stats persistence 한 함수 다중 책임
- **위치**: `src/scripts/pages/members.ts:358-415` (58 lines)
- **현재 책임 다중**:
  1. 배치 분할 (`for ... BATCH_SIZE`)
  2. Promise chain 구성
  3. 버튼 텍스트 progress 갱신 (closure `updateBtnText`)
  4. 배너 progress 표시 (`setBannerStatus('progress', ...)`)
  5. 완료 후 stats persist (`saveFailedRefresh`/`clearFailedRefresh`)
  6. cache invalidate + store refresh
- **제안 분리**:
  - F12 (batch processor) 와 함께 배치 부분을 추출. 본 함수는 "callback 으로 각 member fetch + 끝나면 stats 처리" 로 축약.
  - 슈도코드: `runBatched(targets, BATCH_SIZE, (m) => refreshSingleMember(m, stats), { onProgress: (done, total) => { updateBtnText(); setBannerStatus(...) } })`
- **노력**: S (F12 추출되면 자연스럽게 따라감)
- **리스크**: S
- **연쇄 영향**: F12 와 묶음. coupons.ts/refreshAllExtras + blacklist.ts/refreshAllPlayerInfo 가 같은 패턴이라 동시 정리 가능.

### F4. `coupons.ts/initPage()` 와 `coupons.ts/bindEventListeners()` 분리가 모호 — 책임 경계 흐릿
- **위치**: `src/scripts/pages/coupons.ts:1188-1197` (initPage) + `1209-1423` (bindEventListeners 215 lines)
- **현재 책임 다중**: `initPage()` 는 데이터 로드 콜백 chain 만, 모든 wiring 은 `bindEventListeners()` 에. 그런데 `bindEventListeners()` 안에:
  1. 검색 input + Esc 클리어
  2. 쿠폰 카드 위임 (click + keydown)
  3. 계정 row 위임 (redeem / remove)
  4. 추가 계정 등록 모달 wiring (open/close/search/save) — F11 와 중복 패턴
  5. 전체 수령 / extras 갱신 버튼
  6. 수령 이력 다이얼로그 (open/close/search debounce/pagination 컨테이너 위임)
  7. Esc 키 글로벌 핸들러
  8. onLangChange
- **제안 분리**: members.ts 의 F1 과 같은 패턴 — `initSearch()`, `initCouponCards()`, `initAccountRows()`, `initAddAccountModal()`, `initBulkActions()`, `initHistoryDialog()`, `initEscapeKey()`. 1446 lines 파일이 가독성 측면에서 가장 큰 부담.
- **노력**: M (members.ts 보다 큼 — history dialog 가 추가)
- **리스크**: S
- **연쇄 영향**: F1 과 같은 패턴이라 동시 처리 권장.

### F5. `blacklist.ts/submitForm()` — 등록 + 수정 + storage 관리 + DB PATCH/POST 한 함수
- **위치**: `src/scripts/pages/blacklist.ts:573-648` (76 lines)
- **현재 책임 다중**:
  1. lookupResult 검증
  2. 새 이미지 업로드 (조건부)
  3. **수정 분기** (4종 이미지 케이스 a/b/c/d 결정 + PATCH)
  4. **등록 분기** (POST)
  5. 옛 storage object 정리 (조건부)
  6. UI 마무리 (closeModal + reload + finally)
- **현재 코드는 `if (editingId) { 수정 } else { 등록 }` 으로 명시 분기되어 있어 *이미* "두 함수가 하나에 섞임" 이 가시적 — 추출 자체는 trivial.
- **제안 분리**:
  - `submitForm()` 은 `if (editingId) updateEntry(...)` else `createEntry(...)` 로 dispatch
  - `updateEntry()` 안에 4종 이미지 케이스 결정 로직 (15줄)
  - `createEntry()` 안에 단순 POST 로직
- **근거**: 현재 76줄 함수는 "수정 경로의 4종 케이스" 가 인지 부담. 분리 후 한 함수당 30줄 이하.
- **노력**: S
- **리스크**: S

### F6. `coupons.ts/redeemForMember()` — 네트워크 + 응답 파싱 + stats 집계 + UI progress + 만료 감지 + cache invalidate
- **위치**: `src/scripts/pages/coupons.ts:716-790` (75 lines)
- **현재 책임 다중**:
  1. fetch + JSON parse
  2. top-level 응답 실패 분기 (`json.code !== 0`)
  3. 결과 array forEach 로 success/already/failed 분류
  4. saveHistory 호출 (DB write)
  5. showProgress (UI feedback)
  6. err_code=40007 (만료) 감지 + cache invalidate + 재렌더
  7. updateAccountRowStatus (DOM 부분 갱신)
  8. catch 블록의 stats 집계
- **제안 분리**: 가장 큰 책임은 5+6 (UI 사이드이펙트). 네트워크 + 결과 분류만 pure 하게 추출:
  - `submitRedeem(fid, codes): Promise<RedeemBatchResponse>` — 순수 IO
  - `classifyResults(json, fid, nickname, stats): { expiredCodes, perCodeStatus[] }` — 순수 분류
  - `redeemForMember()` 는 호출 + 분류 결과로 UI 사이드 이펙트만 (showProgress / saveHistory / updateRowStatus / cache invalidate)
- **근거**: 책임 8개는 명백히 과다. 단 우선 순위는 F1/F4 보다 낮음 (이 함수만 보면 동작 흐름이 어쩌겠든 선형이라 *읽힘*).
- **노력**: M
- **리스크**: M (saveHistory, updateAccountRowStatus 호출 순서/시점이 미묘 — 회귀 가능)

### F7. `members.ts/setBannerStatus()` — UI 모드 'idle'|'progress'|'failure' 한 함수가 3개 분기
- **위치**: `src/scripts/pages/members.ts:458-507` (50 lines)
- **현재 책임 다중**: 모드별 element 생성 + innerHTML 통째 교체 + 액션 버튼 wiring (retry/close).
- **제안 분리**: 사실 이 함수 자체는 분기 명확 (`if (mode === 'progress')`/`if (mode === 'failure')`/idle). 단 trade-off:
  - 분리 시: `renderProgressBanner()`, `renderFailureBanner()`, `hideBanner()` 3 함수 + dispatch
  - 유지 시: 50 lines 한 함수 (분기 명확)
- **근거**: 추출해도 큰 가치 없음 — *이 함수만은 분리 권장 안 함*. Open Question.
- **노력**: S
- **리스크**: S
- **결론**: 의도적으로 추출 안 함을 권장 (premature 가능). 유지.

---

## Section B — Componentization (중복 → 범용)

### F10. `fetchPlayerInfo` — centurygame `action:'player'` 호출이 4 사이트에 거의 동일 인라인
- **중복 사이트 (4곳)**:
  - `src/scripts/pages/members.ts:58-80` (`fetchPlayerInfo` 모듈 함수, profilePhoto field 명 사용)
  - `src/scripts/pages/coupons.ts:637-667` (`refreshSingleExtra` 안에 인라인, profile_photo)
  - `src/scripts/pages/coupons.ts:1288-1326` (등록 모달 조회, profile_photo)
  - `src/scripts/pages/blacklist.ts:180-201` (`refreshSingleEntry`, avatar_url)
  - `src/scripts/pages/blacklist.ts:483-510` (`searchPlayer`, avatar_url)
- **공통 패턴**:
  ```
  POST {SUPABASE_URL}/functions/v1/redeem-coupon
  Headers: Content-Type: application/json
  Body: { action: 'player', fid: <id> }
  Parse: json.code !== 0 || !json.data → throw
  Map: json.data.fid → playerId,
       json.data.nickname → name,
       json.data.stove_lv ?? json.data.stove_lv_content → level,
       json.data.kid → kingdom,
       json.data.avatar_image → photo
  ```
- **차이점** (호출자 별):
  - 출력 필드명 (`profilePhoto` vs `profile_photo` vs `avatar_url`) — 호출자 책임으로 매핑
  - level fallback 사용 여부 — 표준화 권장 (모두 `?? stove_lv_content`)
  - 에러 메시지 라벨 (i18n 키) — 호출자 책임
- **추출 위치 제안**: 신규 `src/lib/player-lookup.ts`
- **인터페이스 제안**:
  ```ts
  // src/lib/player-lookup.ts
  export interface PlayerLookupResult {
    fid: string;             // 항상 string 으로 정규화
    nickname: string;
    level: number;           // null 대신 0 (호출자 측 별도 분기)
    kingdom: string | null;  // game API 가 number 줄 때도 string 정규화
    avatar: string | null;   // photo URL — 호출자가 자기 필드명으로 매핑
  }
  export async function lookupPlayer(kingshotId: string): Promise<PlayerLookupResult>;
  ```
  - 호출자는 `const p = await lookupPlayer(id); searchData = { kingshot_id: p.fid, nickname: p.nickname, profile_photo: p.avatar, ... }` 처럼 매핑.
- **노력**: S (새 파일 30~40 lines + 호출자 5곳 swap)
- **리스크**: S (level: null 정책 통일 시 blacklist 가 `null` 을 기대하는데 `0` 으로 바뀌면 회귀 — `lookupPlayer` 는 `level: number | null` 그대로 두고 정책은 호출자에게 위임 권장)
- **추가 가치**: F11 의 search 모달 컨트롤러도 이 함수 위에 build → 재사용 사이트가 4 → 사실상 공통 인프라.

### F11. 등록/조회 모달 — `[ID input] [조회 btn] → preview card` 패턴이 3 페이지에 거의 동일
- **중복 사이트 (3곳)**:
  - `src/pages/manage/members.astro:43-84` (마크업: modal-overlay + modal + .player-card preview) + `members.ts:640-735` (open/close/search/save 핸들러)
  - `src/pages/manage/coupons.astro:43-91` (마크업 거의 identical) + `coupons.ts:1267-1367` (핸들러 거의 identical)
  - `src/pages/manage/blacklist.astro:80-163` (마크업 — bl-pill preview 변형 + 메모/이미지 추가) + `blacklist.ts:354-528` (open/close/search/preview 핸들러)
- **공통 패턴**:
  - 마크업: `.modal-overlay > .modal > .modal-header (close X) + .modal-body (input-row + search-result preview) + .modal-footer (cancel/save)` — `manage.css` 의 공유 클래스
  - 핸들러:
    1. open: 입력 reset, preview hide, save btn disabled, overlay.classList.add('open')
    2. search btn: lookupPlayer(id) → preview render → save btn enabled
    3. cancel/X/backdrop click: overlay.classList.remove('open')
    4. save: 검증 후 DB insert/update → cache invalidate → close + refresh
- **차이점** (사이트마다 다름):
  - **preview 변형**: members/coupons 는 `.player-card` (큰 사진 + 정보 column), blacklist 는 `.bl-pill` (한 줄 pill)
  - **save destination**: `members` table / `coupon_accounts` table / `blacklist` table
  - **추가 폼 필드**: blacklist 만 메모 + 이미지 업로드
  - **수정 모드**: blacklist 만 지원 (members/coupons 는 등록 only)
- **추출 위치 제안**: 마크업 컴포넌트 + 컨트롤러 분리.
  - `src/components/PlayerSearchModal.astro` — common shell (header/body 부분/footer slots 받음)
  - `src/lib/player-search-modal.ts` — 컨트롤러 헬퍼
- **인터페이스 제안**:
  ```ts
  // src/lib/player-search-modal.ts
  interface PlayerSearchModalOptions {
    overlayId: string;          // 'modal-overlay' | 'coupon-modal-overlay' | 'bl-modal-overlay'
    inputId: string;            // 'input-kingshot-id' 등
    searchBtnId: string;
    saveBtnId: string;
    onPreview: (p: PlayerLookupResult) => void;  // 사이트별 preview 그리기
    onReset: () => void;                          // open 시 reset
    onClose?: () => void;
  }
  function bindPlayerSearchModal(opts: PlayerSearchModalOptions): {
    open: () => void;
    close: () => void;
    getLastResult: () => PlayerLookupResult | null;
  };
  ```
  - blacklist 처럼 추가 필드(메모/이미지) 가 있는 경우는 onPreview/onReset 콜백 안에서 처리 → save 시 `getLastResult()` + 추가 필드를 호출자 자체 submit 함수에 묶음
- **노력**: M (3 사이트 각각 모달 wiring 코드 약 50줄씩 → 1곳으로)
- **리스크**: M (blacklist 의 수정 모드 가 등록 모드 위에 추가됨 — 모드 prop 또는 수정 모드는 별도 컨트롤러 권장)
- **추가 가치**: 신규 페이지에서 "킹샷 ID 입력 후 조회" 가 필요할 때 (예: KvK survey 진입 — 이미 survey-kvk.ts 에서 비슷한 패턴 사용 중) 즉시 재사용.

### F12. 배치 처리 (BATCH_SIZE=5 + Promise.all + delay) — 3 사이트에 동일 구조
- **중복 사이트 (3곳)**:
  - `src/scripts/pages/members.ts:382-415` (`refreshMembersByIds` 의 chain 구성)
  - `src/scripts/pages/coupons.ts:594-631` (`refreshAllExtras` 의 chain — 동일 패턴, async/await 아닌 .then chain)
  - `src/scripts/pages/coupons.ts:826-849` (`startBulkRedeem` 의 chain — 동일 패턴)
  - `src/scripts/pages/blacklist.ts:155-174` (`refreshAllPlayerInfo` — async/await 버전, 동일 의미)
- **공통 패턴**:
  ```
  for i in 0..N step BATCH_SIZE:
    batch = items.slice(i, i+BATCH_SIZE)
    await Promise.all(batch.map(fn))
    if (i+BATCH_SIZE < N) await delay(D)
  → onProgress(done, total) 콜백 (members 만 progress callback)
  → 완료 후 finalize (cache invalidate, summary alert)
  ```
- **차이점**:
  - members 는 .then chain, blacklist 는 async/await — 의미 동일
  - members 는 onProgress 콜백 (버튼 텍스트 + 배너 둘 다), coupons 는 progress text 만 + showProgress, blacklist 는 progress UI 없음
  - DELAY: members 500ms, coupons 1000ms, blacklist 1000ms — 호출자 옵션화
- **추출 위치 제안**: `src/lib/batch.ts` 또는 `src/lib/utils.ts` 확장
- **인터페이스 제안**:
  ```ts
  export interface RunBatchedOptions<T, R> {
    items: readonly T[];
    batchSize?: number;        // 기본 5
    delayMs?: number;          // 배치 사이 (기본 500)
    handler: (item: T) => Promise<R>;
    onBatchComplete?: (done: number, total: number) => void;
  }
  export async function runBatched<T, R>(opts: RunBatchedOptions<T, R>): Promise<R[]>;
  ```
  - 호출자: `await runBatched({ items: targets, batchSize: 5, delayMs: 500, handler: (m) => refreshSingleMember(m, stats), onBatchComplete: (done, total) => { updateBtnText(done, total); setBannerStatus('progress', done, total); } })`
- **노력**: S (15~20 lines util + 4곳 호출 swap)
- **리스크**: S (members 의 .then chain 이 finalize 도 같은 chain 에 묶여있어 일부 코드 재구조 필요)
- **추가 가치**: 향후 PvP 결과 일괄 처리, KvK survey 일괄 검증 등에서도 재사용 가능.

### F13. `syncPhoto` — placeholder + img stack + `.mc-photo-loaded` 페이드 패턴이 2 곳에 동일
- **중복 사이트 (2곳)**:
  - `src/scripts/pages/members.ts:162-189` (`syncPhoto`)
  - `src/scripts/pages/coupons.ts:412-440` (`syncAccountPhoto` — 한 줄 주석으로 "members.ts 의 syncPhoto 와 동일 패턴" 이라고 명시)
- **공통 패턴**: wrap 안 `.mc-photo-empty` (첫 글자) + `<img.mc-photo.mc-photo-fade>` stack. URL 같으면 src 재할당 X. 페이드 인은 onload → `.mc-photo-loaded`.
- **차이점**:
  - 표시할 텍스트 source: members 는 `m.nickname.charAt(0)`, coupons 는 `(a.nickname || '?').charAt(0)`
  - 입력 타입: `Member` vs `RedeemAccount` — 둘 다 `nickname` + `profile_photo` 만 사용
- **추출 위치 제안**: `src/lib/photo-sync.ts` (또는 dom-diff.ts 확장)
- **인터페이스 제안**:
  ```ts
  export function syncPhotoCell(
    wrap: HTMLElement,
    args: { photoUrl: string | null; placeholderText: string },
    classes?: { img?: string; empty?: string },  // 기본 'mc-photo' / 'mc-photo-empty'
  ): void;
  ```
- **노력**: S (15 lines util + 2 호출 swap)
- **리스크**: S — 단 사이트가 2곳뿐이라 premature abstraction 경계. 권장 조건:
  - tile-match.ts 에 `tm-rank-photo-fade` 같은 동등 패턴이 있다면 (확인 필요 — 트랙 1 운영 메모에 마커명 등장) 사이트 수가 3+ 가 되어 추출 가치 명확.
- **결정 보류**: 2 사이트면 신중. tile-match 확장 시점에 결정 권장.

### F14. RFC 5322 / 외부 API 에러 → "친화 메시지" 매핑 — `playerLookupNotFound`/`playerLookupFailed` 분기가 3곳 동일
- **중복 사이트 (3곳)**:
  - `src/scripts/pages/members.ts:686-687`
  - `src/scripts/pages/coupons.ts:1319-1320`
  - `src/scripts/pages/blacklist.ts:503-504`
- **공통 패턴**:
  ```ts
  const isNotFound = /not.*exist|not.*found/i.test(err.message);
  appAlert(t(isNotFound ? 'common.playerLookupNotFound' : 'common.playerLookupFailed'));
  ```
- **차이점**: 없음 — 완전 동일 2 lines.
- **추출 위치 제안**: F10 의 `lookupPlayer` 안에 통합 — 외부 API throw 를 catch 해서 분류된 Error 클래스로 다시 throw, 호출자는 `try/catch` 만:
  ```ts
  // player-lookup.ts
  export class PlayerNotFoundError extends Error {}
  export class PlayerLookupError extends Error {}
  // 호출자
  catch (err) {
    appAlert(t(err instanceof PlayerNotFoundError ? 'common.playerLookupNotFound' : 'common.playerLookupFailed'));
  }
  ```
  또는 더 단순한 헬퍼: `showPlayerLookupError(err)` 한 줄.
- **노력**: S (F10 추출 시 자연스럽게)
- **리스크**: S
- **추가 가치**: F10 와 같은 commit 으로 처리 — 분리 의미 없음.

### F15. Supabase REST 헤더 (`apikey` + `Authorization`) 인라인 — 다양한 형태로 반복
- **중복 사이트 (5곳 이상)**:
  - `src/scripts/pages/blacklist.ts:34-41` (`restHeaders` + `restJsonHeaders` 모듈 상수 — 잘 추출됨)
  - `src/scripts/pages/coupons.ts:138-145` (`pruneStaleHistory` 안에 inline)
  - `src/scripts/pages/members.ts:840-844` (`submitGrant` 의 fetch — `apikey` + Authorization Bearer)
  - 추가로 `src/scripts/pages/survey-kvk.ts` (스코프 외 but 같은 패턴 가능성)
- **공통 패턴**:
  ```
  Headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    [Content-Type: application/json] (옵션)
  }
  ```
- **차이점**: members 의 admin-grant 는 `Content-Type` 포함, blacklist GET 은 미포함. blacklist 에 이미 `restHeaders`/`restJsonHeaders` 패턴이 있음 — 그 패턴을 lib 으로 승격.
- **추출 위치 제안**: `src/lib/supabase.ts` 확장
- **인터페이스 제안**:
  ```ts
  // src/lib/supabase.ts (기존 supabase + SUPABASE_URL + SUPABASE_ANON_KEY 옆에)
  export const REST_BASE = SUPABASE_URL + '/rest/v1';
  export const FN_BASE = SUPABASE_URL + '/functions/v1';
  export const STORAGE_BASE = SUPABASE_URL + '/storage/v1';
  export const restHeaders: Record<string, string> = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
  };
  export const restJsonHeaders = { ...restHeaders, 'Content-Type': 'application/json' };
  ```
- **노력**: S (lib 에 5줄 추가 + 3+ 사이트 swap)
- **리스크**: S
- **추가 가치**: 향후 Edge Function 추가 시 base url + headers 자동 사용 — 보일러플레이트 제거. 단 단순 swap 이라 우선순위 낮음.

### F16. `coupon-modal-save` save flow — 중복 검증 + insert + 에러 메시지 분기 (members vs coupons 거의 동일)
- **중복 사이트 (2곳)**:
  - `src/scripts/pages/members.ts:698-735` (`btn-modal-save` handler)
  - `src/scripts/pages/coupons.ts:1330-1367` (`coupon-modal-save` handler)
- **공통 패턴**:
  - searchData 검증 → DB insert → error 분기 (duplicate/unique 키워드 검출)/일반 메시지 분기 → invalidateAccountsCache → close + refresh
  - members 는 추가로 `coupon_accounts` 에 같은 ID 가 있으면 자동 삭제
- **차이점**:
  - members 는 `members` table + 추가 정리 단계 (coupon_accounts 삭제)
  - coupons 는 `coupon_accounts` table + 사전 members 중복 체크
- **추출 위치 제안**: F11 의 PlayerSearchModal 컨트롤러 안에 옵션 `onSave: (data) => Promise<void>` 콜백으로 처리. 에러 메시지 분기 (duplicate/unique → "이미 등록됨") 만 별도 헬퍼 추출:
  ```ts
  // src/lib/supabase.ts 확장
  export function isDuplicateError(msg: string): boolean {
    return msg.indexOf('duplicate') !== -1 || msg.indexOf('unique') !== -1;
  }
  ```
- **노력**: S (헬퍼 함수 1개 + 2곳 swap)
- **리스크**: S
- **추가 가치**: F11 의존 — 같이 처리.

### F17. 공통 페이지 인프라 (`$<T>(id)` DOM helper) — 페이지마다 같은 함수 정의
- **중복 사이트 (3곳)**:
  - `members.ts:50-54` (throw 버전)
  - `coupons.ts:79-83` (throw 버전, 거의 identical)
  - `coupons.ts:85-87` (`maybe<T>` — null 허용)
  - `blacklist.ts:81` (`$ = (id) => document.getElementById(id) as T | null` — 한 줄 변형, null 허용)
- **공통 패턴**: `document.getElementById(id) as T` 의 typed wrapper
- **차이점**: throw 여부가 사이트마다 다름 — members/coupons 는 strict (throw on missing), blacklist 는 loose (null 허용)
- **추출 위치 제안**: `src/lib/dom.ts` (작은 새 파일) 또는 `utils.ts` 확장
- **인터페이스 제안**:
  ```ts
  export function byId<T extends HTMLElement>(id: string): T;     // throw
  export function byIdOpt<T extends HTMLElement>(id: string): T | null;
  ```
- **노력**: XS (5 lines + 3 사이트 import swap)
- **리스크**: S
- **추가 가치**: 작지만 모든 페이지에서 1-2 lines 절약 + 일관성. 단독 PR 가치는 낮음 — 다른 작업과 묶어서 처리.

### F18. native `confirm()` / `alert()` 잔재 — `appAlert`/`appConfirm` 으로 마이그레이션 안 된 사이트
- **중복 사이트 (15곳 이상 — 마이그레이션 누락)**:
  - `src/scripts/pages/blacklist.ts` 11곳 (`alert` 9 + `confirm` 2) — 모두 native
  - `src/scripts/pages/coupons.ts` 8곳 (`alert` 6 + `confirm` 2) — 모두 native
  - `members.ts` 는 이미 `appAlert`/`appConfirm` 으로 통일됨 (`appAlert` 7곳, `appConfirm` 3곳)
- **공통 패턴**: `alert(t('...'))` / `if (!confirm(t('...'))) return`
- **추출 가치**: 이미 lib 함수 (`appAlert`/`appConfirm`) 존재. 단순 swap 작업이지만 가치 큼:
  1. 디자인 일관성 (현재 blacklist/coupons 다이얼로그는 OS 네이티브 — 사이트 디자인과 어울리지 않음)
  2. 모바일에서 native confirm 의 어색한 UX
  3. 비동기 await 패턴 통일 (members.ts 처럼)
- **추출 위치**: 이미 `src/lib/dialog.ts` 존재. 사이트만 swap.
- **인터페이스**: 변경 없음. 호출 패턴만:
  - `alert(...)` → `await appAlert(...)` (또는 fire-and-forget)
  - `if (!confirm(...))` → `if (!(await appConfirm(...)))`
- **노력**: M (15+ 호출 swap + handleDelete/refreshAllExtras 등 함수를 async 로 변환 — 일부는 이미 async)
- **리스크**: M (await 도입으로 흐름 변경 — 후속 코드가 sync 가정한 경우 회귀 가능. blacklist/coupons 모두 .then chain 위주라 await 도입 시 일부 함수 시그니처 변경 필요)
- **추가 가치**: members.ts 가 reference — UX/디자인 일관성 1 commit.

### F19. CSS 변형 — `.player-card` (members/coupons) vs `.bl-pill` (blacklist) — 같은 의미 다른 시각
- **중복 사이트 (2 변형)**:
  - `src/styles/components.css:421-455` (`.player-card` + `.player-card-photo` + `.player-card-info` + `.player-card-name` + `.player-card-detail`)
  - `src/styles/blacklist.css:171-205` (`.bl-pill` + `.bl-pill-img` + `.bl-pill-text` + `.bl-pill-sep`)
- **공통 의미**: "조회한 플레이어를 시각화 (사진 + 닉네임 + Lv + 서버)"
- **차이점**:
  - 시각: `.player-card` 는 큰 사진(72px) + 세로 정보 column / `.bl-pill` 은 작은 사진(32px) + 한 줄 inline. 의도된 차이 (모달 크기 / 폼 어울림).
- **추출 가치 평가**:
  - **추출 비권장** — 두 디자인이 의도적으로 다름. variant prop 으로 통합하는 것은 abstraction 비용 > 이득.
  - 단, 마크업은 F11 의 PlayerSearchModal 에서 slot 으로 받게 하면 자연스러움.
- **노력**: -
- **리스크**: -
- **결론**: CSS 추출 안 함. F11 추출 시 marker class 만 prop 으로 받음.

---

## Open Questions

### Q1. F13 (syncPhoto) 추출 vs 유지
- 현재 사이트 2곳. 트랙 1 메모에 `tm-rank-photo-fade` 마커가 tile-match 에 있다고 적혀있는데, 코드 grep 으론 함수 형태가 아니라 inline 가능성. tile-match.ts 검토 후 사이트 3+ 면 추출, 아니면 유지 권장.

### Q2. F11 (PlayerSearchModal) 의 추출 단위 — Astro 컴포넌트 vs JS 컨트롤러만
- 마크업 자체가 거의 동일하지만 ID prefix 가 다름 (`input-kingshot-id` / `coupon-input-id` / `bl-input-id`). Astro 컴포넌트로 만들고 prop 으로 ID 받는 패턴이 가능하나, 이미 사용 중인 ID 가 CSS/i18n 셀렉터에 박혀있어 swap 비용 큼. JS 컨트롤러만 추출하고 마크업은 페이지마다 유지하는 것이 회귀 위험 작음. 결정 필요.

### Q3. F18 (native alert/confirm 마이그레이션) 의 우선순위
- 작업 자체는 명확하지만 await 도입으로 함수 시그니처 변경 — 다른 finding 들과 같은 PR 에 묶으면 review 부담. 단독 PR 권장 vs 다른 PR 과 묶음 결정 필요.

### Q4. `kingshot-id` lookup 의 Edge Function vs 클라이언트 호출
- 현재 외부 API (`centurygame`) 를 클라가 직접 호출 (`/functions/v1/redeem-coupon` 안의 `action:'player'` proxy). 호출 사이트 4곳 모두 anon key 없이 호출 — Edge Function 이 anon key 없이 처리 (config 의 `verify_jwt = false` 추정). F10 추출 시 `Authorization` 헤더 추가 가능성 검토 권장 (현재는 헤더 없음 — 동작은 잘 됨).

### Q5. F1 분리 후 module-level state (`currentDialogId`, `searchData`) 의 위치
- 함수 분리 후에도 두 변수는 module-level 유지가 가장 단순. 단 "관리 다이얼로그 컨트롤러" 객체로 추출하면 자체 state 캡슐화 가능. 선호도 결정 필요 (단순 함수 분리 vs 객체화).
