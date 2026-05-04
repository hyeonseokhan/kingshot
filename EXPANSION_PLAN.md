# 미니게임 확장 작업 계획 (Track 5 / 6 / 7)

CLAUDE.md "후속 작업 트랙" 의 트랙 1~4 가 모두 완료된 이후 다음 작업.
세 트랙 모두 구현 결정사항이 합의 완료되어 PR 단위 작업만 남음.

진행 순서: **Track 5 → Track 6 → Track 7**
- 부피 작은 → 큰 순
- Track 6 의 인프라(crystal_transactions enum 확장, idempotency-key 패턴) 는 Track 7 자동 지급에서도 재활용
- 각 트랙 완료 + 사용자 회귀 검증 후 다음 트랙 시작

---

## Track 5 — 강화 확률 곡선 완화

### 목표
등급 진입 시 확률 점프 + 등급 안에서 점진 하강. 사용자 만족감 ↑ + 평균 비용 5~15% 감소.

### 현재 vs 신규 곡선

등급은 6단계: **일반(+0) · 고급(+1~9) · 희귀(+10~24) · 영웅(+25~44) · 레전드(+45~69) · 신화(+70~100)**

| 단계 | 현재 rate | 신규 rate | 변화 |
|---|---|---|---|
| +3 (고급 구간) | 95% | 95% | 동일 |
| +9 (고급 끝) | 80% | 70% | -10%p (점진 가팔게) |
| **+10 (희귀 진입)** | 75% | **90%** | **+15%p ✨ 점프** |
| +24 (희귀 끝) | 55% | 55% | 동일 |
| **+25 (영웅 진입)** | 50% | **75%** | **+25%p ✨ 점프** |
| +44 (영웅 끝) | 30% | 25% | -5%p |
| **+45 (레전드 진입)** | 25% | **65%** | **+40%p ✨ 점프** |
| +69 (레전드 끝) | 10% | 8% | -2%p |
| **+70 (신화 진입)** | 8% | **50%** | **+42%p ✨ 점프** |
| +100 (신화 풀강) | 2% | 4% | +2%p |

### 변경 파일 (마이그레이션 0건)
- `src/lib/balance.ts` — `ENHANCE_RANGES` 의 `rateFrom` / `rateTo` 만 변경
- `supabase/functions/equipment/index.ts` — 동일 곡선 mirror

### 영향 범위
- 기존 사용자 보유 power 변동 없음 (cost / power 미변경, rate 만 변경)
- 데이터 백필 불필요
- 회귀 테스트: 강화 페이지에서 +1~5 한 번씩 시도, +10/+25/+45/+70 진입 단계의 rate UI 가 새 곡선 반영 확인

### PR 단위
**PR 5.1 (단일)**: balance.ts + equipment/index.ts 동시 수정 + 빌드 검증.
- 사용자 측: `supabase functions deploy equipment` 1회

---

## Track 6 — 관리자 크리스탈 지급

### 목표
운영자(현재 Toycode 1인)가 회원에게 임의 크리스탈을 지급하는 관리자 도구.

### 결정사항 (확정)
- **권한 식별**: `members.is_admin` boolean 컬럼 추가. true 인 회원만 PIN 로그인 시 UI / API 접근 가능
- **음수 지급(회수) 금지** — 양수만. 회수가 필요한 경우는 별도 SQL 마이그레이션으로 처리
- **enum + 메모 둘 다** — `source='admin_grant'` + `ref_data.source_kind` enum + `ref_data.memo` 자유 텍스트
- **멱등성**: 클라이언트가 행위 1회당 UUID 생성 → ref_key = `admin_grant:<uuid>` UNIQUE. 재시도 시 같은 UUID 재사용으로 중복 차단
- **UI 디바운스**: 지급 버튼 클릭 직후 disabled (UI 1차 방어 + 서버 키 2차 방어)

### 데이터 모델

```sql
-- 마이그레이션 1: members.is_admin
ALTER TABLE members ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
-- Toycode kingshot_id 에 admin 플래그 (실제 ID 는 사용자가 알려주면 SQL 작성)
UPDATE members SET is_admin = true WHERE kingshot_id = '<TOYCODE_KINGSHOT_ID>';
```

`crystal_transactions` 테이블은 변경 없음. `source` 컬럼이 이미 자유 TEXT 라 새 enum 값 사용 가능.

### ref_data 구조

