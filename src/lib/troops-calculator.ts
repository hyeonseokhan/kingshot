/**
 * 부대 계산기 — 분배 모드 2종.
 *
 * 입력: 출정 상한, 각 병과(보병/기병/궁병) × T9/T10 보유량, 운영 편대 수 N, 분배 모드
 * 출력: 편대당 병과별 분배(T10/T9 분해) + 잔류 + 비율 정보
 *
 * 분배 모드:
 *   - 'bear' (곰 사냥, 1:1:8): 궁병 8 / 보병+기병 자리 2(=1:1 균등). 기병 부족 시 보병이 메움.
 *   - 'even' (보유 비율 그대로): 편대당 = 보유/N. 합이 cap 초과면 비례 축소.
 *
 * 티어 분해: 병과별 perSquad 분배량이 정해지면 그 안에서 T10 우선 채우고 T9 가 보충.
 * (T10 이 더 강한 병사라 우선 투입)
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
 * 편대당 분배량(병과 단위) 을 T10 우선 + T9 보충 으로 분해.
 *   - t10PerSquad = min(perSquad, floor(t10Total / N))
 *   - t9PerSquad  = perSquad - t10PerSquad
 *
 * 결과적으로 한 편대당 동일 분배(=복사 편의성 유지). 마지막 편대만 다르게 만들지 않음.
 * 잔여 T9/T10 는 잔류 행에 표시됨.
 */
function splitTier(perSquadAmount: number, t10Total: number, t9Total: number, N: number): TierBreakdown {
  if (perSquadAmount <= 0) return { t9: 0, t10: 0, total: 0 };
  const t10Available = Math.floor(t10Total / N);
  const t9Available = Math.floor(t9Total / N);
  const t10 = Math.min(perSquadAmount, t10Available);
  // T9 가 부족하면 T10 보유분 안에서 더 끌어와 채울 수 있도록 보정
  // (사실 perSquadAmount = min(보유총량/N, 자리) 라 도달 가능한 합이지만 floor 절단으로 1~2 차이 가능)
  let t9 = Math.min(perSquadAmount - t10, t9Available);
  // T9 가 남는데 perSquadAmount 미달이면 T10 으로 더 채움 (자리는 보유로 차있을 때)
  const filled = t10 + t9;
  if (filled < perSquadAmount && t10 < t10Available) {
    const extra = Math.min(perSquadAmount - filled, t10Available - t10);
    return { t10: t10 + extra, t9, total: t10 + extra + t9 };
  }
  // 반대로 T10 만으로 부족하지만 t9 추가 후에도 미달이면 그대로 (보유 한계)
  return { t10, t9, total: t10 + t9 };
}

/**
 * Case A — 곰 사냥 분배 핵심 로직 (T9/T10 통합 → 분배 → 분해).
 *
 * 그리디 cap 채움. 1:1:8 은 "최대 자리" 의미로만 쓰고, 부족하면 다른 병종이 메워 cap 을 최대한 채움.
 *   1) 궁병: 한 부대당 보유/N 또는 cap*8/10 중 작은 값까지 (궁병은 1:1:8 의 8 자리가 상한)
 *   2) 남은 자리 = cap - 궁병분배 (궁병이 자기 자리 못 채우면 그 자리까지 보병/기병이 흡수)
 *   3) 기병: min(보유/N, 남은자리/2). 보병/기병 1:1 균등 시도, 기병이 한도.
 *   4) 보병: min(보유/N, 남은자리 - 기병분배). 기병 부족분까지 흡수.
 */
