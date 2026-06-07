# PNX 연맹 사이트 — Claude 작업 지침

이 파일은 Claude Code 세션 시작 시 자동 로드되는 프로젝트 컨텍스트야.
**현재 사용 가능한 자원 + 구조 + 룰** 의 단일 진실 공급원(SSOT). 진행 이력은 git log 가 진실 — 본 문서는 "지금 상태" 만.

---

## 🔒 절대 룰 — UI

본 섹션의 항목은 **모든 신규 UI 작업에 예외 없이 적용**. 위반 발견 시 즉시 수정.

- **다이얼로그는 항상 화면 중앙에 위치한다.**
  - native `<dialog>` 의 UA 기본 센터링이 dialog 자체에 `display: flex` 등 표시 속성을 걸 때 깨질 수 있음
  - 해결: dialog 에 `position: fixed; inset: 0; margin: auto;` 명시 (또는 flex 레이아웃은 inner wrapper 로 분리)
  - 적용 대상: 신규 native `<dialog>` 전체. `appAlert`/`appConfirm` 은 `dialog.ts` 가 이미 보장

---

## ⚠️ 작업 시작 전 필독 — 재사용 우선 룰

**신규 기능/페이지/유틸 작성 전 반드시 아래 절차 수행. 사본 코드/중복 컴포넌트 방지의 1차 방어선.**

1. **"재사용 자산 인덱스" 섹션 통독** (바로 아래) — 컴포넌트/유틸/store/패턴 카탈로그
2. **"도메인 맵" 으로 유사 도메인 진입점 확인** → 그 파일들에서 패턴 grep
   - 예: 다이얼로그 → `dialog.ts` / `AuthDialog.astro` / `appConfirm` grep
   - 예: 리스트 갱신 → `patchList` grep
   - 예: 페이지 간 데이터 공유 → `createStore` / `membersStore` grep
3. **동일 패턴 발견 시 추출/재사용 우선, 사본 작성 금지.** 약간 달라도 props/옵션으로 흡수
4. **새 공통 자산을 만들면** `src/lib/` 또는 `src/components/` 에 두고 **본 문서의 인덱스에 한 줄 추가**.
   인덱스에 없는 자산은 다음 세션이 못 찾음 — 사실상 죽은 코드

---

## 📘 지침 문서 운영 룰 (생명주기)

**4단계 사이클 — 매번이 아니라 "맥락 묶음" 단위로 회전.** 꼬리 질문마다 사이클 돌면 토큰 낭비.

1. **조회** — 작업 시작 시 본 문서 + 메모리 통독
2. **참고** — 인덱스/도메인 맵으로 재사용 가능한 자원 식별, 패턴 따라 작업
3. **산출 정리** — 한 묶음 작업이 끝나면 ① 새 자산 발생 여부 ② 새 운영 함정 ③ 새 도메인/페이지 ④ 임시 분기(TEST_MODE 등) 점검
4. **갱신** — 위 4종이 있으면 본 문서 해당 섹션에 한 줄 추가/수정

**무엇을 기록하나 (영구 가치 기준):**
- ✅ 자산: 재사용 가능한 컴포넌트/유틸/패턴 → "인덱스" 섹션
- ✅ 도메인: 새 페이지/기능 진입점 → "도메인 맵"
- ✅ 함정: 다시 만나면 똑같이 당할 PG/DOM/i18n 함정 → "운영 함정"
- ✅ 임시 분기: TEST_MODE 같은 일회성 가지 → "운영 중 임시 분기"
- ❌ **기록 X**: 진행 이력, 일회성 incident, 커밋 단위 변경 — `git log` / `git blame` 이 진실
- ❌ **기록 X**: 단순한 사실 나열 — "왜 그렇게 했나" 가 있어야 가치

**문서 비대 방지**: 본 문서가 400 줄 넘으면 압축 검토. "현재 상태" 만 남기고 과거 결정 사유는 git commit body 로 이관.

---

## 🔗 분리 사이트 (kingshot-1767)

KvK 설문/버프예약 도메인은 **별도 repo + 인프라**로 분리됨 (2026-05).

