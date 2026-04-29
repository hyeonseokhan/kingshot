/**
 * 미니게임 밸런스 상수 — 클라이언트 측 mirror.
 *
 * **반드시** supabase/functions/{economy,equipment}/index.ts 의 동일 상수와 일치 유지.
 * 서버가 항상 진실의 원천(authoritative) — 클라이언트는 즉시 표시용 사전 계산만 수행.
 *
 * 변경 시 양쪽 동시 수정:
 *   - 본 파일
 *   - supabase/functions/economy/index.ts          (rewardForStage)
 *   - supabase/functions/equipment/index.ts        (ENHANCE_TABLE)
 */

// ============================================================
// Stage → 크리스탈 보상 (Phase A)
// ============================================================
//   Stage 1     : 100 (튜토리얼 보너스)
//   Stage 2~10  : 10, 15, 20, 25, 30, 35, 40, 45, 50 (5씩 점진)
//   Stage 11~20 : 100, 120, 140, 160, 180, 200, 220, 250, 280, 300
//   Stage 21~45 : 500 부터 +20씩 → stage 45 = 980
//   Stage 46+   : 0 (난이도 cap, 의미 없음)

const STAGE_11_20: readonly number[] = [100, 120, 140, 160, 180, 200, 220, 250, 280, 300];

export function rewardForStage(stage: number): number {
  if (stage === 1) return 100;
  if (stage >= 2 && stage <= 10) return (stage - 1) * 5 + 5;
  if (stage >= 11 && stage <= 20) return STAGE_11_20[stage - 11]!;
  if (stage >= 21 && stage <= 45) return 500 + (stage - 21) * 20;
  return 0;
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
  tier?: 'bronze' | 'silver';
}

/**
 * 강화 단계별 비용 / 증가 전투력 / 성공률.
 *
 *   level : 강화 후 도달 레벨 (1~10). 즉 +0 → +1 시도 시 ENHANCE_TABLE[0] 참조
 *   cost  : 시도 1회당 소모 크리스탈 (성공/실패 무관)
 *   power : 성공 시 추가되는 전투력 (실패 시 변화 없음)
 *   rate  : 성공 확률 (0.0 ~ 1.0)
 *
 * 현재 cap = +10 (Silver). 향후 해금으로 +11+ 확장 예정.
 */
export const ENHANCE_TABLE: readonly EnhanceStep[] = [
  { level: 1,  cost: 100,   power: 50,    rate: 1.00 },
  { level: 2,  cost: 200,   power: 60,    rate: 1.00 },
  { level: 3,  cost: 400,   power: 80,    rate: 0.90 },
  { level: 4,  cost: 800,   power: 120,   rate: 0.80 },
  { level: 5,  cost: 1500,  power: 200,   rate: 0.70, tier: 'bronze' },
  { level: 6,  cost: 2200,  power: 330,   rate: 0.66 },
  { level: 7,  cost: 2900,  power: 460,   rate: 0.62 },
  { level: 8,  cost: 3600,  power: 600,   rate: 0.58 },
  { level: 9,  cost: 4300,  power: 780,   rate: 0.54 },
  { level: 10, cost: 5000,  power: 1000,  rate: 0.50, tier: 'silver' },
];

/** 현재 cap. 사용자 코드 분기에 사용. */
export const ENHANCE_MAX_LEVEL = 10;

/**
 * 현재 레벨에서 한 단계 강화 시도 시 비용/효과/확률 반환.
 * 이미 max 면 null.
 */
export function enhanceCostFor(currentLevel: number): EnhanceStep | null {
  const next = currentLevel + 1;
  if (next < 1 || next > ENHANCE_MAX_LEVEL) return null;
  return ENHANCE_TABLE[next - 1] ?? null;
}

/** 0..currentLevel 까지의 누적 전투력. 강화 안 된 슬롯이면 0. */
export function accumulatedPower(currentLevel: number): number {
  let sum = 0;
  for (let i = 1; i <= currentLevel && i <= ENHANCE_MAX_LEVEL; i++) {
    sum += ENHANCE_TABLE[i - 1]!.power;
  }
  return sum;
}
