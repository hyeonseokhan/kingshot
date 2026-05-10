/**
 * 부대 계산기 — 곰 사냥 페이지의 클라이언트 로직.
 * 입력 → 계산 → DOM 갱신. 외부 통신 0회 (순수 클라계산).
 *
 * 입력 필드는 [data-tc-number] 마커로 천단위 쉼표 자동 포맷.
 * 결과 표는 N개 편대 + 마지막 잔류 행(.tc-row-remaining).
 *
 * 영속화: 계산 성공 시 입력값을 localStorage 에 저장. 페이지 재진입 시 복원 + 자동 재계산.
 */

import {
  calculateBearHunt,
  formatRatio,
  validate,
  type TroopsInput,
  type TroopsResult,
  type ValidationError,
} from '@/lib/troops-calculator';
import { onLangChange, t } from '@/i18n';

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ===== 영속화 =====
const STORAGE_KEY = 'pnx-troops-calc-bear-v1';

function saveInput(input: TroopsInput): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(input));
  } catch {
    /* quota / private mode — 무시 */
  }
}

function loadInput(): TroopsInput | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Partial<TroopsInput>;
    if (
      typeof obj.cap !== 'number' ||
      typeof obj.infantry !== 'number' ||
      typeof obj.cavalry !== 'number' ||
      typeof obj.archers !== 'number' ||
      typeof obj.squadCount !== 'number'
    ) {
      return null;
    }
    return {
      cap: obj.cap,
      infantry: obj.infantry,
      cavalry: obj.cavalry,
      archers: obj.archers,
      squadCount: obj.squadCount,
    };
  } catch {
    return null;
  }
}

function clearStoredInput(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* */
  }
}

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

/** raw 숫자 추출 — 입력 필드에 쉼표/공백 섞여있어도 숫자만 파싱. */
function parseNumber(raw: FormDataEntryValue | null): number {
  if (raw == null) return Number.NaN;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits === '') return Number.NaN;
  return Number(digits);
}

function readForm(form: HTMLFormElement): TroopsInput {
  const fd = new FormData(form);
  return {
    cap: parseNumber(fd.get('cap')),
    infantry: parseNumber(fd.get('infantry')),
    cavalry: parseNumber(fd.get('cavalry')),
    archers: parseNumber(fd.get('archers')),
    squadCount: parseNumber(fd.get('squadCount')),
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

function renderResult(result: TroopsResult): void {
  lastResult = result;

  const root = $('tc-result');
  if (root) root.removeAttribute('hidden');

  // 모드 텍스트 — "풀 편성" / "궁병 우선 분배"
  const modeText = $('tc-mode-text');
  if (modeText) {
    const isFull = result.mode === 'full';
    const key = isFull
      ? 'gameTools.troopsCalculator.modeFull'
      : 'gameTools.troopsCalculator.modePartial';
    modeText.dataset.i18n = key;
    modeText.dataset.mode = result.mode;
    modeText.textContent = t(key);
  }

  // 비율 — "실제 2.4:2.4:5.1 (목표 1:1:8)"
  const ratioText = $('tc-ratio-text');
  if (ratioText) {
    const tpl = t('gameTools.troopsCalculator.ratioInline');
    ratioText.textContent = tpl.replace('{actual}', formatRatio(result.actualRatio));
    ratioText.dataset.tcActual = formatRatio(result.actualRatio);
  }

  // 표 본체 — N행 편대 + 마지막 잔류 행
  const tbody = $('tc-table-body');
  if (tbody) {
    tbody.innerHTML = '';
    for (let i = 1; i <= result.squadCount; i++) {
      const tr = document.createElement('tr');
      tr.className = 'tc-row-squad';
      tr.innerHTML = `
        <td>${i}</td>
        <td>${fmt(result.perSquad.infantry)}</td>
        <td>${fmt(result.perSquad.cavalry)}</td>
        <td>${fmt(result.perSquad.archers)}</td>
        <td>${fmt(result.perSquad.total)}</td>
      `;
      tbody.appendChild(tr);
    }

    // 잔류 행 (노란색 배경)
    const r = result.remaining;
    const remTotal = r.infantry + r.cavalry + r.archers;
    const remTr = document.createElement('tr');
    remTr.className = 'tc-row-remaining';
    remTr.innerHTML = `
      <td data-i18n="gameTools.troopsCalculator.tableRemaining">${t('gameTools.troopsCalculator.tableRemaining')}</td>
      <td>${fmt(r.infantry)}</td>
      <td>${fmt(r.cavalry)}</td>
      <td>${fmt(r.archers)}</td>
      <td>${fmt(remTotal)}</td>
    `;
    tbody.appendChild(remTr);

    // 합계 행 (회색 배경) — 편대 사용량 + 잔류 = 보유 총량
    const sumInf = result.perSquad.infantry * result.squadCount + r.infantry;
    const sumCav = result.perSquad.cavalry * result.squadCount + r.cavalry;
    const sumArc = result.perSquad.archers * result.squadCount + r.archers;
    const sumAll = sumInf + sumCav + sumArc;
    const sumTr = document.createElement('tr');
    sumTr.className = 'tc-row-total';
    sumTr.innerHTML = `
      <td data-i18n="gameTools.troopsCalculator.tableSumRow">${t('gameTools.troopsCalculator.tableSumRow')}</td>
      <td>${fmt(sumInf)}</td>
      <td>${fmt(sumCav)}</td>
      <td>${fmt(sumArc)}</td>
      <td>${fmt(sumAll)}</td>
    `;
    tbody.appendChild(sumTr);
  }
}

function resetResult(): void {
  lastResult = null;
  const root = $('tc-result');
  if (root) root.setAttribute('hidden', '');
}

/** 저장된 입력값을 폼에 복원. 폼이 비어있는 상태일 때만 사용. */
function restoreFormFromStorage(form: HTMLFormElement): TroopsInput | null {
  const stored = loadInput();
  if (!stored) return null;
  const setText = (name: string, value: number) => {
    const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (el) el.value = value.toLocaleString('ko-KR');
  };
  setText('cap', stored.cap);
  setText('infantry', stored.infantry);
  setText('cavalry', stored.cavalry);
  setText('archers', stored.archers);
  const squad = form.querySelector<HTMLSelectElement>('select[name="squadCount"]');
  if (squad) squad.value = String(stored.squadCount);
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

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearError();
    const input = readForm(form);
    const error = validate(input);
    if (error) {
      showError(error);
      resetResult();
      return;
    }
    renderResult(calculateBearHunt(input));
    saveInput(input);
  });

  resetBtn?.addEventListener('click', () => {
    form.reset();
    // form.reset() 으로 input.value 가 초기 빈 문자열로 돌아감. [data-tc-number] 포맷터는
    // input 이벤트가 안 와서 그대로 빈 채 유지 — OK.
    clearError();
    resetResult();
    clearStoredInput();
  });

  // 언어 변경 시 — 마지막 결과의 라벨을 다시 그림
  onLangChange(() => {
    if (lastResult) renderResult(lastResult);
  });

  // 저장된 입력 복원 + 자동 재계산 (validate 통과 시).
  // 권한 없는 사용자는 가드가 form 자체를 숨기므로 여기까지 와도 시각적 영향 없음.
  const restored = restoreFormFromStorage(form);
  if (restored && validate(restored) === null) {
    renderResult(calculateBearHunt(restored));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
