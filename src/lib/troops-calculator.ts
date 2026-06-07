/**
 * 부대 계산기 — 분배 모드 3종.
 *
 * 입력: 출정 상한, 각 병과(보병/기병/궁병) × T9/T10 보유량, 운영 편대 수 N, 분배 모드
 * 출력: 편대별 병과 분배(T10/T9 분해) + 잔류 + 비율 정보
 *
 * 분배 모드:
 *   - 'bear' (권장값 1:1:8): 모든 편대 동일 분배. 궁병 8 / 보병+기병 2(1:1, 기병 부족 시 보병 메움).
 *     자원 부족 시 전 편대가 동일하게 부족한 형태.
 *   - 'bear-stack' (몰빵형): 풀 1:1:8 가능한 만큼 앞 편대 풀로 채움 → 부족 시점부터 남은
 *     편대수로 평탄(균등) 분배. 앞 편대는 풀, 뒷 편대들도 화력 균형.
 *   - 'even' (보유 비율 그대로): 편대당 = 보유/N. 합이 cap 초과면 비례 축소.
 *
 * 티어 분해 (T10 우선 소진):
 *   병과별 분배량을 채울 때 보유 T10 부터 차감 → 부족분은 T9. 'bear' 모드는 1편대가 T10 을
 *   몰빵해 가져가고 후속 편대는 T9 위주. 'bear-stack' 도 자연스럽게 1편대 T10 풀 → 후속 T9 위주.
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

/** 분배 모드. */
export type DistributionMode = 'bear' | 'bear-stack' | 'even';

export interface TroopsResult {
  /**
   *  - bear-full        : 권장값 — 모든 편대 cap 풀 채움
   *  - bear-partial     : 권장값 — cap 못 채움 (전 편대 동일하게 부족)
   *  - bear-stack-full  : 몰빵형 — 모든 편대 풀 1:1:8 (자원 충분)
   *  - bear-stack-partial : 몰빵형 — 일부 편대 부족 (1편대 우선 풀, 후순위 부족)
   *  - even-fits        : 균등(보유 비율) — cap 안에 들어옴
   *  - even-capped      : 균등(보유 비율) — cap 초과로 비례 축소됨
   */
  mode:
    | 'bear-full'
    | 'bear-partial'
    | 'bear-stack-full'
    | 'bear-stack-partial'
    | 'even-fits'
    | 'even-capped';
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

/**
 * 병종 시너지 발동 최소 참여 비중 = 출정 상한의 10%.
 * 한 편대에서 어떤 병종이 "참여(분배량 > 0)"하면 cap*10% 이상이어야 시너지가 켜짐.
 * 몰빵형 fallback 편대에서 보병에 이 floor 를 먼저 확보 (보유량/자리가 부족하면 그만큼만).
 */
const SYNERGY_RATIO = 0.1;

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
 * 곰 사냥 — 몰빵형. 앞 편대를 풀 1:1:8 로 채우고, 풀이 부족해지는 시점부터
 * 남은 편대에 평탄(균등) 분배.
 *
 * "1,2 편대 풀 → 3 편대부터 자원 모자라면 남은 편대수로 균등" 이라는 요청 반영.
 * 단순 그리디 몰빵보다 마지막 편대도 어느 정도 화력 유지 가능.
 *
 * 알고리즘:
 *   1) "풀 가능 편대 수" 사전 계산:
 *      - 풀 1편대 비용 = (궁:cap*8/10, 기:(cap-궁)/2, 보:(cap-궁) - 기)
 *      - fullSquads = min(궁/궁비용, 기/기비용, 보/보비용, N)
 *      - 단 기/보 비용이 0 이면(=궁이 cap 전체) 0 분모 회피
 *   2) 1..fullSquads 편대: 풀 1:1:8 정확히. 자원 차감.
 *   3) fullSquads+1..N 편대: 매 편대마다 (강함 순 궁 > 기 > 보 — 강한 병종 우선 충원)
 *      - 궁병 = floor(남은궁/남은편대수), 자기자리(cap*8/10) 한도
 *      - 보병/기병 자리 = cap - 궁병사용 (궁병 못 채운 자리도 기/보가 흡수)
 *      - 기병 = 남은 자리 안에서 보유 기병을 "최대한" 충원 (1:1 균등 X — 기병이 보병보다 강함).
 *               마지막 fallback 편대(1개만 남았을 때)는 보유 전량 투입,
 *               여러 편대가 남았으면 평탄 분배(floor(남은기/남은편대수))로 뒤 편대도 화력 유지.
 *      - 보병 = 기병이 채우고 남은 자리를, 보유 보병으로 채움.
 *      예) 잔여 기병 94,028 + 자리 충분 → 3편대 기병 94,028, 나머지 자리 보병.
 *          (기존: 기/보 1:1 → 기병이 절반만 쓰이고 강한 병종이 잔류하던 문제 해결)
 */
