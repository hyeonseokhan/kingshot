# PNX 연맹 사이트 — Claude 작업 지침

이 파일은 Claude Code 세션 시작 시 자동 로드되는 프로젝트 컨텍스트야.
새 세션에서도 작업 흐름과 결정사항을 잃지 않기 위한 단일 진실 공급원(SSOT).

---

## 프로젝트 개요

- **목적**: PNX 연맹(Kingshot 게임) 사이트 — 가이드 + 멤버 관리 + 쿠폰 + 미니게임
- **스택**: Astro 5 + TypeScript + Tailwind v4 + Supabase
- **호스팅**: GitHub Pages (정적 배포, `kingshot.wooju-home.org`)
- **배포 자동화**: `main` push → `.github/workflows/deploy.yml` 자동 트리거
- **인증**: 멤버 로스터 PIN 4자리 (Supabase Auth 사용 안 함)
- **사용자 식별자**: `members.kingshot_id` (TEXT, 모든 도메인 테이블의 FK)

## 디렉토리 구조 (요약)

```
src/
  components/   # AuthDialog, Header, LeftNav, MobileNav, RightToc
  layouts/      # AppLayout, BaseLayout, GuideLayout
  pages/
    manage/     # members, coupons (관리자 도구)
    minigame/   # tile-match, partner-draw (+ 신규: equipment, pvp)
    beginner/   # 가이드
    events/
  scripts/
    pages/      # 각 페이지의 클라이언트 로직 (TypeScript)
    legacy-hash-redirect.ts
  styles/       # global, components, manage, minigame
  lib/          # supabase, types, utils, cache, guides
  content/      # Astro Content Collection (가이드 마크다운)
  data/         # navigation 등 정적 데이터

supabase/
  migrations/   # SQL 마이그레이션
  functions/    # Edge Functions (Deno + TS)
```

---

## 작업 분담 규칙

| 작업 | 담당 |
|------|------|
| `.sql` 마이그레이션 파일 작성 | Claude |
| Edge Function `index.ts` 작성 | Claude |
| 클라이언트 코드 (Astro/TS/CSS) | Claude |
| `npm run build`, 타입체크, 빌드 검증 | Claude |
| git 브랜치/커밋/push (PR 생성) | Claude |
| **`supabase db push`** (production DB 적용) | **사용자** |
| **`supabase functions deploy <name>`** | **사용자** |
| GitHub Secrets / Pages / 환경 설정 | **사용자** |
| 브라우저에서 실제 동작 확인 (UI 회귀) | **사용자** |

> Supabase CLI가 Claude 환경에 설치돼있지 않아서 production 적용 명령은 사용자가 직접 실행.
> Claude는 작업 단계마다 "이 명령 실행해줘" 라고 사용자에게 안내한다.

---

## 신규 컨텐츠: 미니게임 확장 (PNX_Game_Proposal)

### 목표 (Core Loop)
**타일 매치 클리어 → 크리스탈 보상 → 장비 강화 → 전투력 상승 → PvP 카드 대결**

### 네비게이션 추가
```
/minigame/tile-match/    (기존)
/minigame/partner-draw/  (기존)
/minigame/equipment/     ← 신규 "장비/강화"
/minigame/pvp/           ← 신규 "매칭 대결" (페이지 하단에 랭킹 섹션 통합)
```

### 디자인 결정사항 (확정)

#### 데이터 보존 전략
- 장비 / 크리스탈 잔액 / 강화 상태: **영구 누적**
- `pvp_battles` 만 30일 후 pg_cron 자동 삭제 (시즌제 X)

#### 크리스탈 보상
- 같은 stage 재클리어는 **첫 클리어만** 지급 (`crystal_transactions.ref_key` UNIQUE 강제)
- 스테이지별 **결정적 매핑**:
  - Stage 1: 100 (튜토리얼 보너스)
  - Stage 2~10: 10~50 (5씩 점진)
  - Stage 11~20: 100~300 (점진)
  - Stage 21~45: 500+α
  - Stage 46+: 0 (난이도 cap, 보상 의미 없음)
