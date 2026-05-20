/**
 * KvK 계산기 — 입력 → 즉시 재계산 → DOM 갱신.
 *
 * 모든 입력은 [data-kvk-number] 마커로 천단위 쉼표 자동 포맷.
 * 결과 카드 3종: 병사 훈련 / 건물 30T / 30T 가능여부 + 상수 참고 카드.
 * 영속화: 입력값을 localStorage 에 자동 저장 (debounce 200ms).
 */

import {
  calculate,
  formatDhm,
  formatDhmEn,
  KVK_CONSTANTS,
  type KvkInputs,
  type KvkResults,
} from '@/lib/kvk-calculator';
import { onLangChange, t, getLang } from '@/i18n';

/** 언어에 맞는 D/H/M 포맷. */
function dhm(min: number): string {
  return getLang() === 'ko' ? formatDhm(min) : formatDhmEn(min);
}

const STORAGE_KEY = 'pnx-kvk-calc-v1';

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

function parseNumber(raw: FormDataEntryValue | null): number {
  if (raw == null) return 0;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits === '') return 0;
  return Number(digits);
}

/** datetime-local 값 (KST 가정) → ISO 8601 with +09:00. */
function toKstIso(local: string): string {
  if (!local) return KVK_CONSTANTS.refTime;
  return local.length === 16 ? `${local}:00+09:00` : `${local}+09:00`;
}

/** 입력 필드 천단위 쉼표 즉시 적용. 캐럿 위치 보존. */
function formatNumberInput(el: HTMLInputElement): void {
  const oldValue = el.value;
  const oldCaret = el.selectionStart ?? oldValue.length;
  const digitsBefore = oldValue.slice(0, oldCaret).replace(/[^\d]/g, '').length;

  const raw = oldValue.replace(/[^\d]/g, '');
  const next = raw === '' ? '' : Number(raw).toLocaleString('ko-KR');
  if (next === oldValue) return;
  el.value = next;

  let newCaret = next.length;
  if (digitsBefore === 0) {
    newCaret = 0;
  } else {
    let count = 0;
    for (let i = 0; i < next.length; i++) {
      if (/\d/.test(next[i])) {
        count++;
        if (count === digitsBefore) {
          newCaret = i + 1;
          break;
        }
      }
    }
  }
  try {
    el.setSelectionRange(newCaret, newCaret);
  } catch {
    /* */
  }
}

/** 표시 입력값(snapshot) + 측정 시각 → 현재 실시간 잔여(분). 음수 elapsed 는 clamp. */
function computeEmbassyCurrentMin(fd: FormData): number {
  const snapshot = parseNumber(fd.get('embassyRemaining'));
  const measuredAt = String(fd.get('embassyMeasuredAt') ?? '');
  const measuredMs = Date.parse(measuredAt);
  if (!Number.isFinite(measuredMs)) return snapshot;
  const elapsedMin = Math.max(0, (Date.now() - measuredMs) / 60000);
  return Math.max(0, Math.round(snapshot - elapsedMin));
}

function readForm(form: HTMLFormElement): KvkInputs {
  const fd = new FormData(form);
  return {
    troops: {
      infantry: parseNumber(fd.get('infantry')),
      cavalry: parseNumber(fd.get('cavalry')),
      archers: parseNumber(fd.get('archers')),
    },
    accel: {
      common: parseNumber(fd.get('accelCommon')),
      training: parseNumber(fd.get('accelTraining')),
      building: parseNumber(fd.get('accelBuilding')),
    },
    embassyRemaining: computeEmbassyCurrentMin(fd),
    deadline: toKstIso(String(fd.get('deadline') ?? '')),
    bonus: {
      h3: parseNumber(fd.get('bonusH3')),
      h1: parseNumber(fd.get('bonusH1')),
      m5: parseNumber(fd.get('bonusM5')),
      m1: parseNumber(fd.get('bonusM1')),
    },
  };
}

interface StoredInputs {
  fields: Record<string, string>;
}

function saveState(form: HTMLFormElement): void {
  const fields: Record<string, string> = {};
  form.querySelectorAll<HTMLInputElement>('input[name]').forEach((el) => {
    fields[el.name] = el.value;
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fields }));
  } catch {
    /* */
  }
}

