# KvK 버프 슬롯 선점 기능 — 기획 정리 (2026-05-13)

> 다른 PC 에서 이어서 작업할 때 이 파일만 읽으면 컨텍스트 복원 가능하도록 self-contained 로 작성.
> 시안 HTML: `design-mockups/kvk-buff-slots.html`
> 본 문서 위치: `design-mockups/kvk-buff-slots-plan.md`

---

## 1. 개요

### 목적
KvK 이벤트에서 점수 예측 상위 **48명** 에게 30분 단위 버프 시간대를 점수 순위 기준 **순차 선점** 으로 분배.

- 1일차(건설) / 4일차(병사+공용) 국왕스킬 30분씩 24시간 로테이션 → 48 슬롯
- 비행기 좌석 선점 컨셉을 단순화한 "순차 진행" 모델 (강탈 모델 아님)
- 시안 단계에서는 1일치(48 슬롯) 만 우선 검증. 1일차/4일차 분리 여부는 구현 직전 재논의.

### 관련 인프라 (재활용)
- 제출 현황 페이지의 **PIN + 90일 세션 토큰** 인증 (`AUTH_KEY` localStorage, `src/scripts/pages/survey-kvk.ts:85`)
- Edge Function `kvk-survey` 의 `authenticate(opts)` 패턴 — token → kingshot_id 추출
- 가속권 데이터 (`kvk_speedup_survey` 테이블) + 점수 계산 (`src/lib/kvk-score.ts` 의 `estimateKvKScore`)

---

## 2. 확정된 비즈니스 룰

| 항목 | 결정 | 비고 |
|---|---|---|
| **선점 모델** | 순차 진행 (점수 1위 → 48위) | 강탈 모델 아님 |
| **48 컷 freeze 시점** | **KST 2026-05-16 10:00 (= UTC 01:00)** | Edge Function 에서 그 시각 이후 `register`/`update`/`delete` 차단 |
| **자리 선점 윈도우** | **UTC 2026-05-16 01:00 ~ 03:00 (2시간)** | KST 10:00~12:00. 안내 문구와 일치 |
| **차례당 timeout** | **없음** | 게임 내 공지로 마감일 + 자리 선점 시간 사전 통보 |
| **윈도우 종료 시 잔여 슬롯** | **그대로 비움** | KvK 진행 중 연맹 차원에서 swap |
| **본인 차례 외 클릭** | **거부** | 토큰 → kingshot_id 가 `ranked_ids[current_turn_idx]` 와 일치해야 점유 가능 |
| **48위 밖 사용자** | **read-only 진입 허용** | 본인 순위 / 컷 / 부족분 안내 |
| **자리 변경 / 취소** | **선점 윈도우 동안만 본인 자리 이동 허용** | 빈 슬롯이 있으면 자기 자리 옮기기 가능 (운영 복잡도 거의 없음) |

### 운영 리스크 — timeout 없음

- 1위가 안 들어오면 → 2위 못 진행 → 전체 정체 → 윈도우 종료 시 빈 슬롯 47개 가능성
- 완화책:
  - (a) 게임 내 사전 공지로 인지율 ↑
  - (b) 운영자 admin 도구로 수동 skip — Phase 2 옵션
  - (c) 윈도우 종료 후 잔여 슬롯은 그대로 비움 (확정)

---

## 3. 데이터 모델

### 신규 테이블 2종

```sql
-- 슬롯 점유 상태. 48행. day=1 만 구현하고 시작, 4일차는 Phase 2 결정.
CREATE TABLE kvk_buff_slot (
  day SMALLINT NOT NULL,               -- 1 또는 4
  time_slot SMALLINT NOT NULL,         -- 0..47 (UTC 기준 30분 인덱스)
  holder_kingshot_id TEXT,             -- NULL = 빈 슬롯
  claimed_at TIMESTAMPTZ,
  PRIMARY KEY (day, time_slot)
);

-- 자리 선점 글로벌 상태 (singleton). cut freeze 시점에 1행 INSERT/UPSERT.
CREATE TABLE kvk_buff_state (
  id INT PRIMARY KEY DEFAULT 1,        -- 단일 행 보장
  cut_frozen_at TIMESTAMPTZ,           -- 48 컷 freeze 한 순간
  ranked_ids TEXT[],                   -- 48명 kingshot_id (rank 1~48 순서)
  current_turn_idx INT DEFAULT 0,      -- 현재 차례 인덱스 (0~48)
  turn_started_at TIMESTAMPTZ,         -- 통계용 (timeout 없음 → 로직엔 안 씀)
  CHECK (id = 1)
);
```

