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
  calculate,
  formatRatio,
  validate,
  type DistributionMode,
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

/** 저장 데이터 로드. v1(분배 모드 없음) 도 호환 — distribution 없으면 'bear' 기본. */
function loadState(): StoredState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Partial<TroopsInput> & {
      distribution?: DistributionMode;
      input?: Partial<TroopsInput>;
    };
    // v1.5 (StoredState 형식) 또는 v1 (raw TroopsInput) 모두 수용
    const src = obj.input ?? obj;
    if (
      typeof src.cap !== 'number' ||
      typeof src.infantry !== 'number' ||
      typeof src.cavalry !== 'number' ||
      typeof src.archers !== 'number' ||
      typeof src.squadCount !== 'number'
    ) {
      return null;
    }
    const distribution: DistributionMode =
      obj.distribution === 'even' ? 'even' : 'bear';
    return {
      input: {
        cap: src.cap,
        infantry: src.infantry,
        cavalry: src.cavalry,
        archers: src.archers,
        squadCount: src.squadCount,
      },
      distribution,
    };
  } catch {
    return null;
  }
}

function clearStoredState(): void {
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

function readForm(form: HTMLFormElement): { input: TroopsInput; distribution: DistributionMode } {
  const fd = new FormData(form);
  const distribution: DistributionMode = fd.get('distribution') === 'even' ? 'even' : 'bear';
  return {
    input: {
      cap: parseNumber(fd.get('cap')),
      infantry: parseNumber(fd.get('infantry')),
      cavalry: parseNumber(fd.get('cavalry')),
      archers: parseNumber(fd.get('archers')),
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

/** 저장된 상태(입력값 + 분배 모드) 를 폼에 복원. 폼이 비어있는 상태일 때만 사용. */
function restoreFormFromStorage(form: HTMLFormElement): StoredState | null {
  const stored = loadState();
  if (!stored) return null;
  const setText = (name: string, value: number) => {
    const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (el) el.value = value.toLocaleString('ko-KR');
  };
  setText('cap', stored.input.cap);
  setText('infantry', stored.input.infantry);
  setText('cavalry', stored.input.cavalry);
  setText('archers', stored.input.archers);
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
    // form.reset() 으로 input.value 가 초기 빈 문자열로 돌아감. [data-tc-number] 포맷터는
    // input 이벤트가 안 와서 그대로 빈 채 유지 — OK. select 는 default selected 옵션으로 복귀.
    clearError();
    resetResult();
    clearStoredState();
  });

  // 언어 변경 시 — 마지막 결과의 라벨을 다시 그림
  onLangChange(() => {
    if (lastResult) renderResult(lastResult);
  });

  // 저장된 입력 복원 + 자동 재계산 (validate 통과 시).
  // 권한 없는 사용자는 가드가 form 자체를 숨기므로 여기까지 와도 시각적 영향 없음.
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
