/**
 * KvK 계산기 — 입력 → 즉시 재계산 → DOM 갱신.
 *
 * 모든 입력은 [data-kvk-number] 마커로 천단위 쉼표 자동 포맷.
 * 결과 카드 3종: 병사 훈련 / 건물 30T / 30T 가능여부 + 상수 참고 카드.
 *
 * 영속화: kvk_calculator_state 테이블 (kingshot_id PK + fields JSONB).
 *   - 진입 시 DB 에서 자동 로드 (없으면 HTML 기본값 사용)
 *   - 저장하기 버튼 → upsert. 자동 저장 안 함.
 *   - 새로고침 버튼 → DB 재조회 → form 새로 채움.
 *   - 미저장 변경: 사용자 input 이벤트로 dirty=true → 버튼 우측 상단 dot 표시.
 *
 * 대사관 잔여(snapshot + measuredAt) 는 클라 상수라 DB 저장 대상 외.
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
import { supabase } from '@/lib/supabase';
import { getSession, onSessionChange } from '@/scripts/pages/tile-match-auth';
import flatpickr from 'flatpickr';
import type { Instance as FlatpickrInstance } from 'flatpickr/dist/types/instance';
import { Korean } from 'flatpickr/dist/l10n/ko.js';
import 'flatpickr/dist/flatpickr.min.css';

/** DB fields JSONB 에 들어가는 입력 필드 키. 대사관 관련 hidden 은 제외.
 *  bonusMinutes (추가 가속권) 도 제외 — 보유 가속권 갱신 시 이중 누적되는 모델
 *  버그 방지. 매 페이지 로드마다 0 부터 시작, 사용자가 그 세션에서만 입력. */
const DB_FIELDS = [
  'infantry',
  'cavalry',
  'archers',
  'accelCommon',
  'accelTraining',
  'accelBuilding',
  'deadline',
] as const;

/** 언어에 맞는 D/H/M 포맷. */
function dhm(min: number): string {
  return getLang() === 'ko' ? formatDhm(min) : formatDhmEn(min);
}

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

/** flatpickr 표시 포맷("YYYY-MM-DD HH:MM") → ISO 8601 KST. 잘못된 값이면 refTime fallback. */
function combineDeadlineIso(fd: FormData): string {
  const v = String(fd.get('deadline') ?? '').trim();
  if (!v) return KVK_CONSTANTS.refTime;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})/);
  if (!m) return KVK_CONSTANTS.refTime;
  return `${m[1]}T${m[2]}:${m[3]}:00+09:00`;
}

/** ISO 8601 → flatpickr 표시 포맷. flatpickr 인스턴스 있으면 setDate, 없으면 raw set. */
function applyDeadlineIsoToInputs(form: HTMLFormElement, iso: string): void {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return;
  const display = `${m[1]} ${m[2]}:${m[3]}`;
  const input = form.querySelector<HTMLInputElement>('input[name="deadline"]');
  if (!input) return;
  const fp = (input as HTMLInputElement & { _flatpickr?: FlatpickrInstance })._flatpickr;
  if (fp) {
    fp.setDate(display, false);
  } else {
    input.value = display;
  }
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

/** 대사관 snapshot + measuredAt + 마감 → 마감 시점에 자연 진행 후 남는 잔여(분).
 *  전략: "단일 슬롯 즉시완료" execute 시점 = 마감 → 그 전까지 자연 감소를 최대 활용.
 *  음수 elapsed 는 clamp (마감이 measuredAt 이전인 경우). */
function computeEmbassyAtDeadline(fd: FormData): number {
  const snapshot = parseNumber(fd.get('embassyRemaining'));
  const measuredAt = String(fd.get('embassyMeasuredAt') ?? '');
  const deadlineIso = combineDeadlineIso(fd);
  const measuredMs = Date.parse(measuredAt);
  const deadlineMs = Date.parse(deadlineIso);
  if (!Number.isFinite(measuredMs) || !Number.isFinite(deadlineMs)) return snapshot;
  const elapsedMin = Math.max(0, (deadlineMs - measuredMs) / 60000);
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
    embassyRemaining: computeEmbassyAtDeadline(fd),
    deadline: combineDeadlineIso(fd),
    bonusMinutes: parseNumber(fd.get('bonusMinutes')),
  };
}