### RLS 원칙
- 두 테이블 모두 anon SELECT/INSERT/UPDATE 차단
- 모든 변경은 Edge Function `kvk-buff-slot` (service_role) 통과
- list 액션 결과만 anon 키로 호출 가능 (Edge Function 내부)

---

## 4. Edge Function 액션 스펙

새 함수: `supabase/functions/kvk-buff-slot/index.ts`

| 액션 | 입력 | 응답 | 권한 |
|---|---|---|---|
| `list` | (없음) | `{ ok, slots[48], current_turn_idx, ranked_ids?, cut_frozen_at }` | anon (read-only) |
| `claim` | `{ token, day, time_slot }` | `{ ok }` 또는 `{ ok:false, error }` | token 필수 + 본인 차례 검증 |
| `release` | `{ token, day, time_slot }` | `{ ok }` | token + 본인 슬롯만 |
| `init-freeze` | `{ admin_key }` | `{ ok, ranked_ids[48] }` | 운영자 admin_key 검증. 1회만 호출 |

### `claim` 검증 순서
1. token → kingshot_id 추출 (`authenticate`)
2. `kvk_buff_state` 의 `cut_frozen_at` 존재 여부 (freeze 안 됐으면 거부)
3. 현재 시각이 자리 선점 윈도우 안인지 (UTC 01:00~03:00)
4. `ranked_ids[current_turn_idx] === kingshot_id` (본인 차례 확인)
5. `kvk_buff_slot` 의 (day, time_slot) 슬롯이 NULL 인지
6. 모두 통과 → 슬롯 holder 갱신 + `current_turn_idx++`

### `release` (Phase 2 옵션)
- 본인이 점유한 슬롯을 해제 → 자리 이동 가능
- 단 `current_turn_idx` 는 갱신 안 함 (이미 본인 차례 끝남)
- 빈 슬롯이 됐으니 누구든 점유 가능 (단 본인 차례 사용자만)

### `init-freeze`
- KST 5월 16일 10:00 (= UTC 01:00) 시점에 1회 호출
- `kvk_speedup_survey` 의 city_level >= 26 + 점수 desc 상위 48명 추출 → `ranked_ids` 저장
- 점수 계산은 `src/lib/kvk-score.ts` 로직과 동일하게 Edge Function 측에서 재구현 (또는 서버측 함수 추출)
- 동시에 `kvk-survey` 의 `register`/`update`/`delete` 도 차단 시작 (시간 게이트)

---

## 5. UI / UX

### 시안 (완성 — `design-mockups/kvk-buff-slots.html`)

모달 구조 (4단):

```
┌─────────────────────────┐
│ [헤더] 버프 슬롯 선점  × │
├─────────────────────────┤
│ [안내] 4줄 (연보라 톤)  │  ← 점수 순위 / 변경 불가 / 큐 안내 / 윈도우 시각
├─────────────────────────┤
│ [선택중 사용자] 카드    │  ← 인디고 그라데이션 + 선택중 outline 뱃지 + ▾
│   클릭 시 다음 5명 큐   │
│ [KST] [복사하기]        │  ← 카드 바깥, 시간표 위
├─────────────────────────┤
│ [시간표] 48 슬롯 스크롤 │  ← 형광 보더 = 선택 가능 / 회색 = 점유 완료
└─────────────────────────┘
```

### 핵심 UI 컴포넌트

- **선택중 사용자 카드**: 점수 1위부터 순서대로 표시. 본인이 차례면 자기 정보 + "선택중" 뱃지. 클릭 시 다음 5명 큐 expand (CSS grid 0fr→1fr 트랜지션)
- **다음 차례 큐**: 5명까지. 남은 인원이 5명 미만이면 자동 truncate. 0명이면 "대기 중 없음" 메시지. 모두 완료 시 카드 전체가 "모든 사용자가 시간을 선택했습니다" 로 swap
- **KST/UTC 토글**: 뱃지 텍스트 = 전환 대상 (현재 UTC 면 "KST" 라벨, 클릭하면 KST 모드 + 라벨이 "UTC" 로). 시간표 라벨만 변환, 슬롯 순서는 UTC 인덱스 유지
- **복사하기**: 점유 슬롯의 `{TZ HH:MM} - {닉네임}` 줄을 시간순 정렬해 클립보드. 비-secure context 폴백 포함. 1.5초간 "복사됨" 피드백
- **확인 다이얼로그**: native `<dialog>`. "**HH:MM** 시간을 선택하시겠습니까?" + [취소] / [선택]. backdrop 클릭으로 닫기

