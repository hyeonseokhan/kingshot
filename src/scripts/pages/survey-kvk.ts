/**
 * survey.kingshot.wooju-home.org/kvk 페이지 클라이언트 로직.
 *
 * 흐름:
 *   1) [+ 내 정보 등록 / 수정] 클릭 → 다이얼로그 (Step 1: ID 입력)
 *   2) [조회] → Edge Function lookup → 본인 정보 카드 + PIN 입력 (Step 2)
 *      - 미등록: 새 PIN 설정, [확인] → 폼 모드 진입 (서버 호출 X, 저장 시 register)
 *      - 등록됨: 기존 PIN, [확인] → verify → 기존 값 prefill → 폼 모드 진입
 *   3) 폼 입력 후 [저장] → register 또는 update
 *   4) 목록 갱신
 *
 * 모든 변경은 Edge Function `kvk-survey` 통과. 클라이언트는 PIN 평문을 매번 전송하되
 * 세션에는 저장 안 함 (탭 닫으면 사라지는 게 의도).
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import { patchList, patchText } from '@/lib/dom-diff';
import { t, onLangChange } from '@/i18n';

const FN_URL = SUPABASE_URL + '/functions/v1/kvk-survey';

interface SurveyRow {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  training: number;
  construction: number;
  general: number;
  updated_at: string;
}

interface PlayerInfo {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
}

type SortKey = 'training' | 'construction' | 'general' | 'total' | 'updated_at';

// ===== state =====

interface FormSession {
  player: PlayerInfo;
  pin: string;
  mode: 'register' | 'update';
  prefill?: { training: number; construction: number; general: number };
}

let session: FormSession | null = null;
let rowsCache: SurveyRow[] = [];
let sort: { key: SortKey; dir: 'asc' | 'desc' } = { key: 'total', dir: 'desc' };

// ===== DOM =====

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

// ===== API =====

async function callFn<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ===== 다이얼로그 제어 =====

function openAuthDialog(): void {
  const dlg = $<HTMLDialogElement>('sk-auth-dialog');
  resetAuthDialog();
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $<HTMLInputElement>('sk-id-input').focus(), 50);
}

function closeAuthDialog(): void {
  const dlg = $<HTMLDialogElement>('sk-auth-dialog');
  if (dlg.open) dlg.close();
}

function resetAuthDialog(): void {
  showAuthStep('id');
  ($('sk-id-input') as HTMLInputElement).value = '';
  setPinValue('');
  setStatus('sk-id-status', '');
  setStatus('sk-pin-status', '');
  setSearchBtnBusy(false);
}

// ===== PIN 박스 표시 =====

function syncPinBoxes(): void {
  const input = $<HTMLInputElement>('sk-pin-input');
  const boxes = $('sk-pin-boxes').children;
  const len = input.value.length;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i] as HTMLElement;
    const filled = i < len;
    box.classList.toggle('sk-pin-box-filled', filled);
    box.classList.toggle('sk-pin-box-active', i === len && document.activeElement === input);
    box.textContent = filled ? '•' : '';
  }
}

function setPinValue(v: string): void {
  const input = $<HTMLInputElement>('sk-pin-input');
  input.value = v;
  syncPinBoxes();
}

function showAuthStep(step: 'id' | 'confirm'): void {
  ($('sk-step-id') as HTMLElement).hidden = step !== 'id';
  ($('sk-step-confirm') as HTMLElement).hidden = step !== 'confirm';
}

function setStatus(id: string, msg: string, kind: 'ok' | 'err' | '' = ''): void {
  const el = $(id);
  el.textContent = msg;
  el.className = 'sk-status' + (kind ? ' sk-status-' + kind : '');
}

function setSearchBtnBusy(busy: boolean): void {
  const btn = $<HTMLButtonElement>('sk-id-search');
  btn.disabled = busy;
  btn.textContent = busy ? t('survey.kvk.auth.searchingButton') : t('survey.kvk.auth.searchButton');
}

function fillPlayerCard(prefix: 'sk-player' | 'sk-form', player: PlayerInfo): void {
  const name = $(prefix + '-name');
  const idEl = $(prefix + '-id');
  const photo = $(prefix + '-photo') as HTMLImageElement;
  const empty = $(prefix + '-photo-empty');

  patchText(name, player.nickname);
  patchText(idEl, '#' + player.kingshot_id);
  empty.textContent = player.nickname.charAt(0).toUpperCase();
  if (player.avatar_url) {
    if (photo.src !== player.avatar_url) {
      photo.src = player.avatar_url;
      photo.onload = () => {
        photo.hidden = false;
        empty.style.opacity = '0';
      };
    } else {
      photo.hidden = false;
      empty.style.opacity = '0';
    }
  } else {
    photo.hidden = true;
    photo.removeAttribute('src');
    empty.style.opacity = '1';
  }
}

// ===== 흐름: ID 조회 =====

async function onSearchId(): Promise<void> {
  const idInput = $<HTMLInputElement>('sk-id-input');
  const id = idInput.value.trim();
  if (!/^\d{4,15}$/.test(id)) {
    setStatus('sk-id-status', t('survey.kvk.auth.errors.invalidId'), 'err');
    return;
  }
  setSearchBtnBusy(true);
  setStatus('sk-id-status', '');
  try {
    const json = await callFn<{
      ok: boolean;
      error?: string;
      player?: PlayerInfo;
      registered?: boolean;
    }>({ action: 'lookup', kingshot_id: id });
    if (!json.ok || !json.player) {
      setStatus('sk-id-status', mapError(json.error), 'err');
      return;
    }
    // step 2 로
    fillPlayerCard('sk-player', json.player);
    const hint = $('sk-pin-hint');
    if (json.registered) {
      hint.textContent = t('survey.kvk.auth.pinHintExisting');
      hint.className = 'sk-pin-hint sk-pin-hint-existing';
    } else {
      hint.textContent = t('survey.kvk.auth.pinHintNew');
      hint.className = 'sk-pin-hint';
    }
    session = {
      player: json.player,
      pin: '',
      mode: json.registered ? 'update' : 'register',
    };
    showAuthStep('confirm');
    setTimeout(() => $<HTMLInputElement>('sk-pin-input').focus(), 50);
  } catch (err) {
    setStatus('sk-id-status', mapError(String((err as Error).message)), 'err');
  } finally {
    setSearchBtnBusy(false);
  }
}

// ===== 흐름: PIN 확인 =====

async function onConfirmPin(): Promise<void> {
  if (!session) return;
  const pinInput = $<HTMLInputElement>('sk-pin-input');
  const pin = pinInput.value.trim();
  if (!/^\d{4}$/.test(pin)) {
    setStatus('sk-pin-status', t('survey.kvk.auth.errors.invalidPin'), 'err');
    return;
  }
  setStatus('sk-pin-status', '');

  if (session.mode === 'register') {
    // 신규 등록: PIN 만 메모리에 보관 → 폼 모드 진입 (서버 호출은 저장 시점)
    session.pin = pin;
    enterFormMode();
    return;
  }

  // 기존 사용자: PIN 검증
  const json = await callFn<{
    ok: boolean;
    error?: string;
    record?: SurveyRow;
  }>({ action: 'verify', kingshot_id: session.player.kingshot_id, pin });
  if (!json.ok || !json.record) {
    setStatus('sk-pin-status', mapError(json.error), 'err');
    return;
  }
  session.pin = pin;
  session.prefill = {
    training: json.record.training,
    construction: json.record.construction,
    general: json.record.general,
  };
  enterFormMode();
}

// ===== 흐름: 폼 모드 진입/저장 =====

function enterFormMode(): void {
  if (!session) return;
  closeAuthDialog();
  const sec = $('sk-form-section');
  sec.hidden = false;
  fillPlayerCard('sk-form', session.player);
  setNumericInputValue('sk-input-general', session.prefill?.general ?? null);
  setNumericInputValue('sk-input-training', session.prefill?.training ?? null);
  setNumericInputValue('sk-input-construction', session.prefill?.construction ?? null);
  setStatus('sk-form-status', '');
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $<HTMLInputElement>('sk-input-general').focus(), 250);
}

function exitFormMode(): void {
  $('sk-form-section').hidden = true;
  session = null;
}

/** 콤마 포함된 input value 에서 raw 정수 추출. 잘못된 값이면 NaN. */
function parseNumericInput(id: string): number {
  const raw = ($(id) as HTMLInputElement).value.replace(/,/g, '').trim();
  if (raw === '') return NaN;
  return parseInt(raw, 10);
}

