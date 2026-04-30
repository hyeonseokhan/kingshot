/**
 * 건설 최적화 페이지 — UI 와 계산 코어(`@/lib/build-optimizer`) 를 연결.
 *
 * PR 2 (현재): 단일 건물 입력 + 즉시 vs 총리대신 대기 비교 결과 출력. localStorage 자동 저장.
 * PR 3: 결과 카드 다듬기 + 상세 계산 펼치기.
 * PR 4: 다중 건물 + 가속권 + 큐 상태.
 */

import {
  toSeconds,
  formatTime,
  analyzeBuilding,
  type BuffSettings,
  type BuildingCandidate,
} from '@/lib/build-optimizer';

const STORAGE_KEY = 'build-optimizer-v1';

interface SavedState {
  baseSpeedPercent: number;
  petSpeedPercent: number;
  lawUsed: boolean;
  pmWaitDays: number;
  pmWaitHours: number;
  pmWaitMinutes: number;
  bldgName: string;
  bldgDays: number;
  bldgHours: number;
  bldgMinutes: number;
}

const DEFAULT_STATE: SavedState = {
  baseSpeedPercent: 0,
  petSpeedPercent: 0,
  lawUsed: false,
  pmWaitDays: 0,
  pmWaitHours: 0,
  pmWaitMinutes: 0,
  bldgName: '',
  bldgDays: 0,
  bldgHours: 0,
  bldgMinutes: 0,
};

// ===== DOM helpers =====

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('#' + id + ' not found');
  return el as T;
}

function timeInputs(prefix: string): {
  d: HTMLInputElement;
  h: HTMLInputElement;
  m: HTMLInputElement;
} {
  const wrap = document.querySelector<HTMLElement>(`[data-time-input="${prefix}"]`);
  if (!wrap) throw new Error('time input not found: ' + prefix);
  return {
    d: wrap.querySelector<HTMLInputElement>('input[data-unit="d"]')!,
    h: wrap.querySelector<HTMLInputElement>('input[data-unit="h"]')!,
    m: wrap.querySelector<HTMLInputElement>('input[data-unit="m"]')!,
  };
}

// ===== state load/save =====

function loadState(): SavedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<SavedState>) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(s: SavedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* quota / disabled */
  }
}

// ===== state ↔ DOM =====

function readState(): SavedState {
  const baseSpeedEl = $<HTMLInputElement>('bo-base-speed');
  const petEl = document.querySelector<HTMLInputElement>(
    'input[name="bo-pet"]:checked',
  );
  const lawEl = $<HTMLInputElement>('bo-law');
  const pm = timeInputs('bo-pm-wait');
  const bldgNameEl = $<HTMLInputElement>('bo-bldg-name');
  const bldg = timeInputs('bo-bldg-time');

  const num = (el: HTMLInputElement | null): number => {
    if (!el || el.value === '') return 0;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    baseSpeedPercent: num(baseSpeedEl),
    petSpeedPercent: petEl ? Number(petEl.value) : 0,
    lawUsed: !!lawEl?.checked,
    pmWaitDays: num(pm.d),
    pmWaitHours: num(pm.h),
    pmWaitMinutes: num(pm.m),
    bldgName: bldgNameEl?.value ?? '',
    bldgDays: num(bldg.d),
    bldgHours: num(bldg.h),
    bldgMinutes: num(bldg.m),
  };
}

function writeState(s: SavedState): void {
  $<HTMLInputElement>('bo-base-speed').value = s.baseSpeedPercent
    ? String(s.baseSpeedPercent)
    : '';

  // 펫 — radio 중 매칭되는 value 만 checked
  document.querySelectorAll<HTMLInputElement>('input[name="bo-pet"]').forEach((r) => {
    r.checked = Number(r.value) === s.petSpeedPercent;
  });

  $<HTMLInputElement>('bo-law').checked = s.lawUsed;

  const pm = timeInputs('bo-pm-wait');
  pm.d.value = s.pmWaitDays ? String(s.pmWaitDays) : '';
  pm.h.value = s.pmWaitHours ? String(s.pmWaitHours) : '';
  pm.m.value = s.pmWaitMinutes ? String(s.pmWaitMinutes) : '';

  $<HTMLInputElement>('bo-bldg-name').value = s.bldgName;

  const bldg = timeInputs('bo-bldg-time');
  bldg.d.value = s.bldgDays ? String(s.bldgDays) : '';
  bldg.h.value = s.bldgHours ? String(s.bldgHours) : '';
  bldg.m.value = s.bldgMinutes ? String(s.bldgMinutes) : '';
}