```ts
ref_data: {
  granted_by: string,           // 관리자 kingshot_id (감사용)
  source_kind: 'event' | 'activity' | 'compensation' | 'misc',
  memo: string,                  // 자유 텍스트, max 200자
}
```

### Edge Function (`economy/index.ts` 에 action 추가)

신규 action `admin-grant`:
```
입력: {
  admin_kingshot_id, admin_pin,
  target_kingshot_id, amount,
  source_kind, memo,
  idempotency_key  // 클라이언트 UUID
}

검증:
  - PIN 인증 (기존 패턴)
  - members.is_admin = true 확인
  - amount > 0, amount <= 300_000 (오타 사고 방지 cap — 30만 이상은 SQL 마이그레이션으로)
  - source_kind enum valid
  - memo length <= 200
  - target_kingshot_id 가 members 에 존재

처리:
  - ref_key = 'admin_grant:' + idempotency_key
  - apply_crystal_transaction(target, +amount, 'admin_grant', ref_key, ref_data)
  - 중복 호출 시 UNIQUE 위반 → idempotent 응답 (성공 처리, 실제 INSERT 는 1회만)
```

### UI

[src/pages/manage/members.astro](src/pages/manage/members.astro) — 회원 row 에 admin 만 보이는 "💎 지급" 버튼 추가:

- admin 인 사용자가 PIN 로그인 시 `current_user.is_admin === true` 확인
- admin 인 경우 row 마다 "💎 지급" 버튼 표시
- 클릭 시 모달:
  - amount 입력: type=number, 정규식 `^([1-9][0-9]{0,4}|[1-2][0-9]{5}|300000)$` (1~300,000)
  - source 선택: select (이벤트 보상 / 활동 보상 / 보전 / 기타)
  - memo: textarea, maxlength=200
  - "지급" 버튼: 클릭 시 `crypto.randomUUID()` 생성 → 호출 → 성공 시 모달 닫고 토스트
  - 클릭 즉시 disabled (응답 받기 전까지 재클릭 불가)

### PR 단위

- **PR 6.1**: DB 마이그레이션 (`is_admin` 컬럼 + Toycode UPDATE) — 사용자 측 `supabase db push` 1회
- **PR 6.2**: Edge Function `admin-grant` action — 사용자 측 `supabase functions deploy economy` 1회
- **PR 6.3**: members.ts UI + admin 게이팅 (LoginedUserInfo 의 admin flag 노출 포함)
- **PR 6.4**: i18n 사전 (관리자 라벨 / 토스트 메시지)

### 사이드 이슈 / 고려사항
- LoginedUserInfo 위젯이 현재 admin 정보를 모름 → Edge Function 응답에 `is_admin` 포함하도록 확장 필요 (`tile-match-auth/index.ts` 의 PIN 검증 응답 + members 테이블 join)
- 토스트 위치: 모달 안 (top layer 충돌 회피, equipment 패턴 참조)

---

## Track 7 — 주간 랭킹 보상

### 목표
타일매치 / PvP 각 게임에서 매주 1~10등에게 자동 크리스탈 지급. 매주 월요일 09:00 KST.

### 결정사항 (확정)
- **두 게임 별도 지급** — 같은 회원이 두 게임 모두 1등이면 30,000 × 2 = 60,000 수령
- **자동 스케줄러**: pg_cron (Supabase 내장, 외부 의존 X)
- **소급 지급(2026-05-04)**: pg_cron 등록 + 수동 1회 트리거 (멱등 키로 안전)
- **랭킹 산출 정책**: **누적 기준**. 매주 동일 인물이 1등 가능 (저번 주 1등이 이번 주도 1등 OK)
  - 타일매치: `tile_match_records.best_stage` 누적 (영구 보존, 매주 동일)
  - PvP: 시즌 시작 이후 누적 ranked 승수 (시즌 오프 정리 시 자연 리셋)
- **동률 처리**: 먼저 도달자 우선
  - 타일매치: `tile_match_records.best_stage_at` ASC tie-break
  - PvP: 동률 승수 도달의 마지막 ranked 승리 시각 ASC tie-break (`MAX(pvp_battles.finished_at)` per winner)
- **표시 위치**: 각 미니게임 페이지 상단 (게임 설명 컴포넌트 바로 아래)
- **주차 표기**: "26년 15주차 순위결과" — 단순 카운팅 ("그 해 1월 1일이 속한 주가 1주차"). 27년 1월 1일부터 1주차로 리셋
- **PvP 시즌 오프와 분리**: weekly_rankings 박제 패턴으로 battles 삭제 무관

