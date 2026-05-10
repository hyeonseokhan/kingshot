/**
 * 부대 계산기 — 곰 사냥(Bear Hunt) 편성 계산.
 *
 * 입력: 출정 상한, 보병/기병/궁병 보유량, 운영 편대 수 N
 * 출력: 편대당 분배 + 잔류 + 비율 정보
 *
 * 알고리즘:
 *   - Case B: 보유 ≥ 상한×비율×N 모두 충족 → 1:1:8 풀 편성
 *   - Case A: 부족하면 궁병 우선 (균등 배분 후 남은 자리 = 보+기 균등)
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

export interface TroopsResult {
  mode: 'full' | 'partial';
  /** 편대 수 N. 모든 편대 동일 분배라 squadCount 만 반환. */
  squadCount: number;
  /** 1편대 (=모든 편대 동일) 분배량 */
  perSquad: SquadAllocation;
  remaining: RemainingTroops;
  /** 목표 1:1:8 정규화 (10 합 기준) */
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
 * Case A — 궁병 우선 분배.
 *   편대당 궁병 = floor(보유 궁병 / N), 단 cap 초과 금지
 *   편대당 (보+기) = cap - 편대당 궁병
 *   편대당 보 = 기 = floor((보+기) / 2)
 *
 * 단, 보병/기병 보유량이 (편대 분배량 × N) 보다 적으면 그쪽을 보유량 한도로 자르고
 * 부족분만큼 다른 쪽으로 보충 (cap 유지). 두 병종 모두 모자라면 cap 미달인 채 반환.
 */
function allocatePartial(input: TroopsInput): SquadAllocation {
  const { cap, infantry, cavalry, archers, squadCount } = input;

  // 편대당 궁병 — 보유 궁병 균등 분배. cap 초과는 못 가니까 cap 으로 캡.
  const archerPerSquad = Math.min(Math.floor(archers / squadCount), cap);
  const remainingPerSquad = cap - archerPerSquad;

  // 보병/기병 후보치 — 일단 균등 절반.
  let infPerSquad = Math.floor(remainingPerSquad / 2);
  let cavPerSquad = remainingPerSquad - infPerSquad;

  // 보유량 cap — 편대당 사용량 × N 이 보유량 초과하면 보유량 한도로 자르고 차이를 다른 쪽에 보충.
  const maxInfPerSquad = Math.floor(infantry / squadCount);
  const maxCavPerSquad = Math.floor(cavalry / squadCount);

  if (infPerSquad > maxInfPerSquad) {
    const overflow = infPerSquad - maxInfPerSquad;
    infPerSquad = maxInfPerSquad;
    cavPerSquad = Math.min(cavPerSquad + overflow, maxCavPerSquad);
  } else if (cavPerSquad > maxCavPerSquad) {
    const overflow = cavPerSquad - maxCavPerSquad;
    cavPerSquad = maxCavPerSquad;
    infPerSquad = Math.min(infPerSquad + overflow, maxInfPerSquad);
  }

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
    mode: fullPossible ? 'full' : 'partial',
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

/** 비율 표기 — "1.0 : 1.0 : 8.0" 형식 */
export function formatRatio(r: RatioBreakdown): string {
  return `${r.infantry.toFixed(1)} : ${r.cavalry.toFixed(1)} : ${r.archers.toFixed(1)}`;
}