export function calculateBearStack(input: TroopsInput): TroopsResult {
  const { cap, squadCount: N } = input;
  const archerSlotMax = Math.floor((cap * RATIO.archers) / RATIO_SUM);
  // 병종 시너지 floor — fallback 편대 보병이 최소 이만큼 참여해야 시너지 발동.
  const synergyFloor = Math.floor(cap * SYNERGY_RATIO);
  // 풀 1편대의 보병/기병 자리 = 1:1 균등 (홀수면 보병 +1)
  const fullInfCavSlot = cap - archerSlotMax;
  const cavSlotFull = Math.floor(fullInfCavSlot / 2);
  const infSlotFull = fullInfCavSlot - cavSlotFull;

  const totalArc = input.archersT10 + input.archersT9;
  const totalCav = input.cavalryT10 + input.cavalryT9;
  const totalInf = input.infantryT10 + input.infantryT9;

  // 풀 가능 편대 수 — 세 병종 모두 풀이 가능해야 한 편대 풀. 분모 0 회피.
  const fullByArc = archerSlotMax > 0 ? Math.floor(totalArc / archerSlotMax) : Infinity;
  const fullByCav = cavSlotFull > 0 ? Math.floor(totalCav / cavSlotFull) : Infinity;
  const fullByInf = infSlotFull > 0 ? Math.floor(totalInf / infSlotFull) : Infinity;
  const fullSquads = Math.min(N, fullByArc, fullByCav, fullByInf);

  let leftInfT10 = input.infantryT10, leftInfT9 = input.infantryT9;
  let leftCavT10 = input.cavalryT10, leftCavT9 = input.cavalryT9;
  let leftArcT10 = input.archersT10, leftArcT9 = input.archersT9;

  const perSquad: SquadAllocation[] = [];
  let allFull = true;

  /** T10 우선 소진 — 분배량을 받아서 T10/T9 분해 + 좌측 잔량 갱신. */
  const consume = (
    want: number,
    leftT10: number,
    leftT9: number,
  ): { t10: number; t9: number; used: number; leftT10: number; leftT9: number } => {
    const t10 = Math.min(want, leftT10);
    const t9 = Math.min(want - t10, leftT9);
    return { t10, t9, used: t10 + t9, leftT10: leftT10 - t10, leftT9: leftT9 - t9 };
  };

  // 1단계: 풀 편대 — 정확히 1:1:8 풀
  for (let i = 0; i < fullSquads; i++) {
    const arc = consume(archerSlotMax, leftArcT10, leftArcT9);
    leftArcT10 = arc.leftT10; leftArcT9 = arc.leftT9;
    const cav = consume(cavSlotFull, leftCavT10, leftCavT9);
    leftCavT10 = cav.leftT10; leftCavT9 = cav.leftT9;
    const inf = consume(infSlotFull, leftInfT10, leftInfT9);
    leftInfT10 = inf.leftT10; leftInfT9 = inf.leftT9;
    perSquad.push({
      infantry: { t10: inf.t10, t9: inf.t9, total: inf.used },
      cavalry: { t10: cav.t10, t9: cav.t9, total: cav.used },
      archers: { t10: arc.t10, t9: arc.t9, total: arc.used },
      total: arc.used + cav.used + inf.used,
    });
  }

  // 2단계: 평탄 편대 — 남은 자원을 남은 편대수로 균등 분배
  for (let i = fullSquads; i < N; i++) {
    const remainingSquads = N - i;

    // 궁병 — 평탄 분배, 자기자리 한도. 단 궁병이 참여(보유>0)하면 시너지 floor 이상 보장
    //        (평탄 share 가 floor 미만이어도 보유/슬롯 한도 안에서 floor 까지 끌어올림).
    const leftArcTotal = leftArcT10 + leftArcT9;
    const arcShare = Math.floor(leftArcTotal / remainingSquads);
    const arcFloor = leftArcTotal > 0 ? Math.min(synergyFloor, leftArcTotal, archerSlotMax) : 0;
    const arcWant = Math.min(Math.max(arcShare, arcFloor), archerSlotMax);
    const arc = consume(arcWant, leftArcT10, leftArcT9);
    leftArcT10 = arc.leftT10; leftArcT9 = arc.leftT9;

    // 보병/기병 자리 = cap - 궁병 사용. 궁병 못 채운 자리도 보/기가 흡수.
    // 기병이 보병보다 강하므로 "기병 우선 충원"이지만, 시너지 발동(병종별 cap*10% 참여)을
    // 위해 보병에 synergyFloor(=cap*10%) 만큼 먼저 양보 → 나머지 자리를 기병이 채움.
    const infCavSlot = cap - arc.used;

    // 보병 — 시너지 floor 우선 확보. 보유량과 자리(infCavSlot)가 상한, floor 는 목표.
    // (floor 만큼만 확보하고 나머지는 기병에 양보 — 기병이 더 강함.)
    const leftInfTotal = leftInfT10 + leftInfT9;
    const infWant = Math.min(leftInfTotal, synergyFloor, infCavSlot);
    const inf = consume(infWant, leftInfT10, leftInfT9);
    leftInfT10 = inf.leftT10; leftInfT9 = inf.leftT9;

    // 기병 — 보병 floor 확보 후 남은 자리를 최대 충원. 뒤에도 fallback 편대가 남았으면
    //        평탄(floor) 분배로 뒤 편대 화력 유지, 마지막 1개 편대면 보유 전량을 자리 한도까지.
    const cavSlot = infCavSlot - inf.used;
    const leftCavTotal = leftCavT10 + leftCavT9;
    const cavShare = remainingSquads > 1 ? Math.floor(leftCavTotal / remainingSquads) : leftCavTotal;
    const cavWant = Math.min(cavShare, cavSlot);
    const cav = consume(cavWant, leftCavT10, leftCavT9);
    leftCavT10 = cav.leftT10; leftCavT9 = cav.leftT9;

    const squadTotal = arc.used + cav.used + inf.used;
    if (squadTotal < cap) allFull = false;

    perSquad.push({
      infantry: { t10: inf.t10, t9: inf.t9, total: inf.used },
      cavalry: { t10: cav.t10, t9: cav.t9, total: cav.used },
      archers: { t10: arc.t10, t9: arc.t9, total: arc.used },
      total: squadTotal,
    });
  }

  // 실제 비율은 전체 사용량 합 기준 (편대별 분배가 다르므로 평균)
  let sumInf = 0, sumCav = 0, sumArc = 0;
  for (const s of perSquad) { sumInf += s.infantry.total; sumCav += s.cavalry.total; sumArc += s.archers.total; }

  return {
    mode: allFull ? 'bear-stack-full' : 'bear-stack-partial',
    squadCount: N,
    perSquad,
    remaining: {
      infantry: { t10: leftInfT10, t9: leftInfT9, total: leftInfT10 + leftInfT9 },
      cavalry: { t10: leftCavT10, t9: leftCavT9, total: leftCavT10 + leftCavT9 },
      archers: { t10: leftArcT10, t9: leftArcT9, total: leftArcT10 + leftArcT9 },
    },
    targetRatio: { infantry: 1, cavalry: 1, archers: 8 },
    actualRatio: toRatio(sumInf, sumCav, sumArc),
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
  if (mode === 'bear-stack') return calculateBearStack(input);
  return calculateBearHunt(input);
}

/** 비율 표기 — "1.0 : 1.0 : 8.0" 형식 */
export function formatRatio(r: RatioBreakdown): string {
  return `${r.infantry.toFixed(1)} : ${r.cavalry.toFixed(1)} : ${r.archers.toFixed(1)}`;
}
