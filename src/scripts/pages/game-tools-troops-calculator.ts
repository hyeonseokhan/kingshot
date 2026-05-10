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

  // 표 본체 — N행 편대 + 잔류 + 합계.
  // 숫자 셀(.tc-num) 은 클릭 시 data-raw 의 raw 숫자가 클립보드로 복사됨 (게임 인풋용).
  const tbody = $('tc-table-body');
  if (tbody) {
    const numCell = (n: number) =>
      `<td class="tc-num" data-raw="${n}" tabindex="0" role="button" title="${t('gameTools.troopsCalculator.copyHint')}">${fmt(n)}</td>`;

    tbody.innerHTML = '';
    for (let i = 1; i <= result.squadCount; i++) {
      const tr = document.createElement('tr');
      tr.className = 'tc-row-squad';
      tr.innerHTML = `
        <td>${i}</td>
        ${numCell(result.perSquad.infantry)}
        ${numCell(result.perSquad.cavalry)}
        ${numCell(result.perSquad.archers)}
        ${numCell(result.perSquad.total)}
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
      ${numCell(r.infantry)}
      ${numCell(r.cavalry)}
      ${numCell(r.archers)}
      ${numCell(remTotal)}
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
      ${numCell(sumInf)}
      ${numCell(sumCav)}
      ${numCell(sumArc)}
      ${numCell(sumAll)}
    `;
    tbody.appendChild(sumTr);
  }
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

/** pointerdown 위임 — .tc-num 이면 짧은 강조 시작 (PC down + 모바일 touch 모두). */
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
    // 키보드 활성화 시에도 같은 강조 (마우스/터치 일관)
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

  // 결과 표 숫자 셀 — 클릭/터치 시 클립보드 복사. (이벤트 위임으로 tbody 재렌더 후에도 유지)
  // - pointerdown : 손가락/마우스 닿는 순간 짧은 시각 강조 (.tc-tap 120ms)
  // - click       : 복사 + 토스트
  // - keydown     : Enter/Space 키보드 활성화도 같은 동작
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