/** 숫자 input 에 raw 값 셋팅 — null 이면 빈칸. 자동 콤마 포맷 적용. */
function setNumericInputValue(id: string, n: number | null): void {
  const el = $(id) as HTMLInputElement;
  el.value = n === null ? '' : formatNum(n);
}

/** input event 핸들러 — 입력 중에도 콤마 자동 유지. caret 위치 보존. */
function onNumericInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  const before = el.value;
  const caret = el.selectionStart ?? before.length;
  // 콤마 제외하고 caret 앞에 숫자 몇 개 있는지 — caret 재계산 기준
  const digitsBeforeCaret = before.slice(0, caret).replace(/[^0-9]/g, '').length;
  const digitsOnly = before.replace(/[^0-9]/g, '');
  if (digitsOnly === '') {
    el.value = '';
    return;
  }
  // 9999999 cap
  const n = Math.min(9_999_999, parseInt(digitsOnly, 10));
  const next = formatNum(n);
  if (next === before) return;
  el.value = next;
  // caret 복원
  let p = 0;
  let seen = 0;
  for (; p < next.length && seen < digitsBeforeCaret; p++) {
    if (/[0-9]/.test(next[p]!)) seen++;
  }
  el.setSelectionRange(p, p);
}

function readFormValues(): { training: number; construction: number; general: number } | null {
  const tr = parseNumericInput('sk-input-training');
  const co = parseNumericInput('sk-input-construction');
  const ge = parseNumericInput('sk-input-general');
  if (![tr, co, ge].every((v) => Number.isInteger(v) && v >= 0 && v <= 9_999_999)) return null;
  return { training: tr, construction: co, general: ge };
}

