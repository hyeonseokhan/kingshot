/**
 * 부대 계산기 — 분배 모드 2종.
 *
 * 입력: 출정 상한, 보병/기병/궁병 보유량, 운영 편대 수 N, 분배 모드
 * 출력: 편대당 분배 + 잔류 + 비율 정보
 *
 * 분배 모드:
 *   - 'bear' (곰 사냥, 1:1:8): 풀 편성 가능하면 1:1:8, 부족하면 궁병 우선
 *   - 'even' (보유 비율 그대로): 편대당 = 보유/N. 합이 cap 초과면 비례 축소.
 *
 * 모든 출력은 floor 정수. 게임 내 배치는 정수 단위.
 *
 * 순수 함수 — UI/DOM 의존 없음. 테스트 가능.
 */

export interface TroopsInput {
  cap: number;
  infantry: number;
  cavalry: number;
  archers: number;
  squadCount: number;
}

export interface SquadAllocation {
  infantry: number;
  cavalry: number;
  archers: number;
  total: number;
}

export interface RemainingTroops {
  infantry: number;
  cavalry: number;
  archers: number;
}

export interface RatioBreakdown {
  /** 정규화 (10 합 기준) — 표시용 */
  infantry: number;
  cavalry: number;
  archers: number;
}

/** 분배 모드. 'bear' = 곰 사냥 1:1:8, 'even' = 보유 비율 그대로 N편대 분배. */
export type DistributionMode = 'bear' | 'even';

export interface TroopsResult {
  /**
   *  - bear-full    : 1:1:8 풀 편성 가능
   *  - bear-partial : 1:1:8 부족, 궁병 우선 분배
   *  - even-fits    : 균등(보유 비율) — cap 안에 들어옴
   *  - even-capped  : 균등(보유 비율) — cap 초과로 비례 축소됨
   */
  mode: 'bear-full' | 'bear-partial' | 'even-fits' | 'even-capped';
  /** 편대 수 N. 모든 편대 동일 분배라 squadCount 만 반환. */
  squadCount: number;
  /** 1편대 (=모든 편대 동일) 분배량 */
  perSquad: SquadAllocation;
  remaining: RemainingTroops;
  /** 목표 비율 (10 합 기준) — 곰 사냥은 1:1:8, 균등은 보유 비율 정규화. */
  targetRatio: RatioBreakdown;
  /** 실제 분배 비율 (10 합 기준, 소수 1자리) */
  actualRatio: RatioBreakdown;
}

export type ValidationError =
  | { kind: 'invalid' }
  | { kind: 'cap-too-small' }
  | { kind: 'squad-count-too-small' };

const RATIO = { infantry: 1, cavalry: 1, archers: 8 } as const;
const RATIO_SUM = RATIO.infantry + RATIO.cavalry + RATIO.archers; // 10

/** 입력 검증. ok=false 일 때 error 종류 반환. */
export function validate(input: TroopsInput): ValidationError | null {
  const { cap, infantry, cavalry, archers, squadCount } = input;
  // NaN / Infinity / 음수 차단
  for (const v of [cap, infantry, cavalry, archers, squadCount]) {
    if (!Number.isFinite(v) || v < 0) return { kind: 'invalid' };
  }
  if (cap < 1) return { kind: 'cap-too-small' };
  if (squadCount < 1) return { kind: 'squad-count-too-small' };
  return null;
}

/** 1:1:8 풀 편성 가능 여부 — 보유량이 N부대 풀에 필요한 양 모두 충족. */
function canFullSplit(input: TroopsInput): boolean {
  const { cap, infantry, cavalry, archers, squadCount } = input;
  const needArc = (cap * RATIO.archers * squadCount) / RATIO_SUM;
  const needInf = (cap * RATIO.infantry * squadCount) / RATIO_SUM;
  const needCav = (cap * RATIO.cavalry * squadCount) / RATIO_SUM;
  return archers >= needArc && infantry >= needInf && cavalry >= needCav;
}

/** Case B — 풀 편성. 편대당 cap × (1/10, 1/10, 8/10). */
function allocateFull(cap: number): SquadAllocation {
  const archers = Math.floor((cap * RATIO.archers) / RATIO_SUM);
  const infantry = Math.floor((cap * RATIO.infantry) / RATIO_SUM);
  const cavalry = Math.floor((cap * RATIO.cavalry) / RATIO_SUM);
  return {
    infantry,
    cavalry,
    archers,
    total: infantry + cavalry + archers,
  };
}

/**
 * Case A — 효율 우선순위 분배 (궁병 → 보병 → 기병).
 *   1순위 궁병: floor(보유 / N), cap 초과 금지
 *   2순위 보병: 남은 슬롯에서 floor(보유 / N) 한도로 채움
 *   3순위 기병: 그 나머지 슬롯에서 floor(보유 / N) 한도로 채움
 *   → 잔류는 기병 위주로 남고 cap 은 최대한 채움.
 */
