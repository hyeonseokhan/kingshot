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
  /** 권장: 총리대신을 기다려야 하는가? */
  shouldWaitForPrimeMinister: boolean;
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
    shouldWaitForPrimeMinister: netGain > 0,
  };
}