function bearAllocate(input: TroopsInput): SquadAllocation {
  const { cap, squadCount: N } = input;
  const T = totals(input);

  // 1) 궁병 — 자기 자리(cap*8/10) 한도까지만. 그 이상은 안 채움(궁병 우위 자체는 게임 메커닉이라 비율 유지).
  const archerSlotMax = Math.floor((cap * RATIO.archers) / RATIO_SUM);
  const archerPerSquad = Math.min(Math.floor(T.archers / N), archerSlotMax);

  // 2) 보병/기병 자리 = cap - 궁병분배. 궁병이 못 채운 archer 자리도 흡수.
  const infCavSlot = cap - archerPerSquad;
  // 1:1 균등 분배. 홀수면 보병이 1 더(약한 쪽 백업).
  const cavTarget = Math.floor(infCavSlot / 2);
  const infTarget = infCavSlot - cavTarget;

  // 3) 기병
  const cavPerSquad = Math.min(Math.floor(T.cavalry / N), cavTarget);
  const cavShortage = cavTarget - cavPerSquad; // 기병 부족분 → 보병이 메움

  // 4) 보병 (자기 자리 + 기병 부족분)
  const infMaxPossible = infTarget + cavShortage;
  const infPerSquad = Math.min(Math.floor(T.infantry / N), infMaxPossible);

  return {
    infantry: splitTier(infPerSquad, input.infantryT10, input.infantryT9, N),
    cavalry: splitTier(cavPerSquad, input.cavalryT10, input.cavalryT9, N),
    archers: splitTier(archerPerSquad, input.archersT10, input.archersT9, N),
    total: infPerSquad + cavPerSquad + archerPerSquad,
  };
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
 * 부대 편성 계산 — 곰 사냥. 입력 검증 후 분배.
 * 사전 검증 함수 validate() 로 호출자가 에러 분기를 먼저 처리해야 함.
 */
export function calculateBearHunt(input: TroopsInput): TroopsResult {
  const perSquad = bearAllocate(input);
  const N = input.squadCount;

  // cap 을 전부 채웠는지(=full) vs 미달(=partial)
  const isFull = perSquad.total >= input.cap;

  const T = totals(input);
  const usedInf = perSquad.infantry.total * N;
  const usedCav = perSquad.cavalry.total * N;
  const usedArc = perSquad.archers.total * N;

  const usedInfT10 = perSquad.infantry.t10 * N;
  const usedInfT9 = perSquad.infantry.t9 * N;
  const usedCavT10 = perSquad.cavalry.t10 * N;
  const usedCavT9 = perSquad.cavalry.t9 * N;
  const usedArcT10 = perSquad.archers.t10 * N;
  const usedArcT9 = perSquad.archers.t9 * N;

  return {
    mode: isFull ? 'bear-full' : 'bear-partial',
    squadCount: N,
    perSquad,
    remaining: {
      infantry: {
        t10: input.infantryT10 - usedInfT10,
        t9: input.infantryT9 - usedInfT9,
        total: T.infantry - usedInf,
      },
      cavalry: {
        t10: input.cavalryT10 - usedCavT10,
        t9: input.cavalryT9 - usedCavT9,
        total: T.cavalry - usedCav,
      },
      archers: {
        t10: input.archersT10 - usedArcT10,
        t9: input.archersT9 - usedArcT9,
        total: T.archers - usedArc,
      },
    },
    targetRatio: { infantry: 1, cavalry: 1, archers: 8 },
    actualRatio: toRatio(
      perSquad.infantry.total,
      perSquad.cavalry.total,
      perSquad.archers.total,
    ),
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
    // cap 초과 — 비례 축소. ratio 보존을 위해 (값 * cap / total) 사용.
    inf = Math.floor((inf * cap) / total);
    cav = Math.floor((cav * cap) / total);
    arc = Math.floor((arc * cap) / total);
    total = inf + cav + arc;
    capped = true;
  }

  const perSquad: SquadAllocation = {
    infantry: splitTier(inf, input.infantryT10, input.infantryT9, N),
    cavalry: splitTier(cav, input.cavalryT10, input.cavalryT9, N),
    archers: splitTier(arc, input.archersT10, input.archersT9, N),
    total,
  };

  return {
    mode: capped ? 'even-capped' : 'even-fits',
    squadCount: N,
    perSquad,
    remaining: {
      infantry: {
        t10: input.infantryT10 - perSquad.infantry.t10 * N,
        t9: input.infantryT9 - perSquad.infantry.t9 * N,
        total: T.infantry - perSquad.infantry.total * N,
      },
      cavalry: {
        t10: input.cavalryT10 - perSquad.cavalry.t10 * N,
        t9: input.cavalryT9 - perSquad.cavalry.t9 * N,
        total: T.cavalry - perSquad.cavalry.total * N,
      },
      archers: {
        t10: input.archersT10 - perSquad.archers.t10 * N,
        t9: input.archersT9 - perSquad.archers.t9 * N,
        total: T.archers - perSquad.archers.total * N,
      },
    },
    // 균등 모드의 "목표" 는 보유량 정규화 (보유 비율 자체가 목표). 합이 0 이면 0:0:0.
    targetRatio: toRatio(T.infantry, T.cavalry, T.archers),
    actualRatio: toRatio(
      perSquad.infantry.total,
      perSquad.cavalry.total,
      perSquad.archers.total,
    ),
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

