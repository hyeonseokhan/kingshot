/**
 * 미니게임 밸런스 상수 — 클라이언트 측 mirror.
 *
 * **반드시** supabase/functions/{economy,equipment}/index.ts 의 동일 상수와 일치 유지.
 * 서버가 항상 진실의 원천(authoritative) — 클라이언트는 즉시 표시용 사전 계산만 수행.
 *
 * 변경 시 양쪽 동시 수정:
 *   - 본 파일
 *   - supabase/functions/economy/index.ts          (rewardForStage)
 *   - supabase/functions/equipment/index.ts        (ENHANCE_RANGES + helpers)
 */

// ============================================================
// Stage → 크리스탈 보상 (Phase A)
// ============================================================
//   Stage 1     : 100 (튜토리얼 보너스, 1회)
//   Stage 2~10  : 10, 15, 20, 25, 30, 35, 40, 45, 50 (5씩 점진, 각 1회)
//   Stage 11~20 : 100, 120, 140, 160, 180, 200, 220, 250, 280, 300 (각 1회)
//   Stage 21~45 : 500 부터 +20씩 → stage 45 = 980 (각 1회)
//   Stage 46+   : 100 (고정, 매 클리어 반복 파밍 가능 — 연맹원 일상 활동 재화)

const STAGE_11_20: readonly number[] = [100, 120, 140, 160, 180, 200, 220, 250, 280, 300];

export function rewardForStage(stage: number): number {
  if (stage === 1) return 100;
  if (stage >= 2 && stage <= 10) return (stage - 1) * 5 + 5;
  if (stage >= 11 && stage <= 20) return STAGE_11_20[stage - 11]!;
  if (stage >= 21 && stage <= 45) return 500 + (stage - 21) * 20;
  if (stage >= 46) return 100; // 반복 파밍 구간
  return 0;
}

/** stage 가 반복 보상 구간(46+)인지. 서버측 ref_key 분기에 사용. */
export function isRepeatableRewardStage(stage: number): boolean {
  return stage >= 46;
}

// ============================================================
// 장비 강화 (Phase B)
// ============================================================

/** 장비 슬롯 6종 — 월계관/목걸이/상의/하의/반지/지팡이. */
export const EQUIPMENT_SLOTS = ['crown', 'necklace', 'top', 'bottom', 'ring', 'staff'] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

/** UI 표시용 한글 라벨 + 아이콘 이미지 경로 (이모지 fallback). */
export const SLOT_LABEL: Record<
  EquipmentSlot,
  { name: string; icon: string; image: string }
> = {
  crown:    { name: '월계관', icon: '👑', image: '/images/items/crown.png' },
  necklace: { name: '목걸이', icon: '📿', image: '/images/items/necklace.png' },
  top:      { name: '상의',   icon: '👕', image: '/images/items/top.png' },
  bottom:   { name: '하의',   icon: '👖', image: '/images/items/bottom.png' },
  ring:     { name: '반지',   icon: '💍', image: '/images/items/ring.png' },
  staff:    { name: '지팡이', icon: '🪄', image: '/images/items/staff.png' },
};

export interface EnhanceStep {
  level: number;
  cost: number;
  power: number;
  rate: number;
}

/** 강화 cap. 100 단계 이후는 별도 컨텐츠 (신소재 등 — 후속 트랙 X-3 참조). */
export const ENHANCE_MAX_LEVEL = 100;

/**
 * 강화 등급 (rarity).
 *   common(+0) → uncommon(+1~10) → rare(+11~25) → epic(+26~45)
 *   → legendary(+46~70) → mythic(+71~100)
 */
export type EquipmentTier =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'mythic';

export const TIER_LABEL: Record<EquipmentTier, string> = {
  common: '일반',
  uncommon: '고급',
  rare: '희귀',
  epic: '영웅',
  legendary: '레전드',
  mythic: '신화',
};

export function tierForLevel(level: number): EquipmentTier {
  if (level <= 0) return 'common';
  if (level <= 10) return 'uncommon';
  if (level <= 25) return 'rare';
  if (level <= 45) return 'epic';
  if (level <= 70) return 'legendary';
  return 'mythic'; // 71~100
}

/**
 * 강화 단계 비용/전투력/확률 — 등급별 range 정의 + 선형 보간.
 *   - 튜토리얼 (+1, +2): 무조건 100% 성공 (특별 처리)
 *   - 그 외: 등급별 시작/끝 값 사이 보간
 *
 * 참고:
 *   - 비용 곡선 — 등급 사이에 의도적 jump (uncommon 끝 1,000 → rare 시작 1,500)
 *   - 게임 평생 max 재화 ~20,820 + stage 46+ 100/회 반복 파밍 가정
 *   - 한 부위 신화(+71~100) 풀강은 end-game grind 영역 (수백만 ~ 수천만 크리스탈)
 */
const ENHANCE_RANGES: ReadonlyArray<{
  tier: EquipmentTier;
  from: number;
  to: number;
  costFrom: number;
  costTo: number;
  powerFrom: number;
  powerTo: number;
  rateFrom: number;
  rateTo: number;
}> = [
  { tier: 'uncommon',  from: 3,  to: 10,  costFrom: 300,    costTo: 1000,    powerFrom: 80,    powerTo: 200,    rateFrom: 0.95, rateTo: 0.80 },
  { tier: 'rare',      from: 11, to: 25,  costFrom: 1500,   costTo: 4000,    powerFrom: 250,   powerTo: 600,    rateFrom: 0.75, rateTo: 0.55 },
  { tier: 'epic',      from: 26, to: 45,  costFrom: 5000,   costTo: 15000,   powerFrom: 700,   powerTo: 2000,   rateFrom: 0.50, rateTo: 0.30 },
  { tier: 'legendary', from: 46, to: 70,  costFrom: 18000,  costTo: 60000,   powerFrom: 2500,  powerTo: 8000,   rateFrom: 0.25, rateTo: 0.10 },
  { tier: 'mythic',    from: 71, to: 100, costFrom: 70000,  costTo: 400000,  powerFrom: 10000, powerTo: 50000,  rateFrom: 0.08, rateTo: 0.02 },
];

/**
 * 현재 레벨에서 한 단계 강화 시도 시 cost/power/rate 반환.
 * 이미 max 면 null.
 */
export function enhanceCostFor(currentLevel: number): EnhanceStep | null {
  const next = currentLevel + 1;
  if (next < 1 || next > ENHANCE_MAX_LEVEL) return null;

  // 튜토리얼 — +1, +2 는 100% 성공 보장
  if (next === 1) return { level: 1, cost: 100, power: 50, rate: 1.0 };
  if (next === 2) return { level: 2, cost: 200, power: 60, rate: 1.0 };

  const range = ENHANCE_RANGES.find((r) => next >= r.from && next <= r.to);
  if (!range) return null;
  const span = Math.max(1, range.to - range.from);
  const t = (next - range.from) / span;
  return {
    level: next,
    cost: Math.round(range.costFrom + (range.costTo - range.costFrom) * t),
    power: Math.round(range.powerFrom + (range.powerTo - range.powerFrom) * t),
    rate: range.rateFrom + (range.rateTo - range.rateFrom) * t,
  };
}

/** 0..currentLevel 까지의 누적 전투력 (성공 가정). */
export function accumulatedPower(currentLevel: number): number {
  let sum = 0;
  for (let i = 1; i <= currentLevel && i <= ENHANCE_MAX_LEVEL; i++) {
    const step = enhanceCostFor(i - 1);
    if (step) sum += step.power;
  }
  return sum;
}