// ===== 계산 + 결과 출력 =====

function calculate(): void {
  const state = readState();
  saveState(state);

  const baseSeconds = toSeconds({
    days: state.bldgDays,
    hours: state.bldgHours,
    minutes: state.bldgMinutes,
    seconds: 0,
  });

  if (baseSeconds <= 0) {
    showResult('<p class="bo-result-error">건축 시간을 입력하세요.</p>');
    return;
  }

  const building: BuildingCandidate = {
    id: 'bldg',
    name: state.bldgName || '건물',
    baseSeconds,
  };
  const buffs: BuffSettings = {
    baseSpeedPercent: state.baseSpeedPercent,
    petSpeedPercent: state.petSpeedPercent,
    primeMinisterSpeedPercent: 10, // 총리대신 사용 시 항상 10%
    lawReductionPercent: state.lawUsed ? 20 : 0,
    primeMinisterWaitSeconds: toSeconds({
      days: state.pmWaitDays,
      hours: state.pmWaitHours,
      minutes: state.pmWaitMinutes,
      seconds: 0,
    }),
    accelerationTicketSeconds: 0,
  };

  const a = analyzeBuilding(building, buffs);
  const name = building.name ?? '건물';

  const recommendLine = a.shouldWaitForPrimeMinister
    ? `<strong class="bo-tag-positive">기다리세요 (총리대신 후 시작)</strong>`
    : `<strong class="bo-tag-neutral">지금 바로 시작하세요</strong>`;

  const gainLine = a.shouldWaitForPrimeMinister
    ? `예상 이득 <strong>${formatTime(Math.abs(a.netGainSeconds))}</strong>`
    : a.netGainSeconds === 0
      ? '동률 — 어느 쪽이든 결과 같음'
      : `즉시 시작이 <strong>${formatTime(Math.abs(a.netGainSeconds))}</strong> 이득`;

  const html = `
    <div class="bo-result-row bo-result-recommend">${name}: ${recommendLine}</div>
    <div class="bo-result-row">${gainLine}</div>
    <hr class="bo-result-divider" />
    <div class="bo-result-detail">
      <div><span>즉시 시작 시 건축 시간</span><strong>${formatTime(a.immediateBuildSeconds)}</strong></div>
      <div><span>총리대신 적용 시 건축 시간</span><strong>${formatTime(a.withPrimeMinisterBuildSeconds)}</strong></div>
      <div><span>손익분기 대기 시간</span><strong>${formatTime(a.breakEvenWaitSeconds)}</strong></div>
      <div><span>현재 총리대신 대기 시간</span><strong>${formatTime(a.actualWaitSeconds)}</strong></div>
    </div>
    <p class="bo-result-note">법령과 펫은 사용 후 5분 이내에 건축을 시작해야 적용됩니다.</p>
  `;

  showResult(html);
}

function showResult(html: string): void {
  const wrap = $('bo-result');
  const card = $('bo-result-card');
  card.innerHTML = html;
  wrap.hidden = false;
  // 모바일에서 결과 영역으로 스크롤
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===== 진입 =====

export function initBuildOptimizer(): void {
  // 저장된 입력값 복원
  writeState(loadState());

  // 입력 변경 시 자동 저장 (debounce 없음 — localStorage write 는 가벼움)
  document
    .querySelectorAll<HTMLInputElement>(
      'input[type="number"], input[type="text"], input[type="checkbox"], input[type="radio"]',
    )
    .forEach((el) => {
      el.addEventListener('change', () => saveState(readState()));
    });

  $('bo-calc').addEventListener('click', calculate);

  // Enter 키로 계산하기
  document.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        calculate();
      }
    });
  });
}
