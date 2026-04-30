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
    minigame/   # tile-match, partner-draw, equipment, pvp
    tools/      # build-optimizer (트랙 3 — 본문 미구현)
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
  - [x] 헤더 잔액 배지 (이후 `LoginedUserInfo` 위젯으로 흡수)
  - [x] 빌드 검증 + PR + main 머지 + GitHub Pages 배포
  - [x] 브라우저 회귀 검증 + 22명/526 stages 데이터 백필 (2026-04-29)
- [x] **Phase B** — 장비 강화 (`/minigame/equipment/`) (PR #2~#8, 최종 commit `3dc7cce`)
  - [x] DB 마이그레이션 (`equipment_levels` + `enhance_equipment` RPC)
  - [x] Edge Function `equipment/` — production 배포 완료
  - [x] `/minigame/equipment/` 페이지 — 캐릭터 중심 레이아웃 + 모달 + RPG 게임 아이콘 PNG
  - [x] **100단계 확장** + 6 RPG 등급 (일반/고급/희귀/영웅/레전드/신화) — `ENHANCE_RANGES` 보간
  - [x] **결정적 회귀 fix** — `apply_crystal_transaction` 의 CHECK violation 버그 (마이그레이션 `20260429120000`)
  - [x] **데이터 백필** (2026-04-29 재밸런스) — 22명/655 거래/220,165 크리스탈,
    `tile_match_records` 는 건드리지 않음. 강화/잔액/거래 모두 새 시스템 기준 재지급
  - [x] Stage 46+ 반복 파밍 (100/회, ref_key NULL) — 일상 활동 재화
  - [x] **브라우저 회귀 검증** (사용자 직접, 2026-04-29 OK)
- [x] **Phase C** — PvP 카드 대결 + 랭킹 섹션 (`/minigame/pvp/`) (commit `e8923ff` + 후속 fix 다수)
  - [x] DB 마이그레이션 (`pvp_battles`, `pvp_daily_state`, `is_ranked` 컬럼)
  - [x] Edge Function `pvp/` — 데미지/카드효과/크리/보상 모두 서버측 계산
  - [x] `/minigame/pvp/` 페이지 — 매칭 → 배틀 → 결과 → 랭킹 통합
  - [x] **밸런스 재설계** — share-based 데미지 + chip floor (1턴 즉사 차단)
  - [x] cooldown (enhance/defend 직후 attack 만) + 격돌 메커닉
  - [x] 연습 모드 (일일 5회 후 자유 매칭, 보상/승수 X) + `is_ranked` 분리
  - [x] **브라우저 회귀 검증** + 모바일 컬럼 줄바꿈/연습승수 합산 fix (commit `b05f450`)

### 보안 / 무결성 체크리스트
- [x] anon key로 통화 테이블 직접 변경 차단 (RLS write 차단)
- [x] 보상 중복 청구 방지 (`crystal_transactions.ref_key` UNIQUE)
- [x] 강화 race condition 방지 (DB 함수 단일 트랜잭션 + `target == current+1` 검증)
- [x] **무료 강화 hole 차단** — 음수 amount + 잔액 row 미존재 케이스를 명시적 `check_violation` 으로 거부
  (마이그레이션 `20260429120000_fix_apply_crystal_transaction.sql`)
- [x] PvP 데미지 계산 서버측 강제 (클라이언트는 카드 선택만 전송)
- [x] PvP 자기공격 (`self_attack_forbidden`) / 일일 한도 위반 차단 + 멱등 보상 (`ref_key=pvp:<battle_id>:reward`)

### 후속 작업 트랙 (Phase A/B/C 완료 이후)

위에서 아래로 순차 진행. 각 트랙은 **이전 트랙 완료 + 사용자 회귀 검증** 후 시작.

1. **트랙 1: 웹 프로젝트 설계 재검토 — 깜박임 100% 제거** ✅ 완료 (commits 574e0d9 ~ 7697e28)
   - **달성**: 데이터 갱신 시 row 단위 keyed reconcile + 사진 placeholder + 페이드 인 패턴 적용.
     `innerHTML = ...` 통째 교체 패턴이 제거된 곳:
     - 회원 관리 (members.ts) — row + 사진
     - 쿠폰 받기 (coupons.ts) — 계정 목록 + 쿠폰 카드 + 진행 UI + 수령 이력 + pagination
     - 타일매치 랭킹 (tile-match.ts) — row 의 부분 patch + 사진 fade
     - PvP 검색 모드 (pvp.ts) — allMembersCache → membersStore
   - **남은 곳 (의도적)**: 타일매치 게임 보드 자체는 frame animation 필수라 손대지 않음
   - **신규 인프라**:
     - `src/lib/store.ts` — createStore<T> (get/set/subscribe/refresh + sessionStorage TTL + in-flight 보호)
     - `src/lib/stores/members.ts` — membersStore (4페이지 공유)
     - `.mc-photo-fade`, `.tm-rank-photo-fade` 마커 — img.onload 시 .loaded 클래스로 페이드 인 (transition 80ms)

2. **트랙 2: 메모리 / Supabase I/O 최적화** ✅ 완료 (commits 9868cb5 ~ e12c029)
   - **달성**: 페이지 간 중복 fetch 약 60% 감소 (5 페이지 순회 시 16건 → 6건).
     `members` 로스터를 4 페이지가 각자 fetch 하던 패턴 → 단일 store 공유.
   - **변경 (PR 1~3)**:
     - `store.refresh(fetcher, force?)` 에 freshness 체크 추가 — TTL 안이면 fetch 스킵
     - `tile-match-auth.ts` 가 자체 fetch 대신 `membersStore` 사용 (미니게임 4 페이지 영향)
     - `partner-draw.ts` / `tile-match.ts` (랭킹 join) / `coupons.ts` (loadAccounts) 도 store 활용
   - **Mutation fix**: 회원 변경 5곳 (저장/삭제/등록/단일갱신/전체갱신) 에서 `force=true` 호출 →
     freshness 체크가 변경 누락하던 회귀 차단
   - **남은 영역 (다음 트랙들에서 자연스럽게)**: balance store, equipment store, ranking store,
     daily-state store. 각 도메인 자체 작업 시 같은 패턴으로 추출

3. **트랙 3: 신규 서비스 개발 — 게임도구 / 건설 최적화** (`/tools/build-optimizer/`) ← **진행 중**
   - **개발 가이드**: `신규서비스.md` (repo root) — 17개 섹션, MVP 범위는 §13 참조

   #### Phase 1 (코어 알고리즘) ✅ 완료 (commits `3ead677` ~ `99fd8c9`)
   - `src/lib/build-optimizer.ts`:
     - 시간 변환 (toSeconds/fromSeconds/formatTime) — 가이드 §5
     - calculateBuildTime — 가이드 §2.3 공식
     - analyzeBuilding — 단일 건물 즉시 vs 총리대신 비교
     - **evaluateAssignment** — 4 시점 비교 (큐 빔 시각 더한 현실 시간 기준)
     - **recommendForCandidates** — 후보 1~2개 + 큐 2개 → 결정적 매칭 + 패턴 분류 (A/B/C/D/single)
     - 타입: BuildQueue / BuildingCandidate / BuildingAnalysis / CandidateAssignment / OptimizationResult / RecommendationPattern / AccelerationAnalysis
   - `src/lib/build-optimizer.test.ts` — **48 테스트 모두 통과**
     - 가이드 §16 시나리오 1/2 + §8.3 패턴 A/B/C/D
     - 사용자 실사용 케이스 A (큐 빔 2h + 총리 8h, 도시센터/7일 둘 다)
     - 상위 사용자 속도 61.8%
     - 극단 1일 / 60일 건축 시간

   #### Phase 2-A (UI 입력 폼 재구성) ← **다음 시작 지점**
   PR 2.5 의 UI 는 "큐=후보" 잘못된 매핑 → 입력 폼 재구성:
   - **공통 버프** 섹션 (현재와 동일)
   - **총리대신 임명 시각** — 텍스트 입력 (placeholder `2026-05-01 06:41:29`).
     게임 화면 표기 그대로 복붙 가능 + parseDatetime 헬퍼로 다양한 포맷 허용
   - **현재 건축 큐** 섹션 ← 신규
     - 큐 1: radio (비어있음 / 건축 중) + 건축 중 시 시간/분 입력 활성
     - 큐 2: 동일
   - **다음 건축 후보** 섹션 — 라벨 변경 (큐1/큐2 → 후보1/후보2)
   - **보유 가속권** 섹션 ← 신규 (일/시간/분 합산. Phase 3 에서 사용, 입력만 미리)
   - `SavedState` 확장 + `STORAGE_KEY` v2 → v3 (호환성 끊고 새로 시작)
   - `calculate()` → `recommendForCandidates` 호출 (결과 표시는 임시, Phase 2-B 에서 다듬기)

   #### Phase 2-B (결과 메시지) ← Phase 2-A 후
   - 패턴별 헤더 메시지 (§17 행동 추천 중심)
   - 큐 배정 카드 + 상세 펼치기
   - 색상 (이득=초록 / 손해=빨강 / 동률=회색, 가이드 §12.2)
   - "PM" 약자 → "총리대신" 풀어쓰기 일관 적용

   #### Phase 3 (가속권) ← Phase 2-B 후
   - `evaluateAccelerationTicket` — 큐를 PM 시각에 맞춰 가속
   - 가이드 §9 + §16 시나리오 3 단위 테스트 4개
   - UI 결과 카드에 가속권 권장 라인 추가

   #### 모델 한계 (§14 추후 확장)
   - **케이스 B (수면 시간)** — 사용자 비활성 시간대 처리. 현재는 UI 안내로만 처리 예정 ("예상 큐 빔 시각: ..." 표시). 알고리즘 차원 추가는 추후.

   #### 운영 노출 정책
   - 트랙 3 진행 중엔 `navigation.ts` 의 tools 탭 주석 처리 → **메뉴에 보이지 않음**
   - URL 직접 진입 시엔 페이지 상단에 "🚧 개발 중" 배너 노출
   - Phase 3 완료 + 검증 후 navigation 주석 해제 + 배너 제거

   #### 다음 PC 합류 시 빠른 진입
   ```bash
   git pull origin main
   npm install
   npm test                # 48 테스트 통과 확인
   npm run dev             # 로컬에서 /tools/build-optimizer/ 진입
   # Phase 2-A 부터 시작. 위 'Phase 2-A' 섹션의 항목 순서대로.
   ```

4. **트랙 4: 데이터베이스 최적화 — 누적된 dead column / index 정리**
   - **목표**: Phase A/B/C 진행 중 누적된 **사용하지 않는 컬럼 / 인덱스 / RLS 정책 정리**
   - **점검 대상 (예시)**:
     - `members` 테이블의 더 이상 안 쓰는 필드
     - 마이그레이션 중간에 만들었다가 dead 가 된 인덱스
     - PvP `is_ranked` 도입 전 인덱스 (winner_id only) — 새 인덱스 (winner_id, is_ranked) 와 중복 검토
   - **방법론**:
     - `information_schema` 쿼리로 컬럼 사용 여부 확인 (`pg_stat_user_tables`, `pg_stat_user_indexes`)
     - production Supabase Dashboard 의 query stats 로 실제 사용 패턴 확인
     - **삭제 전 백업 마이그레이션 1건 = 컬럼/인덱스 추가 마이그레이션 1건** 패턴 (rollback 가능)
   - **트랙 1~3 완료 후 진행** — 신규 서비스 코드도 안정화된 뒤 dead 판정 정확도 ↑

### Phase B 운영 메모 (Phase C 작업 시 알아둘 것)

- **100단계 + 6 RPG 등급 시스템** (2026-04-29 재밸런스) — `src/lib/balance.ts` 의
  `ENHANCE_RANGES` 객체 + 선형 보간 함수. Phase C 의 PvP 데미지 공식에서 장비 power
  계산 시 `accumulatedPower(level)` 활용 가능.
- **`apply_crystal_transaction` 의 PG 동작 함정** — INSERT...ON CONFLICT 의 row CHECK
  는 conflict 분기보다 먼저 검사됨. 음수 amount(차감) 시 INSERT VALUES 의 balance
  컬럼에 raw 값 넣으면 항상 CHECK violation. 향후 통화 차감 마이그레이션 작성 시
  반드시 `INSERT VALUES (..., GREATEST(amount, 0), ...)` 패턴 사용 + `DO UPDATE`
  분기에서만 raw amount 적용.
- **Stage 46+ 반복 파밍** — `claim-stage-reward` 가 stage 46+ 에 ref_key NULL 사용해
  매 클리어마다 새 거래 INSERT. PvP 보상도 비슷하게 ref_key 패턴 결정 필요
  (시즌별 또는 매번).
- **데이터 백필 표준 패턴** — 두 번 실행됨 (2026-04-29 두 차례).
  `tile_match_records.best_stage` 보고 `crystal_transactions` 행별 INSERT +
  `crystal_balances` 합산 INSERT. `tile_match_records` 는 절대 건드리지 않음.
- **모달 결과 토스트 패턴** — native `<dialog>` 가 top layer 라 외부 fixed 토스트는
  backdrop 블러에 가려짐. dialog 내부 absolute 로 두면 같은 top layer.

### Phase A 운영 메모 (Phase B 이전)

- **production schema_migrations 와 supabase CLI 추적 sync 완료** (2026-04-28).
  과거 dashboard SQL Editor 로 직접 적용된 6개 마이그레이션이 CLI 추적엔 누락돼있어
  `supabase migration repair --status applied <ts>...` 로 sync. Phase B 부터는 `supabase db push` 가
  깔끔하게 새 마이그레이션 1개만 적용함 (이 단계 다시 할 필요 없음).
- **데이터 백필 완료** (2026-04-29): 22명 / 526 stages / +187,940 크리스탈 소급 지급.
  `claim-stage-reward` Edge Function 멱등 호출로 처리 (audit trail: `source=tile_match_clear`).
  → production `crystal_transactions` 에 이미 526건 거래 기록 존재. Phase B 의 강화 거래는
  `source=equipment_enhance` 로 별도 분류해서 audit 분리.
- **헤더 잔액 표시 위치 변경**: 별도 배지(`header-crystal-badge.ts`, 삭제됨) → `LoginedUserInfo`
  위젯 (`src/components/LoginedUserInfo.astro`) 으로 통합. Phase B 의 강화 결과로 잔액이 변경되면
  `crystal-balance-update` 이벤트 dispatch — 위젯이 자동 갱신함 (이벤트 listener 위치는 위젯 내부).
- **Stage→reward mirror**: 클라이언트도 보상 amount 를 즉시 알아야 fire-and-forget UI 가 가능해서
  `src/lib/balance.ts` 에 `rewardForStage()` mirror 도입. 서버(`economy/index.ts`)가 진실의 원천,
  클라이언트는 표시용. **변경 시 양쪽 동시 수정**. Phase B 의 강화 표(비용/확률)도 같은 패턴으로
  `src/lib/balance.ts` 확장 권장.
- **DOM diff 헬퍼 도입**: `src/lib/dom-diff.ts` 의 `patchList`/`patchText`. Phase B 의 장비 강화
  결과 갱신, 인벤토리 표시 등에서도 처음부터 이 헬퍼로 갱신 — `innerHTML=''` 패턴 사용 금지.

### 트랙 2 운영 메모 (트랙 3~ 작업 시 알아둘 것)

- **store API 변경** — `refresh(fetcher, force?)` 에 freshness 체크 추가됨. 페이지 진입은 force=false
  (캐시 활용), **변경 작업 후엔 반드시 force=true** (안 그러면 stale 반환). Mutation 후 누락하면 다른
  페이지에서 변경 미반영. members.ts 의 5곳이 레퍼런스 패턴.
- **Akamai CDN** — 사진은 `got-global-avatar.akamaized.net` (게임 공식 avatar). Supabase Storage 가
  아님 → Cache-Control 못 건드리지만 브라우저 disk cache 작동.
- **Playwright 진단 패턴** — 트랙 2 에서 매 PR 마다 `/tmp` 또는 임시 `diag-*.mjs` 로 페이지별
  네트워크 캡처. 영구 도구화 안 함 — 필요 시 그때그때 작성. (이미 정형화된 패턴: page.on('request')
  필터링 + label 별 grouping + 응답시간/size 출력)
- **store 의 추가 도메인 후보** — `balanceStore` (현재는 LoginedUserInfo 가 별도 fetch + custom event
  로 sync), `equipmentStore` (현재는 equipment.ts 의 모듈 변수), `rankingStore` (tile-match/PvP).
  각 도메인 자체 변경 PR 시 자연스럽게 store 화 가능.
- **store 캐시 TTL 60초** — members 변경이 잦은 프로젝트면 짧게, 정적이면 길게. 22명 규모라
  60초 적정. 변경 시 force refresh 가 캐시 우회 → TTL 보다 정확.

### 트랙 1 운영 메모 (트랙 2~ 작업 시 알아둘 것)

- **단일 store 패턴** — `src/lib/stores/<name>.ts` 가 표준. members 외에 balance/equipment/rankings 등도
  같은 패턴으로 추가 가능. 트랙 2 의 I/O 최적화는 store 화 안 된 데이터(예: tile-match 의 ranking
  records, members.ts 의 RANK_WEIGHT 정렬 후 view-model) 를 store 화 하는 것이 자연스럽게 이어짐.
- **사진 페이드 패턴 일관성** — placeholder(첫 글자) 항상 보이고 `<img>` 가 onload 시
  `.<X>-photo-loaded` 추가로 페이드 인. transition 80ms (Playwright 진단 기반 — cache hit 시
  200ms 면 lag 감각). 마커 클래스(`.mc-photo-fade`, `.tm-rank-photo-fade`) 한정 적용 — 다른 페이지의
  같은 base class(.mc-photo) 는 영향 X.
- **이미지 cache** — 사진은 Akamai CDN(got-global-avatar.akamaized.net), Cache-Control 헤더 부재지만
  브라우저 heuristic 으로 disk cache 작동. 두 번째 진입 0~1ms. Supabase 무관.
- **`.<X>-photo-wrap` grid stack** — flex(단일 자식) → grid + place-items + grid-area:1/1 로 두 자식
  (empty placeholder + img) 같은 셀에 stack. 다른 페이지에서 같은 wrap class 단일 자식만 쓰면 영향 X.
- **이벤트 위임** — 인라인 `onclick="X.foo(...)"` 는 신규 코드에서 금지. 대신 컨테이너에 click 위임 +
  `data-action="..."` + `data-*` 로 정보 전달. members.ts/coupons.ts 가 레퍼런스.
- **patchList container 안 비-row 자식** — patchList 는 `data-key` 있는 자식만 reconcile. 그 외 자식
  (status div, label 등) 은 형제 element 로 분리해서 patchList container 밖에 둘 것 (그렇지 않으면
  새 row appendChild 가 비-row 자식 뒤로 밀어버려 순서 꼬임).

### Phase C 운영 메모 (트랙 1 작업 시 알아둘 것)

- **`is_ranked` 분리** — `pvp_battles.is_ranked` 가 ranked(일일 5회 안) / 연습(자유) 매치 구분.
  보상 적립도 ranked 만, 클라이언트 승수 집계 쿼리도 `is_ranked=eq.true` 필터 필수
  (한번 빠뜨려서 fix 한 적 있음 — commit `b05f450`).
- **share-based 데미지 공식** — `pvp/index.ts` 의 `rollCardDamage()` 가 share + chip 합산.
  단순 (MyPower - EnemyDefense) 곱셈에서 변경됨. 트랙 1/2 에서 PvP 화면 손볼 때 참조.
- **격돌(collision) 메커닉** — 양쪽 동시 attack 시 일반 데미지 X, 양쪽 정액 200 (HP 의 20%).
  화면에 별도 banner 노출. 깜박임 제거 작업 시 이 banner 도 keyed 갱신 대상.

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
- `신규서비스.md` — **트랙 3 (건설 최적화) 개발 가이드** (사용자 작성, repo root)
- 신규 미니게임 확장 기획서 (PDF, 사내 문서 — repo 외부 보관). 핵심 내용은 본 문서의 "디자인 결정사항" 섹션에 모두 반영됨
- `supabase/migrations/` — 기존 스키마 (가장 최근: `20260429160000_pvp_is_ranked.sql`)
- `supabase/functions/tile-match-auth/index.ts` — Edge Function 패턴 레퍼런스
- `supabase/functions/economy/index.ts` — Phase A 의 stage→reward 매핑 + RPC 호출 패턴
- `supabase/functions/pvp/index.ts` — Phase C 의 서버측 데미지 계산 + 멱등 보상 패턴

## 다른 PC 합류 시 setup

```bash
git pull origin main
npm install
# .env 파일은 git ignore 되어있음 — 다른 PC 에 별도 복사 필요
#   필수 키: PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_ACCESS_TOKEN
npm run dev   # 로컬 미리보기 (Astro dev server)
```
