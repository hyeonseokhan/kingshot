/**
 * 건설 최적화 페이지 — UI 와 계산 코어(`@/lib/build-optimizer`) 를 연결.
 *
 * Phase 2-A (현재): 5 섹션 입력 폼 (공통 버프 / PM 시각 / 건축 큐 / 후보 / 가속권).
 *   recommendForCandidates 로 패턴 분류 + 큐 배정. 결과 표시는 임시 (Phase 2-B 에서 다듬음).
 * Phase 2-B: 패턴별 헤더 메시지 + 큐 배정 카드 + 색상.
 * Phase 3:    가속권 분석 (evaluateAccelerationTicket).
 */

import {
  toSeconds,
  formatTime,
  recommendForCandidates,
  type BuffSettings,
  type BuildingCandidate,
  type BuildQueue,
  type CandidateAssignment,
  type OptimizationResult,
  type RecommendationPattern,
} from '@/lib/build-optimizer';

const STORAGE_KEY = 'build-optimizer-v3';

interface SavedState {
  // 공통 버프
  baseSpeedPercent: number;
  petSpeedPercent: number;
  lawUsed: boolean;

  // 총리대신 임명 시각 — 자유 텍스트 (parseDatetime 으로 파싱)
  pmDatetimeStr: string;

  // 건축 큐 1
  queue1Status: 'empty' | 'building';
  queue1Days: number;
  queue1Hours: number;
  queue1Minutes: number;

  // 건축 큐 2
  queue2Status: 'empty' | 'building';
  queue2Days: number;
  queue2Hours: number;
  queue2Minutes: number;

  // 후보 1
  cand1Days: number;
  cand1Hours: number;
  cand1Minutes: number;

  // 후보 2
  cand2Days: number;
  cand2Hours: number;
  cand2Minutes: number;

  // 보유 가속권 (Phase 3 에서 사용)
  ticketDays: number;
  ticketHours: number;
  ticketMinutes: number;
}

const DEFAULT_STATE: SavedState = {
  baseSpeedPercent: 0,
  petSpeedPercent: 0,
  lawUsed: false,
  pmDatetimeStr: '',
  queue1Status: 'empty',
  queue1Days: 0,
  queue1Hours: 0,
  queue1Minutes: 0,
  queue2Status: 'empty',
  queue2Days: 0,
  queue2Hours: 0,
  queue2Minutes: 0,
  cand1Days: 0,
  cand1Hours: 0,
  cand1Minutes: 0,
  cand2Days: 0,
  cand2Hours: 0,
  cand2Minutes: 0,
  ticketDays: 0,
  ticketHours: 0,
  ticketMinutes: 0,
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

// ===== datetime 파싱 =====

/**
 * 사용자 자유입력 → Date. 게임 화면의 다양한 표기 그대로 받기 위해 여러 포맷 허용.
 *
 * 지원:
 *   - "2026-05-01 06:41:29" / "2026/05/01 06:41" / "2026.05.01 06:41"
 *   - "06:41:29" / "06:41"  (오늘, 지나간 시각이면 내일로 자동 보정)
 *   - 빈 문자열 → null (즉시 사용 가능)
 */
function parseDatetime(input: string, now: Date = new Date()): Date | null {
  const s = input.trim().replace(/[/.]/g, '-');
  if (!s) return null;

  // YYYY-MM-DD HH:MM[:SS]
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0);
  }
  // HH:MM[:SS] only — today, if past push to tomorrow
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1]!, +m[2]!, m[3] ? +m[3] : 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t;
  }
  return null;
}