// ===== DB 영속화 =====

interface KvkDbRow {
  kingshot_id: string;
  fields: Record<string, string>;
}

function getKingshotId(): string | null {
  return getSession()?.player_id ?? null;
}

/** DB → form. 데이터 없으면 HTML 기본값 유지.
 *  deadline 은 ISO 한 줄로 저장돼 있어 → date + time 두 input 으로 분해. */
async function loadFromDb(form: HTMLFormElement): Promise<boolean> {
  const id = getKingshotId();
  if (!id) return false;

  const { data, error } = await supabase
    .from('kvk_calculator_state')
    .select('fields')
    .eq('kingshot_id', id)
    .maybeSingle();

  if (error) {
    console.error('[kvk-calc] DB load error', error);
    return false;
  }
  if (!data) return true; // row 없음 — HTML 기본값으로 진행

  const fields = (data as Pick<KvkDbRow, 'fields'>).fields ?? {};
  DB_FIELDS.forEach((name) => {
    const value = fields[name];
    if (value == null) return;
    if (name === 'deadline') {
      applyDeadlineIsoToInputs(form, String(value));
      return;
    }
    const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (el) el.value = String(value);
  });
  // 천단위 쉼표 재적용 (DB 값은 plain 숫자일 수 있음)
  form.querySelectorAll<HTMLInputElement>('[data-kvk-number]').forEach((el) => {
    formatNumberInput(el);
  });
  return true;
}

/** form → DB upsert. deadline 은 date + time 합쳐 ISO 로 저장. */
async function saveToDb(form: HTMLFormElement): Promise<boolean> {
  const id = getKingshotId();
  if (!id) return false;

  const fd = new FormData(form);
  const fields: Record<string, string> = {};
  DB_FIELDS.forEach((name) => {
    if (name === 'deadline') {
      fields[name] = combineDeadlineIso(fd);
      return;
    }
    const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    fields[name] = el?.value ?? '';
  });

  const { error } = await supabase
    .from('kvk_calculator_state')
    .upsert({ kingshot_id: id, fields } satisfies KvkDbRow);

  if (error) {
    console.error('[kvk-calc] DB save error', error);
    return false;
  }
  return true;
}

// ===== Dirty 추적 =====

let dirty = false;

function setDirty(v: boolean): void {
  dirty = v;
  const dot = $('kvk-save-dot');
  if (!dot) return;
  if (v) dot.removeAttribute('hidden');
  else dot.setAttribute('hidden', '');
}

// ===== 토스트 =====

