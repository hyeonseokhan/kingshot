/**
 * 부대 계산기 — 곰 사냥 페이지의 클라이언트 로직.
 * 입력 → 계산 → DOM 갱신. 외부 통신 0회 (순수 클라계산).
 *
 * 입력 필드는 [data-tc-number] 마커로 천단위 쉼표 자동 포맷.
 * 결과 표는 N개 편대(각 셀에 T10/T9 두 줄) + 잔류 행 + 합계 행.
 * 숫자 셀(.tc-num)은 클릭 시 raw 숫자 클립보드 복사.
 *
 * 영속화: 계산 성공 시 입력값을 localStorage 에 저장. 페이지 재진입 시 복원 + 자동 재계산.
 * v1(보병/기병/궁병 단일 입력) 데이터는 T9 로 마이그레이션 (T10=0).
 */

import {
  calculate,
  formatRatio,
  validate,
  type DistributionMode,
  type TierBreakdown,
  type TroopsInput,
  type TroopsResult,
  type ValidationError,
} from '@/lib/troops-calculator';
import { onLangChange, t } from '@/i18n';

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ===== 영속화 =====
// v2 — T9/T10 분리 모델. v1 형식은 폴드해서 T9 로 마이그레이션.
const STORAGE_KEY = 'pnx-troops-calc-bear-v2';
const LEGACY_KEY_V1 = 'pnx-troops-calc-bear-v1';

interface StoredState {
  input: TroopsInput;
  distribution: DistributionMode;
}

function saveState(state: StoredState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — 무시 */
  }
}

/**
 * 저장 데이터 로드.
 *   v2 (T9/T10 분리) 우선 → 없으면 v1 (단일 입력) → T9 로 마이그레이션.
 */
function loadState(): StoredState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as { input?: Partial<TroopsInput>; distribution?: DistributionMode };
      const src = obj.input;
      if (
        src &&
        typeof src.cap === 'number' &&
        typeof src.infantryT9 === 'number' &&
        typeof src.infantryT10 === 'number' &&
        typeof src.cavalryT9 === 'number' &&
        typeof src.cavalryT10 === 'number' &&
        typeof src.archersT9 === 'number' &&
        typeof src.archersT10 === 'number' &&
        typeof src.squadCount === 'number'
      ) {
        return {
          input: {
            cap: src.cap,
            infantryT9: src.infantryT9,
            infantryT10: src.infantryT10,
            cavalryT9: src.cavalryT9,
            cavalryT10: src.cavalryT10,
            archersT9: src.archersT9,
            archersT10: src.archersT10,
            squadCount: src.squadCount,
          },
          distribution: obj.distribution === 'even' ? 'even' : 'bear',
        };
      }
    }
    // v1 마이그레이션 — 보유량을 T9 로 매핑
    const legacy = localStorage.getItem(LEGACY_KEY_V1);
    if (legacy) {
      const obj = JSON.parse(legacy) as {
        input?: { cap?: number; infantry?: number; cavalry?: number; archers?: number; squadCount?: number };
        distribution?: DistributionMode;
        cap?: number; infantry?: number; cavalry?: number; archers?: number; squadCount?: number;
      };
      const src = obj.input ?? obj;
      if (
        typeof src.cap === 'number' &&
        typeof src.infantry === 'number' &&
        typeof src.cavalry === 'number' &&
        typeof src.archers === 'number' &&
        typeof src.squadCount === 'number'
      ) {
        return {
          input: {
            cap: src.cap,
            infantryT9: src.infantry,
            infantryT10: 0,
            cavalryT9: src.cavalry,
            cavalryT10: 0,
            archersT9: src.archers,
            archersT10: 0,
            squadCount: src.squadCount,
          },
          distribution: obj.distribution === 'even' ? 'even' : 'bear',
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function clearStoredState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_KEY_V1);
  } catch {
    /* */
  }
}

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

/** raw 숫자 추출 — 입력 필드에 쉼표/공백 섞여있어도 숫자만 파싱. 빈 값은 0 으로 간주. */
function parseNumber(raw: FormDataEntryValue | null, allowEmptyAsZero = false): number {
  if (raw == null) return Number.NaN;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits === '') return allowEmptyAsZero ? 0 : Number.NaN;
  return Number(digits);
}

