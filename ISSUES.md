# ISSUES

> 발견한 이슈를 모아두는 파일. 사용자가 "끝났어" 라고 신호를 주면 그때부터 위에서부터 차례로 수정 시작.
> 진행 중인 작업과 분리해 별도로 트래킹.

---

## #1 (모바일) 햄버거 버튼 위치 — 비로그인 시 좌측으로 쏠림

- **상태**: ✅ 해결 (2026-04-28, 커밋 예정) — #3 위젯 도입으로 자동 해결 (헤더 우측이 항상 "로그인" 버튼 또는 위젯으로 채워짐)
- **페이지**: `/minigame/tile-match/` (다른 페이지에서도 재현되는지 추가 확인 필요)
- **재현**:
  1. 모바일 viewport
  2. 인증 안 된 상태(인증 박스/크리스탈 배지 모두 미표시)로 페이지 진입
  3. 헤더 우측에 있어야 할 햄버거(≡) 버튼이 좌측으로 쏠려있음
- **로그인(인증) 후**: 인증 박스 + ✨ 크리스탈 배지가 헤더 우측에 채워지면 햄버거가 정상(우측 끝) 위치로 보임
- **추정 원인**: 헤더 레이아웃이 `justify-content: space-between` 류로 짜여있어 우측 콘텐츠(인증 박스/배지)가 비면 햄버거가 좌측 그룹에 쏠려 들어가는 듯. 실제 CSS 보고 확인 필요.
- **참고 스크린샷**: 사용자 첨부 (비로그인 vs 로그인 비교)

---

## #2 로그인 버튼을 헤더에 상시 노출

- **상태**: ✅ 적용 (2026-04-28, 커밋 예정) | 분류: 기능 변경
- **현재 동작**: 미니게임 메뉴(타일 매치 등) 진입 시에만 PIN 인증 다이얼로그 노출
- **변경 후**:
  - **헤더에 "로그인" 버튼 상시 노출** (다른 일반 웹서비스 패턴) — 비로그인 상태일 때 항상 보이고, 클릭하면 인증 다이얼로그
  - **자동 팝업 X** — 사이트 진입만으로는 다이얼로그가 뜨지 않음 (가이드/이벤트 등 공개 콘텐츠 그대로 사용)
  - **미니게임 진입 시 인증 흐름은 기존 그대로** — 비로그인 상태로 미니게임 탭 누르면 기존처럼 인증 다이얼로그 (이게 유일한 자동 트리거)