| 항목 | 값 |
|------|----|
| Repo | `hyeonseokhan/kingshot-1767` |
| 도메인 | `1767.kingshot.co.kr` |
| Supabase project ref | `qbcpohhzfhaxzbuncsne` |
| 대상 | 1767 서버 전체 (~400명) — PNX 와 회원 풀 독립 |

**공통 lib 동기화 룰** — 두 사이트가 공유하는 자산은 **양쪽 repo 에 복붙** 패턴:
- `src/lib/supabase.ts`, `dialog.ts`, `dom-diff.ts`, `store.ts`, `utils.ts`, `image-optimize.ts`, `refresh-button.ts`
- `src/i18n/*` (현재 전체 복사, 추후 도메인별 분리)
- `src/components/{LangSwitcher,AuthDialog}.astro`
- `supabase/functions/tile-match-auth/` (PIN 인증 공유)

**둘 중 한 쪽에서 위 자산 변경 시 → 반드시 다른 쪽도 같이 갱신.** npm 패키지/submodule X — 운영 단순성 우선.

신규 repo 의 아키텍처는 **feature-based modular monolith** (`src/lib/shared/` + `src/lib/<domain>/`). 자세한 cookbook 은 kingshot-1767 의 CLAUDE.md 참고.

---

## 재사용 자산 인덱스

> 📌 작업 시작 전 반드시 스캔. 누락된 자산이 있으면 본 인덱스도 함께 갱신.

### 컴포넌트 ([src/components/](src/components/))

| 컴포넌트 | 용도 | 사용처 |
|---------|------|--------|
| `AuthDialog.astro` + `scripts/pages/tile-match-auth.ts` | PIN 4자리 인증 다이얼로그 (kingshot_id + PIN) | 미니게임 4종 |
| `Header.astro` | 상단 헤더 (로고 + 메뉴 + LoginedUserInfo + LangSwitcher) | BaseLayout 자동 |
| `LoginedUserInfo.astro` | 인증 위젯 (아바타 + 닉네임 + 💎 잔액 + 로그아웃) | Header 안 자동 |
| `LangSwitcher.astro` | 🌐 KOR/ENG 토글 — 클라이언트 swap | Header 안 자동 |
| `LeftNav` / `MobileNav` / `RightToc` | 가이드 네비게이션 | GuideLayout 자동 |
| `RefreshButton.astro` + `bindRefreshButton()` | 공통 새로고침 버튼 (회전 spinner, 최소 350ms) | 모든 list/ranking |
| `RankingTable.astro` + `renderRankingTable()` | 미니게임 랭킹 (1·2·3등 글로우 + 사진 fade + 정렬 pill) | tile-match, pvp |
| `MinigameLaunchCard.astro` | 미니게임 진입 카드 (라벨 + 메타 + CTA) | tile-match, partner-draw |
| `WeeklyRankingsPanel.astro` | 주간 1·2·3등 알림 패널 | 미니게임 상단 |

### 클라이언트 유틸 ([src/lib/](src/lib/))