async function onSaveForm(): Promise<void> {
  if (!session) return;
  const values = readFormValues();
  if (!values) {
    setStatus('sk-form-status', t('survey.kvk.form.errors.invalidAmount'), 'err');
    return;
  }
  const btn = $<HTMLButtonElement>('sk-form-save');
  btn.disabled = true;
  setStatus('sk-form-status', t('survey.kvk.form.saving'), '');
  try {
    const action = session.mode === 'register' ? 'register' : 'update';
    const json = await callFn<{ ok: boolean; error?: string }>({
      action,
      kingshot_id: session.player.kingshot_id,
      pin: session.pin,
      ...values,
    });
    if (!json.ok) {
      setStatus('sk-form-status', mapError(json.error), 'err');
      btn.disabled = false;
      return;
    }
    setStatus('sk-form-status', t('survey.kvk.form.saved'), 'ok');
    await refreshList();
    setTimeout(() => exitFormMode(), 600);
  } catch (err) {
    setStatus('sk-form-status', mapError(String((err as Error).message)), 'err');
    btn.disabled = false;
  } finally {
    btn.disabled = false;
  }
}

// ===== 목록 =====

async function refreshList(): Promise<void> {
  const loadingEl = $('sk-loading');
  loadingEl.hidden = false;
  try {
    const json = await callFn<{ ok: boolean; items?: SurveyRow[] }>({ action: 'list' });
    if (json.ok && json.items) {
      rowsCache = json.items;
      renderList();
    }
  } finally {
    loadingEl.hidden = true;
  }
}

function renderList(): void {
  const tbody = $('sk-tbody');
  const sorted = sortRows(rowsCache, sort);
  const empty = $('sk-empty');
  empty.hidden = sorted.length > 0;

  patchText($('sk-list-count'), t('survey.kvk.list.count', { n: sorted.length }));

  patchList<SurveyRow & { rank: number }>({
    container: tbody,
    items: sorted.map((r, i) => ({ ...r, rank: i + 1 })),
    key: (r) => r.kingshot_id,
    render: (r) => buildRow(r),
    update: (el, r) => updateRow(el, r),
  });

  // sort 활성 표시 — 화살표 없음, 색상/굵기만 변경
  document.querySelectorAll<HTMLElement>('.sk-sort-btn').forEach((btn) => {
    btn.dataset.active = btn.dataset.sort === sort.key ? 'true' : 'false';
  });
}