- 정확한 stage→reward 테이블은 Phase A 마이그레이션에서 상수화 (`src/lib/balance.ts`)

#### 장비 강화 (6부위: 월계관/목걸이/상의/하의/반지/지팡이)
- 실패 시: 크리스탈만 소모, 등급 유지
- **+10 (Silver) 가 현재 최대치** — 추후 해금으로 +11+ 확장 (DB 제약은 열어둠, cap은 코드에서만 강제)
- 강화 밸런스 테이블:

| 단계 | 비용 | 전투력 +Δ | 성공률 |
|------|------|----------|--------|
| +1 | 100 | +50 | 100% |
| +2 | 200 | +60 | 100% |
| +3 | 400 | +80 | 90% |
| +4 | 800 | +120 | 80% |
| +5 (Bronze) | 1,500 | +200 | 70% |
| +6 | 2,200 | +330 | 66% |
| +7 | 2,900 | +460 | 62% |
| +8 | 3,600 | +600 | 58% |
| +9 | 4,300 | +780 | 54% |
| +10 (Silver) | 5,000 | +1,000 | 50% |

→ 부위당 풀강 +3,420 / 6부위 풀강 합계 **+20,520**

#### PvP
- **비동기 PvP**: 방어자는 DB에 저장된 power로 자동 응전
- **매칭**: 랭킹 ±N등 범위 내 랜덤 3명 후보 → 1명 선택
- **HP**: 양쪽 1000 고정 (전투력은 데미지 곱셈에만 작용)
- **턴**: 5턴 후 잔여 HP 비교, HP 0 즉시 종료
- **일일 제한**: 공격 5회 (KST 자정 리셋), 방어 무제한
- **카드** (매 턴 3장 중 1택):
  - 공격(Red): 데미지 120~150%
  - 강화(Blue): 크리티컬 확률 증가
  - 방어(Green): 피격 데미지 50% 감소
- **데미지 공식** (서버측 계산, 클라이언트 조작 방지):
  ```
  Damage = max(0, floor(MyPower × CardEffect × Random(0.85~1.15) - EnemyDefense))
  ```

#### 전투력 합산
```
TotalPower(player) = members.power + Σ(equipment_levels[player].power for slot in 6슬롯)
```

### 데이터 모델 (신규 테이블 5종)

| 테이블 | 용도 | 핵심 컬럼 |
|--------|------|----------|
| `crystal_balances` | 잔액 요약 | player_id PK, balance, total_earned, total_spent |
| `crystal_transactions` | 거래 원장 (감사 + 멱등성) | id, player_id, amount, source, ref_key UNIQUE, ref_data |
| `equipment_levels` | 6부위 강화 상태 | (player_id, slot) PK, level, power |
| `pvp_battles` | 전투 로그 (30일 자동 삭제) | id, attacker_id, defender_id, winner_id, turns_log JSONB |
| `pvp_daily_state` | 일일 공격 횟수 | (player_id, date) PK, attacks_used |

**RLS 원칙**:
- `crystal_balances`, `equipment_levels`: SELECT public, write 차단 (Edge Function only)
- `pvp_battles`: SELECT public (랭킹/전적 조회), write 차단
- 모든 변경은 Edge Function (service_role) 통과 필수

### Edge Functions (신규 3종)
- `economy/index.ts` — `claim-stage-reward`, `get-balance`, `spend-crystals`
- `equipment/index.ts` — `get-equipment`, `enhance`
- `pvp/index.ts` — `list-opponents`, `start-battle`, `play-card`, `get-result`

기존 `tile-match-auth/index.ts` 의 PIN 검증 로직을 공유 모듈로 분리하여 재사용.

### Phase 진행 상황