| 모듈 | 핵심 API | 언제 쓰나 |
|------|---------|----------|
| `store.ts` | `createStore<T>({storageKey, ttlMs, validate})` | **페이지 간 데이터 공유** — 모듈 변수 패턴 금지 |
| `stores/members.ts` | `membersStore`, `fetchMembers()` | 연맹원 로스터 (4 페이지 공유) — `members` 직접 fetch 금지 |
| `dom-diff.ts` | `patchList({container,items,key,render,update})`, `patchText(el,val)` | **데이터 갱신 시 필수** — `innerHTML=''` 금지 |
| `dialog.ts` | `appAlert(msg)`, `appConfirm(msg, {variant:'danger'})` | **window.alert/confirm 금지** — 사이트 토큰 디자인 |
| `utils.ts` | `esc`, `formatDate`, `formatDateTime`, `formatRelativeTime`, `formatNum`, `formatPower`, `getLevelClass`, `truncate`, `delay`, `toggleOverlay`, `describeRedeemError`, `isAlreadyRedeemed` | 텍스트 포매팅 / HTML escape / 레벨 테두리 / 쿠폰 응답 해석 |
| `image-optimize.ts` | `optimizeImage(file, {maxWidth, quality, mimeType})`, `formatBytes` | 사용자 업로드 PNG/JPEG → WebP resize. iOS Safari 17 이하 WASM 폴백 |
| `balance.ts` | `rewardForStage`, `enhanceCostFor`, `accumulatedPower`, `tierForLevel`, `TIER_LABEL`, `EQUIPMENT_SLOTS`, `SLOT_LABEL` | 크리스탈/강화 (서버 mirror — 변경 시 양쪽 동시) |
| `equipment-tier-fx.ts` | `applyStageTier(stageEl, tier)`, `lowestStageTier(rows)` | 장비 stage 배경 + 모션 효과 |
| `ranking-table.ts` | `renderRankingTable({bodyId, columns, items, clickable})`, `setActiveSortPill` | RankingTable.astro 짝꿍 |
| `refresh-button.ts` | `bindRefreshButton(id, fn)` | RefreshButton.astro 짝꿍 |
| `troops-calculator.ts` | `calculate(input, mode)`, `validate(input)`, `formatRatio` | 부대 분배 — 순수 함수 |
| `cache.ts` | `getGiftCodesCache`, `getAccountsCache`, `invalidateAccountsCache`, `getFailedRefresh`, … | 쿠폰/계정/실패이력 sessionStorage 캐시 |
| `guides.ts` | `getGuidesByCategory`, `getGuideEn`, `buildNavItems` | 가이드 ko/en pair 매칭 |
| `supabase.ts` | `supabase`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase 클라이언트 단일 인스턴스 |
| `types.ts` | `Member`, `CouponAccount`, `ActiveCoupon`, `RedeemAccount`, … | DB row 타입 |

### 패턴 / 규칙 (이름 없는 자산이지만 항상 적용)

- **데이터 fetch**: 페이지 간 공유는 `createStore` + sessionStorage TTL. 모듈 변수 + custom event 금지
- **Mutation 후**: 반드시 `store.refresh(fetcher, true)` 로 force 갱신. 안 그러면 freshness 체크에 막혀 stale
- **리스트/row 갱신**: `patchList` + `data-key`. `innerHTML = ''` 또는 `el.innerHTML = template(items)` 금지
- **사진 페이드**: `<X>-photo-wrap` (grid stack) + placeholder span + `<img>` onload 시 `.<X>-photo-loaded` 클래스. transition 80ms
- **이벤트 핸들러**: 인라인 `onclick="X.foo(...)"` 금지. 컨테이너 click 위임 + `data-action` + `data-*`
- **다이얼로그**: native `<dialog>` (top layer) 또는 `appAlert`/`appConfirm`. 외부 fixed 토스트는 backdrop 가려짐 → dialog 내부 absolute
- **i18n**: 정적은 `data-i18n="key"` / `data-i18n-html` / `data-i18n-attr-*`. 동적 textContent 는 `onLangChange(() => 재렌더)` 콜백 필수
- **밸런스 상수**: `src/lib/balance.ts` (클라 mirror) + `supabase/functions/{economy,equipment}/index.ts` (authoritative) — 변경 시 양쪽 동시
- **새 Edge Function**: anon key 미사용 시 `supabase/config.toml` 의 `[functions.<name>]` 에 `verify_jwt = false` 등록
- **마이그레이션 파일명**: `YYYYMMDDHHMMSS_<verb>_<subject>.sql` + 파일 상단에 ROLLBACK SQL 주석 보존
- **컴포넌트/페이지**: `.astro` (마크업) + `src/scripts/{components,pages}/<name>.ts` (로직). 짝꿍 패턴

---

## 프로젝트 개요

- **목적**: PNX 연맹(Kingshot 게임) 사이트 — 가이드 + 멤버 관리 + 쿠폰 + 미니게임 + 관리도구
- **스택**: Astro 5 + TypeScript + Tailwind v4 + Supabase
- **호스팅**: GitHub Pages (정적 배포, `pnx.kingshot.co.kr`)
- **배포 자동화**: `main` push → `.github/workflows/deploy.yml` 자동 트리거
- **인증**: 멤버 로스터 PIN 4자리 (Supabase Auth 사용 안 함)
- **사용자 식별자**: `members.kingshot_id` (TEXT, 모든 도메인 테이블의 FK)

