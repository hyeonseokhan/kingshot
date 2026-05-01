/**
 * 장비 강화 stage 의 *배경 효과* (등급별 분위기 연출).
 *
 * 슬롯 자체의 등급 (.eq-slot-tier-*) 과 별개로, 6 슬롯 합산 *최저 등급* 기준으로 stage
 * 의 background + 모션 효과를 부여한다. 클래스: .eq-stage-bg-tier-{tier}.
 *
 * 사용:
 *   const tier = lowestStageTier([{slot:'crown',level:9}, ...]);
 *   applyStageTier(stageEl, tier);
 *
 * 호출 위치:
 *   - equipment.ts: fetchEquipment / 강화 결과 후 (renderAllSlots 안)
 *   - pvp.ts: openEquipView 의 장비 fetch 응답 후
 *   - 미리보기 다이얼로그: 사용자가 등급 넘길 때마다
 *
 * fx 컨테이너 (.eq-tier-fx) 는 stage 의 첫 번째 자식으로 자동 생성. 등급 전환 시 안의
 * 자식 element 모두 갈아끼움 — 이전 등급의 모션 element 가 남지 않게.
 */

import { tierForLevel, EQUIPMENT_SLOTS, type EquipmentTier } from './balance';

const TIER_BG_CLASSES: ReadonlyArray<string> = (
  ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const
).map((t) => 'eq-stage-bg-tier-' + t);

const TIER_ORDER: readonly EquipmentTier[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
];

/** 6 슬롯 강화 정보로부터 stage 배경 등급 결정.
 *  6 슬롯 미만이거나 하나라도 common 이면 'common' (최저 등급 우선). */
export function lowestStageTier(
  rows: ReadonlyArray<{ slot: string; level: number }>,
): EquipmentTier {
  if (rows.length < EQUIPMENT_SLOTS.length) return 'common';
  const tiers = rows.map((r) => tierForLevel(r.level));
  let minIdx = TIER_ORDER.length - 1;
  for (const t of tiers) {
    const i = TIER_ORDER.indexOf(t);
    if (i < minIdx) minIdx = i;
  }
  return TIER_ORDER[minIdx] ?? 'common';
}

/** stage 에 등급 배경 클래스 + fx 컨테이너 element 생성·갱신. */
export function applyStageTier(stageEl: HTMLElement, tier: EquipmentTier): void {
  // 클래스 토글 (이전 등급 클래스 제거 후 신규)
  TIER_BG_CLASSES.forEach((c) => stageEl.classList.remove(c));
  stageEl.classList.add('eq-stage-bg-tier-' + tier);

  // fx 컨테이너 — stage 의 첫 자식. 없으면 생성, 있으면 비움 (이전 등급 element 제거).
  let fx = stageEl.querySelector<HTMLElement>(':scope > .eq-tier-fx');
  if (!fx) {
    fx = document.createElement('div');
    fx.className = 'eq-tier-fx';
    fx.setAttribute('aria-hidden', 'true');
    stageEl.insertBefore(fx, stageEl.firstChild);
  } else {
    fx.replaceChildren();
  }

  // 등급별 모션 element 동적 생성. 일반은 fx 비어있음 (효과 X).
  switch (tier) {
    case 'uncommon':
      buildLeaves(fx);
      break;
    case 'rare':
      buildRipples(fx);
      break;
    case 'epic':
      buildEpicParticles(fx);
      break;
    case 'legendary':
      buildLegendarySparkles(fx);
      break;
    case 'mythic':
      buildMythicLights(fx);
      break;
    case 'common':
    default:
      break;
  }
}

/** 단일 stage 안에서 미리보기 등 임시 모드 호출용 — applyStageTier 와 동일 동작. */
export const setStageTierPreview = applyStageTier;

// ============================================================
// 등급별 element builder — preview HTML 와 동일 스펙
// ============================================================

function buildLeaves(fx: HTMLElement): void {
  // 5 장의 잎 — 사선 drift + sway + 회전. SVG path 는 공통.
  const LEAF_SVG =
    '<svg viewBox="0 0 24 24"><path d="M12 2 C16 5 19 9 19 14 C19 19 14 22 12 22 C10 22 5 19 5 14 C5 9 8 5 12 2Z"/></svg>';
  for (let i = 1; i <= 5; i++) {
    const leaf = document.createElement('span');
    leaf.className = `leaf leaf-${i}`;
    leaf.innerHTML = LEAF_SVG;
    fx.appendChild(leaf);
  }
}

function buildRipples(fx: HTMLElement): void {
  // 7 개 동심 ripple — 호수 빗물 패턴
  for (let i = 1; i <= 7; i++) {
    const r = document.createElement('span');
    r.className = `ripple ripple-${i}`;
    fx.appendChild(r);
  }
}

function buildEpicParticles(fx: HTMLElement): void {
  // 10 개 보라 입자 (떠오르는 마법 입자) + 사이즈 variant (s/m/l)
  // 인덱스별 사이즈 — preview HTML 의 spec 그대로
  const SIZES: ReadonlyArray<'s' | 'm' | 'l'> = [
    'm', 's', 'l', 'm', 's', 'm', 'l', 's', 'm', 'l',
  ];
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('span');
    p.className = `epic-particle size-${SIZES[i]} epic-p${i + 1}`;
    fx.appendChild(p);
  }
}

function buildLegendarySparkles(fx: HTMLElement): void {
  // 16 dust + 3 큰 별빛 — preview spec
  const DUST_SIZES: ReadonlyArray<'tiny' | 'med' | 'big'> = [
    'tiny', 'med', 'tiny', 'big', 'tiny', 'med', 'tiny', 'big',
    'med', 'tiny', 'med', 'tiny', 'big', 'tiny', 'med', 'tiny',
  ];
  for (let i = 0; i < 16; i++) {
    const d = document.createElement('span');
    d.className = `dust ${DUST_SIZES[i]} d${i + 1}`;
    fx.appendChild(d);
  }
  const SPARKLE_SVG =
    '<svg viewBox="0 0 24 24"><path d="M12 0 L13 11 L24 12 L13 13 L12 24 L11 13 L0 12 L11 11 Z"/></svg>';
  for (let i = 1; i <= 3; i++) {
    const s = document.createElement('span');
    s.className = `sparkle-big sparkle-big-${i}`;
    s.innerHTML = SPARKLE_SVG;
    fx.appendChild(s);
  }
}

function buildMythicLights(fx: HTMLElement): void {
  // 신화 = 어둠 + 떠오르는 작은 불씨 (대안 B 확정)
  // 21 개 leak (떠오르는 점) + 1 lava-burst (7.5초 사이클 번쩍이)
  for (let i = 1; i <= 21; i++) {
    const l = document.createElement('span');
    l.className = `leak leak-${i}`;
    fx.appendChild(l);
  }
  const burst = document.createElement('div');
  burst.className = 'lava-burst';
  fx.appendChild(burst);
}