- [x] **Phase A** — 크리스탈 경제 기반 (PR #1, commit `3b9deaf`, main 머지됨)
  - [x] DB 마이그레이션 (`crystal_balances`, `crystal_transactions`) — production 적용 완료
  - [x] Edge Function `economy/` — production 배포 완료, smoke test 3/3 pass
  - [x] tile-match 클리어 시 보상 청구 통합
  - [x] 헤더 잔액 배지
  - [x] 빌드 검증 + PR + main 머지 + GitHub Pages 배포
  - [ ] **브라우저 회귀 검증 (사용자 직접)** — Stage 1 클리어 시 토스트/배지 동작 확인
- [ ] **Phase B** — 장비 강화 (`/minigame/equipment/`) ← **다음 시작 지점**
- [ ] **Phase C** — PvP 카드 대결 + 랭킹 섹션 (`/minigame/pvp/`)

### 보안 / 무결성 체크리스트
- [x] anon key로 통화 테이블 직접 변경 차단 (RLS write 차단)
- [x] 보상 중복 청구 방지 (`crystal_transactions.ref_key` UNIQUE)
- [ ] 강화 race condition 방지 (DB 함수 단일 트랜잭션) — Phase B
- [ ] PvP 데미지 계산 서버측 강제 (클라이언트는 카드 선택만 전송) — Phase C
- [ ] PvP 자기공격 / 일일 한도 위반 차단 — Phase C

### Phase A 작업 중 발견한 운영 메모

- **production schema_migrations 와 supabase CLI 추적 sync 완료** (2026-04-28).
  과거 dashboard SQL Editor 로 직접 적용된 6개 마이그레이션이 CLI 추적엔 누락돼있어
  `supabase migration repair --status applied <ts>...` 로 sync. Phase B 부터는 `supabase db push` 가
  깔끔하게 새 마이그레이션 1개만 적용함 (이 단계 다시 할 필요 없음).
- **Phase B 시작 절차**:
  1. `git pull origin main` (이 PC 또는 다른 PC 어느 쪽이든)
  2. `npm install` (의존성 동기화)
  3. 새 브랜치: `git checkout -b feat/minigame-equipment`
  4. 본 문서 "디자인 결정사항 → 장비 강화" 섹션 기준으로 작업
  5. 강화 비용/확률 표는 본 문서의 표를 단일 진실 공급원으로 사용
- **Phase B 의 production 적용**:
  사용자 환경에 supabase CLI 가 설치돼있다면 직접 `supabase db push` + `supabase functions deploy equipment` 실행.
  없으면 위 "Phase A 작업 중 발견" 섹션처럼 binary 다운로드 후 `--project-ref cbzgmugtsustsxuqpznv` 로 link.

---

## 코딩 컨벤션 (이 프로젝트 한정)

- 컴포넌트: `.astro`, 클라이언트 로직: `src/scripts/pages/<page>.ts`
- 스타일: `src/styles/{global,components,manage,minigame}.css` 분리 유지
- 한국어 식별자(키) 사용 시 주석으로 의미 부연 (예: `kingshot_id` 가 게임 ID)
- Edge Function: Deno + TypeScript, action 디스패치 패턴 (기존 `tile-match-auth/index.ts` 참조)
- 마이그레이션 파일명: `YYYYMMDDHHMMSS_<verb>_<subject>.sql`

---

## 참고 문서

- `MIGRATION_PLAN.md` — 과거 Jekyll → Astro 마이그레이션 기록
- 신규 미니게임 확장 기획서 (PDF, 사내 문서 — repo 외부 보관). 핵심 내용은 본 문서의 "디자인 결정사항" 섹션에 모두 반영됨
- `supabase/migrations/` — 기존 스키마 (가장 최근: `20260428100000_create_crystal_economy.sql`)
- `supabase/functions/tile-match-auth/index.ts` — Edge Function 패턴 레퍼런스
- `supabase/functions/economy/index.ts` — Phase A 의 stage→reward 매핑 + RPC 호출 패턴 (Phase B/C 가 따라갈 템플릿)

## 다른 PC 합류 시 setup

```bash
git pull origin main
npm install
# .env 파일은 git ignore 되어있음 — 다른 PC 에 별도 복사 필요
#   필수 키: PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_ACCESS_TOKEN
npm run dev   # 로컬 미리보기 (Astro dev server)
```
