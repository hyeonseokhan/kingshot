/**
 * 부대 계산기 — 분배 모드 2종.
 *
 * 입력: 출정 상한, 각 병과(보병/기병/궁병) × T9/T10 보유량, 운영 편대 수 N, 분배 모드
 * 출력: 편대별 병과 분배(T10/T9 분해) + 잔류 + 비율 정보
 *
 * 분배 모드:
 *   - 'bear' (곰 사냥, 1:1:8): 궁병 8 / 보병+기병 자리 2(=1:1 균등). 기병 부족 시 보병이 메움.
 *   - 'even' (보유 비율 그대로): 편대당 = 보유/N. 합이 cap 초과면 비례 축소.
 *
 * 티어 분해(전 편대 공통):
 *   병과별 perSquad 분배 총량은 모든 편대 동일하지만, 그 안의 T10/T9 비중은
 *   1편대부터 T10 을 우선 소진 → 부족분은 그 편대부터 T9 보충 → T10 잔고 모두 소진되면
 *   이후 편대는 T9 위주. "강한 T10 병사는 선두 편대에 집중" 이 게임 효율적이라 따름.
 *
 * 모든 출력은 floor 정수. 게임 내 배치는 정수 단위.
 *
 * 순수 함수 — UI/DOM 의존 없음. 테스트 가능.
 */

export interface TroopsInput {
  cap: number;
  infantryT9: number;
  infantryT10: number;
  cavalryT9: number;
  cavalryT10: number;
  archersT9: number;
  archersT10: number;
  squadCount: number;
}

/** 한 병과의 T9/T10 분해. */
export interface TierBreakdown {
  t9: number;
  t10: number;
  /** t9 + t10 */
  total: number;
}

export interface SquadAllocation {
  infantry: TierBreakdown;
  cavalry: TierBreakdown;
  archers: TierBreakdown;
  /** 편대 전체 합 = infantry.total + cavalry.total + archers.total */
  total: number;
}

export interface RemainingTroops {
  infantry: TierBreakdown;
  cavalry: TierBreakdown;
  archers: TierBreakdown;
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
   *  - bear-full    : cap 전체 채움 (궁병 풀 + 보병/기병 자리 충족)
   *  - bear-partial : cap 못 채움 (궁병 부족 또는 보병+기병 합쳐도 자리 부족)
   *  - even-fits    : 균등(보유 비율) — cap 안에 들어옴
   *  - even-capped  : 균등(보유 비율) — cap 초과로 비례 축소됨
   */
  mode: 'bear-full' | 'bear-partial' | 'even-fits' | 'even-capped';
  /** 편대 수 N. */
  squadCount: number;
  /**
   * 편대별 분배(0-based index, length === squadCount).
   * 병과 총량은 모든 편대 동일하지만 T10/T9 비중은 편대마다 다를 수 있음
   * (T10 우선 소진 → 후속 편대 T9 보충).
   */
  perSquad: SquadAllocation[];
  remaining: RemainingTroops;
  /** 목표 비율 (10 합 기준) — 곰 사냥은 1:1:8, 균등은 보유 비율 정규화. */
  targetRatio: RatioBreakdown;
  /** 실제 분배 비율 (10 합 기준, 소수 1자리). 모든 편대 동일하므로 1개 값. */
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
  const values = [
    input.cap,
    input.infantryT9,
    input.infantryT10,
    input.cavalryT9,
    input.cavalryT10,
    input.archersT9,
    input.archersT10,
    input.squadCount,
  ];
  // NaN / Infinity / 음수 차단
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) return { kind: 'invalid' };
  }
  if (input.cap < 1) return { kind: 'cap-too-small' };
  if (input.squadCount < 1) return { kind: 'squad-count-too-small' };
  return null;
}

/** 병과 합계 (T9 + T10). */
function totals(input: TroopsInput) {
  return {
    infantry: input.infantryT9 + input.infantryT10,
    cavalry: input.cavalryT9 + input.cavalryT10,
    archers: input.archersT9 + input.archersT10,
  };
}

