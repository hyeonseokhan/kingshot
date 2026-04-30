/**
 * 건축 버프 최적화 — 순수 계산 유틸.
 *
 * 가이드 (`신규서비스.md`) §6 ~ §10 의 공식을 코드로 옮긴 것. UI 무관 — Node 환경에서도 실행되는
 * 순수 함수만. 단위 테스트(`build-optimizer.test.ts`) 가 가이드의 §16 시나리오를 검증.
 *
 * 핵심 공식 (§2.3):
 *   최종 건축 시간 = 기본 ÷ (1 + 속도 버프 합 / 100) × (1 - 시간 단축 / 100)
 *
 * 의사결정 흐름:
 *   1. 즉시 건축 시간 계산 (총리대신 제외)
 *   2. 총리대신 적용 시 건축 시간 계산
 *   3. 손익분기 대기 시간 = (1) - (2). 이 시간 안이면 기다림이 이득.
 *   4. 실제 대기시간 vs 손익분기 비교 → 이득/손해
 */

// ============================================================
// 타입
// ============================================================

export interface TimeInput {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export interface BuffSettings {
  /** 기본 건설 속도 (%) — 예: 54.6 */
  baseSpeedPercent: number;
  /** 펫 버프 속도 (%) — 0 / 5 / 7 / 9 / 12 / 15 */
  petSpeedPercent: number;
  /** 총리대신 속도 (%) — 0 또는 10 */
  primeMinisterSpeedPercent: number;
  /** 법령 시간 단축 (%) — 0 또는 20 */
  lawReductionPercent: number;
  /** 총리대신까지 남은 시간 (초). 0 이면 즉시 사용 가능. */
  primeMinisterWaitSeconds: number;
  /** 보유 건축 가속권 합산 시간 (초). 0 이면 없음. */
  accelerationTicketSeconds: number;
}

export interface BuildingCandidate {
  id: string;
  name?: string;
  /** 기본 건축 시간 (초) */
  baseSeconds: number;
  priority?: number;
}

export interface BuildQueue {
  id: 'queue1' | 'queue2';
  status: 'empty' | 'building';
  /** building 일 때만 의미 */
  remainingSeconds: number;
}

export interface BuildingAnalysis {
  buildingId: string;
  /** 지금 시작 시 완료까지 걸리는 *건축* 시간 (총리대신 제외) */
  immediateBuildSeconds: number;
  /** 총리대신 받은 후 시작 시 *건축* 시간 (대기시간 제외) */
  withPrimeMinisterBuildSeconds: number;
  /**
   * 손익분기 대기 시간. 총리대신을 이 시간보다 짧게 기다리면 이득.
   * (= immediate - withPrimeMinister, 가이드 §7)
   */
  breakEvenWaitSeconds: number;
  /** 실제 사용자가 기다려야 하는 시간 (= buffs.primeMinisterWaitSeconds) */
  actualWaitSeconds: number;
  /**
   * 이득 시간 (양수=기다리는 게 이득, 음수=즉시가 이득, 0=동률).
   * = breakEvenWaitSeconds - actualWaitSeconds
   */
  netGainSeconds: number;
  /**
   * 권장: 총리대신을 기다려야 하는가?
   * - actualWaitSeconds === 0 (즉시 사용 가능) → false (지금 모든 버프 적용해서 시작)
   * - netGainSeconds > 0 (대기가 이득) → true
   * - 그 외 → false
   */
  shouldWaitForPrimeMinister: boolean;
}

/**
 * 단일 후보의 큐 배정 결과 — `evaluateAssignment` 의 출력.
 * BuildingAnalysis 가 "큐 빔 시각 = 0 가정 + 즉시 vs PM" 비교라면
 * CandidateAssignment 는 큐 빔 시각을 더해 *현실 시각* 기준 완료 시점까지 계산.
 */
export interface CandidateAssignment {
  candidate: BuildingCandidate;
  assignedQueueId: 'queue1' | 'queue2';
  /** 큐 빔 시각 (now=0 기준 초). 이미 비어 있으면 0. */
  queueFreeSeconds: number;
  /** 즉시 전략(총리대신 미적용) 시 *현재 시각 기준* 완료까지 총 소요 = 큐 빔 + 즉시건축. */
  immediateTotalSeconds: number;
  /** 총리대신 적용 시 *현재 시각 기준* 완료까지 총 소요 = max(큐빔, PM) + PM건축. */
  withPmTotalSeconds: number;
  /** 즉시건축 시간 (대기 제외) — 상세 표시용 */
  immediateBuildSeconds: number;
  withPrimeMinisterBuildSeconds: number;
  /** 손익분기 — 가이드 §7 상세 표시용 */
  breakEvenWaitSeconds: number;
  /** 4 시점 비교 결과. 패턴 D 등 외부 규칙으로 override 될 수 있음. */
  chosenStrategy: 'immediate' | 'wait-pm';
  shouldWaitForPrimeMinister: boolean;
  /** 이득 시간 (양수=PM 이득). = immediateTotal - withPmTotal */
  netGainSeconds: number;
  /** 가속권 사용량 (Phase 3) — 0 이면 미사용. */
  accelerationUsedSeconds: number;
}

/**
 * §8.3 의 패턴 분류 — UI 헤더 메시지에 활용.
 * - 'A': 큐가 곧 비고 PM 은 멀음, 후보 2개 (짧은+긴)
 * - 'B': 긴 건물 1개 + PM 대기 < 손익분기
 * - 'C': 짧은 건물 + PM 대기 > 손익분기
 * - 'D': 큐 둘 다 비어 있고 후보 2개 (짧은 즉시, 긴 PM)
 * - 'single': 후보 1개 단순 케이스
 */
export type RecommendationPattern = 'A' | 'B' | 'C' | 'D' | 'single';

export interface OptimizationResult {
  pattern: RecommendationPattern;
  assignments: CandidateAssignment[];
  /** 가속권 분석 (Phase 3) — undefined 면 미사용. */
  acceleration?: AccelerationAnalysis;
}

export interface AccelerationAnalysis {
  recommended: boolean;
  useTicketSeconds: number;
  /** 큐 빔 시각이 가속권 사용으로 얼마나 단축되는지 = useTicketSeconds */
  /** 절약 시간 (가속 미사용 vs 사용 시 완료 시각 차이 + useTicket — 즉 §9.3 정의의 절약) */
  savedSeconds: number;
  /** 순이득 = savedSeconds - useTicketSeconds. 양수면 추천. */
  netGainSeconds: number;
  reason: string;
}

// ============================================================
// 시간 변환
// ============================================================

/** TimeInput → 초 합산. */
export function toSeconds(t: TimeInput): number {
  return t.days * 86400 + t.hours * 3600 + t.minutes * 60 + t.seconds;
}

/** 초 → TimeInput 분해. */
export function fromSeconds(totalSec: number): TimeInput {
  const sign = totalSec < 0 ? -1 : 1;
  let s = Math.abs(Math.floor(totalSec));
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  const seconds = s - minutes * 60;
  return {
    days: sign * days,
    hours: sign * hours,
    minutes: sign * minutes,
    seconds: sign * seconds,
  };
}

/**
 * 초 → 사람이 읽기 쉬운 형식. 0 단위는 생략.
 * - 기본: "13일 4시간 35분"
 * - includeSeconds=true: "13일 4시간 35분 14초"
 * - 0초: "0초"
 */
export function formatTime(totalSec: number, includeSeconds = false): string {
  if (totalSec === 0) return '0초';
  const t = fromSeconds(totalSec);
  const parts: string[] = [];
  if (t.days) parts.push(t.days + '일');
  if (t.hours) parts.push(t.hours + '시간');
  if (t.minutes) parts.push(t.minutes + '분');
  if (includeSeconds && t.seconds) parts.push(t.seconds + '초');
  // 모든 큰 단위가 0 인데 초만 있는 경우 (includeSeconds=false) → 0분 표시
  if (parts.length === 0) {
    return includeSeconds ? t.seconds + '초' : '0분';
  }
  return parts.join(' ');
}

// ============================================================
// 핵심 공식 (§6.1)
// ============================================================

/**
 * 최종 건축 시간 계산. 가이드 §2.3, §6.1.
 *
 * 최종시간 = 기본 ÷ (1 + 속도 버프 합 / 100) × (1 - 시간 단축 / 100)
 *
 * @param baseSeconds 기본 건축 시간 (초)
 * @param speedBuffPercent 속도 버프 합 (%) — 기본 + 펫 + 총리대신
 * @param timeReductionPercent 시간 단축 (%) — 법령 등
 */
export function calculateBuildTime(
  baseSeconds: number,
  speedBuffPercent: number,
  timeReductionPercent: number,
): number {
  const speedMultiplier = 1 + speedBuffPercent / 100;
  const reductionMultiplier = 1 - timeReductionPercent / 100;
  return (baseSeconds / speedMultiplier) * reductionMultiplier;
}

// ============================================================
// 단일 건물 분석 (§6.2 ~ §7)
// ============================================================

/** 즉시 건축 시 적용되는 속도 버프 합 (총리대신 제외). */
function immediateSpeedPercent(buffs: BuffSettings): number {
  return buffs.baseSpeedPercent + buffs.petSpeedPercent;
}

/** 총리대신 적용 시 속도 버프 합. */
function withPmSpeedPercent(buffs: BuffSettings): number {
  return immediateSpeedPercent(buffs) + buffs.primeMinisterSpeedPercent;
}

/**
 * 단일 건물 분석. 가이드 §6.2 ~ §7.
 *
 * 즉시 vs 총리대신 대기 비교 + 손익분기 + 이득 시간 계산.
 */
export function analyzeBuilding(
  building: BuildingCandidate,
  buffs: BuffSettings,
): BuildingAnalysis {
  const immediate = calculateBuildTime(
    building.baseSeconds,
    immediateSpeedPercent(buffs),
    buffs.lawReductionPercent,
  );
  const withPm = calculateBuildTime(
    building.baseSeconds,
    withPmSpeedPercent(buffs),
    buffs.lawReductionPercent,
  );
  const breakEven = immediate - withPm;
  const actualWait = buffs.primeMinisterWaitSeconds;
  const netGain = breakEven - actualWait;
  return {
    buildingId: building.id,
    immediateBuildSeconds: immediate,
    withPrimeMinisterBuildSeconds: withPm,
    breakEvenWaitSeconds: breakEven,
    actualWaitSeconds: actualWait,
    netGainSeconds: netGain,
    shouldWaitForPrimeMinister: actualWait > 0 && netGain > 0,
  };
}

// ============================================================
// 큐 빔 시각 기반 후보 배정 (§8 ~ §10)
// ============================================================

/**
 * BuildQueue → 큐 빔 시각 (현재=0 기준 초).
 * empty 면 0 (즉시 비어 있음).
 */
function queueFreeSeconds(q: BuildQueue): number {
  return q.status === 'empty' ? 0 : Math.max(0, q.remainingSeconds);
}

/**
 * 단일 후보 + 단일 큐 (배정 후) 의 4 시점 비교.
 *
 * - t_start_immediate = max(t_queue_free, 0) = t_queue_free
 * - t_start_with_pm   = max(t_queue_free, t_pm)
 * - 완료_즉시   = t_start_immediate + 즉시건축
 * - 완료_PM     = t_start_with_pm   + PM건축
 *
 * 더 빠른 쪽이 chosenStrategy. 4 시점 모델 단독으론 패턴 D 의 "짧은 건은 즉시" 규칙을
 * 못 풀어내므로, 그건 호출 측(`recommendForCandidates`)에서 override.
 */
export function evaluateAssignment(
  candidate: BuildingCandidate,
  queueFreeSec: number,
  buffs: BuffSettings,
  options?: { queueId?: 'queue1' | 'queue2' },
): CandidateAssignment {
  const inner = analyzeBuilding(candidate, buffs);
  const tQueueFree = Math.max(0, queueFreeSec);
  const tPm = Math.max(0, buffs.primeMinisterWaitSeconds);

  const tStartImmediate = tQueueFree;
  const tStartWithPm = Math.max(tQueueFree, tPm);

  const totalImmediate = tStartImmediate + inner.immediateBuildSeconds;
  const totalWithPm = tStartWithPm + inner.withPrimeMinisterBuildSeconds;

  const chosenStrategy: 'immediate' | 'wait-pm' =
    totalWithPm < totalImmediate ? 'wait-pm' : 'immediate';
  const netGain = totalImmediate - totalWithPm;

  return {
    candidate,
    assignedQueueId: options?.queueId ?? 'queue1',
    queueFreeSeconds: tQueueFree,
    immediateTotalSeconds: totalImmediate,
    withPmTotalSeconds: totalWithPm,
    immediateBuildSeconds: inner.immediateBuildSeconds,
    withPrimeMinisterBuildSeconds: inner.withPrimeMinisterBuildSeconds,
    breakEvenWaitSeconds: inner.breakEvenWaitSeconds,
    chosenStrategy,
    shouldWaitForPrimeMinister: chosenStrategy === 'wait-pm',
    netGainSeconds: netGain,
    accelerationUsedSeconds: 0,
  };
}

/**
 * 후보 1~2개 + 큐 2개 (각각 비어있음/건축중) + 버프 → 추천 결과.
 *
 * 알고리즘:
 *   1) 후보 1개 → 더 빠르게 비는 큐에 배정 + evaluateAssignment
 *   2) 후보 2개 → 두 매칭 (긴→q1·짧→q2 vs 긴→q2·짧→q1) 모두 평가 →
 *                makespan(=두 완료 시각의 최댓값) 작은 쪽 선택
 *   3) 패턴 D (큐 둘 다 비어 + 후보 2개): 짧은 후보는 강제 immediate, 긴 후보만 PM 평가.
 *      §8.3 의 명시 규칙 — 두 후보 모두에 PM 적용 X (펫/법령 별개 처리는 §15.3 안내)
 */
export function recommendForCandidates(
  candidates: BuildingCandidate[],
  queues: [BuildQueue, BuildQueue],
  buffs: BuffSettings,
): OptimizationResult {
  if (candidates.length === 0) {
    return { pattern: 'single', assignments: [] };
  }

  const queueFree: [number, number] = [queueFreeSeconds(queues[0]), queueFreeSeconds(queues[1])];

  // 후보 1개 — 더 빠르게 비는 큐에 배정
  if (candidates.length === 1) {
    const qIdx = queueFree[0] <= queueFree[1] ? 0 : 1;
    const a = evaluateAssignment(candidates[0]!, queueFree[qIdx]!, buffs, {
      queueId: queues[qIdx]!.id,
    });
    return {
      pattern: classifySingle(a, buffs.primeMinisterWaitSeconds),
      assignments: [a],
    };
  }

  // 후보 2개 — 가이드 §8.3 의 결정적 매칭:
  //   짧은 후보 → 빠르게 비는 큐 (즉시 시작 잘 됨)
  //   긴 후보   → 늦게 비는 큐    (PM 적용 시 자연 정렬)
  // 두 큐 빔 시각이 같으면 어느 쪽이든 동등 — fasterQueueIdx 가 0 이라 결정적.
  const sortedDesc = [...candidates].sort((a, b) => b.baseSeconds - a.baseSeconds);
  const longer = sortedDesc[0]!;
  const shorter = sortedDesc[1]!;

  const fasterQueueIdx: 0 | 1 = queueFree[0] <= queueFree[1] ? 0 : 1;
  const slowerQueueIdx: 0 | 1 = fasterQueueIdx === 0 ? 1 : 0;

  const evals = [
    evaluateAssignment(shorter, queueFree[fasterQueueIdx]!, buffs, {
      queueId: queues[fasterQueueIdx]!.id,
    }),
    evaluateAssignment(longer, queueFree[slowerQueueIdx]!, buffs, {
      queueId: queues[slowerQueueIdx]!.id,
    }),
  ];

  // 패턴 D 규칙: 큐 둘 다 비어 있을 때 짧은 후보는 항상 immediate
  // (가이드 §8.3 패턴 D — 둘 다 PM 이득이라도 짧은 건은 즉시)
  const bothQueuesEmpty = queueFree[0] === 0 && queueFree[1] === 0;
  if (bothQueuesEmpty) {
    const shorterEval = evals.find((e) => e.candidate.id === shorter.id)!;
    shorterEval.chosenStrategy = 'immediate';
    shorterEval.shouldWaitForPrimeMinister = false;
  }

  return {
    pattern: classifyPair(evals, queueFree, buffs.primeMinisterWaitSeconds),
    assignments: evals,
  };
}

/** 단일 후보의 패턴 분류 — B (긴+PM 이득) vs C (짧+PM 손해) vs single */
function classifySingle(a: CandidateAssignment, tPm: number): RecommendationPattern {
  if (tPm <= 0) return 'single';
  // 손익분기 vs 실제 대기 비교 — 가이드 §8.3 의 B/C 정의
  if (a.breakEvenWaitSeconds > tPm) return 'B'; // 대기가 이득
  return 'C'; // 즉시가 이득
}

/** 후보 2개 패턴 분류 — A (큐 진행 중) vs D (큐 둘 다 비어) */
function classifyPair(
  evals: CandidateAssignment[],
  queueFree: readonly [number, number],
  tPm: number,
): RecommendationPattern {
  const bothQueuesEmpty = queueFree[0] === 0 && queueFree[1] === 0;
  if (bothQueuesEmpty) {
    // 큐 둘 다 비어 — PM 이 의미 있는 대기시간이 있을 때만 D
    return tPm > 0 ? 'D' : 'single';
  }
  // 어느 한 쪽이라도 진행 중 — 패턴 A
  return 'A';
}