---

## 디렉토리 구조

```
src/
  components/    # 재사용 자산 인덱스 참고
  layouts/       # AppLayout, BaseLayout, GuideLayout
  pages/
    manage/      # members, blacklist, coupons
    minigame/    # tile-match, partner-draw, equipment, pvp
    game-tools/  # troops-calculator (관리자 전용)
    beginner/    # 가이드 (Content Collection)
    events/      # 이벤트 가이드
  scripts/
    components/  # lang-switcher, logined-user-info, weekly-rankings-panel
    pages/       # 각 페이지 클라 로직
  styles/        # global, components, manage, minigame, game-tools
  lib/           # 재사용 자산 인덱스 참고
  i18n/          # ko / en / index (다국어 사전 + 헬퍼)
  content/       # Astro Content Collection (가이드 마크다운, ko/en pair)
  data/          # navigation.ts (상단 메뉴 구조)

supabase/
  migrations/    # YYYYMMDDHHMMSS_*.sql
  functions/     # Edge Functions (Deno + TS) — 도메인 맵 참고
  config.toml    # 함수별 verify_jwt 정책
```

---

## 작업 분담 규칙

| 작업 | 담당 |
|------|------|
| `.sql` 마이그레이션 / Edge Function / 클라 코드 / 빌드 검증 / git 커밋·PR | Claude |
| `supabase db push` (production DB 적용) | Claude (직접 실행 + 결과 보고) |
| `supabase functions deploy <name>` | Claude (직접 실행 + 결과 보고) |
| GitHub Secrets / Pages / 환경 설정 | 사용자 |
| 브라우저 UI 회귀 검증 | 사용자 |

### Supabase CLI 운영

- **CLI 위치**: `/Users/toycode/bin/supabase` (이미 설치됨, 그대로 사용)
- **인증**: `.env` 의 `SUPABASE_ACCESS_TOKEN`. functions deploy 시 `set -a && source .env && set +a` 패턴으로 inject
- **DB push**: 별도 토큰 없이 동작 (link 됨)
- **흐름**: 코드 작성 + 빌드 검증 → Claude 가 DB → Function → push 순서로 직접 실행 → 결과 한 번에 요약 보고
- **CLI 없는 환경**: 새로 설치 전 사용자에게 확인 (과거 검증·우회에 시간 낭비한 적 있음)
- **가벼운 검증**: REST API + curl 로 anon key 만으로 가능한 작업은 CLI 거치지 않음

---

## 도메인 맵

각 도메인 작업 시 진입점 파일부터 확인. 백엔드는 Edge Function 우선, 없으면 클라 직접 supabase.

| 도메인 | URL | 클라 진입점 | 백엔드 (테이블 / Edge Function) |
|--------|-----|------------|-------------------------------|
| 회원 관리 | `/manage/members` | `members.ts` | `members` (RLS write 차단) |
| 블랙리스트 | `/manage/blacklist` | `blacklist.ts` | `blacklist` |
| 쿠폰 | `/manage/coupons` | `coupons.ts` | `redeem-coupon`, `player-info`, `gift-codes` EF |
| 가이드 | `/beginner/*`, `/events/*` | (Astro Content Collection) | 정적 빌드 (ko/en pair) |
| 타일매치 | `/minigame/tile-match` | `tile-match.ts` | `tile_match_records` + `economy` EF (`claim-stage-reward`) |
| 운명파트너 | `/minigame/partner-draw` | `partner-draw.ts` | `tile_match_records`, `members` |
| 장비 강화 | `/minigame/equipment` | `equipment.ts` | `equipment_levels` + `equipment` EF (`enhance`) |
| PvP | `/minigame/pvp` | `pvp.ts` | `pvp_battles`, `pvp_daily_state` + `pvp` EF |
| 부대 계산기 | `/game-tools/troops-calculator` | `game-tools-troops-calculator.ts` (+ `game-tools-guard.ts`) | 계산은 순수 클라 + 프로필 슬롯 1~5 는 `troops_profiles` + `troops-profiles` EF (관리자 한정 — `kingshot_id == '270680423'`) |

