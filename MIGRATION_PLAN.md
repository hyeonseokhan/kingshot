# Jekyll → Astro 마이그레이션 계획

> 브랜치: `migrate/astro`
> 작성일: 2026-04-28
> 대상: PNX 연맹 가이드 (https://kingshot.wooju-home.org)

---

## 1. 배경 / 목적

현재 프로젝트는 Jekyll 정적 사이트 위에 점점 무거워지는 JS 인터랙티브 콘텐츠가 얹혀있는 구조다. 콘텐츠가 늘면서 다음 한계가 누적됐다:

- `_layouts/default.html` 단일 파일 563줄에 4개 탭(beginner/events/manage/minigame) 마크업이 혼재
- `_includes/` 빈 폴더 → 공통 컴포넌트(모달, 페이지 헤더, page-intro 등) 추출 0건
- `assets/css/style.css` 1,772줄 단일 파일 (prefix만으로 느슨하게 스코프됨)
- JS 6개 파일 3,300줄, IIFE + `window.X` 네임스페이스로 우회
- TypeScript 미사용, npm 생태계 미사용 (CDN 로드만 가능)
- `app.js:46` `fireSubmenuInit`이 페이지 모듈을 하드코딩 if-else로 디스패치
- `tile-match.js` 단일 파일 1,057줄

앞으로 가이드 + 인터랙티브 웹 콘텐츠 양쪽 모두 추가될 예정이다. Astro는 이 혼합형 케이스(문서 + JS 컴포넌트)에 최적화된 도구이며, GitHub Pages 정적 배포·Supabase 무료 플랜 제약과 모두 호환된다.

---

## 2. 마이그레이션 후 기대 결과

| 항목 | Jekyll (현재) | Astro (이후) |
|---|---|---|
| 마크다운 가이드 처리 | Jekyll collections | Astro Content Collections (타입 안전) |
| 컴포넌트 | 텍스트 치환(`_includes`) | `.astro` 컴포넌트 (props/slot) |
| 인터랙티브 페이지 | IIFE + window | TypeScript 모듈 + Astro Islands |
| 타입 시스템 | 없음 | TypeScript 전체 |
| 의존성 관리 | CDN `<script>` | npm + Vite 번들 |
| CSS | 단일 1,772줄 | Scoped styles + 공통 토큰 |
| 빌드 | GitHub Pages 내장 | GitHub Actions (공식 템플릿) |
| 호스팅 | GitHub Pages | GitHub Pages (변경 없음) |
| 도메인 | kingshot.wooju-home.org | kingshot.wooju-home.org (변경 없음) |
| Supabase | 동일 URL/anon key | 동일 URL/anon key (DB 무손상) |

---

## 3. DB·백엔드 안전 보장

**다음 항목은 마이그레이션 중 절대 손대지 않는다:**

- `supabase/migrations/` — DB 스키마 마이그레이션 파일
- `supabase/functions/` — Edge Functions (`redeem-coupon`, `gift-codes`, `tile-match-auth`, `player-info`)
- Supabase 프로젝트 자체 (URL, anon key, 테이블, RLS 정책)
- 운영 중인 데이터 (`members`, `coupon_accounts`, `coupon_history`, `tile_match_records`, `member_credentials`)

**근거**: 마이그레이션은 100% 클라이언트 사이드 변경이다. Astro 빌드 결과는 정적 HTML/JS/CSS이며, 동일한 anon key로 동일한 Supabase 프로젝트를 호출한다. 백엔드는 클라이언트가 무엇으로 작성됐는지 모르고 무관하다.

---

## 4. 사전 인벤토리 (현 상태 스냅샷)

### 4.1 페이지 / 기능

| 탭 | 서브 | 형식 | 주요 자산 |
|---|---|---|---|
| beginner | (7개 .md) | 가이드형 | `_guides/beginner/01~07.md` |
| events | (3개 .md) | 가이드형 | `_guides/events/01~03.md` |
| manage | members | 앱형 | `members.js` (591줄) |
| manage | coupons | 앱형 | `coupons.js` (974줄) |
| minigame | tile-match | 앱형 | `tile-match.js` (1057줄) + `tile-match-auth.js` (326줄) |
| minigame | partner-draw | 앱형 | `partner-draw.js` (225줄) |

### 4.2 Supabase 사용 (DB 변경 없음, 참조만)

- **테이블**: `members`, `coupon_accounts`, `coupon_history`, `tile_match_records`, `member_credentials`
- **Edge Functions**: `redeem-coupon`, `gift-codes`, `tile-match-auth`, `player-info`
- **Auth**: anonymous (anon key만 사용, 사용자 로그인 없음)

### 4.3 외부 의존

- `https://kingshot-giftcode.centurygame.com/api` — Edge Function 경유로만 호출 (프론트는 직접 안 부름)
- CDN: Pretendard 폰트, JetBrains Mono, `@supabase/supabase-js` v2 → npm 패키지로 전환 예정

### 4.4 URL 라우팅 (Astro 페이지 라우팅으로 전환)

**결정**: 기존 hash 라우팅 → Astro 페이지 라우팅으로 전환. 신규 프로젝트 표준에 맞추는 것이 장기적으로 합리적.

| 기존 (hash) | 신규 (path) |
|---|---|
| `/#beginner` 또는 `/` | `/` (첫 입문 가이드 직접 렌더) |
| `/#beginner-3` | `/beginner/03-vip-arena/` |
| `/#beginner-3:slug` | `/beginner/03-vip-arena/#slug` |
| `/#events` | `/events/` (첫 이벤트 가이드 직접 렌더) |
| `/#events-1` | `/events/01-viking-raid/` |
| `/#manage-members` | `/manage/members/` |
| `/#manage-coupons` | `/manage/coupons/` |
| `/#minigame-tile-match` | `/minigame/tile-match/` |
| `/#minigame-partner-draw` | `/minigame/partner-draw/` |
| `?auto-redeem=true` | `/manage/coupons/?auto-redeem=true` (유지) |

> URL 평탄화: `/guides/` 접두사를 두지 않고 탭 id 자체를 path 첫 세그먼트로 사용 (`/beginner/`, `/events/`). 헤더 탭과 1:1 매칭되어 직관적.

**레거시 hash 호환성**: 기존 외부 링크(예: 단톡방 공유)가 깨지지 않도록, 루트 `/`에서 진입 시 `location.hash`를 감지해 신규 path로 `replaceState` 하는 작은 클라이언트 스크립트(`legacy-hash-redirect.ts`)를 추가. Phase 2에서 구현.

### 4.5 sessionStorage 키 (보존 대상)

- `tileMatchAuth` — 인증 정보
- `members_failed_refresh_v1` — 갱신 실패 이력
- `gift_codes_cache`, `coupon_accounts_cache` — 캐시
- 사용자 입장에서 새로고침 후에도 작동해야 하므로 키·구조 유지

---

## 5. 작업 단계 (Phase)

### Phase 0 — 준비
- [x] `migrate/astro` 브랜치 생성
- [x] 본 계획서 작성

### Phase 1 — Astro 프로젝트 골격 (Jekyll과 공존)

**목표**: Jekyll 사이트는 기존대로 두고, 별도 폴더에 Astro를 설치해 빌드만 가능한 상태로 만든다.

- [ ] `package.json` 초기화
- [ ] Astro + TypeScript + Tailwind + `@supabase/supabase-js` 설치
- [ ] `astro.config.mjs` 작성 (`site`, `output: 'static'`, Tailwind 통합)
- [ ] `tailwind.config.mjs` 작성 (현재 CSS 토큰을 theme으로 이식: `--bg`, `--bg2`, `--text`, `--text2`, `--border`, `--border2`)
- [ ] `tsconfig.json` (Astro strict)
- [ ] `src/` 디렉토리 구조 결정 (아래 §6 참조)
- [ ] `.env.example` (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`) + 로컬 `.env` 작성 (gitignore됨)
- [ ] `.gitignore`에 `node_modules/`, `dist/`, `.astro/` 추가
- [ ] `npm run build`로 빈 프로젝트가 빌드되는지 확인

**Tailwind 도입 전략 (시각적 회귀 최소화)**:
- 기존 CSS 변수를 Tailwind theme에 그대로 이식 → 색상·간격 토큰이 1:1 매칭
- 레이아웃·간격·타이포그래피·반응형은 Tailwind 유틸리티로 작성
- 복잡한 게임 UI(`tm-*`, `pd-slot-*`), 다이얼로그 애니메이션 등 1,772줄 중 게임/다이얼로그 영역은 **scoped CSS 그대로 보존** → Tailwind로 강제 변환 시 시각 회귀 위험 큼
- 결과적으로 **하이브리드**: Tailwind(80%) + 기존 scoped CSS(20%, 게임/다이얼로그)

**위험**: 없음. Jekyll 빌드는 그대로 동작.

### Phase 2 — 레이아웃 + 라우팅 골격

**목표**: 두 가지 레이아웃 패턴을 명시 분리하고, Astro 페이지 라우팅 + 헤더 활성 상태 동기화까지 정상 동작.

- [ ] `src/layouts/BaseLayout.astro` — 공통 head + 헤더 + 모바일 메뉴 + footer
- [ ] `src/layouts/GuideLayout.astro` — 좌 nav + content + 우 TOC (BaseLayout 위)
- [ ] `src/layouts/AppLayout.astro` — 좌 nav(서브메뉴) + main slot (BaseLayout 위)
- [ ] `src/components/Header.astro` — 탭 nav(현재 path 기반 active)
- [ ] `src/components/MobileNav.astro`
- [ ] `src/components/LeftNav.astro` — 가이드/앱 모드 분기
- [ ] `src/components/RightToc.astro` — 스크롤 스파이 client script
- [ ] `src/data/navigation.ts` — 기존 `navigation.yml` 이식 + 타입 정의 (`{ id, title, path, submenus? }`)
- [ ] `src/scripts/legacy-hash-redirect.ts` — 루트 진입 시 `#beginner-3:slug` → `/guides/beginner/03-...#slug` 변환 후 `replaceState`
- [ ] 빈 페이지 라우트 (Phase 3~5에서 채움):
  - `src/pages/index.astro` (입문 가이드 첫 항목으로 redirect)
  - `src/pages/guides/[category]/[slug].astro` (동적 라우트)
  - `src/pages/manage/members.astro`, `manage/coupons.astro`
  - `src/pages/minigame/tile-match.astro`, `minigame/partner-draw.astro`
- [ ] 헤더 탭 클릭 → 해당 path로 이동 / 현재 path 기반 active 표시 동작 확인

**위험**:
- Astro는 페이지 이동 시 기본적으로 풀 페이지 리로드. 인터랙티브 페이지(타일매치 게임 중)에서 다른 탭으로 이동하면 게임 상태 소실 — 기존과 동일한 동작이라 무관 (현재도 탭 전환 시 게임 종료됨).
- View Transitions(`<ClientRouter />`) 도입은 **Phase 7로 미룸** — 마이그레이션 동등성 검증을 흐림.

### Phase 3 — 가이드형 콘텐츠 (beginner, events)

**목표**: `_guides/`의 마크다운 10개를 Astro Content Collection으로 이식.

- [ ] `src/content/config.ts` — `guides` collection 스키마 (`category`, `order`, `title`)
- [ ] `_guides/beginner/*.md` → `src/content/guides/beginner/*.md` (frontmatter 그대로)
- [ ] `_guides/events/*.md` → `src/content/guides/events/*.md`
- [ ] `src/pages/index.astro`, `src/pages/events.astro`에서 `getCollection()`으로 렌더
- [ ] 우측 TOC 자동 생성 (heading 추출)
- [ ] heading anchor (`#`) 동작 확인
- [ ] `#beginner-3:slug` 형식 deep link 동작 확인

**위험**: 마크다운 `id` 자동 생성 방식이 Jekyll(kramdown)과 Astro(rehype-slug)에서 다를 수 있음 → slug 알고리즘 맞추기. 다르면 외부 링크가 깨질 수 있다.

**검증**: 마이그레이션 전후로 모든 heading의 id가 동일한지 자동 비교 스크립트.

### Phase 4 — 앱형 콘텐츠: members, coupons

**목표**: 연맹원·쿠폰 페이지를 TypeScript로 이식.

- [ ] `src/lib/supabase.ts` — Supabase 클라이언트 (anon key는 환경변수 또는 기존처럼 인라인)
- [ ] `src/lib/types.ts` — DB row 타입 정의 (`Member`, `CouponAccount`, `CouponHistory`)
- [ ] `src/lib/utils.ts` — 기존 `utils.js` TypeScript로 이식 (`esc`, `formatDate`, `formatNum`, `getLevelClass`, `truncate`, `describeRedeemError` 등)
- [ ] `src/components/Modal.astro`, `ManageDialog.astro`, `PageHeader.astro`, `PageIntro.astro`
- [ ] `src/pages/manage/members.astro` — 마크업
- [ ] `src/scripts/pages/members.ts` — 로직 (591줄을 TS로)
- [ ] `src/pages/manage/coupons.astro` — 마크업
- [ ] `src/scripts/pages/coupons.ts` — 로직 (974줄을 TS로)
- [ ] `?auto-redeem=true` 쿼리 동작 확인
- [ ] sessionStorage 키 (`gift_codes_cache`, `coupon_accounts_cache`, `members_failed_refresh_v1`) 동일하게 사용
- [ ] 모달·다이얼로그·토스트 동작 확인

**원칙**: 이 Phase는 **로직 동등성 우선**. 리팩터링은 다음 Phase. 기존 591+974줄을 그대로 TS화 (any 허용 → 점진적 strict).

**위험**: members ↔ coupons 모달이 거의 동일 → 통합 컴포넌트 유혹이 있지만 Phase 4에선 참는다(동등성 검증을 흐림). Phase 7에서 리팩터.

### Phase 5 — 앱형 콘텐츠: minigame

**목표**: 타일매치(인증 포함) + 운명의 파트너 이식.

- [ ] `src/components/AuthBadge.astro`, `AuthDialog.astro`
- [ ] `src/scripts/pages/tile-match-auth.ts` (326줄)
- [ ] `src/scripts/pages/tile-match.ts` (1057줄)
- [ ] `src/scripts/pages/partner-draw.ts` (225줄)
- [ ] `assets/data/tile-match-level.json` → `src/data/tile-match-level.json` (113KB, import 경로 변경)
- [ ] `visualViewport` / `ResizeObserver` 모바일 뷰포트 동작 확인
- [ ] PIN 인증 흐름(set/verify) 동작 확인
- [ ] 랭킹 / 게임 진행 / 아바타 타일 / 아이템(remove/undo/shuffle) 모두 동작
- [ ] 셔플 카카오페이 팝업 + QR 화면 이동 동작

**위험**: tile-match.js의 절차적 보드 생성, ResizeObserver 기반 자동 스케일이 가장 복잡. **이식 후 모바일 실기기 테스트 필수**.

### Phase 6 — CSS 정리 (Tailwind 하이브리드)

**목표**: 1,772줄 단일 CSS를 Tailwind 유틸리티 + scoped 컴포넌트 CSS의 하이브리드로 재구성.

**Tailwind로 전환 (단순 레이아웃·간격·색상)**:
- [ ] 헤더, 좌측 nav, 우측 TOC, 페이지 헤더·intro
- [ ] `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-sm` → Tailwind `@apply` 컴포넌트 (재사용 일관성)
- [ ] 모달 오버레이, 폼 row, 입력 필드
- [ ] 멤버 리스트·쿠폰 카드 그리드(레이아웃만, 카드 내부 디테일은 scoped)
- [ ] 미디어쿼리 → Tailwind 반응형 prefix(`md:`, `lg:`)

**scoped CSS 유지 (시각 회귀 위험 큰 영역)**:
- [ ] `.tm-*` (타일매치 게임 보드, 버퍼, 다이얼로그, 인증) — 약 600줄
- [ ] `.pd-*` (운명의 파트너 슬롯머신 애니메이션) — 약 200줄
- [ ] `.md-*` (관리 다이얼로그)
- [ ] `.lv-*` (레벨별 프로필 테두리 효과)
- [ ] 셔플 카카오페이 팝업 등 1회성 특수 UI
- [ ] 각 영역은 해당 `.astro` 컴포넌트의 `<style>` 블록으로 이동 (Astro 자동 scope)

**공통 토큰 (Tailwind theme 확장)**:
- [ ] `tailwind.config.mjs`에서 `theme.extend.colors` / `spacing`을 기존 CSS 변수와 매핑
- [ ] `src/styles/tokens.css` — Tailwind가 못 잡는 CSS 변수만 (예: `--vh-real` 같은 동적 변수)
- [ ] 폰트(`Pretendard`, `JetBrains Mono`) → `tailwind.config.mjs`의 `fontFamily`에 등록

**위험**: scoped CSS 전환 시 selector specificity 변화 → 시각적 회귀 가능. **페이지별 스크린샷 before/after 비교 필수**. 특히 게임 화면은 모바일 실기기에서 확인.

### Phase 7 — 코드 최적화 (마이그레이션 직후 정리)

> ※ 처음 못 했던 설계 개선들. **Phase 6까지 끝나야 비로소 안전하게 진행 가능.**

- [ ] **공통 컴포넌트 통합**: members 등록 모달 ↔ coupons 등록 모달 → `<PlayerSearchModal>` 단일 컴포넌트
- [ ] **자동 디스패치**: 페이지 모듈 자동 등록(`window.PageModules` 또는 import.meta.glob) — 새 페이지 추가 시 라우터 수정 불필요
- [ ] **타입 강화**: `any`로 이식한 부분을 strict 타입으로 점진 변환
- [ ] **데드코드 제거**: 사용 안 하는 함수/CSS 클래스 식별 후 삭제
- [ ] **에러 처리 일관화**: try/catch + Toast 표시 패턴 통일
- [ ] **Supabase 호출 추상화**: `src/lib/api/{members,coupons,tile-match}.ts`에 한 데 모음 (현재 fetch + REST URL 하드코딩 분산)
- [ ] **상수 분리**: 매직 넘버(배치 크기 5, delay 500/1000ms 등) `src/lib/constants.ts`로
- [ ] **ESLint + Prettier** 설정 (TS strict, 컨벤션 강제)

### Phase 8 — 배포 / 정리

- [ ] `.github/workflows/jekyll.yml` 삭제
- [ ] `.github/workflows/astro.yml` 추가 (Astro 공식 GitHub Pages 템플릿)
- [ ] `CNAME` 파일이 빌드 결과(`dist/`)에 포함되도록 처리 (`public/CNAME`)
- [ ] Jekyll 잔재 삭제:
  - `_config.yml`, `Gemfile`, `Gemfile.lock`
  - `_layouts/`, `_includes/`, `_data/`
  - `_guides/` (콘텐츠는 `src/content/guides/`로 이동 완료)
  - `assets/` (전부 `src/`나 `public/`로 이동 완료)
  - `_site/` (빌드 결과)
  - `index.html` (Jekyll 진입점)
  - `start.bat` (로컬 Jekyll 서버 실행 스크립트)
  - `.gitattributes` (Jekyll 줄바꿈 관련)
  - `Gemfile.lock` 등
- [ ] **유지하는 폴더** (Jekyll과 무관):
  - `supabase/` — 백엔드 (절대 삭제 금지)
  - `client_tools/` — Python 스크래퍼 (웹과 무관)
  - `.github/` — 워크플로 교체만
  - `CNAME` — 도메인 설정
- [ ] `.gitignore` 정리 (Jekyll 항목 제거, Astro 항목 정착)
- [ ] 백업 폴더 사용 여부: **불필요**. git history가 백업이며, 필요 시 `main` 브랜치에서 임의 시점 체크아웃 가능.
- [ ] 운영 도메인 빌드 결과 푸시 전 staging 브랜치에서 미리 확인 (선택)

---

## 6. 디렉토리 구조 (Phase 1 결정)

```
kingshot/
├─ src/
│  ├─ pages/                   # Astro 라우트 (파일 = URL)
│  │  ├─ index.astro           # 입문 가이드 (beginner)
│  │  ├─ events.astro
│  │  ├─ manage/
│  │  │  ├─ members.astro
│  │  │  └─ coupons.astro
│  │  └─ minigame/
│  │     ├─ tile-match.astro
│  │     └─ partner-draw.astro
│  ├─ layouts/
│  │  ├─ BaseLayout.astro      # 공통 head + 헤더 + 모바일 메뉴
│  │  ├─ GuideLayout.astro     # 가이드형 (좌 nav + 본문 + TOC)
│  │  └─ AppLayout.astro       # 앱형 (좌 nav + main)
│  ├─ components/
│  │  ├─ Header.astro
│  │  ├─ MobileNav.astro
│  │  ├─ LeftNav.astro
│  │  ├─ RightToc.astro
│  │  ├─ Modal.astro
│  │  ├─ ManageDialog.astro
│  │  ├─ PageHeader.astro
│  │  ├─ PageIntro.astro
│  │  ├─ AuthBadge.astro
│  │  ├─ AuthDialog.astro
│  │  └─ PlayerCard.astro
│  ├─ content/
│  │  ├─ config.ts             # collection 스키마
│  │  └─ guides/
│  │     ├─ beginner/01~07.md
│  │     └─ events/01~03.md
│  ├─ scripts/
│  │  ├─ router.ts             # hash 라우팅
│  │  └─ pages/
│  │     ├─ members.ts
│  │     ├─ coupons.ts
│  │     ├─ tile-match.ts
│  │     ├─ tile-match-auth.ts
│  │     └─ partner-draw.ts
│  ├─ lib/
│  │  ├─ supabase.ts
│  │  ├─ utils.ts
│  │  ├─ constants.ts
│  │  ├─ types.ts
│  │  └─ api/                  # Phase 7에서 추출
│  ├─ data/
│  │  ├─ navigation.ts
│  │  └─ tile-match-level.json
│  └─ styles/
│     ├─ tokens.css
│     ├─ base.css
│     └─ components/
├─ public/                     # 정적 파일 (빌드 시 그대로 복사)
│  ├─ CNAME                    # GitHub Pages 커스텀 도메인
│  ├─ favicon.ico
│  └─ images/                  # 기존 assets/images/ 이동
├─ supabase/                   # ★ 손대지 않음
├─ client_tools/               # ★ 손대지 않음
├─ .github/workflows/astro.yml # 새 워크플로
├─ astro.config.mjs
├─ tsconfig.json
├─ package.json
└─ MIGRATION_PLAN.md           # 본 문서
```

---

## 7. 검증 체크리스트 (Phase 8 직전)

### 기능 동등성 (모든 항목 ✅ 필수)

**가이드 (beginner / events)**
- [ ] 좌측 nav 클릭 → 해당 섹션 표시
- [ ] 우측 TOC 자동 생성 + 스크롤 스파이
- [ ] heading anchor 클릭 → URL 해시 업데이트
- [ ] `#beginner-3:slug` 직접 접속 시 해당 위치로 스크롤
- [ ] 모바일 메뉴 펼침/접힘 + 네비게이션

**연맹원 관리 (members)**
- [ ] 목록 로드 + 정렬 (등급 → 레벨 → 파워)
- [ ] 레벨 필터 동작
- [ ] 등록 모달 + 킹샷 ID 조회 + 저장
- [ ] 관리 다이얼로그 (등급 변경, 자동 쿠폰 토글, 삭제)
- [ ] 전체 갱신 (5건 배치, 실패 배너)
- [ ] 단일 갱신

**쿠폰 (coupons)**
- [ ] 활성 쿠폰 목록 로드 (D-3 강조)
- [ ] 계정 등록 모달 (외부 인원)
- [ ] 전체 수령 + 진행률 표시
- [ ] 수령 이력 다이얼로그 (페이지네이션, 상대 시간)
- [ ] 닉네임 검색
- [ ] `?auto-redeem=true` 쿼리 자동 발동

**타일매치 (tile-match)**
- [ ] PIN 본인인증 (set / verify 양쪽)
- [ ] 인증 상태 헤더 뱃지 + 전환 버튼
- [ ] 게임 시작 / 보드 생성 / 타일 클릭 / 매칭 / 클리어
- [ ] 아이템: 제거 🧹 / 되돌리기 ↩️ / 재배치 🔀
- [ ] 셔플 카카오페이 팝업 + QR 이동
- [ ] 랭킹 표시
- [ ] 모바일 뷰포트 자동 스케일 (visualViewport)
- [ ] 아바타 타일 (멤버 프로필 사진 등장)

**운명의 파트너 (partner-draw)**
- [ ] 인원 스테퍼 (2~4)
- [ ] 슬롯머신 애니메이션
- [ ] 본인 자동 제외
- [ ] 결과 카드 표시

### URL / 외부 링크
- [ ] 모든 기존 hash URL이 동일하게 작동
- [ ] heading slug가 Jekyll과 동일하게 생성됨

### 데이터 무결성
- [ ] Supabase 테이블 데이터 변경 없음 (마이그레이션 전후 row count 비교)
- [ ] sessionStorage 키 호환 (기존 사용자가 새로고침해도 인증 유지)
- [ ] Edge Function 호출 응답 동일

### 배포
- [ ] `npm run build` → `dist/CNAME` 포함
- [ ] GitHub Actions 빌드 성공
- [ ] `kingshot.wooju-home.org`에 정상 배포
- [ ] HTTPS 인증서 정상

---

## 8. 롤백 계획

마이그레이션 후 문제가 발견되면:

1. **즉시 롤백**: GitHub Pages 워크플로를 `main` 브랜치 기준으로 재실행 (Jekyll 빌드)
2. **`migrate/astro` 브랜치 머지 전까지 `main`은 무손상** — 외부 사용자는 영향 없음
3. **DB는 항상 안전**: 백엔드 코드 변경이 0이므로 클라이언트만 되돌리면 끝

---

## 9. 일정 추정

| Phase | 예상 시간 | 비고 |
|---|---|---|
| 1. 골격 | 1~2시간 | npm/Astro/TS 설정 |
| 2. 레이아웃·라우팅 | 2~4시간 | 핵심 골격 |
| 3. 가이드 이식 | 1~2시간 | 마크다운 + slug 검증 |
| 4. members/coupons | 4~6시간 | TS 이식, 동등성 우선 |
| 5. minigame | 4~6시간 | tile-match가 가장 복잡 |
| 6. CSS 정리 | 2~3시간 | scoped + 토큰 |
| 7. 최적화 | 3~5시간 | 컴포넌트 통합, 디스패치, 상수, 타입 강화 |
| 8. 배포·정리 | 1~2시간 | 워크플로 교체, Jekyll 삭제 |
| **합계** | **18~30시간** | 분할 가능 |

여러 세션에 나눠 진행 가능. 각 Phase는 독립 커밋 단위로 관리.

---

## 10. 결정 사항 (확정)

| # | 항목 | 결정 |
|---|---|---|
| 1 | **라우팅 방식** | **Astro 페이지 라우팅** — 신규 표준 채택. 레거시 hash URL은 루트 진입 시 redirect 스크립트로 호환 |
| 2 | **Supabase anon key 위치** | **환경변수** (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`) — `.env.example` 커밋 |
| 3 | **CSS 프레임워크** | **Tailwind 도입** — 단, 게임/다이얼로그 영역은 scoped CSS 보존하는 하이브리드. 시각 회귀 최소화 |
| 4 | **Phase 7 시점** | **별도 PR** — 본 마이그레이션 PR은 동등성 검증, 리팩터는 후속 PR에서 |

---

## 11. 변경 이력

| 일자 | 내용 |
|---|---|
| 2026-04-28 | 초안 작성 |
| 2026-04-28 | 4개 결정 사항 확정 반영 (페이지 라우팅 / 환경변수 / Tailwind 하이브리드 / Phase 7 별도 PR) |
| 2026-04-28 | Phase 2 완료 — URL 평탄화(`/guides/` 접두사 제거), 6 라우트 동작 확인 |