- **영향 범위**:
  - 헤더 컴포넌트(`Header.astro`)에 로그인 버튼 슬롯 추가 (#3 의 `LoginedUserInfo` 와 결합 — 인증 시 위젯으로 swap)
  - 기존 미니게임 인증 흐름(`tm-launch-btn` 등)은 손대지 않음
- **#1, #3 와의 관계**: 헤더 변경이 같이 묶이므로 한 PR 로 처리 권장

---

## #3 인증/사용자 정보 컴포넌트 통합 — `LoginedUserInfo` 위젯 도입

- **상태**: ✅ 적용 (2026-04-28, 커밋 예정) | 분류: 기능/UX 재구조화
- **추가 보완**: 데스크톱 trigger 클릭 비활성 (`matchMedia` 가드 + `cursor: default`) — 4요소 이미 펼쳐져있어 드롭다운 불필요
- **현재 동작**:
  - 타일매치 페이지에 "인증된 Toycode [전환]" 녹색 박스 (페이지 범위 한정)
  - 헤더 우측에 크리스탈 배지 "✨ 0" 별도 노출
  - "전환" 버튼 = 로그아웃+다른 계정 선택 의미였음
- **변경 후**:
  - 헤더 우측 상단에 **`LoginedUserInfo` 컴포넌트** 신설 (모든 페이지 공통)
    - 아바타 / 닉네임 / 보유 크리스탈 (✨ N) / 로그아웃 버튼
  - 기존 "전환" 버튼 → **"로그아웃"** 으로 리네임
  - 로그아웃 클릭 시 → 세션 즉시 클리어 → 헤더가 "로그인" 버튼 상태로 swap (#2)
  - 비로그인 상태 헤더: "로그인" 버튼만 노출 → #1 햄버거 위치 문제도 자연 해결
- **결정사항**:
  - **아바타 소스**: `members.profile_photo` (이미 존재, centurygame API 에서 받아 저장 중). 비어있으면 initial(닉네임 첫글자) placeholder
  - **모바일 패턴**: **드롭다운** — 헤더에는 아바타+크리스탈만 노출, 클릭 시 닉네임+로그아웃이 드롭다운 패널로 펼쳐짐
  - **데스크톱**: 4요소 모두 펼쳐서 표시
- **영향 범위**:
  - 신규: `src/components/LoginedUserInfo.astro` (+ `src/scripts/components/logined-user-info.ts`)
  - 수정: `src/components/Header.astro` — 크리스탈 배지 자리에 위젯 마운트
  - 수정: `src/scripts/pages/tile-match.ts` — 페이지 내 "인증된 ... 전환" 박스 제거, `tm-launch-user-logout` 핸들러 위젯과 통합
  - `crystal-balance-update` 이벤트 listener 위치를 위젯으로 이전 (페이지마다 동작하도록)

---

## #4 미니게임 페이지 — 중간 섹션 콤팩트화 + 시각적 다듬기

- **상태**: ✅ 적용 (2026-04-28, 커밋 예정) | 분류: UI/UX 개선
- **추가 결정 (사용자)**: 타일매치 메타 표기 — `다음 스테이지 Stage N` 의 영어 중복 제거 → `다음 스테이지 N`
- **대상 페이지**:
  - `/minigame/tile-match/` — "다음 스테이지 / Stage N / 게임 시작" 카드
  - `/minigame/partner-draw/` — "파티 인원 / 본인 포함 N명 / − + / 오늘의 운명의 파트너" 카드
- **현재 문제**:
  - 카드가 세로로 너무 크고 내부 spacing 과해서 공간 낭비
  - 모바일에선 카드 하나가 viewport 절반 차지 → 랭킹 영역 보려면 스크롤 필요
- **결정사항**:
  - **통일 컴포넌트로 추출**: `src/components/MinigameLaunchCard.astro` 신설 — 두 페이지가 같은 컴포넌트 사용
    - props: `title`(다음 스테이지/파티 인원), `value`(Stage N/본인 포함 N명), `cta`(버튼 라벨), `slot`(보조 컨트롤 — 운명파트너의 −+ 버튼 같은 거)
  - **레이아웃**: 작업 시 시안 만들어서 사용자에게 보여주고 결정 (데스크톱 가로 배치 vs 모바일/데스크톱 모두 세로 압축)
  - **시각**: 사이트 그린 계열(#4ade80) 톤 유지, CTA 버튼이 시선 중심
- **영향 범위**:
  - 신규: `src/components/MinigameLaunchCard.astro` + `src/styles/minigame-launch-card.css` (또는 `minigame.css` 내 섹션)
  - 수정: `src/pages/minigame/tile-match.astro` — `.tm-launch-card` 제거, 컴포넌트 사용
  - 수정: `src/pages/minigame/partner-draw.astro` — 파티 인원 카드 제거, 컴포넌트 사용
- **참고 스크린샷**: 사용자 첨부 (현재 너무 커보이는 상태)

---

## #5 크리스탈 획득 안내 — 토스트 제거 → 클리어 다이얼로그에 즉시 표시 (fire-and-forget)

- **상태**: ✅ 적용 (2026-04-29, 커밋 예정) | 분류: UX 변경
- **추가 보완 (사용자 피드백)**:
  - 다이얼로그 가로 요소 수직 중앙 정렬 (icon/amount/label) — `align-items: center` + 자식 `inline-flex/line-height:1` 통일
  - 폭죽 wiggle + 숫자 슬라이드업 애니메이션 + 매 표시마다 재시작 (restartAnimation 헬퍼)
  - 크리스탈 이모지 ✨ → 💎 (다이아몬드)
  - 헤더 위젯 `.hu-crystal-value` `min-width: 3.5em` + 우측 정렬 — 자릿수 변해도 위젯 폭 고정
  - AuthDialog 스타일을 컴포넌트 자체로 이전 (BaseLayout 마운트 후 비-미니게임 페이지에서 스타일 누락 회귀 수정)
- **데이터 백필 (2026-04-29 실행)**:
  - 22명, 526 stages 신규 지급, +187,940 크리스탈
  - `claim-stage-reward` Edge Function 멱등 호출로 라이브 시스템 호환 (audit trail: source=`tile_match_clear`)
- **현재 동작**:
  - 스테이지 클리어 시 클리어 다이얼로그 즉시 표시 ("🎉 Stage N 클리어!")
  - 별도 토스트 "✨ 크리스탈 +N" 가 1.8초간 떴다 사라짐 (`tm-crystal-toast`)
- **결정사항 (변경 후)**:
  - **토스트 제거** (`showCrystalRewardToast` + `.tm-crystal-toast` CSS)
  - **클리어 다이얼로그에 즉시 완성형 표시**: "Stage 3 클리어! ✨ +50 크리스탈" — 서버 응답 기다리지 않음
  - **fire-and-forget 패턴**: `claim-stage-reward` 호출은 비동기로 백그라운드 진행. 사용자가 다이얼로그 닫고 브라우저 종료해도 서버는 처리됨. 다음 로그인 시 잔액 fetch 하면 적용된 상태로 보임
  - **재플레이 X 도메인 가정**: 사용자 명시 — "스테이지는 무조건 증가, 도전했던 스테이지 재도전 없음". duplicate 케이스는 기능상 발생 불가능 (서버는 ref_key UNIQUE 로 방어만 함). 따라서 "이미 받은 보상" 같은 표시는 불필요
  - amount === 0 (Stage 46+ cap) 인 경우만 보상 라인 미표시
- **클라이언트가 amount 미리 알기 위한 선결조건**:
  - **`src/lib/balance.ts` 신설** — Edge Function [economy/index.ts:51-66](supabase/functions/economy/index.ts#L51) 의 `rewardForStage()` 와 동일한 매핑을 클라이언트 측에 mirror
    - Stage 1 → 100 / Stage 2~10 → 10~50 / Stage 11~20 → 100~300 / Stage 21~45 → 500~980 / Stage 46+ → 0
  - 두 곳을 mirror 하므로 변경 시 **양쪽 동시 수정** 주석 명시. 서버가 항상 진실의 원천(authoritative).
  - 클라이언트가 잘못 표시해도 → 다음 잔액 fetch 시 서버값으로 정정됨 (자가 치유)
- **영향 범위**:
  - 신규: `src/lib/balance.ts` (stage→reward mirror)
  - 수정: `src/scripts/pages/tile-match.ts` — `showCrystalRewardToast` 제거, `onClear()` 에서 `rewardForStage(stage)` 로 즉시 amount 계산 후 다이얼로그에 주입, `claim-stage-reward` fire-and-forget (응답 대기 X, 응답 오면 잔액만 broadcast)
  - 수정: `src/pages/minigame/tile-match.astro` — 클리어 다이얼로그(`tm-overlay`) 마크업에 크리스탈 라인 슬롯 추가
  - 수정: `src/styles/minigame.css` — `.tm-crystal-toast` 제거, 다이얼로그 내 크리스탈 라인 스타일 추가

---

## #6 데이터 갱신 시 화면 깜박임 — 구조적 개선

- **상태**: 미수정 (분류: 구조 개선) | **결정 완료**: 2026-04-28
- **증상**: API 로 데이터 조회/갱신하는 **거의 모든 동적 UI** 가 깜박임 발생
  - 사용자 명시: "연맹원 목록 그리고 API 로 상태를 조회하여 받는 모든 UI 요소가 다 그러고있어"
- **주 원인**: `innerHTML = ''` 으로 컨테이너 통째 비우고 다시 채우는 패턴 → DOM 이 빈 상태로 1프레임 이상 노출되며 깜박임. 이미지/아바타도 매번 새로 로드되어 가시적 flash
- **결정사항**:
  - **A. DOM diff 헬퍼 직접 작성** 채택 — Preact/React 도입 X (정적 GH Pages 사이트에 과함)
  - 신규 공용 헬퍼 `src/lib/dom-diff.ts` (~80~120줄) — keyed reconciliation
    - 시그니처 (안): `patchList(container: HTMLElement, items: T[], key: (item: T) => string, render: (item: T) => HTMLElement, update?: (el: HTMLElement, item: T) => void)`
    - 동작: 각 row 에 `data-key` 부여 → 신규 데이터와 기존 DOM 비교 → 사라진 row 만 remove, 새 row 만 append, 위치 바뀐 row 만 move, 동일 key 의 변경된 필드만 textContent 교체
  - 텍스트 단독(헤더 크리스탈 배지 등)은 별도 `patchText(el, value)` — 같은 값이면 no-op
- **적용 순서 (자주 보이는 곳 → 드문 곳)**:
  1. 헤더 크리스탈 배지 (`crystal-balance-update` 이벤트 핸들러)
  2. 미니게임 랭킹 (`tile-match` 의 `loadRanking()`)
  3. 멤버 관리 리스트 (`/manage/members/`)
  4. 쿠폰 히스토리 / 기타 관리자 도구
- **영향 범위**:
  - 신규: `src/lib/dom-diff.ts`
  - 수정: 위 적용 순서대로 각 페이지의 갱신 함수를 헬퍼로 교체
  - 비고: 한 번에 다 안 해도 됨. 헬퍼 만들고 1번부터 차례로 점진 적용 가능

---

## #7 쿠폰 자동 수령 — silent return 시 사용자 피드백 부재

- **상태**: 미수정 (분류: 버그/UX)
- **재현 URL**: `https://kingshot.wooju-home.org/manage/coupons/?auto-redeem=true`
- **증상**: URL 진입 시 화면에 아무 변화도 일어나지 않음 → 사용자 입장에선 "동작 안 함"으로 보임
- **원인 (실제 동작 분석 결과)**:
  - URL 트리거 + `coupons.ts` 의 `checkAutoRedeem()` 자체는 **정상 작동**
  - `startBulkRedeem(skipConfirm=true)` 가 두 경로로 silent return:
    1. `activeCoupons.length === 0` ([coupons.ts:557](src/scripts/pages/coupons.ts#L557))
    2. `pending.length === 0` (모든 계정 이미 수령) ([coupons.ts:563-571](src/scripts/pages/coupons.ts#L563))
  - `skipConfirm=true` 일 때 alert 까지 차단되어 결과 알림 누락 — `skipConfirm` 본래 의도는 "확인 prompt 생략" 이지 "결과 알림 차단" 이 아님
  - 진단 시점 production DB 상태: 활성 쿠폰 3개 모두에 대해 ~103 계정 모두 수령 이력 보유 → pending=0 으로 silent 종료
- **결정사항 (개선 방향)**:
  - `skipConfirm` 의미를 좁힘: confirm prompt 만 막고, **결과/상태 피드백은 항상 표시**
  - URL 진입 시 결과를 토스트 또는 진행바 영역에 노출
    - "현재 활성 쿠폰이 없습니다"
    - "모든 계정이 이미 쿠폰을 수령했습니다 ✓"
    - "N명 / M건 수령 시작..." (정상 케이스)
  - 추가 안정성: [loadAccounts](src/scripts/pages/coupons.ts#L237), [loadHistory](src/scripts/pages/coupons.ts#L278) 의 `.then()` 체인에 `.catch()`/`.finally()` 추가 — Supabase 쿼리 reject 시 callback 누락 방지 (현재는 reject 시 chain 영영 멈춤)
- **영향 범위**:
  - `src/scripts/pages/coupons.ts` — `startBulkRedeem` 의 silent return 분기에 결과 알림 추가, `loadAccounts`/`loadHistory` catch 보강
