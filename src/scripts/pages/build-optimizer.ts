/**
 * 건설 최적화 페이지 — UI 와 계산 코어(`@/lib/build-optimizer`) 를 연결.
 *
 * PR 2 (현재): 큐 2개 입력 + 각 큐 독립 분석. 총리대신은 임명 예정 시각(HH:MM) 으로 입력.
 * PR 3: 결과 카드 다듬기 (펼치기/색상 강조).
 * PR 4: 큐 간 상호작용(같은 5분 윈도우 공유 등) + 가속권 분석.
 */

import {
  toSeconds,
  formatTime,
  analyzeBuilding,
  type BuffSettings,
  type BuildingAnalysis,
  type BuildingCandidate,
} from '@/lib/build-optimizer';

const STORAGE_KEY = 'build-optimizer-v2';

interface SavedState {
  baseSpeedPercent: number;
  petSpeedPercent: number;
  lawUsed: boolean;
  /** 총리대신 임명 예정 시각 (HH:MM, 24h). 빈 문자열이면 즉시 사용 가능. */
  pmTimeStr: string;
  bldg1Days: number;
  bldg1Hours: number;
  bldg1Minutes: number;
  bldg2Days: number;
  bldg2Hours: number;
  bldg2Minutes: number;
}

const DEFAULT_STATE: SavedState = {
  baseSpeedPercent: 0,
  petSpeedPercent: 0,
  lawUsed: false,
  pmTimeStr: '',
  bldg1Days: 0,
  bldg1Hours: 0,
  bldg1Minutes: 0,
  bldg2Days: 0,
  bldg2Hours: 0,
  bldg2Minutes: 0,
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

// ===== 시각 → 대기 초 =====

/**
 * "HH:MM" → 현재 시각으로부터 그 시각까지의 대기 초.
 * 입력 시각이 현재보다 과거면 내일의 같은 시각으로 자동 해석.
 * 빈 문자열이면 0 (즉시).
 */
function pmWaitSecondsFromTime(timeStr: string): number {
  if (!timeStr) return 0;
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!m) return 0;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return Math.floor((target.getTime() - now.getTime()) / 1000);
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
  const num = (el: HTMLInputElement | null): number => {
    if (!el || el.value === '') return 0;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : 0;
  };

  const baseSpeedEl = $<HTMLInputElement>('bo-base-speed');
  const petEl = document.querySelector<HTMLInputElement>(
    'input[name="bo-pet"]:checked',
  );
  const lawEl = $<HTMLInputElement>('bo-law');
  const pmTimeEl = $<HTMLInputElement>('bo-pm-time');
  const b1 = timeInputs('bo-bldg1-time');
  const b2 = timeInputs('bo-bldg2-time');

  return {
    baseSpeedPercent: num(baseSpeedEl),
    petSpeedPercent: petEl ? Number(petEl.value) : 0,
    lawUsed: !!lawEl?.checked,
    pmTimeStr: pmTimeEl?.value ?? '',
    bldg1Days: num(b1.d),
    bldg1Hours: num(b1.h),
    bldg1Minutes: num(b1.m),
    bldg2Days: num(b2.d),
    bldg2Hours: num(b2.h),
    bldg2Minutes: num(b2.m),
  };
}

function writeState(s: SavedState): void {
  $<HTMLInputElement>('bo-base-speed').value = s.baseSpeedPercent
    ? String(s.baseSpeedPercent)
    : '';

  document.querySelectorAll<HTMLInputElement>('input[name="bo-pet"]').forEach((r) => {
    r.checked = Number(r.value) === s.petSpeedPercent;
  });

  $<HTMLInputElement>('bo-law').checked = s.lawUsed;
  $<HTMLInputElement>('bo-pm-time').value = s.pmTimeStr;

  const b1 = timeInputs('bo-bldg1-time');
  b1.d.value = s.bldg1Days ? String(s.bldg1Days) : '';
  b1.h.value = s.bldg1Hours ? String(s.bldg1Hours) : '';
  b1.m.value = s.bldg1Minutes ? String(s.bldg1Minutes) : '';

  const b2 = timeInputs('bo-bldg2-time');
  b2.d.value = s.bldg2Days ? String(s.bldg2Days) : '';
  b2.h.value = s.bldg2Hours ? String(s.bldg2Hours) : '';
  b2.m.value = s.bldg2Minutes ? String(s.bldg2Minutes) : '';
}

// ===== 분석 + 결과 출력 =====

