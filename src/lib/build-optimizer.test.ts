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
  type BuffSettings,
  type BuildingCandidate,
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