### 권한별 UI 상태 (미구현 — 시안 단계에선 본인 차례만 단순 시뮬레이션)

| 상태 | UI |
|---|---|
| 토큰 없음 (PIN 미인증) | 모달 진입 차단. 제출 현황의 잠금 placeholder 재사용 |
| 48위 밖 | 카드 read-only. 빈 슬롯은 dim. "내 순위 49 / 컷 X점" 안내 |
| 48위 안 + 본인 차례 아님 | "지금 **X** 의 차례입니다" 라벨. 빈 슬롯도 dim (클릭 불가) |
| 48위 안 + 본인 차례 | 시안의 현재 동작. 빈 슬롯 형광 보더 + 클릭 → 확인 → 점유 |

---

## 6. 실시간 동기화

- **폴링**: 5초 간격으로 `list` 액션 호출
- `document.visibilityState === 'visible'` 일 때만 (탭 active)
- 새 데이터 도착 시 `patchList` 패턴으로 부분 갱신 (트랙 1 의 깜박임 제거 패턴 재사용)
- Supabase Realtime 도 옵션이지만 48명 규모에서 폴링이 충분히 가벼움

---

## 7. 단계적 구현 로드맵

### Phase 1 — MVP (1일차만, 일주일 안)
1. DB 마이그레이션 (`kvk_buff_slot` + `kvk_buff_state`)
2. Edge Function `kvk-buff-slot/index.ts` (list / claim / init-freeze)
3. 페이지: 제출 현황에 "버프 슬롯 보기" 진입 버튼 → 모달
4. 시안 HTML 을 Astro 페이지로 포팅 (`src/pages/survey/buff-slots.astro` 또는 모달 컴포넌트)
5. 폴링 5초
6. **운영 적용**: 마감 시점 + freeze 자동화

### Phase 2 — 운영 보강
- 1일차 / 4일차 분리 (필요하다면)
- 자리 변경 (`release` 액션)
- 48위 밖 사용자용 read-only UI
- 운영자 admin 도구 (수동 skip / 강제 할당)
- 강탈 모델 검토 (필요 시)

### Phase 3 — 시즌 후
- 자리 점유 결과 history 보존
- 다음 KvK 시즌용 재사용 패턴 확립

---

## 8. 다음 PC 에서 시작 가이드

```bash
git pull origin main
npm install
npm run dev
# 시안 확인: design-mockups/kvk-buff-slots.html 직접 브라우저에서 열기
# 본 기획 문서: design-mockups/kvk-buff-slots-plan.md (이 파일)
```

### 우선 할 일 순서

1. **이 문서 + 시안 HTML 둘 다 다시 한 번 검토** — 결정사항 vs 시안의 일치 확인
2. Phase 1 의 작업 1번부터 진행 — DB 마이그레이션 작성 (Claude 가)
3. 사용자가 `supabase db push` 로 production 적용
4. Edge Function 작성 → 사용자가 `supabase functions deploy kvk-buff-slot`
5. Astro 페이지 / 모달 구현 → `npm run build` 검증 → PR

### 결정 보류 사항 (Phase 1 시작 전 재확인 필요)
- **1일차 / 4일차 분리 여부**: 현재 기획서엔 1일치 우선 작성됨. 한 사람이 두 day 모두 받는다면 day 컬럼 활용. 한 day 만 받는다면 day 컬럼 의미 없어짐.
- **점수 계산을 Edge Function 측에 어떻게 이식**: 현재 `src/lib/kvk-score.ts` 가 TypeScript 클라/SSR 공용. Edge Function 은 Deno → 코드 재작성 필요. 또는 list API 응답에서 클라가 계산 후 ranked_ids 를 push?

---

## 9. 참고 — 결정 과정에서 검토했으나 채택 안 한 옵션

| 항목 | 검토한 옵션 | 채택 옵션 | 사유 |
|---|---|---|---|
| 선점 모델 | 강탈 (비행기 좌석) / 하이브리드 (사전 선호 등록) | 순차 진행 | UI 단순, 운영 부담 ↓ |
| Cut freeze 시점 | 선점 시작 순간 snapshot | 마감 시각(KST 5/16 10:00) 동시 freeze | 명료한 단일 시각 |
| Timeout | 1.5분+2pass / 2분 / 3분 | **없음** | 게임 내 공지로 인지율 ↑, 운영 단순 |
| 잔여 빈 슬롯 | 윈도우 연장 / skip 된 사람 free-for-all | 그대로 비움 | 운영 단순, 연맹 swap 가능 |

---

(끝. 작성일: 2026-05-13. 작성자: 사용자(Toycode) + Claude 협업.)