function readForm(form: HTMLFormElement): { input: TroopsInput; distribution: DistributionMode } {
  const fd = new FormData(form);
  const distribution: DistributionMode = fd.get('distribution') === 'even' ? 'even' : 'bear';
  // 병과 입력은 비워두면 0 으로 간주 (T10/T9 한쪽만 입력하는 케이스 자연 지원)
  return {
    input: {
      cap: parseNumber(fd.get('cap')),
      infantryT9: parseNumber(fd.get('infantryT9'), true),
      infantryT10: parseNumber(fd.get('infantryT10'), true),
      cavalryT9: parseNumber(fd.get('cavalryT9'), true),
      cavalryT10: parseNumber(fd.get('cavalryT10'), true),
      archersT9: parseNumber(fd.get('archersT9'), true),
      archersT10: parseNumber(fd.get('archersT10'), true),
      squadCount: parseNumber(fd.get('squadCount')),
    },
    distribution,
  };
}

/**
 * input 필드 천단위 쉼표 포맷팅.
 * 사용자가 입력 중에도 쉼표 즉시 적용. 캐럿 위치는 "캐럿 앞쪽 숫자 개수"를 보존하여 자연스럽게 따라감.
 */
function formatNumberInput(el: HTMLInputElement): void {
  const oldValue = el.value;
  const oldCaret = el.selectionStart ?? oldValue.length;
  const digitsBefore = oldValue.slice(0, oldCaret).replace(/[^\d]/g, '').length;

  const raw = oldValue.replace(/[^\d]/g, '');
  const next = raw === '' ? '' : Number(raw).toLocaleString('ko-KR');
  if (next === oldValue) return;
  el.value = next;

  // 새 캐럿 위치 — digitsBefore 개의 숫자를 지난 직후
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
    /* type=text 가 아니면 throw — 무시 */
  }
}

function showError(error: ValidationError): void {
  const el = $('tc-error');
  if (!el) return;
  let key = 'gameTools.troopsCalculator.errInvalid';
  if (error.kind === 'cap-too-small') key = 'gameTools.troopsCalculator.errCap';
  else if (error.kind === 'squad-count-too-small') key = 'gameTools.troopsCalculator.errSquadCount';
  el.dataset.i18n = key;
  el.textContent = t(key);
  el.removeAttribute('hidden');
}

function clearError(): void {
  const el = $('tc-error');
  if (!el) return;
  el.setAttribute('hidden', '');
  el.textContent = '';
  el.removeAttribute('data-i18n');
}

let lastResult: TroopsResult | null = null;

/** mode → i18n key 매핑. 결과 헤더의 모드 텍스트 + 도트 색상. */
const MODE_KEYS: Record<TroopsResult['mode'], string> = {
  'bear-full': 'gameTools.troopsCalculator.modeFull',
  'bear-partial': 'gameTools.troopsCalculator.modePartial',
  'even-fits': 'gameTools.troopsCalculator.modeEvenFits',
  'even-capped': 'gameTools.troopsCalculator.modeEvenCapped',
};

/** mode → ratio inline i18n key. 곰 사냥은 "(목표 1:1:8)", 균등은 "(보유 비율 기준)". */
function ratioInlineKey(mode: TroopsResult['mode']): string {
  return mode.startsWith('even')
    ? 'gameTools.troopsCalculator.ratioInlineEven'
    : 'gameTools.troopsCalculator.ratioInline';
}

/** mode → CSS dataset 값. 풀 편성 계열은 'full', 그 외는 'partial' (도트 색상). */
function modeDot(mode: TroopsResult['mode']): 'full' | 'partial' {
  if (mode === 'bear-full' || mode === 'even-fits') return 'full';
  return 'partial';
}

/**
 * 병과 셀 — T10/T9 두 줄. 각 줄은 .tc-num 으로 클릭 시 그 티어 raw 만 복사.
 * 보유/배분이 모두 0 이면 그 줄 숨김(시각적 노이즈 제거).
 */
function tierCell(b: TierBreakdown): string {
  const lines: string[] = [];
  if (b.t10 > 0) {
    lines.push(
      `<span class="tc-num tc-tier-row" data-raw="${b.t10}" tabindex="0" role="button" title="${t('gameTools.troopsCalculator.copyHint')}">` +
        `<span class="tc-tier-label">T10</span><span class="tc-tier-val">${fmt(b.t10)}</span>` +
      `</span>`,
    );
  }
  if (b.t9 > 0) {
    lines.push(
      `<span class="tc-num tc-tier-row" data-raw="${b.t9}" tabindex="0" role="button" title="${t('gameTools.troopsCalculator.copyHint')}">` +
        `<span class="tc-tier-label">T9</span><span class="tc-tier-val">${fmt(b.t9)}</span>` +
      `</span>`,
    );
  }
  if (lines.length === 0) {
    // 0 인 셀은 "0" 한 줄 — 시각적 빈 셀 회피
    lines.push(`<span class="tc-tier-row tc-tier-zero"><span class="tc-tier-val">0</span></span>`);
  }
  return `<td class="tc-cell-tier">${lines.join('')}</td>`;
}