function loadState(form: HTMLFormElement): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as StoredInputs;
    if (!obj?.fields) return;
    Object.entries(obj.fields).forEach(([name, value]) => {
      const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (el) el.value = value;
    });
  } catch {
    /* */
  }
}

// ===== 렌더 =====

let lastResults: KvkResults | null = null;

function renderDhmHints(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLElement>('[data-dhm-for]').forEach((el) => {
    const name = el.dataset.dhmFor!;
    const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) return;
    const min = parseNumber(input.value);
    el.textContent = min > 0 ? `ㄴ ${dhm(min)}` : '';
  });
}

function setRows(tbodyId: string, rowsHtml: string): void {
  const tbody = $(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = rowsHtml;
}

const BUILD_KEY_LABEL: Record<string, { ko: string; en: string }> = {
  embassy28to29: { ko: '대사관 28→29 (잔여)', en: 'Embassy 28→29 (remaining)' },
  archery28to29: { ko: '궁병대 28→29', en: 'Archer 28→29' },
  tc29to30: { ko: '도시센터 29→30', en: 'TC 29→30' },
  infantry29to30: { ko: '보병대 29→30', en: 'Infantry 29→30' },
  archery29to30: { ko: '궁병대 29→30', en: 'Archer 29→30' },
};

function buildLabel(key: string): string {
  const lang = getLang();
  return (BUILD_KEY_LABEL[key] ?? { ko: key, en: key })[lang];
}

function renderTraining(r: KvkResults['training']): void {
  const lang = getLang();
  const labels = {
    targetInf: t('gameTools.kvkCalculator.mTargetInf'),
    targetCav: t('gameTools.kvkCalculator.mTargetCav'),
    targetArc: t('gameTools.kvkCalculator.mTargetArc'),
    extra: t('gameTools.kvkCalculator.mExtraTroops'),
    days: t('gameTools.kvkCalculator.mTrainDays'),
    min: t('gameTools.kvkCalculator.mTrainMin'),
  };
  const trainingLabel = t('gameTools.kvkCalculator.accelTraining');
  const commonLabel = t('gameTools.kvkCalculator.accelCommon');

  const daysText = (r.neededMinutes / 1440).toFixed(2) + (lang === 'ko' ? '일' : 'd');

  setRows(
    'kvk-training-target',
    `
    <tr><th>${labels.targetInf}</th><td>${fmt(r.targetInfantry)} <span class="kvk-extra">(+${fmt(r.extraInfantry)})</span></td></tr>
    <tr><th>${labels.targetCav}</th><td>${fmt(r.targetCavalry)}</td></tr>
    <tr><th>${labels.targetArc}</th><td>${fmt(r.targetArchers)} <span class="kvk-extra">(+${fmt(r.extraArchers)})</span></td></tr>
    <tr><th>${labels.extra}</th><td><strong>${fmt(r.totalExtra)}</strong></td></tr>
    <tr><th>${labels.days}</th><td>${daysText}</td></tr>
    <tr><th>${labels.min}</th><td>${fmt(r.neededMinutes)} <span class="kvk-extra">(${dhm(r.neededMinutes)})</span></td></tr>
  `,
  );

  const haveTraining = lastInputs?.accel.training ?? 0;
  const haveCommon = lastInputs?.accel.common ?? 0;
  setRows(
    'kvk-training-accel',
    `
    <tr>
      <th>${trainingLabel}</th>
      <td>${dhm(haveTraining)}</td>
      <td>${dhm(r.used.training)}</td>
      <td>${dhm(r.remaining.training)}</td>
    </tr>
    <tr>
      <th>${commonLabel}</th>
      <td>${dhm(haveCommon)}</td>
      <td>${dhm(r.used.common)}</td>
      <td>${dhm(r.remaining.common)}</td>
    </tr>
  `,
  );
}

function renderBuilding(r: KvkResults['building']): void {
  const rows = r.breakdown
    .map((b) => `<tr><th>${buildLabel(b.key)}</th><td>${fmt(b.minutes)} <span class="kvk-extra">(${dhm(b.minutes)})</span></td></tr>`)
    .join('');
  const totalLabel = t('gameTools.kvkCalculator.bTotalWork');
  setRows(
    'kvk-building-rows',
    `${rows}
    <tr class="kvk-row-total"><th>${totalLabel}</th><td><strong>${fmt(r.totalMinutes)}</strong> <span class="kvk-extra">(${dhm(r.totalMinutes)})</span></td></tr>`,
  );
}

function renderFeasibility(r: KvkResults['feasibility']): void {
  const lang = getLang();
  const fmtIso = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // KST 표기 — toLocaleString 'Asia/Seoul'
    return d.toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  const labels = {
    deadline: t('gameTools.kvkCalculator.fDeadline'),
    refTime: t('gameTools.kvkCalculator.fRefTime'),
    realtime: t('gameTools.kvkCalculator.fRealtime'),
    bonus: t('gameTools.kvkCalculator.fBonusGain'),
    needed: t('gameTools.kvkCalculator.fNeeded'),
    available: t('gameTools.kvkCalculator.fAvailable'),
    shortage: t(r.shortage > 0 ? 'gameTools.kvkCalculator.fShortage' : 'gameTools.kvkCalculator.fShortageOk'),
  };

  const shortageVal = Math.abs(r.shortage);
  const shortageClass = r.shortage > 0 ? 'kvk-shortage-bad' : 'kvk-shortage-ok';

  setRows(
    'kvk-feasibility-rows',
    `
    <tr><th>${labels.refTime}</th><td>${fmtIso(r.refTime)}</td></tr>
    <tr><th>${labels.deadline}</th><td>${fmtIso(r.deadline)}</td></tr>
    <tr><th>${labels.realtime}</th><td>${dhm(r.realtimeAvailableMin)}</td></tr>
    <tr><th>${labels.bonus}</th><td>${fmt(r.bonusGainMin)} <span class="kvk-extra">(${dhm(r.bonusGainMin)})</span></td></tr>
    <tr><th>${labels.needed}</th><td>${fmt(r.needed)} <span class="kvk-extra">(${dhm(r.needed)})</span></td></tr>
    <tr><th>${labels.available}</th><td>${fmt(r.available)} <span class="kvk-extra">(${dhm(r.available)})</span></td></tr>
    <tr class="${shortageClass}"><th>${labels.shortage}</th><td><strong>${fmt(shortageVal)}</strong> <span class="kvk-extra">(${dhm(shortageVal)})</span></td></tr>
  `,
  );
}

function renderConstants(): void {
  const c = KVK_CONSTANTS;
  const labels = {
    trainingSpeed: t('gameTools.kvkCalculator.constTrainingSpeed'),
    buildSpeed: t('gameTools.kvkCalculator.constBuildSpeed'),
    refTime: t('gameTools.kvkCalculator.constRefTime'),
    tier: t('gameTools.kvkCalculator.constTier'),
    daily: t('gameTools.kvkCalculator.constDailyTroops'),
    ratio: t('gameTools.kvkCalculator.constRatio'),
    arch28: t('gameTools.kvkCalculator.constArcheryUp'),
    tcUp: t('gameTools.kvkCalculator.constTcUp'),
    infUp: t('gameTools.kvkCalculator.constInfantryUp'),
    arch29: t('gameTools.kvkCalculator.constArcheryUp2'),
  };
  setRows(
    'kvk-constants-rows',
    `
    <tr><th>${labels.trainingSpeed}</th><td>${c.trainingSpeedPct}%</td></tr>
    <tr><th>${labels.buildSpeed}</th><td>${c.buildTimeFactor}</td></tr>
    <tr><th>${labels.refTime}</th><td>${c.refTime}</td></tr>
    <tr><th>${labels.tier}</th><td>T${c.tier}</td></tr>
    <tr><th>${labels.daily}</th><td>${c.troopsPerDay}</td></tr>
    <tr><th>${labels.ratio}</th><td>${c.ratio.infantry}:${c.ratio.cavalry}:${c.ratio.archers}</td></tr>
    <tr><th>${labels.arch28}</th><td>${fmt(c.buildMinutes.archery28to29)} <span class="kvk-extra">(${dhm(c.buildMinutes.archery28to29)})</span></td></tr>
    <tr><th>${labels.tcUp}</th><td>${fmt(c.buildMinutes.tc29to30)} <span class="kvk-extra">(${dhm(c.buildMinutes.tc29to30)})</span></td></tr>
    <tr><th>${labels.infUp}</th><td>${fmt(c.buildMinutes.infantry29to30)} <span class="kvk-extra">(${dhm(c.buildMinutes.infantry29to30)})</span></td></tr>
    <tr><th>${labels.arch29}</th><td>${fmt(c.buildMinutes.archery29to30)} <span class="kvk-extra">(${dhm(c.buildMinutes.archery29to30)})</span></td></tr>
  `,
  );
}

let lastInputs: KvkInputs | null = null;

/** 대사관 hidden input → #kvk-embassy-display span 을 실시간 잔여값으로 갱신. */
function syncEmbassyDisplay(form: HTMLFormElement): void {
  const snapshotEl = form.querySelector<HTMLInputElement>('input[name="embassyRemaining"]');
  const measuredEl = form.querySelector<HTMLInputElement>('input[name="embassyMeasuredAt"]');
  const displayEl = document.getElementById('kvk-embassy-display');
  if (!snapshotEl || !measuredEl) return;

  const snapshot = parseNumber(snapshotEl.value);
  const measuredMs = Date.parse(measuredEl.value);
  if (!Number.isFinite(measuredMs)) {
    measuredEl.value = new Date().toISOString();
    if (displayEl) displayEl.textContent = dhm(snapshot);
    return;
  }
  const elapsedMin = Math.max(0, (Date.now() - measuredMs) / 60000);
  const current = Math.max(0, Math.round(snapshot - elapsedMin));
  if (displayEl) displayEl.textContent = dhm(current);
}

function recompute(form: HTMLFormElement): void {
  const inputs = readForm(form);
  lastInputs = inputs;
  const results = calculate(inputs);
  lastResults = results;

  renderDhmHints(form);
  renderTraining(results.training);
  renderBuilding(results.building);
  renderFeasibility(results.feasibility);
  renderConstants();
}

// ===== init =====
let _saveTimer: number | null = null;
function scheduleSave(form: HTMLFormElement): void {
  if (_saveTimer !== null) window.clearTimeout(_saveTimer);
  _saveTimer = window.setTimeout(() => {
    saveState(form);
    _saveTimer = null;
  }, 200);
}

function init(): void {
  const form = $('kvk-form') as HTMLFormElement | null;
  if (!form) return;

  loadState(form);

  // 천단위 쉼표 자동 포맷
  form.querySelectorAll<HTMLInputElement>('[data-kvk-number]').forEach((el) => {
    formatNumberInput(el);
  });

  // 페이지 진입 시 한 번 sync — 직전 저장 이후 경과한 분만큼 차감 반영
  syncEmbassyDisplay(form);

  recompute(form);

  form.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.matches('[data-kvk-number]')) {
      formatNumberInput(target);
    }
    // 대사관 잔여 직접 수정 시 측정 시각도 now 로 리셋 (사용자가 게임에서 재확인한 시점).
    if (target.name === 'embassyRemaining') {
      const hidden = form.querySelector<HTMLInputElement>('input[name="embassyMeasuredAt"]');
      if (hidden) hidden.value = new Date().toISOString();
    }
    recompute(form);
    scheduleSave(form);
  });

  // 언어 변경 → 결과 라벨 재렌더
  onLangChange(() => {
    syncEmbassyDisplay(form);
    renderDhmHints(form);
    if (lastResults) {
      renderTraining(lastResults.training);
      renderBuilding(lastResults.building);
      renderFeasibility(lastResults.feasibility);
      renderConstants();
    }
  });

  // 대사관 잔여시간 실시간 갱신 — 60초마다 sync + 재계산.
  window.setInterval(() => {
    syncEmbassyDisplay(form);
    recompute(form);
    scheduleSave(form);
  }, 60_000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