**Edge Function 디스패치 패턴**: 모든 함수는 action 디스패치 방식. 레퍼런스 = `supabase/functions/tile-match-auth/index.ts` (PIN 검증), `economy/index.ts` (stage→reward + RPC), `pvp/index.ts` (서버측 데미지 + 멱등 보상).

---

## 핵심 밸런스 / 비즈니스 룰

### 크리스탈 보상 (`balance.ts:rewardForStage` + `economy/index.ts`)
- Stage 1: 100 (튜토리얼) · 2~10: 5씩 점진 · 11~20: 100~300 · 21~45: 500+20씩 · 46~999: 100 반복 · 1000+: 1000 (D11)
- 첫 클리어만 (`crystal_transactions.ref_key` UNIQUE). 46+ 는 ref_key NULL 로 반복 파밍

### 장비 강화 (`balance.ts:ENHANCE_RANGES` + `equipment/index.ts`)
- 6 부위 (월계관/목걸이/상의/하의/반지/지팡이) × 최대 +100 단계
- 6 RPG 등급: 일반(+0) / 고급(+1~9) / 희귀(+10~24) / 영웅(+25~44) / 레전드(+45~69) / 신화(+70~100)
- 실패 시 크리스탈만 소모, 등급 유지
- **변경 시 양쪽 동시**: `src/lib/balance.ts` + `supabase/functions/equipment/index.ts` + `equipment.astro` 안내 텍스트

### PvP (`pvp/index.ts`)
- 비동기 — 방어자는 DB power 로 자동 응전
- HP 1000 고정 · 5턴 후 잔여 HP 비교 · 일일 공격 5회 (KST 자정 리셋), 방어 무제한
- 카드 3종 (공격/강화/방어) — 매 턴 3장 중 1택
- 데미지 서버 계산 (share-based + chip floor + 격돌 메커닉), 클라는 카드 선택만 전송
- `is_ranked` 분리: ranked (일일 5회 안) / 연습 (자유) — 보상/승수는 ranked 만

### 부대 계산기 분배 (`troops-calculator.ts`)
- 병종 강함 순서 = **궁병 > 기병 > 보병**. 분배는 강한 병종 우선 충원.
- **병종 시너지 floor** = cap*10% (`SYNERGY_RATIO`). 한 편대에서 어떤 병종이 참여(분배>0)하면 cap*10% 이상이어야 시너지 발동. 몰빵형 fallback 편대에서 궁병·보병에 이 floor 우선 보장 (보유/자리 부족하면 그만큼만 — floor 미달 허용, 0 이면 안 넣음)
- 몰빵형(`bear-stack`) fallback 편대 순서: 궁병(평탄+floor, 자기자리 한도) → **보병 floor(=cap*10%) 먼저 양보** → **기병이 남은 자리 최대 충원**. 기/보 1:1 균등 아님. 마지막 1개 fallback 편대는 기병 보유 전량, 여러 개면 평탄(floor) 분배
- 권장값(`bear`)은 기존 1:1 균등 유지 — 의도적. 몰빵형만 기병 우선 + 시너지 floor
- 프로필 슬롯: 전역 1~5 (player_id 무관 — 관리자 전용 도구라). 쓰기는 EF(service_role)만

---

## 운영 함정 (영구 가치)

다시 만나면 똑같이 당함. 신규 작업 시 해당 영역 건드리면 본 섹션 먼저 체크.