function buildBuffs(state: SavedState): BuffSettings {
  return {
    baseSpeedPercent: state.baseSpeedPercent,
    petSpeedPercent: state.petSpeedPercent,
    primeMinisterSpeedPercent: 10, // 총리대신 적용 시 항상 10%
    lawReductionPercent: state.lawUsed ? 20 : 0,
    primeMinisterWaitSeconds: pmWaitSecondsFromTime(state.pmTimeStr),
    accelerationTicketSeconds: 0,
  };
}

function calculate(): void {
  const state = readState();
  saveState(state);

  const candidates: BuildingCandidate[] = [];
  const q1Sec = toSeconds({
    days: state.bldg1Days,
    hours: state.bldg1Hours,
    minutes: state.bldg1Minutes,
    seconds: 0,
  });
  if (q1Sec > 0) candidates.push({ id: 'q1', name: '큐 1', baseSeconds: q1Sec });

  const q2Sec = toSeconds({
    days: state.bldg2Days,
    hours: state.bldg2Hours,
    minutes: state.bldg2Minutes,
    seconds: 0,
  });
  if (q2Sec > 0) candidates.push({ id: 'q2', name: '큐 2', baseSeconds: q2Sec });

  if (candidates.length === 0) {
    showResult('<p class="bo-result-error">큐 1 또는 큐 2 의 건축 시간을 입력하세요.</p>');
    return;
  }

  const buffs = buildBuffs(state);
  const html = candidates
    .map((b) => renderBuildingResult(b, analyzeBuilding(b, buffs)))
    .join('<hr class="bo-result-divider" />');

  showResult(html + '<p class="bo-result-note">법령과 펫은 사용 후 5분 이내에 건축을 시작해야 적용됩니다.</p>');
}

function renderBuildingResult(b: BuildingCandidate, a: BuildingAnalysis): string {
  // 추천/이득 메시지 — 3가지 케이스
  // 1) 총리대신 즉시 사용 가능 (actualWait=0): 지금 모든 버프 적용해서 시작
  // 2) 대기 시간 < 손익분기: 기다림이 이득
  // 3) 대기 시간 >= 손익분기: 즉시 시작이 이득
  let recommendLine: string;
  let gainLine: string;

  if (a.actualWaitSeconds === 0) {
    recommendLine = `<strong class="bo-tag-positive">지금 바로 시작하세요 (모든 버프 적용)</strong>`;
    gainLine = `총리대신 + 법령 + 펫 적용으로 <strong>${formatTime(a.breakEvenWaitSeconds)}</strong> 단축됨`;
  } else if (a.shouldWaitForPrimeMinister) {
    recommendLine = `<strong class="bo-tag-positive">기다리세요 (총리대신 후 시작)</strong>`;
    gainLine = `예상 이득 <strong>${formatTime(Math.abs(a.netGainSeconds))}</strong>`;
  } else if (a.netGainSeconds === 0) {
    recommendLine = `<strong class="bo-tag-neutral">지금 바로 시작하세요</strong>`;
    gainLine = '동률 — 어느 쪽이든 결과 같음';
  } else {
    recommendLine = `<strong class="bo-tag-neutral">지금 바로 시작하세요</strong>`;
    gainLine = `즉시 시작이 <strong>${formatTime(Math.abs(a.netGainSeconds))}</strong> 이득`;
  }

  return `
    <div class="bo-result-row bo-result-recommend">
      ${b.name} <span class="bo-result-baseTime">(${formatTime(b.baseSeconds)})</span>: ${recommendLine}
    </div>
    <div class="bo-result-row">${gainLine}</div>
    <div class="bo-result-detail">
      <div><span>즉시 시작 시 건축 시간</span><strong>${formatTime(a.immediateBuildSeconds)}</strong></div>
      <div><span>총리대신 적용 시 건축 시간</span><strong>${formatTime(a.withPrimeMinisterBuildSeconds)}</strong></div>
      <div><span>손익분기 대기 시간</span><strong>${formatTime(a.breakEvenWaitSeconds)}</strong></div>
      <div><span>현재 총리대신 대기 시간</span><strong>${formatTime(a.actualWaitSeconds)}</strong></div>
    </div>
  `;
}

function showResult(html: string): void {
  const wrap = $('bo-result');
  const card = $('bo-result-card');
  card.innerHTML = html;
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===== 진입 =====

export function initBuildOptimizer(): void {
  writeState(loadState());

  document
    .querySelectorAll<HTMLInputElement>(
      'input[type="number"], input[type="text"], input[type="time"], input[type="checkbox"], input[type="radio"]',
    )
    .forEach((el) => {
      el.addEventListener('change', () => saveState(readState()));
    });

  $('bo-calc').addEventListener('click', calculate);

  document.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        calculate();
      }
    });
  });
}
