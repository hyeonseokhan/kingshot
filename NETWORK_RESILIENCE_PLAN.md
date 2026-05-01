# 네트워크 회복력 점진 도입 계획

> **상태**: 계획 수립 완료, 구현 미시작 (2026-05-01)
> **목표**: 약한 네트워크 환경 (호텔/카페 Wi-Fi, 셀룰러 hiccup, iOS Safari background drop) 에서도 미니게임 보상/진행 손실이 없도록 클라이언트 ↔ Edge Function 호출의 회복력 강화
> **다른 PC 에서 작업 재개 시**: 본 문서가 SSOT. CLAUDE.md 의 "후속 작업 트랙" 과는 별개의 횡단 트랙.

---

## 1. 발단 (이번 사건)

- 사용자 바유당 (kingshot_id=271155609), iOS Safari, 호텔 Wi-Fi
- 타일매치 Stage 66 클리어 시 `⚠️ Stage 66 보상 처리 실패 (Load failed) — 운영자에게 알려주세요` 토스트 발생
- 분석:
  - 서버가 reject 한 게 아니라 iOS Safari 의 `fetch()` 가 네트워크 단계에서 실패 (`TypeError: Load failed`)
  - [src/scripts/pages/tile-match.ts:144-167](src/scripts/pages/tile-match.ts#L144-L167) `callEconomy` 의 catch 분기가 `String(err.message)` 를 그대로 `error` 필드로 반환
  - [src/scripts/pages/tile-match.ts:1017-1026](src/scripts/pages/tile-match.ts#L1017-L1026) `showClaimFailureToast` 가 그 raw 메시지를 괄호 안에 노출
- 그래서 **이건 stage cap 이슈 (ISSUES #8) 와 무관**. 메시지가 영문 "Load failed" 면 클라이언트 fetch 실패, 영문 코드 (invalid_stage 등) 면 서버 reject

### 1.1 핵심 함정 — stage 46+ 의 멱등성 부재

- [supabase/migrations/20260428100000_create_crystal_economy.sql:54-57](supabase/migrations/20260428100000_create_crystal_economy.sql#L54-L57) 의 partial unique index `(player_id, ref_key) WHERE ref_key IS NOT NULL`
- [supabase/functions/economy/index.ts:113-115](supabase/functions/economy/index.ts#L113-L115) 가 stage 46+ 에 `refKey = null` 부여 (반복 파밍 의도)
- 결과: stage 46+ 클리어는 **재시도 시 중복 적립 위험**. 즉 retry/outbox 도입 전 반드시 멱등 키 부여 선행 필요

---

## 2. 작업 시작 전 1회 보전 (사용자 직접 SQL 실행)

### 2.1 바유당 stage 66 실제 적립 여부 확인

```sql
SELECT created_at, amount, ref_data
FROM crystal_transactions
WHERE player_id = '271155609'
  AND source = 'tile_match_clear'
  AND ref_data->>'stage' = '66'
ORDER BY created_at DESC
LIMIT 5;

-- 보조: 잔액 / 진척
SELECT balance, total_earned, updated_at FROM crystal_balances WHERE player_id = '271155609';
SELECT best_stage, updated_at FROM tile_match_records WHERE player_id = '271155609';
```

토스트 발생 시각의 row 가 있으면 → 적립 정상, 토스트만 거짓 알람.
없으면 → 100 손실, 아래 INSERT 로 보전:

### 2.2 누락이면 100 보전

```sql
INSERT INTO crystal_transactions (player_id, amount, source, ref_data)
VALUES ('271155609', 100, 'tile_match_clear', '{"stage": 66, "manual_recover": true}'::jsonb);

UPDATE crystal_balances
SET balance = balance + 100,
    total_earned = total_earned + 100,
    updated_at = now()
WHERE player_id = '271155609';
```

---

## 3. 현재 코드 결함 체크리스트

5개 호출부 ([tile-match.ts callEconomy/callAuth](src/scripts/pages/tile-match.ts#L118), [tile-match-auth.ts callAuth](src/scripts/pages/tile-match-auth.ts#L319), [equipment.ts postJson](src/scripts/pages/equipment.ts#L79), [pvp.ts postJson](src/scripts/pages/pvp.ts)) 가 거의 동일한 얇은 fetch 래퍼이며 모두 다음이 부재:

| 결함 | 영향 | 노출 호출 |
|------|------|-----------|
| 타임아웃 없음 | 약한 Wi-Fi 에서 무한 대기 → 앱 전환 시 abort = "Load failed" | 5곳 전부 |
| 네트워크 오류 재시도 없음 | 503 만 재시도하고 catch 분기는 즉시 포기 | 5곳 전부 |
| keepalive 미사용 | fire-and-forget 인데도 페이지 hide 시 connection drop | record-clear, claim-stage-reward |
| stage 46+ 멱등성 부재 | 재시도/outbox 도입 못 하는 근본 원인 | claim-stage-reward |
| outbox/큐 부재 | 페이지 닫으면 누락 영구화 | 5곳 전부 |
| online/offline 감지 없음 | 사용자 안내 없음 | 5곳 전부 |
| 사용자 안내 raw 메시지 | "Load failed" 같은 영문 stack 노출 | claim-stage-reward 외 alert raw |
| 공통 fetcher 부재 | 정책 변경 시 5곳 손대야 | 5곳 전부 |

### 3.1 호출별 멱등성 / retry 안전성

| 호출 | 자연 멱등? | retry 안전? | 비고 |
|------|----------|-----------|------|
| `claim-stage-reward` (stage 1~45) | ✅ (first_clear ref_key) | ✅ | 그대로 OK |
| `claim-stage-reward` (stage 46+) | ❌ (ref_key=NULL) | ❌ | **PR 1 에서 client UUID 부여로 해결** |
| `record-clear` | ✅ (best_stage UPSERT) | ✅ | 그대로 OK |
| `pin-status` / `verify-pin` / `set-pin` | ⚪ (read 또는 idempotent UPSERT) | ✅ | OK |
| `enhance` | ❌ (random roll, 차감) | ❌ | **retry 금물**. 별도 트랙 (멱등성 도입 시점) |
| `play-card` | ❌ (random roll, 턴 진행) | ❌ | **retry 금물**. 한 클릭 = 두 턴 위험 |
| `start-battle` / `list-opponents` / 기타 read | ⚪ | ✅ | OK |
| `get-balance` / `get-equipment` | ⚪ (pure read) | ✅ | OK |

→ **공통 fetcher 의 retry 옵션은 호출 단위로 명시적 on/off** 필수. 기본값 단정 금지.

---

## 4. 작업 계획 (PR 단위)

> **모든 PR 공통 작업 분담**: Claude 가 코드/빌드/PR 까지. 사용자가 `supabase functions deploy <name>` (또는 `db push`) + 브라우저 회귀 검증.

### PR 1 — Tier 1: 이번 케이스 차단 ⚠️ 항목 분리 금지 (묶음 필수)

**목적**: 약한 네트워크에서 claim-stage-reward 가 손실 없이 자동 재시도. stage 46+ 도 안전.

**변경 1: stage 46+ 도 client UUID ref_key 부여**
- 클라 [src/scripts/pages/tile-match.ts](src/scripts/pages/tile-match.ts) 의 `onClear` 가 `crypto.randomUUID()` 로 ref_key 생성 → body 에 포함하여 전송
- ref_key 형식 제안: `tile_match:stage_${stage}:repeat:${uuid}` (디버깅/audit 용 prefix 유지)
- 서버 [supabase/functions/economy/index.ts:113-115](supabase/functions/economy/index.ts#L113-L115) 가 클라가 보낸 ref_key 우선 사용, 없으면 fallback
  - stage 1~45 는 클라가 ref_key 안 보내도 서버가 first_clear 키 부여 (현재 동작 유지)
  - stage 46+ 는 클라가 보낸 ref_key 가 있으면 그걸로, 없으면 NULL (현재 동작 fallback)
- DB 변경 없음 (partial unique index 그대로 활용)

**변경 2: 네트워크 오류 + 5xx 재시도**
- catch 분기에서도 재시도 (현재는 503 만)
- exponential backoff: 300ms → 900ms → 2700ms + jitter (±20%), 총 3회 시도
- HTTP 408/429/5xx 도 재시도 대상

**변경 3: AbortController 15초 타임아웃**
- 무한 대기 차단. iOS Safari 의 background drop 보다 먼저 자체 timeout → retry 안전

**변경 4: 사용자 메시지 인간화**
- raw "Load failed" 노출 제거. 재시도 중에는 silent, 최종 실패 시 "📶 네트워크가 불안정합니다 — 잠시 후 자동 처리됩니다" (PR 3 에서 outbox 도착 후 메시지 동기화)

#### PR 1 의 invariants (반드시 지킬 규칙)

1. **ref_key 는 호출 1건당 1번만 생성**. retry 가 동일 키 재사용 (closure 또는 sessionStorage). retry 마다 새 UUID 생성하면 멱등성 깨짐.
2. **PR 분리 금지**. 변경 1 + 변경 2 가 같은 PR. 분리하면 stage 46+ 중복 적립 윈도우 발생 (검토 에이전트 핵심 지적).

#### PR 1 변경 파일

- `src/scripts/pages/tile-match.ts` (callEconomy + onClear)
- `supabase/functions/economy/index.ts` (claimStageReward refKey 처리)
- (선택) `src/lib/edge-fn.ts` 신규 — 공통 fetcher 의 토대를 미리 깔 수도 있고, PR 2 까지 미뤄도 됨

#### PR 1 검증

- 빌드: `npm run build`
- 사용자 직접: `supabase functions deploy economy`
- 브라우저 회귀:
  - stage 1~45 첫 클리어 (보상 정상)
  - stage 1~45 재클리어 (duplicate=true, +0)
  - stage 46+ 클리어 (보상 +100, 동일 stage 여러 번 클리어 시 매번 +100 정상)
  - DevTools 로 네트워크 throttling (Slow 3G + offline) 시뮬레이션 → retry 후 성공 확인
  - DB 의 `crystal_transactions` 에서 stage 46+ row 의 ref_key 가 `tile_match:stage_N:repeat:<uuid>` 패턴인지 확인

---

### PR 2 — Tier 2: 5곳 일반화

**목적**: 다른 4개 호출부도 PR 1 의 회복력 패턴 활용. enhance/play-card 는 retry 끄기.

**변경 1: 공통 fetcher 추출 → `src/lib/edge-fn.ts`**

API 형태 (제안):
```ts
type RetryPolicy = 'safe' | 'none';
// 'safe': PR 1 의 backoff retry 정책 (호출이 멱등인 경우만)
// 'none': 재시도 없음 (random 결과 액션 — play-card, enhance)

interface CallEdgeFnOptions {
  retry?: RetryPolicy;       // default: 'none' (보수적 — 호출자가 명시적 opt-in)
  timeoutMs?: number;        // default: 15000
  keepalive?: boolean;       // default: false (fire-and-forget 호출만 true)
}

function callEdgeFn<T>(url: string, body: object, opts?: CallEdgeFnOptions): Promise<T>;
```

**기본값 보수적 설계** — `retry: 'none'` 이 default. 호출자가 안전을 입증하고 'safe' opt-in. play-card/enhance 가 실수로 retry 타지 않게.

**변경 2: 5곳 호출부 마이그레이션**

| 호출 | retry | keepalive | 비고 |
|------|-------|-----------|------|
| `claim-stage-reward` | 'safe' | true | PR 1 에서 이미 안전 |
| `record-clear` | 'safe' | true | best_stage UPSERT 라 멱등 |
| `pin-status` / `verify-pin` / `set-pin` | 'safe' | false | UPSERT 또는 read |
| `get-equipment` / `get-balance` / `get-record` / `list-opponents` | 'safe' | false | pure read |
| `enhance` | **'none'** | false | random roll, retry 금지 |
| `play-card` | **'none'** | false | random roll, retry 금지 |
| `start-battle` | 'none' | false | 매 호출 새 battle row 생성, retry 시 두 battle 위험 |

**변경 3: pagehide listener + sendBeacon fallback**

- 페이지 hide 직전 미전송 in-flight 요청을 sendBeacon 으로 강제 송출 (응답은 못 받지만 서버 도달은 보장)
- 단, sendBeacon 은 잔액 응답을 못 받음 → 다음 페이지 진입 시 `get-balance` 로 동기화

**iOS Safari keepalive 한계 (검토 에이전트 지적)**
- Safari 14.1+ 부터 지원하지만 약한 Wi-Fi / OS 강제 kill 시 신뢰성 약함
- → keepalive 는 **best-effort**, 진짜 안전망은 PR 3 의 outbox

#### PR 2 변경 파일

- `src/lib/edge-fn.ts` (신규)
- `src/scripts/pages/tile-match.ts` (callAuth/callEconomy 래퍼 → callEdgeFn)
- `src/scripts/pages/tile-match-auth.ts`
- `src/scripts/pages/equipment.ts`
- `src/scripts/pages/pvp.ts`
- (선택) `src/scripts/pages/partner-draw.ts`, `src/scripts/pages/coupons.ts` 도 같은 패턴 쓰는지 확인

#### PR 2 검증

- 빌드 + 타입체크
- 5개 페이지 모두 회귀: 인증/타일매치/장비/PvP/쿠폰
- 특히 enhance 와 play-card 가 retry **안 타는지** 확인 — 의도적 fail (서버 503 mock 또는 네트워크 throttle) 후 1회만 시도하는지

---

### PR 3 — Tier 3: outbox 큐 (외부 단절 회복)

**목적**: 호텔 Wi-Fi 가 실제로 끊겼다 붙는 상황 — 페이지 닫혀도 다음 진입 시 자동 보전.

**변경 1: localStorage outbox**

- 스키마 (제안):
```ts
interface OutboxEntry {
  id: string;              // 같은 UUID = ref_key 와 동일 (멱등 키)
  url: string;
  body: object;            // ref_key 포함 — flush 시 그대로 재전송
  created_at: number;      // ms epoch
  attempt_count: number;
  last_error?: string;
}
```
- 키: `pnx_outbox_v1`. 배열 형태. 5MB quota 충분 (각 entry < 1KB)
- 위치: `src/lib/outbox.ts` (신규)

**변경 2: outbox 흐름**

- `callEdgeFn` 의 final 실패 (3회 retry 모두 실패 또는 offline) 시 outbox 에 append (호출이 outbox 대상인 경우만 — `outboxable: true` 옵션)
- flush trigger:
  1. 페이지 진입 시 (`initTileMatch`, `initEquipment`, `initPvp` 등에서 호출) 또는 통합 init 후크
  2. `online` 이벤트 수신 시
  3. 사용자가 "재시도" 버튼 클릭 시 (옵션 ⑨ 의 배지에서)
- flush 동작: outbox entry 마다 `callEdgeFn(url, body, { retry: 'safe' })`. 성공 시 entry 제거, attempt_count 증가. 5회 이상 실패면 dead letter (별도 키 `pnx_outbox_dead_v1` 로 이동, 사용자 안내)
- **race**: 두 탭에서 동시 flush 가능. 다행히 ref_key 멱등성 덕분에 안전 (서버 unique violation 으로 한쪽만 적용). 그래도 좋은 시민으로 `BroadcastChannel` 또는 `localStorage` lock 시도 권장

**변경 3: 헤더 배지 "처리 대기 N건"**

- `LoginedUserInfo` 위젯 옆 (또는 내부) 에 작은 배지. outbox 비면 hide.
- 클릭 시: 보류 항목 목록 + "지금 재시도" 버튼

**변경 4: navigator.onLine 감지**

- offline 인 동안 호출은 즉시 outbox 행 + 토스트 "오프라인 — 연결 복구 시 자동 처리"
- online 이벤트 수신 시 자동 flush

#### outbox 대상 (outboxable: true)

| 호출 | outboxable | 이유 |
|------|-----------|------|
| `claim-stage-reward` | ✅ | 멱등 키 있음, 보상 손실 막아야 |
| `record-clear` | ✅ | UPSERT 멱등 |
| `set-pin` | ✅ | UPSERT 멱등 |
| `verify-pin` / `pin-status` | ❌ | 즉시 응답 필요한 인증 흐름 |
| `enhance` | ❌ | 멱등성 없음 |
| `play-card` / `start-battle` | ❌ | 멱등성 없음 + 즉시 응답 필요 |
| `get-*` (read) | ❌ | 의미 없음 |

#### PR 3 검증

- DevTools offline 모드로 stage 46+ 클리어 → 토스트 "오프라인" → outbox 에 entry 1건 → online 복귀 → 자동 flush → 잔액 +100
- 동일 시나리오 X N (5번 정도) → 모두 적립 + outbox 빔
- 페이지 닫고 재진입해도 entry 살아있고 flush 됨
- 두 탭에서 동시 flush 시 중복 적립 X (서버 멱등으로 차단 확인)

#### PR 3 변경 파일

- `src/lib/outbox.ts` (신규)
- `src/lib/edge-fn.ts` (outbox 통합)
- `src/components/LoginedUserInfo.astro` (배지)
- `src/scripts/pages/tile-match.ts`, `equipment.ts`, `pvp.ts` 등 (outboxable 플래그)

---

## 5. invariants & 위험 회피 (전 PR 공통)

1. **ref_key UUID 는 호출 1건당 1번 생성**. retry 와 outbox flush 모두 같은 키 재사용. 매번 새 UUID 생성 = 멱등성 붕괴.
2. **retry: 'safe' 는 호출 단위 명시적 opt-in**. default 'none'. play-card/enhance 가 실수로 retry 타는 회귀 차단.
3. **PR 1 의 변경 1 + 변경 2 분리 금지**. 같은 PR.
4. **outbox dead letter** — 5회 이상 실패한 entry 는 자동 폐기 X, 별도 dead letter 키로 이동 + 사용자 안내. 데이터 silent loss 차단.
5. **localStorage quota 모니터** — outbox 가 5MB 넘기 전에 dead letter 로 밀거나 사용자 안내. 정상 사용자는 절대 도달 안 하지만 방어.
6. **두 탭 race** — ref_key 멱등성으로 안전하지만 좋은 시민 패턴 (BroadcastChannel) 권장.

---

## 6. 보류 / 미래 항목 (이번 트랙 범위 밖)

| 항목 | 사유 |
|------|------|
| Service Worker + Background Sync | iOS Safari 미지원. 우리 사용자층에 가성비 낮음 |
| `enhance` 멱등성 도입 | DB 마이그레이션 필요 (random seed 캐시 또는 (player_id, attempt_id) UNIQUE). 위험도 큼. 별도 트랙 |
| `play-card` 멱등성 도입 | (battle_id, turn) UNIQUE 제약 + 결과 캐시. 별도 트랙 |
| IndexedDB outbox | localStorage 5MB 충분, 22명 규모. IndexedDB 는 과투자 |

---

## 7. 작업 분담

| 작업 | 담당 |
|------|------|
| PR 1~3 코드 작성 + 빌드 검증 + PR 생성 | Claude |
| `supabase functions deploy economy` (PR 1) | 사용자 |
| `supabase functions deploy <others>` (PR 2 시 필요한 경우) | 사용자 |
| 브라우저 회귀 검증 | 사용자 |
| 바유당 stage 66 보전 SQL 실행 (작업 시작 전 1회) | 사용자 |

PR 머지 → 다음 PR 시작은 사용자의 회귀 검증 통과 후.

---

## 8. 진행 시작 시 먼저 할 일

1. (사용자) §2 보전 SQL 실행
2. (Claude) 본 문서 마지막 commit hash 와 현재 main 의 diff 확인. 그동안 economy/tile-match 가 변경됐다면 §1.1 의 핵심 함정 재검증 (특히 ref_key 처리 로직)
3. (Claude) PR 1 부터 시작

---

## 9. 참고

- 본 계획은 독립 검토 에이전트의 사전 검토 통과 (수정 후) 본
- 핵심 검토 포인트:
  - ① + ② 분리 금지 (stage 46+ 중복 적립 윈도우)
  - retry 시 ref_key 재사용 invariant
  - play-card/enhance retry 금물 (random 결과)
  - keepalive 만으론 부족, outbox 까지 가야 진짜 안전망
- 관련 기존 메모: CLAUDE.md 의 "Stage cap 회귀 함정" (ISSUES #8) — 본 사건과 별개의 이슈이지만 같은 호출 경로