/** 합계 셀 — 단일 라인. 클릭 시 raw 복사. */
function totalCell(n: number): string {
  return `<td class="tc-num" data-raw="${n}" tabindex="0" role="button" title="${t('gameTools.troopsCalculator.copyHint')}">${fmt(n)}</td>`;
}

function renderResult(result: TroopsResult): void {
  lastResult = result;

  const root = $('tc-result');
  if (root) root.removeAttribute('hidden');

  // 모드 텍스트
  const modeText = $('tc-mode-text');
  if (modeText) {
    const key = MODE_KEYS[result.mode];
    modeText.dataset.i18n = key;
    modeText.dataset.mode = modeDot(result.mode);
    modeText.textContent = t(key);
  }

  // 비율 — 모드별 다른 템플릿
  const ratioText = $('tc-ratio-text');
  if (ratioText) {
    const tpl = t(ratioInlineKey(result.mode));
    ratioText.textContent = tpl.replace('{actual}', formatRatio(result.actualRatio));
    ratioText.dataset.tcActual = formatRatio(result.actualRatio);
  }

  // 표 본체 — N행 편대 + 잔류 + 합계.
  const tbody = $('tc-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  for (let i = 0; i < result.squadCount; i++) {
    const squad = result.perSquad[i];
    const tr = document.createElement('tr');
    tr.className = 'tc-row-squad';
    tr.innerHTML = `
      <td>${i + 1}</td>
      ${tierCell(squad.infantry)}
      ${tierCell(squad.cavalry)}
      ${tierCell(squad.archers)}
      ${totalCell(squad.total)}
    `;
    tbody.appendChild(tr);
  }

  // 잔류 행 (노란색 배경)
  const r = result.remaining;
  const remTotal = r.infantry.total + r.cavalry.total + r.archers.total;
  const remTr = document.createElement('tr');
  remTr.className = 'tc-row-remaining';
  remTr.innerHTML = `
    <td data-i18n="gameTools.troopsCalculator.tableRemaining">${t('gameTools.troopsCalculator.tableRemaining')}</td>
    ${tierCell(r.infantry)}
    ${tierCell(r.cavalry)}
    ${tierCell(r.archers)}
    ${totalCell(remTotal)}
  `;
  tbody.appendChild(remTr);

  // 합계 행 (회색 배경) — 편대 사용량 + 잔류 = 보유 총량. 티어별 합계 분리 표시.
  // 편대마다 T10/T9 분포가 달라서(T10 1편대부터 몰빵) Σ perSquad[i] 누적 필요.
  const sumInf: TierBreakdown = { t10: r.infantry.t10, t9: r.infantry.t9, total: r.infantry.total };
  const sumCav: TierBreakdown = { t10: r.cavalry.t10, t9: r.cavalry.t9, total: r.cavalry.total };
  const sumArc: TierBreakdown = { t10: r.archers.t10, t9: r.archers.t9, total: r.archers.total };
  for (const squad of result.perSquad) {
    sumInf.t10 += squad.infantry.t10; sumInf.t9 += squad.infantry.t9; sumInf.total += squad.infantry.total;
    sumCav.t10 += squad.cavalry.t10; sumCav.t9 += squad.cavalry.t9; sumCav.total += squad.cavalry.total;
    sumArc.t10 += squad.archers.t10; sumArc.t9 += squad.archers.t9; sumArc.total += squad.archers.total;
  }
  const sumAll = sumInf.total + sumCav.total + sumArc.total;
  const sumTr = document.createElement('tr');
  sumTr.className = 'tc-row-total';
  sumTr.innerHTML = `
    <td data-i18n="gameTools.troopsCalculator.tableSumRow">${t('gameTools.troopsCalculator.tableSumRow')}</td>
    ${tierCell(sumInf)}
    ${tierCell(sumCav)}
    ${tierCell(sumArc)}
    ${totalCell(sumAll)}
  `;
  tbody.appendChild(sumTr);
}