/**
 * 편대별 분배 총량(perSquadTotal — 모든 편대 동일)을 T10/T9 로 분해.
 * 1편대부터 T10 을 가능한 만큼 다 소진 → 부족하면 그 편대부터 T9 로 보충.
 *
 * 예: perSquadTotal = 34,643, totalT10 = 50,000, totalT9 = 200,000, N = 3
 *   편대1: T10 34,643 / T9 0          (T10 잔고 15,357)
 *   편대2: T10 15,357 / T9 19,286     (T10 잔고 0)
 *   편대3: T10 0      / T9 34,643
 *
 * 결과적으로 1편대가 가장 강한 병사 비중을 갖고, 마지막 편대가 가장 약함.
 */
function distributeTierAcrossSquads(
  perSquadTotal: number,
  totalT10: number,
  totalT9: number,
  N: number,
): TierBreakdown[] {
  const result: TierBreakdown[] = [];
  let leftT10 = totalT10;
  let leftT9 = totalT9;
  for (let i = 0; i < N; i++) {
    if (perSquadTotal <= 0) {
      result.push({ t10: 0, t9: 0, total: 0 });
      continue;
    }
    const t10 = Math.min(perSquadTotal, Math.max(0, leftT10));
    const t9 = Math.min(perSquadTotal - t10, Math.max(0, leftT9));
    result.push({ t10, t9, total: t10 + t9 });
    leftT10 -= t10;
    leftT9 -= t9;
  }
  return result;
}

/**
 * 곰 사냥 — 편대당 분배 "총량" 계산.
 *
 * 그리디 cap 채움. 1:1:8 은 "최대 자리" 의미로만 쓰고, 부족하면 다른 병종이 메워 cap 을 최대한 채움.
 *   1) 궁병: 한 부대당 보유/N 또는 cap*8/10 중 작은 값까지 (궁병은 1:1:8 의 8 자리가 상한)
 *   2) 남은 자리 = cap - 궁병분배 (궁병이 자기 자리 못 채우면 그 자리까지 보병/기병이 흡수)
 *   3) 기병: min(보유/N, 남은자리/2). 보병/기병 1:1 균등 시도, 기병이 한도.
 *   4) 보병: min(보유/N, 남은자리 - 기병분배). 기병 부족분까지 흡수.
 *
 * @returns { infantry, cavalry, archers } — 각 편대별 분배 "총량" (T10/T9 합).
 */
function bearAllocateTotals(input: TroopsInput): {
  infantry: number;
  cavalry: number;
  archers: number;
} {
  const { cap, squadCount: N } = input;
  const T = totals(input);

  const archerSlotMax = Math.floor((cap * RATIO.archers) / RATIO_SUM);
  const archerPerSquad = Math.min(Math.floor(T.archers / N), archerSlotMax);

  const infCavSlot = cap - archerPerSquad;
  const cavTarget = Math.floor(infCavSlot / 2);
  const infTarget = infCavSlot - cavTarget;

  const cavPerSquad = Math.min(Math.floor(T.cavalry / N), cavTarget);
  const cavShortage = cavTarget - cavPerSquad;

  const infMaxPossible = infTarget + cavShortage;
  const infPerSquad = Math.min(Math.floor(T.infantry / N), infMaxPossible);

  return { infantry: infPerSquad, cavalry: cavPerSquad, archers: archerPerSquad };
}

/** 편대 분배 → 비율 정규화 (10 합 기준, 소수 1자리). */
function toRatio(inf: number, cav: number, arc: number): RatioBreakdown {
  const sum = inf + cav + arc;
  if (sum <= 0) return { infantry: 0, cavalry: 0, archers: 0 };
  const round1 = (n: number) => Math.round((n * RATIO_SUM * 10) / sum) / 10;
  return {
    infantry: round1(inf),
    cavalry: round1(cav),
    archers: round1(arc),
  };
}

/**
 * 편대당 분배 총량 + 보유 T10/T9 → 편대별 SquadAllocation 배열로 조립.
 * 잔류 정보(remaining)는 분배 후 실제 사용량을 차감해서 계산.
 */