### 보상 액수 (확정)

| 등수 | 크리스탈 |
|---|---|
| 1등 | 30,000 |
| 2등 | 10,000 |
| 3등 | 5,000 |
| 4~10등 | 2,000 |

연간 보상 (한 게임 기준):
- 1등 매주 = 1,560,000 / 년
- 두 게임 모두 1등 = 3,120,000 / 년 → 한 부위 레전드 4개월

평균 회원 (4~10등 두 게임 = 4,000/주 × 52 = 208,000/년) → epic 후반 도달 가능

### 데이터 모델

```sql
-- 마이그레이션: 박제용 신규 테이블
CREATE TABLE weekly_rankings (
  game           TEXT NOT NULL CHECK (game IN ('tile_match', 'pvp')),
  year           INT  NOT NULL,
  week_no        INT  NOT NULL CHECK (week_no BETWEEN 1 AND 53),
  rank           INT  NOT NULL CHECK (rank BETWEEN 1 AND 10),
  player_id      TEXT NOT NULL REFERENCES members(kingshot_id) ON DELETE CASCADE,
  score          BIGINT NOT NULL,                    -- best_stage 또는 wins
  achieved_at    TIMESTAMPTZ,                        -- tie-break 기록 시각
  reward_amount  INT  NOT NULL,
  reward_tx_id   BIGINT REFERENCES crystal_transactions(id) ON DELETE SET NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game, year, week_no, rank)
);
CREATE INDEX idx_weekly_rankings_period
  ON weekly_rankings (game, year DESC, week_no DESC);

ALTER TABLE weekly_rankings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "weekly_rankings_select_all" ON weekly_rankings FOR SELECT USING (true);
-- INSERT/UPDATE 는 service_role 만 (Edge Function/cron)
```

### 자동 지급 로직

`process_weekly_rank_rewards()` SQL 함수 또는 Edge Function:

1. 그 주의 (year, week_no) 계산 (지급 시점 = 월요일 09:00 KST 직후, 직전 한 주의 결과로 봄)
2. 타일매치 1~10등 — **누적 기준**:
   ```sql
   SELECT player_id, best_stage, best_stage_at
   FROM tile_match_records
   WHERE best_stage > 0
   ORDER BY best_stage DESC, best_stage_at ASC
   LIMIT 10;
   ```
   누적이라 동일 인물이 매주 1등 가능 (의도된 동작).
3. PvP 1~10등 — **시즌 시작 이후 누적**:
   ```sql
   SELECT winner_id, COUNT(*) AS wins, MAX(finished_at) AS last_win
   FROM pvp_battles
   WHERE is_ranked = true AND winner_id IS NOT NULL
   GROUP BY winner_id
   ORDER BY wins DESC, last_win ASC
   LIMIT 10;
   ```
   시즌 정리되면 pvp_battles 가 비어서 자연 리셋. 정리 후 첫 주는 데이터 적어 graceful skip 가능.
4. 각 등수에 대해:
   - `apply_crystal_transaction(player_id, +reward_amount, 'weekly_rank', 'weekly_rank:<game>:<year>-W<week_no>:rank:<rank>', ref_data)`
   - `weekly_rankings INSERT` + `reward_tx_id` 업데이트
5. 해당 게임에 보상 대상자 0명이면 graceful skip (해당 게임만 skip, 다른 게임은 정상 진행)

### pg_cron 등록

```sql
-- KST 09:00 = UTC 00:00 (KST = UTC+9)
SELECT cron.schedule(
  'weekly-rank-reward',
  '0 0 * * 1',  -- 매주 월요일 00:00 UTC = 09:00 KST
  $$ SELECT process_weekly_rank_rewards(); $$
);
```

### 주차 계산 (단순 카운팅)

```ts
// 클라이언트/서버 공유 헬퍼 (src/lib/balance.ts 또는 src/lib/week.ts)
export function weekNumberFor(date: Date): { year: number; week_no: number } {
  const year = date.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - jan1.getTime()) / 86400000) + 1;
  const week_no = Math.ceil(dayOfYear / 7);
  return { year, week_no };
}
```

### 표시 컴포넌트

[src/pages/minigame/tile-match.astro](src/pages/minigame/tile-match.astro) 와 [src/pages/minigame/pvp.astro](src/pages/minigame/pvp.astro) 의 게임 설명 컴포넌트 바로 아래에 신규 컴포넌트 삽입:

```astro
<WeeklyRankingsPanel game="tile_match" />  <!-- tile-match 페이지 -->
<WeeklyRankingsPanel game="pvp" />          <!-- pvp 페이지 -->
```

UI:
- 헤더: "26년 15주차 순위결과"
- 1·2·3등: 사진(placeholder + fade) + 이름 + 보상 크리스탈 표시
- 하단 작은 글씨: "4~10등은 2,000씩 지급"
- 데이터 없으면 (시즌 시작 첫 주 등) "아직 집계된 결과가 없습니다" 표시

데이터 fetch: `weekly_rankings` 에서 가장 최근 주차 1~3등 select. store 패턴 적용 (rankingStore 같은 식, TTL 짧게 — 30~60분, 매주 월요일 갱신이라).

### 소급 지급 (1회 수동, 2026-05-04 기준)

PR 7.2 배포 후 사용자 측에서 SQL 직접 실행:
```sql
-- 지난 주 (2026-04-27 월요일 ~ 2026-05-04 월요일) 보상 1회 트리거
SELECT process_weekly_rank_rewards();
```

멱등 키 패턴 동일하므로 다음 자동 실행과 충돌 없음.

### PR 단위

- **PR 7.1**: DB 마이그레이션 (`weekly_rankings` 테이블 + RLS)
- **PR 7.2**: `process_weekly_rank_rewards()` SQL 함수 + pg_cron 등록 마이그레이션
- **PR 7.3**: 표시 컴포넌트 (`WeeklyRankingsPanel.astro` + scripts)
- **PR 7.4**: i18n 사전 (주차 표기 / 등수 라벨)
- **PR 7.5 (사용자 측)**: 소급 지급 SQL 1회 + 회귀 검증

### 사이드 이슈 / 고려사항

- **PvP 시즌 오프 timing**: 시즌 정리는 월요일 보상 지급 후 권장. 운영 가이드 (CLAUDE.md) 에 명시 필요.
- **누적 vs 주간 의도 재확인**: 타일매치는 영구 누적이라 같은 인물이 매주 1등 가능 (best_stage 갱신해야 다음 사람이 추월). PvP 도 시즌 안에서 누적 — 시즌 시작 이후 가장 많이 이긴 사람이 매주 1등. 시즌 리셋이 사실상 PvP 의 "주기적 리프레시" 역할.
- **첫 주 데이터 없음**: 컴포넌트가 "아직 집계 안 됨" graceful 처리.
- **pg_cron 활성화 확인**: Supabase 프로젝트에서 pg_cron extension 활성화 필요 (사용자 측 확인 사항).
- **타임존**: KST = UTC+9. cron 표현은 UTC 기준이라 `0 0 * * 1` = UTC 월요일 0시 = KST 월요일 9시. 단, KST 일요일 자정~월요일 오전 사이에 클리어한 사람은 어느 주에 속하나? → "월요일 09:00 KST" 를 주 경계로 명확히 정의. 즉 한 주 = 월 09:00 ~ 다음 월 09:00.
- **타일매치 동률 컬럼 존재 확인**: `tile_match_records.best_stage_at` 이미 존재 (마이그레이션 `20260427004015`). 신규 컬럼 불필요.
- **PvP 동률 컬럼 존재 확인**: `pvp_battles.finished_at` 이미 존재. 신규 컬럼 불필요.

---

## 기타 Pending 작업 (이 계획서 범위 밖)

### NETWORK_RESILIENCE_PLAN.md
바유당(kingshot_id=271155609) Stage 66 보상 누락 케이스 기반 네트워크 회복력 개선. 위 세 트랙 완료 후 별도 재개. 사용자 측 SQL 사전 확인 필요 (`NETWORK_RESILIENCE_PLAN.md` §2 참조).

### BACKLOG.md
사용자가 추가하는 ad-hoc 아이디어 모음. 위 세 트랙 항목은 본 계획서로 이관됨. BACKLOG.md 는 그대로 두고 신규 아이디어 적재 용도로 유지.

---

## 추적

각 트랙 진행 상황은 PR 단위로 갱신. 트랙 전체 완료 시 본 계획서 해당 섹션을 ✅ 완료 마크 + 운영 메모 추가 형태로 갱신 (CLAUDE.md "후속 작업 트랙" 섹션 패턴과 동일).