let _toastTimer: number | null = null;
function showToast(msg: string): void {
  const el = $('kvk-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('kvk-toast-show');
  if (_toastTimer !== null) window.clearTimeout(_toastTimer);
  _toastTimer = window.setTimeout(() => {
    el.classList.remove('kvk-toast-show');
    _toastTimer = null;
  }, 1500);
}

// ===== 렌더 =====

let lastResults: KvkResults | null = null;
let lastInputs: KvkInputs | null = null;

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
  const labels = {
    targetInf: t('gameTools.kvkCalculator.mTargetInf'),
    targetCav: t('gameTools.kvkCalculator.mTargetCav'),
    targetArc: t('gameTools.kvkCalculator.mTargetArc'),
    extra: t('gameTools.kvkCalculator.mExtraTroops'),
    min: t('gameTools.kvkCalculator.mTrainMin'),
    prep: t('gameTools.kvkCalculator.mPrepScore'),
  };
  const unitTroops = t('gameTools.kvkCalculator.unitTroops');
  const unitMinutes = t('gameTools.kvkCalculator.unitMinutes');
  const unitPoints = t('gameTools.kvkCalculator.unitPoints');
  const trainingLabel = t('gameTools.kvkCalculator.accelTraining');
  const commonLabel = t('gameTools.kvkCalculator.accelCommon');

  setRows(
    'kvk-training-target',
    `
    <tr><th>${labels.targetInf}</th><td>${fmt(r.targetInfantry)} <span class="kvk-extra">(+${fmt(r.extraInfantry)})</span></td></tr>
    <tr><th>${labels.targetCav}</th><td>${fmt(r.targetCavalry)}</td></tr>
    <tr><th>${labels.targetArc}</th><td>${fmt(r.targetArchers)} <span class="kvk-extra">(+${fmt(r.extraArchers)})</span></td></tr>
    <tr><th>${labels.extra}</th><td><strong>${fmt(r.totalExtra)}</strong> ${unitTroops}</td></tr>
    <tr><th>${labels.min}</th><td>${fmt(r.neededMinutes)} ${unitMinutes} <span class="kvk-extra">(${dhm(r.neededMinutes)})</span></td></tr>
    <tr class="kvk-row-prep"><th>${labels.prep}</th><td><strong>${fmt(r.prepKingdomScore)}</strong> ${unitPoints}</td></tr>
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
    realtime: t('gameTools.kvkCalculator.fRealtime'),
    realtimeNow: t('gameTools.kvkCalculator.fRealtimeNow'),
    needed: t('gameTools.kvkCalculator.fNeeded'),
    available: t('gameTools.kvkCalculator.fAvailable'),
    shortage: t(r.shortage > 0 ? 'gameTools.kvkCalculator.fShortage' : 'gameTools.kvkCalculator.fShortageOk'),
  };

  const shortageVal = Math.abs(r.shortage);
  const shortageClass = r.shortage > 0 ? 'kvk-shortage-bad' : 'kvk-shortage-ok';
  const unitMinutes = t('gameTools.kvkCalculator.unitMinutes');

  setRows(
    'kvk-feasibility-rows',
    `
    <tr><th>${labels.deadline}</th><td>${fmtIso(r.deadline)}</td></tr>
    <tr class="kvk-sub-row"><th>ㄴ ${labels.realtime}</th><td>${dhm(r.realtimeAvailableMin)}</td></tr>
    <tr class="kvk-sub-row"><th>ㄴ ${labels.realtimeNow}</th><td id="kvk-current-remaining">${currentRemainingText(r.deadline)}</td></tr>
    <tr><th>${labels.needed}</th><td>${fmt(r.needed)} ${unitMinutes} <span class="kvk-extra">(${dhm(r.needed)})</span></td></tr>
    <tr class="kvk-sub-row"><th>ㄴ ${labels.available}</th><td>${fmt(r.available)} ${unitMinutes} <span class="kvk-extra">(${dhm(r.available)})</span></td></tr>
    <tr class="kvk-sub-row ${shortageClass}"><th>ㄴ ${labels.shortage}</th><td><strong>${fmt(shortageVal)}</strong> ${unitMinutes} <span class="kvk-extra">(${dhm(shortageVal)})</span></td></tr>
  `,
  );
}

/** 현재 KST 기준 마감까지 남은 시간 (dhm). 마감 지나면 'fDeadlinePassed' 라벨.
 *  setInterval 로 매 분 갱신 — recompute 호출과 무관하게 시계가 흐름. */
function currentRemainingText(deadlineIso: string): string {
  const deadlineMs = Date.parse(deadlineIso);
  if (!Number.isFinite(deadlineMs)) return '-';
  const diffMin = Math.round((deadlineMs - Date.now()) / 60000);
  if (diffMin <= 0) return t('gameTools.kvkCalculator.fDeadlinePassed');
  return dhm(diffMin);
}

function syncCurrentRemaining(): void {
  if (!lastResults) return;
  const el = $('kvk-current-remaining');
  if (!el) return;
  el.textContent = currentRemainingText(lastResults.feasibility.deadline);
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

/** 대사관 (마감 시점 잔여) 를 #kvk-embassy-display 에 표시. form 값 안 건드림. */
function syncEmbassyDisplay(form: HTMLFormElement): void {
  const displayEl = $('kvk-embassy-display');
  if (!displayEl) return;
  const fd = new FormData(form);
  displayEl.textContent = dhm(computeEmbassyAtDeadline(fd));
}

/** 추가 가속권 입력값을 D/H/M 으로 변환해 #kvk-bonus-dhm 에 표시.
 *  0 이면 row 자체 숨김 (시각 노이즈 차단). */
function syncBonusDhm(form: HTMLFormElement): void {
  const displayEl = $('kvk-bonus-dhm');
  const rowEl = $('kvk-bonus-dhm-row');
  if (!displayEl || !rowEl) return;
  const minutes = parseNumber(new FormData(form).get('bonusMinutes'));
  if (minutes > 0) {
    displayEl.textContent = dhm(minutes);
    rowEl.style.visibility = 'visible';
  } else {
    displayEl.textContent = '';
    rowEl.style.visibility = 'hidden';
  }
}

function recompute(form: HTMLFormElement): void {
  const inputs = readForm(form);
  lastInputs = inputs;
  const results = calculate(inputs);
  lastResults = results;

  syncEmbassyDisplay(form);
  syncBonusDhm(form);
  renderDhmHints(form);
  renderTraining(results.training);
  renderBuilding(results.building);
  renderFeasibility(results.feasibility);
  renderConstants();
}

// ===== 핸들러 =====

async function handleSave(form: HTMLFormElement): Promise<void> {
  const btn = $('kvk-save-btn') as HTMLButtonElement | null;
  if (!btn) return;
  if (btn.disabled) return;

  btn.disabled = true;
  const label = btn.querySelector<HTMLElement>('.kvk-btn-label');
  const origLabel = label?.textContent ?? '';
  if (label) label.textContent = t('gameTools.kvkCalculator.btnSaving');

  const ok = await saveToDb(form);

  if (label) label.textContent = origLabel;
  btn.disabled = false;

  if (ok) {
    setDirty(false);
    showToast(t('gameTools.kvkCalculator.toastSaved'));
  } else {
    showToast(t('gameTools.kvkCalculator.toastSaveFail'));
  }
}

async function handleRefresh(form: HTMLFormElement): Promise<void> {
  const btn = $('kvk-refresh-btn') as HTMLButtonElement | null;
  if (!btn) return;
  if (btn.disabled) return;

  btn.disabled = true;
  btn.classList.add('kvk-spinning');

  const ok = await loadFromDb(form);

  btn.classList.remove('kvk-spinning');
  btn.disabled = false;

  if (ok) {
    setDirty(false);
    syncEmbassyDisplay(form);
    recompute(form);
    showToast(t('gameTools.kvkCalculator.toastLoaded'));
  } else {
    showToast(t('gameTools.kvkCalculator.toastLoadFail'));
  }
}

// ===== init =====

function initDeadlinePicker(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>('input[name="deadline"]');
  if (!input) return;
  flatpickr(input, {
    enableTime: true,
    time_24hr: true,
    dateFormat: 'Y-m-d H:i',
    locale: Korean,
    minuteIncrement: 15,
    onChange: () => {
      setDirty(true);
      recompute(form);
    },
  });
}

function bootForm(form: HTMLFormElement): void {
  // 천단위 쉼표 자동 포맷
  form.querySelectorAll<HTMLInputElement>('[data-kvk-number]').forEach((el) => {
    formatNumberInput(el);
  });

  initDeadlinePicker(form);

  syncEmbassyDisplay(form);
  recompute(form);

  form.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    // 마감일은 flatpickr onChange 가 처리 — 중복 처리 방지
    if (target.name === 'deadline') return;
    if (target.matches('[data-kvk-number]')) {
      formatNumberInput(target);
    }
    setDirty(true);
    recompute(form);
  });
}

function bindActions(form: HTMLFormElement): void {
  const saveBtn = $('kvk-save-btn');
  const refreshBtn = $('kvk-refresh-btn');
  saveBtn?.addEventListener('click', () => void handleSave(form));
  refreshBtn?.addEventListener('click', () => void handleRefresh(form));
}

async function init(): Promise<void> {
  const form = $('kvk-form') as HTMLFormElement | null;
  if (!form) return;

  bootForm(form);
  bindActions(form);

  // 세션 준비된 시점에 DB 로드 시도. 이미 있으면 즉시, 아니면 onSessionChange 로 첫 변경 후.
  const trySync = async (): Promise<void> => {
    if (!getKingshotId()) return;
    await loadFromDb(form);
    setDirty(false);
    syncEmbassyDisplay(form);
    recompute(form);
  };
  if (getKingshotId()) {
    void trySync();
  }
  onSessionChange(() => void trySync());

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

  // 현재 시간 기준 잔여 — 매 분 자동 갱신 (시계는 입력과 무관하게 흐름).
  // 페이지 진입 후 lastResults 가 채워질 때까지는 no-op.
  setInterval(syncCurrentRemaining, 60_000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init());
} else {
  void init();
}