- **`apply_crystal_transaction` PG `INSERT...ON CONFLICT` CHECK 함정** — 음수 amount 차감 시 INSERT VALUES 의 balance 컬럼에 raw 값 넣으면 항상 CHECK violation. `INSERT VALUES (..., GREATEST(amount, 0), ...)` + `DO UPDATE` 분기에서만 raw amount 적용
- **Stage cap 회귀** — 서버 입력 검증 cap 이 클라 `rewardForStage` 보다 좁으면 silent 손실. cap 은 `balance.ts:rewardForStage` 와 일치 유지. 청구 실패 응답은 silent 무시 X, 토스트로 표시
- **patchList container 안 비-row 자식** — `data-key` 없는 자식(status/label 등)이 있으면 새 row appendChild 가 그 뒤로 밀려 순서 꼬임. 비-row 는 형제 element 로 분리해서 patchList container **밖**에 둘 것
- **store force=true 누락** — Mutation 후 `store.refresh(fetcher, true)` 안 부르면 freshness 체크에 막혀 stale. `members.ts` 의 5곳 레퍼런스 패턴
- **모달 결과 토스트** — native `<dialog>` 가 top layer 라 외부 fixed 토스트는 backdrop 에 가려짐. dialog 내부 absolute 로 두기
- **i18n 동적 텍스트** — JS 가 `textContent` 로 박은 곳은 `onLangChange(() => 재렌더)` 콜백 필수. 정적 마크업만 자동 swap. 새 키는 `ko.ts` + `en.ts` 둘 다 채워야 `astro check` 통과
- **이미지 dialog src 교체 잔상** — `<img>` src 만 바꾸면 새 이미지 디코드 전까지 이전 이미지 그대로 보임. src 교체 직전 `img.src = ''` 또는 명시 hide → 새 src 로 (블랙리스트 인증샷 lightbox 레퍼런스)

---

## 완료된 마일스톤

진행 이력 — 자세한 변경은 `git log` 로 추적.

- **Phase A** (2026-04): 크리스탈 경제 기반 — `crystal_balances/transactions` + `economy` EF + tile-match 보상 청구
- **Phase B** (2026-04): 장비 강화 — `equipment_levels` + `equipment` EF + 100 단계/6 RPG 등급
- **Phase C** (2026-04): PvP 카드 대결 — `pvp_battles/daily_state` + `pvp` EF + share-based 데미지 + 연습/랭크 분리
- **트랙 1** (2026-04): 깜박임 100% 제거 — keyed reconcile + 사진 fade (`dom-diff.ts`, `store.ts`)
- **트랙 2** (2026-04): I/O 최적화 — 페이지 간 중복 fetch 60% 감소 (`membersStore` 도입)
- **트랙 3** (2026-04): DB 정리 — dead column/index 4+2 개 삭제 + pvp 자동청소 포기 결정
- **트랙 4** (2026-05): KOR/ENG 다국어 — `src/i18n/{ko,en}.ts` + 가이드 pair + LangSwitcher
- **블랙리스트** (2026-05): `/manage/blacklist` + `blacklist` 테이블
- **사이트 도메인 분리** (2026-05): KvK 설문 → `kingshot-1767` repo + `1767.kingshot.co.kr` 로 완전 분리. PNX 측 KvK 자산 (테이블/RPC/Storage/i18n/코드) 일괄 정리. 공유 lib 동기화 룰 신설

---

## 코딩 컨벤션

- 컴포넌트: `.astro`, 클라 로직: `src/scripts/{components,pages}/<name>.ts` (짝꿍)
- 스타일: 도메인별 CSS 파일 분리 (`global`, `components`, `manage`, `minigame`, `game-tools` 등)
- 한국어 식별자(키) 사용 시 주석으로 의미 부연 (예: `kingshot_id` = 게임 ID)
- Edge Function: Deno + TS, action 디스패치 패턴 (`tile-match-auth/index.ts` 레퍼런스)
- 마이그레이션: `YYYYMMDDHHMMSS_<verb>_<subject>.sql` + 파일 상단 ROLLBACK SQL 주석

---

## 참고 문서

- `supabase/migrations/` — DB 스키마 (최신은 `git log -- supabase/migrations/` 로 확인)
- `supabase/functions/tile-match-auth/index.ts` — Edge Function 패턴 레퍼런스 (PIN 검증)
- `supabase/functions/economy/index.ts` — stage→reward 매핑 + RPC 호출 패턴
- `supabase/functions/pvp/index.ts` — 서버측 데미지 + 멱등 보상 패턴
- `~/.claude/projects/.../memory/` — 사용자 메모리

---

## 다른 PC 합류 시 setup

```bash
git pull origin main
npm install
# .env 파일은 git ignore — 다른 PC 에 별도 복사 필요
#   필수 키: PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_ACCESS_TOKEN
npm run dev   # 로컬 미리보기 (Astro dev server)
```