/**
 * 클립보드 복사 — Clipboard API 우선, 비-secure context 면 textarea fallback.
 * 게임 인풋이 raw 숫자만 받는 경우가 많아 쉼표 없는 raw 값으로 복사.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ===== 토스트 (타일매치 .tm-toast 패턴 동일) =====
let _toastTimer: number | null = null;
function showToast(msg: string): void {
  const el = $('tc-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('tc-toast-show');
  if (_toastTimer !== null) window.clearTimeout(_toastTimer);
  _toastTimer = window.setTimeout(() => {
    el.classList.remove('tc-toast-show');
    _toastTimer = null;
  }, 1500);
}

/**
 * 셀 강조 클래스를 항상 최소 120ms 보장.
 * 짧은 탭에서도 시각 피드백이 명확히 보이게 함. PC 마우스 클릭과 모바일 터치 모두 동일.
 */
function flashCell(cell: HTMLElement): void {
  cell.classList.remove('tc-tap');
  // 강제 reflow — 같은 셀 연속 활성화 시 transition 재시작
  void cell.offsetWidth;
  cell.classList.add('tc-tap');
  window.setTimeout(() => cell.classList.remove('tc-tap'), 120);
}

/** pointerdown 위임 — .tc-num 이면 짧은 강조 시작. */
function onCellPointerDown(e: PointerEvent): void {
  const target = e.target as HTMLElement;
  const cell = target.closest('.tc-num') as HTMLElement | null;
  if (cell) flashCell(cell);
}

/** 셀 click/keydown 위임 핸들러 — .tc-num 이면 data-raw 복사 + 토스트. */
function onCellActivate(e: Event): void {
  const target = e.target as HTMLElement;
  const cell = target.closest('.tc-num') as HTMLElement | null;
  if (!cell) return;
  if (e instanceof KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    flashCell(cell);
  }
  e.preventDefault();
  const raw = cell.dataset.raw;
  if (!raw) return;
  copyToClipboard(raw).then((ok) => {
    if (ok) showToast(t('gameTools.troopsCalculator.copyToast'));
  });
}

function resetResult(): void {
  lastResult = null;
  const root = $('tc-result');
  if (root) root.setAttribute('hidden', '');
}

const TIER_FIELD_NAMES = [
  'infantryT10',
  'infantryT9',
  'cavalryT10',
  'cavalryT9',
  'archersT10',
  'archersT9',
] as const;

/** 저장된 상태(입력값 + 분배 모드) 를 폼에 복원. 폼이 비어있는 상태일 때만 사용. */
function restoreFormFromStorage(form: HTMLFormElement): StoredState | null {
  const stored = loadState();
  if (!stored) return null;
  const setText = (name: string, value: number) => {
    const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (el) el.value = value > 0 ? value.toLocaleString('ko-KR') : '';
  };
  setText('cap', stored.input.cap);
  for (const name of TIER_FIELD_NAMES) {
    setText(name, stored.input[name]);
  }
  const squad = form.querySelector<HTMLSelectElement>('select[name="squadCount"]');
  if (squad) squad.value = String(stored.input.squadCount);
  const dist = form.querySelector<HTMLSelectElement>('select[name="distribution"]');
  if (dist) dist.value = stored.distribution;
  return stored;
}

function init(): void {
  const form = document.getElementById('tc-form') as HTMLFormElement | null;
  const resetBtn = $('tc-reset');
  if (!form) return;

  // 천단위 쉼표 자동 포맷 — [data-tc-number] 마커가 붙은 모든 input
  form.querySelectorAll<HTMLInputElement>('input[data-tc-number]').forEach((input) => {
    input.addEventListener('input', () => formatNumberInput(input));
    input.addEventListener('blur', () => formatNumberInput(input));
  });

  // 결과 표 숫자 셀 — 클릭/터치 시 클립보드 복사. (이벤트 위임으로 tbody 재렌더 후에도 유지)
  const tableBody = $('tc-table-body');
  tableBody?.addEventListener('pointerdown', onCellPointerDown);
  tableBody?.addEventListener('click', onCellActivate);
  tableBody?.addEventListener('keydown', onCellActivate);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearError();
    const { input, distribution } = readForm(form);
    const error = validate(input);
    if (error) {
      showError(error);
      resetResult();
      return;
    }
    renderResult(calculate(input, distribution));
    saveState({ input, distribution });
  });

  resetBtn?.addEventListener('click', () => {
    form.reset();
    clearError();
    resetResult();
    clearStoredState();
  });

  // 언어 변경 시 — 마지막 결과의 라벨을 다시 그림
  onLangChange(() => {
    if (lastResult) renderResult(lastResult);
  });

  // 저장된 입력 복원 + 자동 재계산 (validate 통과 시).
  const restored = restoreFormFromStorage(form);
  if (restored && validate(restored.input) === null) {
    renderResult(calculate(restored.input, restored.distribution));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