function assembleSquads(
  input: TroopsInput,
  perSquadTotals: { infantry: number; cavalry: number; archers: number },
): { perSquad: SquadAllocation[]; remaining: RemainingTroops } {
  const N = input.squadCount;
  const infList = distributeTierAcrossSquads(perSquadTotals.infantry, input.infantryT10, input.infantryT9, N);
  const cavList = distributeTierAcrossSquads(perSquadTotals.cavalry, input.cavalryT10, input.cavalryT9, N);
  const arcList = distributeTierAcrossSquads(perSquadTotals.archers, input.archersT10, input.archersT9, N);

  const perSquad: SquadAllocation[] = [];
  let usedInfT10 = 0, usedInfT9 = 0;
  let usedCavT10 = 0, usedCavT9 = 0;
  let usedArcT10 = 0, usedArcT9 = 0;
  for (let i = 0; i < N; i++) {
    perSquad.push({
      infantry: infList[i],
      cavalry: cavList[i],
      archers: arcList[i],
      total: infList[i].total + cavList[i].total + arcList[i].total,
    });
    usedInfT10 += infList[i].t10;
    usedInfT9 += infList[i].t9;
    usedCavT10 += cavList[i].t10;
    usedCavT9 += cavList[i].t9;
    usedArcT10 += arcList[i].t10;
    usedArcT9 += arcList[i].t9;
  }
  return {
    perSquad,
    remaining: {
      infantry: {
        t10: input.infantryT10 - usedInfT10,
        t9: input.infantryT9 - usedInfT9,
        total: input.infantryT10 + input.infantryT9 - usedInfT10 - usedInfT9,
      },
      cavalry: {
        t10: input.cavalryT10 - usedCavT10,
        t9: input.cavalryT9 - usedCavT9,
        total: input.cavalryT10 + input.cavalryT9 - usedCavT10 - usedCavT9,
      },
      archers: {
        t10: input.archersT10 - usedArcT10,
        t9: input.archersT9 - usedArcT9,
        total: input.archersT10 + input.archersT9 - usedArcT10 - usedArcT9,
      },
    },
  };
}

/**
 * 부대 편성 계산 — 곰 사냥. 입력 검증 후 분배.
 * 사전 검증 함수 validate() 로 호출자가 에러 분기를 먼저 처리해야 함.
 */
export function calculateBearHunt(input: TroopsInput): TroopsResult {
  const perSquadTotals = bearAllocateTotals(input);
  const totalPerSquad = perSquadTotals.infantry + perSquadTotals.cavalry + perSquadTotals.archers;
  const isFull = totalPerSquad >= input.cap;

  const { perSquad, remaining } = assembleSquads(input, perSquadTotals);

  return {
    mode: isFull ? 'bear-full' : 'bear-partial',
    squadCount: input.squadCount,
    perSquad,
    remaining,
    targetRatio: { infantry: 1, cavalry: 1, archers: 8 },
    actualRatio: toRatio(perSquadTotals.infantry, perSquadTotals.cavalry, perSquadTotals.archers),
  };
}

/**
 * 균등 분배 — 보유 비율 그대로 N편대에 나눔. 합이 cap 초과면 비례 축소.
 * "균등"은 "보유 비율 유지" 라는 의미로, 1:1:1 강제가 아님.
 */
export function calculateEven(input: TroopsInput): TroopsResult {
  const { cap, squadCount: N } = input;
  const T = totals(input);
  let inf = Math.floor(T.infantry / N);
  let cav = Math.floor(T.cavalry / N);
  let arc = Math.floor(T.archers / N);
  let total = inf + cav + arc;
  let capped = false;

  if (total > cap) {
    inf = Math.floor((inf * cap) / total);
    cav = Math.floor((cav * cap) / total);
    arc = Math.floor((arc * cap) / total);
    total = inf + cav + arc;
    capped = true;
  }

  const { perSquad, remaining } = assembleSquads(input, { infantry: inf, cavalry: cav, archers: arc });

  return {
    mode: capped ? 'even-capped' : 'even-fits',
    squadCount: N,
    perSquad,
    remaining,
    // 균등 모드의 "목표" 는 보유량 정규화 (보유 비율 자체가 목표). 합이 0 이면 0:0:0.
    targetRatio: toRatio(T.infantry, T.cavalry, T.archers),
    actualRatio: toRatio(inf, cav, arc),
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