function sortRows(rows: SurveyRow[], s: typeof sort): SurveyRow[] {
  const out = rows.slice();
  out.sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    if (s.key === 'total') {
      av = a.training + a.construction + a.general;
      bv = b.training + b.construction + b.general;
    } else if (s.key === 'updated_at') {
      av = Date.parse(a.updated_at);
      bv = Date.parse(b.updated_at);
    } else {
      av = a[s.key];
      bv = b[s.key];
    }
    return s.dir === 'asc' ? (av < bv ? -1 : av > bv ? 1 : 0) : av < bv ? 1 : av > bv ? -1 : 0;
  });
  return out;
}

function buildRow(r: SurveyRow & { rank: number }): HTMLElement {
  const tr = document.createElement('tr');
  tr.className = 'sk-tr';
  tr.innerHTML = `
    <td class="sk-td sk-td-rank"></td>
    <td class="sk-td sk-td-player">
      <div class="sk-row-player">
        <div class="sk-row-photo-wrap">
          <div class="sk-row-photo-empty"></div>
          <img class="sk-row-photo" hidden alt="" />
        </div>
        <div class="sk-row-meta">
          <div class="sk-row-name"></div>
          <div class="sk-row-id"></div>
        </div>
      </div>
    </td>
    <td class="sk-td sk-td-num sk-td-general"></td>
    <td class="sk-td sk-td-num sk-td-training"></td>
    <td class="sk-td sk-td-num sk-td-construction"></td>
    <td class="sk-td sk-td-num sk-td-total"></td>
    <td class="sk-td sk-td-time sk-td-updated"></td>
    <td class="sk-td sk-td-actions">
      <button type="button" class="sk-btn sk-btn-secondary sk-btn-small sk-edit-btn"
        data-i18n="survey.kvk.list.editButton">수정</button>
    </td>
  `;
  updateRow(tr, r);
  return tr;
}

function updateRow(tr: HTMLElement, r: SurveyRow & { rank: number }): void {
  patchText(tr.querySelector<HTMLElement>('.sk-td-rank'), String(r.rank));
  patchText(tr.querySelector<HTMLElement>('.sk-row-name'), r.nickname);
  patchText(tr.querySelector<HTMLElement>('.sk-row-id'), '#' + r.kingshot_id);
  const total = r.training + r.construction + r.general;
  patchText(tr.querySelector<HTMLElement>('.sk-td-general'), formatDuration(r.general));
  patchText(tr.querySelector<HTMLElement>('.sk-td-training'), formatDuration(r.training));
  patchText(tr.querySelector<HTMLElement>('.sk-td-construction'), formatDuration(r.construction));
  patchText(tr.querySelector<HTMLElement>('.sk-td-total'), formatDuration(total));
  patchText(tr.querySelector<HTMLElement>('.sk-td-updated'), formatTime(r.updated_at));

  const empty = tr.querySelector<HTMLElement>('.sk-row-photo-empty')!;
  const img = tr.querySelector<HTMLImageElement>('.sk-row-photo')!;
  empty.textContent = r.nickname.charAt(0).toUpperCase();
  if (r.avatar_url) {
    if (img.src !== r.avatar_url) {
      img.src = r.avatar_url;
      img.onload = () => {
        img.hidden = false;
        empty.style.opacity = '0';
      };
    }
  } else {
    img.hidden = true;
    empty.style.opacity = '1';
  }

  const editBtn = tr.querySelector<HTMLButtonElement>('.sk-edit-btn')!;
  editBtn.textContent = t('survey.kvk.list.editButton');
  editBtn.onclick = () => onEditRow(r.kingshot_id);
}

function onEditRow(kingshotId: string): void {
  // 수정 흐름은 일반 등록 흐름과 동일 — 다이얼로그 → ID 자동 입력 + 조회
  openAuthDialog();
  ($('sk-id-input') as HTMLInputElement).value = kingshotId;
  onSearchId();
}

