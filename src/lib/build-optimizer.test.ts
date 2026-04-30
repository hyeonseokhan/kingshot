/**
 * 건축 버프 최적화 — 단위 테스트.
 *
 * 가이드(`신규서비스.md`) 의 명시 예시 + edge case 검증.
 * 검증 케이스:
 *   - §2.3 / §7 의 명시 숫자 (도시 센터 29일 2시간 52분 시나리오)
 *   - §16 시나리오 1 (이득 8시간)
 *   - §6 의 공식이 edge case 에서 깨지지 않는지
 *   - 시간 변환 (toSeconds / fromSeconds / formatTime) 의 round-trip
 */

import { describe, it, expect } from 'vitest';
import {
  toSeconds,
  fromSeconds,
  formatTime,
  calculateBuildTime,
  analyzeBuilding,
  evaluateAssignment,
  recommendForCandidates,
  type BuffSettings,
  type BuildingCandidate,
  type BuildQueue,
} from './build-optimizer';

// ============================================================
// 시간 변환
// ============================================================

describe('toSeconds / fromSeconds', () => {
  it('29일 2시간 52분 = 2,515,920초', () => {
    expect(toSeconds({ days: 29, hours: 2, minutes: 52, seconds: 0 })).toBe(2_515_920);
  });

  it('round-trip — 13일 23시간 35분', () => {
    const sec = toSeconds({ days: 13, hours: 23, minutes: 35, seconds: 0 });
    expect(fromSeconds(sec)).toEqual({ days: 13, hours: 23, minutes: 35, seconds: 0 });
  });

  it('소수점 초는 floor — fromSeconds(60.9) = 1분 0초', () => {
    expect(fromSeconds(60.9)).toEqual({ days: 0, hours: 0, minutes: 1, seconds: 0 });
  });

  it('0초', () => {
    expect(toSeconds({ days: 0, hours: 0, minutes: 0, seconds: 0 })).toBe(0);
    expect(fromSeconds(0)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  });

  it('1일 = 86400초', () => {
    expect(toSeconds({ days: 1, hours: 0, minutes: 0, seconds: 0 })).toBe(86400);
  });
});

describe('formatTime', () => {
  it('29일 2시간 52분 — 0 단위 생략', () => {
    expect(formatTime(2_515_920)).toBe('29일 2시간 52분');
  });

  it('초 포함 옵션 — includeSeconds=true', () => {
    // 2,515,920 + 14 = 2,515,934
    expect(formatTime(2_515_934, true)).toBe('29일 2시간 52분 14초');
  });

  it('0 → "0초"', () => {
    expect(formatTime(0)).toBe('0초');
  });

  it('59초 + includeSeconds=false → "0분" (대안: 큰 단위 없으면 0분 표기)', () => {
    expect(formatTime(59)).toBe('0분');
  });

  it('59초 + includeSeconds=true → "59초"', () => {
    expect(formatTime(59, true)).toBe('59초');
  });

  it('5일 12시간 14분 (가이드 §3.4 가속권 예시)', () => {
    const sec = toSeconds({ days: 5, hours: 12, minutes: 14, seconds: 0 });
    expect(formatTime(sec)).toBe('5일 12시간 14분');
  });

  it('1시간 — 단일 단위', () => {
    expect(formatTime(3600)).toBe('1시간');
  });

  it('1일 — 단일 단위, 시간/분 0 생략', () => {
    expect(formatTime(86400)).toBe('1일');
  });

  it('30분', () => {
    expect(formatTime(1800)).toBe('30분');
  });
});

// ============================================================
// 핵심 공식 — calculateBuildTime
// ============================================================

describe('calculateBuildTime — 가이드 §2.3 명시 예시', () => {
  // 기본: 29일 2시간 52분 = 2,515,920초
  // 속도 버프 76.6% (= 54.6 + 12 + 10), 시간 단축 20%
  // 기대: 약 13일 4시간 35분 (가이드 §7 의 "총리대신 포함")
  it('속도 76.6% + 단축 20% → 약 13일 4시간 35분', () => {
    const result = calculateBuildTime(2_515_920, 76.6, 20);
    // 정확값: 2515920 / 1.766 * 0.8 ≈ 1,139,714.61 초
    // 13일 4시간 35분 = 13*86400 + 4*3600 + 35*60 = 1,123,200 + 14,400 + 2,100 = 1,139,700초
    expect(result).toBeCloseTo(1_139_714.61, 0);
    expect(formatTime(result)).toBe('13일 4시간 35분');
  });

  it('속도 66.6% (= 기본54.6 + 펫12) + 단축 20% → 약 13일 23시간 35분 (총리대신 미적용, §7)', () => {
    const result = calculateBuildTime(2_515_920, 66.6, 20);
    // 정확값: 2515920 / 1.666 * 0.8 ≈ 1,208,124.85 초
    // 13일 23시간 35분 = 1,208,100 → 가이드 표현보다 약 25초 더 (floor 시 표현은 일치)
    expect(result).toBeCloseTo(1_208_124.85, 0);
    expect(formatTime(result)).toBe('13일 23시간 35분');
  });

  it('버프 없음 (0/0) → 그대로', () => {
    expect(calculateBuildTime(100, 0, 0)).toBe(100);
  });

  it('속도 100% → 절반', () => {
    expect(calculateBuildTime(100, 100, 0)).toBe(50);
  });

  it('단축 100% → 0', () => {
    expect(calculateBuildTime(100, 0, 100)).toBe(0);
  });

  it('단축 50% + 속도 100% → 25 (반응)', () => {
    // 100 / 2 * 0.5 = 25
    expect(calculateBuildTime(100, 100, 50)).toBe(25);
  });
});

// ============================================================
// 단일 건물 분석 — analyzeBuilding
// ============================================================

describe('analyzeBuilding — 가이드 §16 시나리오 1 (도시 센터, 이득 8h)', () => {
  // 기본 건설 속도: 54.6%, 펫: 12%, 법령: 사용 (단축 20%), 총리대신 11h 대기
  // 건물: 도시 센터 / 29일 2시간 52분
  // 기대: 손익분기 19h, 실제 대기 11h, 이득 = 19h - 11h = 8h

  const cityCenter: BuildingCandidate = {
    id: 'city-center',
    name: '도시 센터',
    baseSeconds: 2_515_920,
  };

  const buffs: BuffSettings = {
    baseSpeedPercent: 54.6,
    petSpeedPercent: 12,
    primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20,
    primeMinisterWaitSeconds: 11 * 3600, // 11시간
    accelerationTicketSeconds: 0,
  };

  const result = analyzeBuilding(cityCenter, buffs);

  it('즉시 건축 시간 ≈ 13일 23시간 35분', () => {
    expect(formatTime(result.immediateBuildSeconds)).toMatch(/^13일 23시간 (34|35)분$/);
  });

  it('총리대신 후 건축 시간 ≈ 13일 4시간 35분', () => {
    expect(formatTime(result.withPrimeMinisterBuildSeconds)).toMatch(/^13일 (3|4)시간 35분$/);
  });

  it('손익분기 대기 시간 ≈ 19시간 (가이드 §7 명시)', () => {
    // 정확값: 1208049.22 - 1139714.61 = 68334.61초 ≈ 18시간 58분 54초
    // 약 19시간이라 가이드 표현
    const breakEvenHours = result.breakEvenWaitSeconds / 3600;
    expect(breakEvenHours).toBeGreaterThan(18.9);
    expect(breakEvenHours).toBeLessThan(19.1);
  });

  it('실제 대기 11h < 손익분기 19h → 기다리는 게 이득', () => {
    expect(result.shouldWaitForPrimeMinister).toBe(true);
  });

  it('이득 ≈ 8시간 (가이드 §16 명시: "약 8시간")', () => {
    // 손익분기 - 실제대기 ≈ 19h - 11h = 8h
    const gainHours = result.netGainSeconds / 3600;
    expect(gainHours).toBeGreaterThan(7.9);
    expect(gainHours).toBeLessThan(8.1);
  });
});

describe('analyzeBuilding — 짧은 건물 (3일)', () => {
  // 가이드 §16 시나리오 2: 건물 A 3일, 총리대신 11h → 즉시가 이득
  const shortBuilding: BuildingCandidate = {
    id: 'a',
    baseSeconds: 3 * 86400, // 3일
  };

  const buffs: BuffSettings = {
    baseSpeedPercent: 54.6,
    petSpeedPercent: 12,
    primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20,
    primeMinisterWaitSeconds: 11 * 3600,
    accelerationTicketSeconds: 0,
  };

  const result = analyzeBuilding(shortBuilding, buffs);

  it('짧은 건물의 손익분기 대기 시간은 짧음 (< 11h 일 가능성)', () => {
    // 3일 = 259200초
    // 즉시: 259200 / 1.666 * 0.8 ≈ 124,449초 ≈ 34시간 34분
    // 총리대신 후: 259200 / 1.766 * 0.8 ≈ 117,400초 ≈ 32시간 36분
    // 손익분기: 124449 - 117400 = 7049초 ≈ 1시간 57분
    const beHours = result.breakEvenWaitSeconds / 3600;
    expect(beHours).toBeGreaterThan(1.5);
    expect(beHours).toBeLessThan(2.5);
  });

  it('실제 대기 11h > 손익분기 ~2h → 즉시 시작이 이득', () => {
    expect(result.shouldWaitForPrimeMinister).toBe(false);
    expect(result.netGainSeconds).toBeLessThan(0);
  });
});

describe('analyzeBuilding — 총리대신 0% (사용 안 함)', () => {
  const building: BuildingCandidate = { id: 'x', baseSeconds: 86400 };

  const buffs: BuffSettings = {
    baseSpeedPercent: 50,
    petSpeedPercent: 0,
    primeMinisterSpeedPercent: 0,
    lawReductionPercent: 0,
    primeMinisterWaitSeconds: 0,
    accelerationTicketSeconds: 0,
  };

  const result = analyzeBuilding(building, buffs);

  it('총리대신 효과 0 → immediate == withPm, 손익분기 0', () => {
    expect(result.immediateBuildSeconds).toBe(result.withPrimeMinisterBuildSeconds);
    expect(result.breakEvenWaitSeconds).toBe(0);
  });

  it('대기 0 + 손익분기 0 → 이득 0, shouldWait=false (동률은 false)', () => {
    expect(result.netGainSeconds).toBe(0);
    expect(result.shouldWaitForPrimeMinister).toBe(false);
  });
});

describe('analyzeBuilding — actualWait=0 (총리대신 즉시 사용 가능)', () => {
  // 사용자가 시각 비워둠 → actualWait=0. 지금 모든 버프 적용해서 시작이 답.
  const building: BuildingCandidate = { id: 'a', baseSeconds: 2_515_920 };
  const buffs: BuffSettings = {
    baseSpeedPercent: 54.6,
    petSpeedPercent: 12,
    primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20,
    primeMinisterWaitSeconds: 0,
    accelerationTicketSeconds: 0,
  };
  const result = analyzeBuilding(building, buffs);

  it('netGain > 0 (≈ 19시간) — 총리대신 효과 자체', () => {
    expect(result.netGainSeconds).toBeGreaterThan(0);
  });

  it('shouldWait=false — 대기 자체가 0 이라 기다릴 의미 없음', () => {
    // actualWait > 0 조건이 없으면 — 즉시 사용 가능 시 권장은 "지금 시작 (모든 버프 적용)"
    expect(result.shouldWaitForPrimeMinister).toBe(false);
  });
});

describe('analyzeBuilding — 동률 케이스', () => {
  // 손익분기 == 실제 대기 → netGain = 0
  const building: BuildingCandidate = { id: 'tie', baseSeconds: 2_515_920 };
  const buffs: BuffSettings = {
    baseSpeedPercent: 54.6,
    petSpeedPercent: 12,
    primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20,
    primeMinisterWaitSeconds: 0, // 일단 임시 — 아래에서 손익분기와 같게 set
    accelerationTicketSeconds: 0,
  };

  it('대기 == 손익분기 → netGain 0 → shouldWait=false (동률은 즉시 권장)', () => {
    const probe = analyzeBuilding(building, { ...buffs, primeMinisterWaitSeconds: 0 });
    const tieBuffs = { ...buffs, primeMinisterWaitSeconds: probe.breakEvenWaitSeconds };
    const result = analyzeBuilding(building, tieBuffs);
    expect(result.netGainSeconds).toBeCloseTo(0, 5);
    expect(result.shouldWaitForPrimeMinister).toBe(false);
  });
});

// ============================================================
// evaluateAssignment — 4 시점 비교 (Phase 1)
// ============================================================

describe('evaluateAssignment — 단일 후보 + 큐 빔 시각', () => {
  // 가이드 §16 시나리오 1 변형 — 큐가 비어 있고 PM 11h. analyzeBuilding 과 같은 결론.
  const cityCenter: BuildingCandidate = { id: 'city', name: '도시 센터', baseSeconds: 2_515_920 };
  const buffsBase: BuffSettings = {
    baseSpeedPercent: 54.6, petSpeedPercent: 12, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20, primeMinisterWaitSeconds: 11 * 3600,
    accelerationTicketSeconds: 0,
  };

  it('큐 비어 (0초) + PM 11h → wait-pm 이득 약 8h', () => {
    const a = evaluateAssignment(cityCenter, 0, buffsBase, { queueId: 'queue1' });
    expect(a.chosenStrategy).toBe('wait-pm');
    expect(a.netGainSeconds / 3600).toBeGreaterThan(7.9);
    expect(a.netGainSeconds / 3600).toBeLessThan(8.1);
  });

  it('큐 빔 시각이 PM 보다 늦음 — t_start_with_pm = t_queue_free', () => {
    // 큐 20h 후 빔, PM 11h → start_with_pm = max(20h, 11h) = 20h (큐 빔이 늦음)
    const a = evaluateAssignment(cityCenter, 20 * 3600, buffsBase, { queueId: 'queue1' });
    // 즉시: 20h + 즉시건축 ≈ 20h + 13d23h35m
    // PM:   20h + PM건축    ≈ 20h + 13d4h35m
    // 차이: 즉시건축 - PM건축 ≈ 19h (PM 자동 적용 효과)
    expect(a.netGainSeconds / 3600).toBeGreaterThan(18.9);
    expect(a.netGainSeconds / 3600).toBeLessThan(19.1);
    expect(a.chosenStrategy).toBe('wait-pm');
  });

  it('PM 즉시 가능 (대기 0) + 큐 비어 → 즉시 시작 (모든 버프 적용)', () => {
    const buffs = { ...buffsBase, primeMinisterWaitSeconds: 0 };
    const a = evaluateAssignment(cityCenter, 0, buffs);
    // start_with_pm = max(0, 0) = 0, total_with_pm = 0 + 13d4h35m
    // start_immediate = 0, total_immediate = 0 + 13d23h35m
    // chosen = wait-pm (= "즉시 시작 + 모든 버프")
    expect(a.chosenStrategy).toBe('wait-pm');
    expect(a.netGainSeconds / 3600).toBeGreaterThan(18.9);
  });

  it('짧은 후보 + PM 대기 큼 → immediate (가이드 §16 시나리오 2 / §8.3 패턴 C)', () => {
    const shortBldg: BuildingCandidate = { id: 'a', baseSeconds: 3 * 86400 }; // 3일
    const a = evaluateAssignment(shortBldg, 0, buffsBase);
    expect(a.chosenStrategy).toBe('immediate');
    expect(a.netGainSeconds).toBeLessThan(0);
  });
});

// ============================================================
// recommendForCandidates — 큐 매칭 + 패턴 분류 (Phase 1)
// ============================================================

describe('recommendForCandidates — 후보 1개', () => {
  const buffsBase: BuffSettings = {
    baseSpeedPercent: 54.6, petSpeedPercent: 12, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20, primeMinisterWaitSeconds: 11 * 3600,
    accelerationTicketSeconds: 0,
  };
  const cityCenter: BuildingCandidate = { id: 'city', name: '도시센터', baseSeconds: 2_515_920 };

  it('큐 1 비어 / 큐 2 진행 중 → q1 배정', () => {
    const result = recommendForCandidates(
      [cityCenter],
      [
        { id: 'queue1', status: 'empty', remainingSeconds: 0 },
        { id: 'queue2', status: 'building', remainingSeconds: 5 * 3600 },
      ],
      buffsBase,
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.assignedQueueId).toBe('queue1');
    expect(result.pattern).toBe('B'); // 긴 건물 + 대기 < 손익분기 → B
  });

  it('큐 1 진행 중 8h / 큐 2 진행 중 2h → 더 빨리 비는 q2 배정', () => {
    const result = recommendForCandidates(
      [cityCenter],
      [
        { id: 'queue1', status: 'building', remainingSeconds: 8 * 3600 },
        { id: 'queue2', status: 'building', remainingSeconds: 2 * 3600 },
      ],
      buffsBase,
    );
    expect(result.assignments[0]!.assignedQueueId).toBe('queue2');
  });
});

describe('recommendForCandidates — 가이드 §8.3 패턴 A', () => {
  // 큐 1 = 2h 후 빔, 큐 2 = 건축 중 (시간 명시 X — 12h 가정), PM = 13h 후
  // 후보 A = 3일 (짧음), 후보 B = 29일 2h 52m (긴 것 — 도시 센터)
  // 추천: A → 큐 1 즉시, B → 큐 2 PM 후
  const buffsBase: BuffSettings = {
    baseSpeedPercent: 54.6, petSpeedPercent: 12, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20, primeMinisterWaitSeconds: 13 * 3600,
    accelerationTicketSeconds: 0,
  };
  const queues: [BuildQueue, BuildQueue] = [
    { id: 'queue1', status: 'building', remainingSeconds: 2 * 3600 },
    { id: 'queue2', status: 'building', remainingSeconds: 12 * 3600 },
  ];
  const buildingA: BuildingCandidate = { id: 'a', name: '병영', baseSeconds: 3 * 86400 };
  const buildingB: BuildingCandidate = { id: 'b', name: '도시센터', baseSeconds: 2_515_920 };

  it('패턴 A — 짧은 A 는 빠르게 비는 q1, 긴 B 는 늦게 비는 q2', () => {
    const result = recommendForCandidates([buildingA, buildingB], queues, buffsBase);
    expect(result.pattern).toBe('A');
    const assignA = result.assignments.find((x) => x.candidate.id === 'a')!;
    const assignB = result.assignments.find((x) => x.candidate.id === 'b')!;
    expect(assignA.assignedQueueId).toBe('queue1');
    expect(assignB.assignedQueueId).toBe('queue2');
  });

  it('패턴 A — A 는 immediate, B 는 wait-pm (PM 효과 큼)', () => {
    const result = recommendForCandidates([buildingA, buildingB], queues, buffsBase);
    const assignA = result.assignments.find((x) => x.candidate.id === 'a')!;
    const assignB = result.assignments.find((x) => x.candidate.id === 'b')!;
    expect(assignA.chosenStrategy).toBe('immediate');
    expect(assignB.chosenStrategy).toBe('wait-pm');
  });
});

describe('recommendForCandidates — 가이드 §8.3 패턴 D (큐 둘 다 비어)', () => {
  // 핵심: 둘 다 PM 이득이어도 짧은 건은 immediate. 긴 건만 PM 적용.
  const buffsBase: BuffSettings = {
    baseSpeedPercent: 54.6, petSpeedPercent: 12, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20, primeMinisterWaitSeconds: 8 * 3600, // 8h 대기
    accelerationTicketSeconds: 0,
  };
  const queues: [BuildQueue, BuildQueue] = [
    { id: 'queue1', status: 'empty', remainingSeconds: 0 },
    { id: 'queue2', status: 'empty', remainingSeconds: 0 },
  ];
  // 두 후보 모두 충분히 길어 4 시점 단순 비교 시 둘 다 wait-pm 이 이득일 수 있음
  const long1: BuildingCandidate = { id: 'long1', baseSeconds: 20 * 86400 };
  const long2: BuildingCandidate = { id: 'long2', baseSeconds: 25 * 86400 };

  it('패턴 D — 둘 다 wait-pm 이득이라도 짧은 후보는 immediate 강제', () => {
    const result = recommendForCandidates([long1, long2], queues, buffsBase);
    expect(result.pattern).toBe('D');
    const longerAssign = result.assignments.find((x) => x.candidate.id === 'long2')!;
    const shorterAssign = result.assignments.find((x) => x.candidate.id === 'long1')!;
    expect(longerAssign.chosenStrategy).toBe('wait-pm'); // 긴 건만 PM
    expect(shorterAssign.chosenStrategy).toBe('immediate'); // 짧은 건 즉시 (override)
  });
});

describe('recommendForCandidates — edge', () => {
  const buffs: BuffSettings = {
    baseSpeedPercent: 50, petSpeedPercent: 0, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 0, primeMinisterWaitSeconds: 5 * 3600,
    accelerationTicketSeconds: 0,
  };
  const queues: [BuildQueue, BuildQueue] = [
    { id: 'queue1', status: 'empty', remainingSeconds: 0 },
    { id: 'queue2', status: 'empty', remainingSeconds: 0 },
  ];

  it('후보 0개 → 빈 결과', () => {
    const result = recommendForCandidates([], queues, buffs);
    expect(result.assignments).toHaveLength(0);
  });

  it('후보 1개 + PM 0 → single 패턴', () => {
    const noPmBuffs = { ...buffs, primeMinisterWaitSeconds: 0 };
    const result = recommendForCandidates(
      [{ id: 'x', baseSeconds: 86400 }],
      queues,
      noPmBuffs,
    );
    expect(result.pattern).toBe('single');
  });
});

// ============================================================
// 실제 사용자 시나리오 기반 케이스
// ============================================================

describe('실사용 케이스 A — 큐가 총리대신보다 빨리 빔', () => {
  // 사용자 실제 고민: 큐1=15h 남음, 큐2=2h 남음, 총리대신 8h 후, 후보=도시센터
  // 큐2(2h)에 배정됨 (빠른 큐). 즉시 시작 vs 6시간 큐 낭비 후 총리대신 시작.
  // 도시센터 같은 긴 건물 → 총리대신 효과(19h) > 큐 낭비(6h) → wait-pm 이득.

  const buffs: BuffSettings = {
    baseSpeedPercent: 54.6, petSpeedPercent: 12, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20, primeMinisterWaitSeconds: 8 * 3600,
    accelerationTicketSeconds: 0,
  };
  const queues: [BuildQueue, BuildQueue] = [
    { id: 'queue1', status: 'building', remainingSeconds: 15 * 3600 },
    { id: 'queue2', status: 'building', remainingSeconds: 2 * 3600 },
  ];

  it('도시센터(29일) — 빠른 큐(q2, 2h) 배정 + wait-pm 이득 (총리대신효과 19h > 큐낭비 6h)', () => {
    const cityCenter: BuildingCandidate = { id: 'city', baseSeconds: 2_515_920 };
    const result = recommendForCandidates([cityCenter], queues, buffs);
    expect(result.assignments[0]!.assignedQueueId).toBe('queue2');
    expect(result.assignments[0]!.chosenStrategy).toBe('wait-pm');
    // 순이득 = 19h - 6h = 13h 정도
    expect(result.assignments[0]!.netGainSeconds / 3600).toBeGreaterThan(12.9);
    expect(result.assignments[0]!.netGainSeconds / 3600).toBeLessThan(13.1);
  });

  it('7일 건물 — 빠른 큐 배정 + immediate 이득 (총리대신효과 ~4.6h < 큐낭비 6h)', () => {
    const sevenDay: BuildingCandidate = { id: '7d', baseSeconds: 7 * 86400 };
    const result = recommendForCandidates([sevenDay], queues, buffs);
    expect(result.assignments[0]!.assignedQueueId).toBe('queue2');
    expect(result.assignments[0]!.chosenStrategy).toBe('immediate');
    // 7일 손익분기 ≈ 4h36m. 큐2 빔 후 6h 기다리면 손해.
    expect(result.assignments[0]!.netGainSeconds).toBeLessThan(0);
  });
});

describe('상위 사용자 속도 61.8% — 도시센터', () => {
  // 속도 73.8% (=61.8+12, 총리 제외) vs 83.8% (+ 총리 10), 단축 20%
  // 즉시:    2515920 / 1.738 * 0.8 ≈ 1,158,076s ≈ 13일 9시간 41분
  // 총리적용: 2515920 / 1.838 * 0.8 ≈ 1,095,068s ≈ 12일 16시간 11분
  // 손익분기 = (1/1.738 - 1/1.838) × 2515920 × 0.8 ≈ 63,023s ≈ 17.5시간
  // 54.6% 사용자의 19시간 보다 짧음 — 속도 높을수록 총리대신 효과 비율 ↓
  const buffs: BuffSettings = {
    baseSpeedPercent: 61.8, petSpeedPercent: 12, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20, primeMinisterWaitSeconds: 0,
    accelerationTicketSeconds: 0,
  };
  const cityCenter: BuildingCandidate = { id: 'city', baseSeconds: 2_515_920 };

  it('손익분기가 54.6% 사용자(19시간) 보다 짧음 (약 17.5시간)', () => {
    const a = analyzeBuilding(cityCenter, buffs);
    expect(a.breakEvenWaitSeconds / 3600).toBeGreaterThan(17.0);
    expect(a.breakEvenWaitSeconds / 3600).toBeLessThan(18.0);
  });
});

describe('극단적 건축 시간 — 1일 / 60일', () => {
  const buffs: BuffSettings = {
    baseSpeedPercent: 54.6, petSpeedPercent: 12, primeMinisterSpeedPercent: 10,
    lawReductionPercent: 20, primeMinisterWaitSeconds: 12 * 3600,
    accelerationTicketSeconds: 0,
  };
  const queues: [BuildQueue, BuildQueue] = [
    { id: 'queue1', status: 'empty', remainingSeconds: 0 },
    { id: 'queue2', status: 'empty', remainingSeconds: 0 },
  ];

  it('1일 (매우 짧은 건물) — 손익분기 매우 짧아 총리대신 12h 대기 손해', () => {
    const oneDay: BuildingCandidate = { id: '1d', baseSeconds: 86400 };
    const result = recommendForCandidates([oneDay], queues, buffs);
    expect(result.assignments[0]!.chosenStrategy).toBe('immediate');
    // 1일 손익분기 ≈ 86400/1.666*0.8 - 86400/1.766*0.8 ≈ 41483 - 39131 = 2352s ≈ 39분
    expect(result.assignments[0]!.breakEvenWaitSeconds / 60).toBeGreaterThan(35);
    expect(result.assignments[0]!.breakEvenWaitSeconds / 60).toBeLessThan(45);
  });

  it('60일 (매우 긴 건물) — 손익분기 매우 길어 총리대신 12h 대기 큰 이득', () => {
    const sixtyDay: BuildingCandidate = { id: '60d', baseSeconds: 60 * 86400 };
    const result = recommendForCandidates([sixtyDay], queues, buffs);
    expect(result.assignments[0]!.chosenStrategy).toBe('wait-pm');
    // 60일 손익분기 ≈ 60일 * (1/1.666 - 1/1.766) * 0.8 ≈ 39h 18m
    expect(result.assignments[0]!.breakEvenWaitSeconds / 3600).toBeGreaterThan(38);
    expect(result.assignments[0]!.breakEvenWaitSeconds / 3600).toBeLessThan(40);
    // 12h 대기 < 39h 손익분기 → 약 27h 이득
    expect(result.assignments[0]!.netGainSeconds / 3600).toBeGreaterThan(26);
  });
});