function allocatePartial(input: TroopsInput): SquadAllocation {
  const { cap, infantry, cavalry, archers, squadCount } = input;

  // 1순위: 궁병
  const archerPerSquad = Math.min(Math.floor(archers / squadCount), cap);
  let remaining = cap - archerPerSquad;

  // 2순위: 보병
  const infPerSquad = Math.min(Math.floor(infantry / squadCount), remaining);
  remaining -= infPerSquad;

  // 3순위: 기병
  const cavPerSquad = Math.min(Math.floor(cavalry / squadCount), remaining);

  return {
    infantry: infPerSquad,
    cavalry: cavPerSquad,
    archers: archerPerSquad,
    total: infPerSquad + cavPerSquad + archerPerSquad,
  };
}

/** 편대 분배 → 비율 정규화 (10 합 기준, 소수 1자리). */
function toRatio(alloc: SquadAllocation): RatioBreakdown {
  const sum = alloc.infantry + alloc.cavalry + alloc.archers;
  if (sum <= 0) return { infantry: 0, cavalry: 0, archers: 0 };
  const round1 = (n: number) => Math.round((n * RATIO_SUM * 10) / sum) / 10;
  return {
    infantry: round1(alloc.infantry),
    cavalry: round1(alloc.cavalry),
    archers: round1(alloc.archers),
  };
}

/**
 * 부대 편성 계산 — 곰 사냥. 입력 검증 후 Case A/B 분기.
 * 사전 검증 함수 validate() 로 호출자가 에러 분기를 먼저 처리해야 함.
 */
export function calculateBearHunt(input: TroopsInput): TroopsResult {
  const fullPossible = canFullSplit(input);
  const perSquad = fullPossible ? allocateFull(input.cap) : allocatePartial(input);

  const usedInf = perSquad.infantry * input.squadCount;
  const usedCav = perSquad.cavalry * input.squadCount;
  const usedArc = perSquad.archers * input.squadCount;

  return {
    mode: fullPossible ? 'bear-full' : 'bear-partial',
    squadCount: input.squadCount,
    perSquad,
    remaining: {
      infantry: input.infantry - usedInf,
      cavalry: input.cavalry - usedCav,
      archers: input.archers - usedArc,
    },
    targetRatio: { infantry: 1, cavalry: 1, archers: 8 },
    actualRatio: toRatio(perSquad),
  };
}

/**
 * 균등 분배 — 보유 비율 그대로 N편대에 나눔. 합이 cap 초과면 비례 축소.
 * "균등"은 "보유 비율 유지" 라는 의미로, 1:1:1 강제가 아님.
 */
export function calculateEven(input: TroopsInput): TroopsResult {
  const { cap, infantry, cavalry, archers, squadCount } = input;
  let inf = Math.floor(infantry / squadCount);
  let cav = Math.floor(cavalry / squadCount);
  let arc = Math.floor(archers / squadCount);
  let total = inf + cav + arc;
  let capped = false;

  if (total > cap) {
    // cap 초과 — 비례 축소. ratio 보존을 위해 (값 * cap / total) 사용.
    inf = Math.floor((inf * cap) / total);
    cav = Math.floor((cav * cap) / total);
    arc = Math.floor((arc * cap) / total);
    total = inf + cav + arc;
    capped = true;
  }

  const perSquad: SquadAllocation = {
    infantry: inf,
    cavalry: cav,
    archers: arc,
    total,
  };

  return {
    mode: capped ? 'even-capped' : 'even-fits',
    squadCount,
    perSquad,
    remaining: {
      infantry: infantry - inf * squadCount,
      cavalry: cavalry - cav * squadCount,
      archers: archers - arc * squadCount,
    },
    // 균등 모드의 "목표" 는 보유량 정규화 (보유 비율 자체가 목표). 합이 0 이면 0:0:0.
    targetRatio: toRatio({ infantry, cavalry, archers, total: infantry + cavalry + archers }),
    actualRatio: toRatio(perSquad),
  };
}

/** 분배 모드 디스패치. 호출자가 mode 를 결정해서 전달. */
export function calculate(input: TroopsInput, mode: DistributionMode): TroopsResult {
  if (mode === 'even') return calculateEven(input);
  return calculateBearHunt(input);
}

/** 비율 표기 — "1.0 : 1.0 : 8.0" 형식 */
export function formatRatio(r: RatioBreakdown): string {
  return `${r.infantry.toFixed(1)} : ${r.cavalry.toFixed(1)} : ${r.archers.toFixed(1)}`;
}