// ===== 정렬 클릭 =====

function onSortClick(key: SortKey): void {
  if (sort.key === key) {
    sort = { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    // 숫자형은 desc 가 기본, 시간은 desc, 이름/순위는 asc
    sort = { key, dir: 'desc' };
  }
  renderList();
}

// ===== util =====

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

/** 분 단위 정수 → "NNd NNh NNm" 표기. 0 이면 "0m". 일/시간 단위가 0 이어도 명시. */
function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '-';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  // 가독성 위해 천 단위 콤마 (일 단위가 큰 값일 때만 의미)
  const dStr = formatNum(d);
  return `${dStr}d ${h}h ${m}m`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yy}-${mm}-${dd} ${hh}:${mi}`;
}

// ===== 이미지 다이얼로그 =====

function openImageDialog(): void {
  const dlg = $<HTMLDialogElement>('sk-image-dialog');
  if (!dlg.open) dlg.showModal();
}

function closeImageDialog(): void {
  const dlg = $<HTMLDialogElement>('sk-image-dialog');
  if (dlg.open) dlg.close();
}

function mapError(code: string | null | undefined): string {
  switch (code) {
    case 'invalid_id':
      return t('survey.kvk.auth.errors.invalidId');
    case 'invalid_pin':
      return t('survey.kvk.auth.errors.invalidPin');
    case 'player_not_found':
      return t('survey.kvk.auth.errors.playerNotFound');
    case 'not_registered':
      return t('survey.kvk.auth.errors.notRegistered');
    case 'already_registered':
      return t('survey.kvk.auth.errors.alreadyRegistered');
    case 'invalid_amount':
      return t('survey.kvk.form.errors.invalidAmount');
    default:
      return t('survey.kvk.errors.generic') + (code ? ` (${code})` : '');
  }
}

// ===== boot =====

function init(): void {
  // 시작 다이얼로그
  $('sk-list-add').addEventListener('click', openAuthDialog);
  $('sk-auth-close').addEventListener('click', closeAuthDialog);
  $('sk-id-search').addEventListener('click', onSearchId);
  $('sk-id-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      onSearchId();
    }
  });
  $('sk-pin-back').addEventListener('click', () => {
    showAuthStep('id');
    setStatus('sk-pin-status', '');
    session = null;
  });
  $('sk-pin-confirm').addEventListener('click', onConfirmPin);

  // PIN 박스 동기화 — input/focus/blur 모두 박스 갱신
  const pinInput = $<HTMLInputElement>('sk-pin-input');
  pinInput.addEventListener('input', () => {
    // 숫자만 유지
    pinInput.value = pinInput.value.replace(/[^0-9]/g, '').slice(0, 4);
    syncPinBoxes();
  });
  pinInput.addEventListener('focus', syncPinBoxes);
  pinInput.addEventListener('blur', syncPinBoxes);
  pinInput.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      onConfirmPin();
    }
  });
  // wrap 클릭 시 input 으로 focus
  $('sk-pin-wrap').addEventListener('click', () => pinInput.focus());

  // 폼
  $('sk-form-cancel').addEventListener('click', exitFormMode);
  $('sk-form-save').addEventListener('click', onSaveForm);

  // 폼 input — 입력 중 천 단위 콤마 자동 포맷
  ['sk-input-general', 'sk-input-training', 'sk-input-construction'].forEach((id) => {
    $(id).addEventListener('input', onNumericInput);
  });

  // 가속권 도움말 이미지 다이얼로그
  $('sk-help-image-trigger').addEventListener('click', openImageDialog);
  // 다이얼로그 어디 클릭하든 닫힘 (이미지 자체 포함)
  $('sk-image-dialog').addEventListener('click', closeImageDialog);

  // 목록
  $('sk-list-refresh').addEventListener('click', refreshList);

  // 정렬
  document.querySelectorAll<HTMLButtonElement>('.sk-sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort as SortKey | undefined;
      if (!key) return;
      onSortClick(key);
    });
  });

  // 언어 변경 시 동적 텍스트 재렌더
  onLangChange(() => {
    renderList();
    setSearchBtnBusy(false); // 버튼 라벨 갱신
  });

  refreshList();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
