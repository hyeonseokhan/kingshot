/**
 * KvK 종합 계산기 — 순수 함수 / DOM 무관.
 *
 * 입력: 보유 병사·가속권·대사관 잔여·마감·추가획득
 * 출력: 병사 5:2:3 훈련 계산, 건물 Phase 1 작업량, 30T 가능 여부
 *
 * 상수: 훈련/건설 속도, 기준 시간, 하루 훈련량, 건물별 시간 — 사이트 계산기 역산값 기반.
 */

export const KVK_CONSTANTS = {
  /** 훈련속도 보너스 합계 (%) — 기본 163.5 + 참모장 50 + 국왕스킬 30 + 최강 25. */
  trainingSpeedPct: 268.5,
  /** 건설 시간배율 (법령 0.8 + 보너스 104.7%) — tf = 0.8 / 2.047 ≈ 0.391. */
  buildTimeFactor: 0.391,
  /** 기준 시간 (KST). 30T 가능여부.md 기준점. */
  refTime: '2026-05-20T16:01:00+09:00',
  /** 훈련 티어. T9 기준. */
  tier: 9 as const,
  /** 하루 훈련량 (명/일) — 사이트 계산기 역산값 (163,975 ÷ 67.4681 ≈ 2,430.41 @ 268.5%). */
  troopsPerDay: 2430.41,
  /** 목표 비율 — 보병 : 기병 : 궁병. */
  ratio: { infantry: 5, cavalry: 2, archers: 3 } as const,
  /** 건설 시간 (분) — Phase 1 즉시완료 대상 (대사관 잔여는 변수). */
  buildMinutes: {
    archery28to29: 2827,
    tc29to30: 22615,
    infantry29to30: 3392,
    archery29to30: 3392,
  },
} as const;

export interface KvkInputs {
  /** 보유 병사 — 보병 / 기병 / 궁병 (명). */
  troops: { infantry: number; cavalry: number; archers: number };
  /** 가속권 보유량 (분). */
  accel: { common: number; training: number; building: number };
  /** 대사관 28→29 잔여 (분). */
  embassyRemaining: number;
  /** 마감 일시 (ISO 8601, 예: 2026-05-23T15:00:00+09:00). */
  deadline: string;
  /** 추가 획득 예상 가속권 (개수). */
  /** 추가 가속권 합계 (분). UI 는 단일 분-입력 필드로 단순화. */
  bonusMinutes: number;
}

export interface TrainingResult {
  targetInfantry: number;
  targetCavalry: number;
  targetArchers: number;
  extraInfantry: number;
  extraArchers: number;
  totalExtra: number;
  /** 필요 훈련 시간 (분). */
  neededMinutes: number;
  /** 사용량 / 잔여 (분). */
  used: { training: number; common: number };
  remaining: { training: number; common: number };
}

export interface BuildingResult {
  /** Phase 1 총 작업량 (분). */
  totalMinutes: number;
  breakdown: Array<{ key: string; minutes: number }>;
}

export interface FeasibilityResult {
  /** ISO. */
  deadline: string;
  refTime: string;
  /** 실시간 여유 (분). 음수면 이미 마감 지남. */
  realtimeAvailableMin: number;
  /** 추가 획득 가속권 합계 (분). */
  bonusGainMin: number;
  /** 필요 가속권 (분) — 단일 슬롯 즉시완료 기준. */
  needed: number;
  /** 가용 가속권 (분) — 훈련 후 잔여 공용 + 추가 + 건설. */
  available: number;
  /** 부족분 (분). 양수면 부족, 음수면 여유. */
  shortage: number;
}

export interface KvkResults {
  training: TrainingResult;
  building: BuildingResult;
  feasibility: FeasibilityResult;
}

/** 메인 계산 함수. 입력 → 결과. */
export function calculate(inputs: KvkInputs): KvkResults {
  const training = computeTraining(inputs);
  const building = computeBuilding(inputs);
  const feasibility = computeFeasibility(inputs, training, building);
  return { training, building, feasibility };
}

function computeTraining(inputs: KvkInputs): TrainingResult {
  const { troops, accel } = inputs;
  const { cavalry } = troops;
  const x = cavalry / KVK_CONSTANTS.ratio.cavalry;
  const targetInfantry = Math.round(x * KVK_CONSTANTS.ratio.infantry);
  const targetCavalry = Math.round(x * KVK_CONSTANTS.ratio.cavalry);
  const targetArchers = Math.round(x * KVK_CONSTANTS.ratio.archers);

  const extraInfantry = Math.max(0, targetInfantry - troops.infantry);
  const extraArchers = Math.max(0, targetArchers - troops.archers);
  const totalExtra = extraInfantry + extraArchers;

  const daysNeeded = totalExtra / KVK_CONSTANTS.troopsPerDay;
  const neededMinutes = Math.ceil(daysNeeded * 1440);

  const usedTraining = Math.min(accel.training, neededMinutes);
  const usedCommon = Math.max(0, neededMinutes - usedTraining);

  return {
    targetInfantry,
    targetCavalry,
    targetArchers,
    extraInfantry,
    extraArchers,
    totalExtra,
    neededMinutes,
    used: { training: usedTraining, common: usedCommon },
    remaining: {
      training: Math.max(0, accel.training - usedTraining),
      common: Math.max(0, accel.common - usedCommon),
    },
  };
}

function computeBuilding(inputs: KvkInputs): BuildingResult {
  const b = KVK_CONSTANTS.buildMinutes;
  const breakdown = [
    { key: 'embassy28to29', minutes: inputs.embassyRemaining },
    { key: 'archery28to29', minutes: b.archery28to29 },
    { key: 'tc29to30', minutes: b.tc29to30 },
    { key: 'infantry29to30', minutes: b.infantry29to30 },
    { key: 'archery29to30', minutes: b.archery29to30 },
  ];
  const totalMinutes = breakdown.reduce((sum, item) => sum + item.minutes, 0);
  return { totalMinutes, breakdown };
}

function computeFeasibility(
  inputs: KvkInputs,
  training: TrainingResult,
  building: BuildingResult,
): FeasibilityResult {
  const refTime = KVK_CONSTANTS.refTime;
  const deadline = inputs.deadline;

  const refMs = Date.parse(refTime);
  const deadlineMs = Date.parse(deadline);
  const realtimeAvailableMin = Number.isFinite(deadlineMs)
    ? Math.round((deadlineMs - refMs) / 60000)
    : 0;

  const bonusGainMin = inputs.bonusMinutes;

  const needed = building.totalMinutes;
  const available = training.remaining.common + bonusGainMin + inputs.accel.building;
  const shortage = needed - available;

  return {
    deadline,
    refTime,
    realtimeAvailableMin,
    bonusGainMin,
    needed,
    available,
    shortage,
  };
}

/** 분 → "X일 Y시간 Z분" 포맷. 음수는 "-X일 ..." 로. */
export function formatDhm(minutesInput: number): string {
  const sign = minutesInput < 0 ? '-' : '';
  let m = Math.abs(Math.round(minutesInput));
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}일`);
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0 || parts.length === 0) parts.push(`${m}분`);
  return sign + parts.join(' ');
}

/** 영문 포맷. */
export function formatDhmEn(minutesInput: number): string {
  const sign = minutesInput < 0 ? '-' : '';
  let m = Math.abs(Math.round(minutesInput));
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return sign + parts.join(' ');
}