function pmWaitSeconds(input: string): number {
  const d = parseDatetime(input);
  if (!d) return 0;
  return Math.max(0, Math.floor((d.getTime() - Date.now()) / 1000));
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

function num(el: HTMLInputElement | null): number {
  if (!el || el.value === '') return 0;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : 0;
}

function readState(): SavedState {
  const baseSpeedEl = $<HTMLInputElement>('bo-base-speed');
  const petEl = document.querySelector<HTMLInputElement>('input[name="bo-pet"]:checked');
  const lawEl = $<HTMLInputElement>('bo-law');
  const pmEl = $<HTMLInputElement>('bo-pm-datetime');

  const q1Status = (
    document.querySelector<HTMLInputElement>('input[name="bo-queue1-status"]:checked')?.value ?? 'empty'
  ) as 'empty' | 'building';
  const q2Status = (
    document.querySelector<HTMLInputElement>('input[name="bo-queue2-status"]:checked')?.value ?? 'empty'
  ) as 'empty' | 'building';

  const q1 = timeInputs('bo-queue1-time');
  const q2 = timeInputs('bo-queue2-time');
  const c1 = timeInputs('bo-cand1-time');
  const c2 = timeInputs('bo-cand2-time');
  const t = timeInputs('bo-ticket-time');

  return {
    baseSpeedPercent: num(baseSpeedEl),
    petSpeedPercent: petEl ? Number(petEl.value) : 0,
    lawUsed: !!lawEl?.checked,
    pmDatetimeStr: pmEl?.value ?? '',
    queue1Status: q1Status,
    queue1Days: num(q1.d),
    queue1Hours: num(q1.h),
    queue1Minutes: num(q1.m),
    queue2Status: q2Status,
    queue2Days: num(q2.d),
    queue2Hours: num(q2.h),
    queue2Minutes: num(q2.m),
    cand1Days: num(c1.d),
    cand1Hours: num(c1.h),
    cand1Minutes: num(c1.m),
    cand2Days: num(c2.d),
    cand2Hours: num(c2.h),
    cand2Minutes: num(c2.m),
    ticketDays: num(t.d),
    ticketHours: num(t.h),
    ticketMinutes: num(t.m),
  };
}

function setNumberInput(el: HTMLInputElement, v: number): void {
  el.value = v ? String(v) : '';
}

function writeState(s: SavedState): void {
  setNumberInput($<HTMLInputElement>('bo-base-speed'), s.baseSpeedPercent);
  document.querySelectorAll<HTMLInputElement>('input[name="bo-pet"]').forEach((r) => {
    r.checked = Number(r.value) === s.petSpeedPercent;
  });
  $<HTMLInputElement>('bo-law').checked = s.lawUsed;
  $<HTMLInputElement>('bo-pm-datetime').value = s.pmDatetimeStr;

  document.querySelectorAll<HTMLInputElement>('input[name="bo-queue1-status"]').forEach((r) => {
    r.checked = r.value === s.queue1Status;
  });
  document.querySelectorAll<HTMLInputElement>('input[name="bo-queue2-status"]').forEach((r) => {
    r.checked = r.value === s.queue2Status;
  });

  const q1 = timeInputs('bo-queue1-time');
  setNumberInput(q1.d, s.queue1Days);
  setNumberInput(q1.h, s.queue1Hours);
  setNumberInput(q1.m, s.queue1Minutes);

  const q2 = timeInputs('bo-queue2-time');
  setNumberInput(q2.d, s.queue2Days);
  setNumberInput(q2.h, s.queue2Hours);
  setNumberInput(q2.m, s.queue2Minutes);

  const c1 = timeInputs('bo-cand1-time');
  setNumberInput(c1.d, s.cand1Days);
  setNumberInput(c1.h, s.cand1Hours);
  setNumberInput(c1.m, s.cand1Minutes);

  const c2 = timeInputs('bo-cand2-time');
  setNumberInput(c2.d, s.cand2Days);
  setNumberInput(c2.h, s.cand2Hours);
  setNumberInput(c2.m, s.cand2Minutes);

  const t = timeInputs('bo-ticket-time');
  setNumberInput(t.d, s.ticketDays);
  setNumberInput(t.h, s.ticketHours);
  setNumberInput(t.m, s.ticketMinutes);

  syncQueueTimeEnabled();
}

// 큐 status='empty' 면 시간 입력 비활성화 — UX 명확성 + 잘못된 입력 차단
function syncQueueTimeEnabled(): void {
  for (const qid of ['queue1', 'queue2'] as const) {
    const status = document.querySelector<HTMLInputElement>(
      `input[name="bo-${qid}-status"]:checked`,
    )?.value;
    const timeRow = document.querySelector<HTMLElement>(`[data-time-input="bo-${qid}-time"]`);
    if (!timeRow) continue;
    const disabled = status === 'empty';
    timeRow.classList.toggle('bo-time-row-disabled', disabled);
    timeRow.querySelectorAll<HTMLInputElement>('input').forEach((i) => {
      i.disabled = disabled;
    });
  }
}

// ===== 분석 + 결과 출력 =====

function buildBuffs(state: SavedState): BuffSettings {
  const ticketSec =
    state.ticketDays * 86400 + state.ticketHours * 3600 + state.ticketMinutes * 60;
  return {
    baseSpeedPercent: state.baseSpeedPercent,
    petSpeedPercent: state.petSpeedPercent,
    primeMinisterSpeedPercent: 10,
    lawReductionPercent: state.lawUsed ? 20 : 0,
    primeMinisterWaitSeconds: pmWaitSeconds(state.pmDatetimeStr),
    accelerationTicketSeconds: ticketSec,
  };
}

function buildQueues(state: SavedState): [BuildQueue, BuildQueue] {
  return [
    {
      id: 'queue1',
      status: state.queue1Status,
      remainingSeconds:
        state.queue1Status === 'building'
          ? toSeconds({
              days: state.queue1Days,
              hours: state.queue1Hours,
              minutes: state.queue1Minutes,
              seconds: 0,
            })
          : 0,
    },
    {
      id: 'queue2',
      status: state.queue2Status,
      remainingSeconds:
        state.queue2Status === 'building'
          ? toSeconds({
              days: state.queue2Days,
              hours: state.queue2Hours,
              minutes: state.queue2Minutes,
              seconds: 0,
            })
          : 0,
    },
  ];
}

function buildCandidates(state: SavedState): BuildingCandidate[] {
  const c1Sec = toSeconds({
    days: state.cand1Days,
    hours: state.cand1Hours,
    minutes: state.cand1Minutes,
    seconds: 0,
  });
  const c2Sec = toSeconds({
    days: state.cand2Days,
    hours: state.cand2Hours,
    minutes: state.cand2Minutes,
    seconds: 0,
  });
  const list: BuildingCandidate[] = [];
  if (c1Sec > 0) list.push({ id: 'cand1', name: '후보 1', baseSeconds: c1Sec });
  if (c2Sec > 0) list.push({ id: 'cand2', name: '후보 2', baseSeconds: c2Sec });
  return list;
}

function calculate(): void {
  const state = readState();
  saveState(state);

  const candidates = buildCandidates(state);
  if (candidates.length === 0) {
    showResult('<p class="bo-result-error">후보 1 또는 후보 2 의 건축 시간을 입력하세요.</p>');
    return;
  }

  const queues = buildQueues(state);
  const buffs = buildBuffs(state);
  const result = recommendForCandidates(candidates, queues, buffs);

  showResult(renderResult(result, buffs));
}

// Phase 2-A 임시 결과 표시 — Phase 2-B 에서 패턴별 헤더 / 색상 / 카드 형태로 다듬음.
function renderResult(r: OptimizationResult, buffs: BuffSettings): string {
  const patternLabel: Record<RecommendationPattern, string> = {
    A: '패턴 A — 큐 진행 중 + 후보 2개',
    B: '패턴 B — 긴 건물 단독, PM 대기가 손익분기보다 짧음',
    C: '패턴 C — 짧은 건물, PM 대기가 손익분기보다 김',
    D: '패턴 D — 큐 둘 다 비어 + 후보 2개',
    single: '단일 (PM 미설정 또는 단순 케이스)',
  };

  const header = `<div class="bo-result-row bo-result-recommend">${patternLabel[r.pattern]}</div>`;
  const pmLine =
    buffs.primeMinisterWaitSeconds > 0
      ? `<div class="bo-result-row">총리대신 대기: <strong>${formatTime(buffs.primeMinisterWaitSeconds)}</strong></div>`
      : `<div class="bo-result-row">총리대신: <strong>즉시 사용 가능</strong></div>`;

  const blocks = r.assignments.map((a) => renderAssignment(a)).join('<hr class="bo-result-divider" />');

  const note =
    '<p class="bo-result-note">법령과 펫은 사용 후 5분 이내에 건축을 시작해야 적용됩니다.</p>';
  return header + pmLine + blocks + note;
}

function renderAssignment(a: CandidateAssignment): string {
  const queueLabel = a.assignedQueueId === 'queue1' ? '큐 1' : '큐 2';
  const strategy =
    a.chosenStrategy === 'wait-pm'
      ? '<strong class="bo-tag-positive">총리대신 대기 후 시작</strong>'
      : '<strong class="bo-tag-neutral">즉시 시작</strong>';
  const gain =
    a.netGainSeconds > 0
      ? `예상 이득 <strong>${formatTime(Math.abs(a.netGainSeconds))}</strong>`
      : a.netGainSeconds < 0
        ? `즉시가 <strong>${formatTime(Math.abs(a.netGainSeconds))}</strong> 이득`
        : '동률 — 어느 쪽이든 결과 같음';

  return `
    <div class="bo-result-row bo-result-recommend">
      ${a.candidate.name ?? a.candidate.id} → ${queueLabel}: ${strategy}
    </div>
    <div class="bo-result-row">${gain}</div>
    <div class="bo-result-detail">
      <div><span>큐 빔 시각 (현재 기준)</span><strong>${formatTime(a.queueFreeSeconds)}</strong></div>
      <div><span>즉시 전략 — 총 소요</span><strong>${formatTime(a.immediateTotalSeconds)}</strong></div>
      <div><span>총리대신 전략 — 총 소요</span><strong>${formatTime(a.withPmTotalSeconds)}</strong></div>
      <div><span>손익분기 대기 시간</span><strong>${formatTime(a.breakEvenWaitSeconds)}</strong></div>
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

  // 입력 변동 → 자동 저장
  document
    .querySelectorAll<HTMLInputElement>(
      'input[type="number"], input[type="text"], input[type="checkbox"], input[type="radio"]',
    )
    .forEach((el) => {
      el.addEventListener('change', () => {
        saveState(readState());
        syncQueueTimeEnabled();
      });
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
