/**
 * survey.kingshot.wooju-home.org/kvk-buff 페이지 클라이언트 로직.
 *
 * 흐름:
 *   1) boot → localStorage 의 토큰으로 get-state 호출 (token 옵션)
 *   2) 5초마다 polling (서버 state 와 sync, stale 충돌 회복)
 *   3) 본인 차례면 slot-card 클릭 → confirm → pick-slot RPC
 *   4) admin 이면 skip / swap 버튼 활성 (자동, is_admin 기반)
 *
 * 모든 변경은 Edge Function `kvk-buff` 통과. RPC 가 atomic 처리.
 * 마감 전 (UTC 5/16 01:00) 이면 잠금 placeholder.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import { t, onLangChange } from '@/i18n';

const FN_URL = SUPABASE_URL + '/functions/v1/kvk-buff';

// !!! TEST_MODE — 관리자 필드 테스트용 분기. 종료 후 제거 대상 !!!
//   활성화 경로 두 가지:
//     1) URL 쿼리 ?test=1 — 페이지 로드 시 자동 활성 (기존 패턴)
//     2) survey-kvk.ts 의 [테스트] 버튼 클릭 → setBuffTestMode(true) + openBuffOverlay() (admin 전용)
//   영향:
//     - SURVEY_DEADLINE_ISO 가드 무시 → 잠금 placeholder skip, 즉시 그리드 표시.
//     - callFn body 에 test_mode: true 자동 동봉 → Edge Function 이 _test 테이블/RPC 사용.
//     - TOTAL_SLOTS 가 6 으로 축소 (admin 6명 전원 1슬롯씩 시나리오).
//   인증은 운영 그대로 (kvk_speedup_survey 의 본인 PIN 으로 로그인).
//   제거: `TEST_MODE` 키워드 grep → 본 분기 + survey-kvk.ts + Edge Function + 마이그레이션 ROLLBACK.
let testMode = typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('test');
const SURVEY_DEADLINE_ISO = '2026-05-16T01:00:00Z';
const TEST_TOTAL_SLOTS = 6;
const PROD_TOTAL_SLOTS = 48;

/** 외부(survey-kvk.ts) 가 [테스트] 버튼 클릭 시 호출 — 다이얼로그를 격리 모드로 진입.
 *  setupBuffDialog() 한 번 호출 후 매번 토글 가능. */
export function setBuffTestMode(v: boolean): void {
  testMode = v;
}

function totalSlots(): number {
  return testMode ? TEST_TOTAL_SLOTS : PROD_TOTAL_SLOTS;
}

const POLL_INTERVAL_MS = 5000;

/** localStorage key — 가속권 현황 조사 페이지의 토큰을 그대로 공유. */
const AUTH_KEY = 'pnx-sk-auth-v1';

interface BuffState {
  bootstrapped_at: string | null;
  current_turn_idx: number;
  turn_started_at: string | null;
  finalized_at: string | null; // admin "예약 마감" 호출 시각. NULL=진행 중.
  updated_at: string;
}

interface Participant {
  kingshot_id: string;
  turn_idx: number;
  score_rank: number;
  was_verified: boolean;
  slot_idx: number | null;
  picked_at: string | null;
  survey: {
    nickname: string;
    avatar_url: string | null;
    city_level: number;
  } | null;
}

interface Me {
  kingshot_id: string;
  nickname: string;
  is_admin: boolean;
  turn_idx?: number;
  slot_idx?: number | null;
}

interface StateResponse {
  ok: boolean;
  deadline: string;
  state: BuffState | null;
  participants: Participant[];
  me: Me | null;
  error?: string;
}

// ===== state =====
let buffState: BuffState | null = null;
let participants: Participant[] = [];
let me: Me | null = null;
let token: string | null = null;
let tzMode: 'UTC' | 'KST' = 'KST';
let pendingSlotIdx: number | null = null; // confirm 다이얼로그 대기 중 slot idx
// swap selection — DOM element 가 아닌 slot_idx 값으로 보존.
// (이전엔 swapSourceCard:HTMLElement 였는데 5초 polling 의 renderGrid 가 grid.innerHTML='' 로
//  통째 재생성하면서 detached element 되어 두 번째 클릭 시 swap 시작점을 잃는 회귀 발생.)
// 값 보존 + renderGrid 후 슬롯 카드에 .is-swap-source 재마킹 → polling 무관 selection 유지.
let swapSourceSlotIdx: number | null = null;
let pendingSwapTargetSlotIdx: number | null = null;
let pollingTimer: number | null = null;
let elapsedTimer: number | null = null;
let countdownTimer: number | null = null;

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
    // !!! TEST_MODE — 모든 액션 body 에 test_mode 자동 동봉 (서버에서 _test 분기) !!!
    body: JSON.stringify({ ...body, test_mode: testMode }),
  });
  return res.json();
}

function loadToken(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return typeof obj?.token === 'string' ? obj.token : null;
  } catch {
    return null;
  }
}

// ===== 시간 포맷 =====
function formatSlotTime(idx: number, mode: 'UTC' | 'KST'): string {
  const utcH = Math.floor(idx / 2);
  const m = (idx % 2) * 30;
  const h = mode === 'KST' ? (utcH + 9) % 24 : utcH;
  return `${mode} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function tzToggleLabel(mode: 'UTC' | 'KST'): string {
  return mode === 'KST' ? 'KST → UTC' : 'UTC → KST';
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ===== 렌더링 =====
function renderAll(): void {
  applyAdminClass();
  renderLocked();
  renderCurrent();
  renderGrid();
}

/** localStorage 의 auth.record.is_admin 캐시 — 다이얼로그 오픈 직후 첫 polling 응답 도착 전
 *  스킵/swap 등 admin UI 가 깜빡이지 않도록 fallback 으로 사용. AUTH_KEY 는 survey-kvk.ts 와 일치. */
function readCachedIsAdmin(): boolean {
  try {
    const raw = localStorage.getItem('pnx-sk-auth-v1');
    if (!raw) return false;
    return JSON.parse(raw)?.record?.is_admin === true;
  } catch {
    return false;
  }
}

function applyAdminClass(): void {
  const page = $('sk-buff-page');
  // me (kvk-buff get-state 응답) 가 우선, 없으면 (다이얼로그 오픈 직후 race) 캐시 fallback.
  const isAdmin = me?.is_admin === true || (me === null && readCachedIsAdmin());
  page.classList.toggle('is-admin', isAdmin);
  // 예약 마감 상태 — CSS 로 [예약 마감] 버튼 숨김 + 향후 마감 배지/안내 노출 hooks.
  page.classList.toggle('is-finalized', !!buffState?.finalized_at);
  // TEST_MODE — page + overlay 양쪽에 토글. overlay 는 head 영역의 [TEST] 라벨/[재시작] 게이트용.
  page.classList.toggle('is-test', testMode);
  document.getElementById('sk-buff-overlay')?.classList.toggle('is-test', testMode);
}

function renderLocked(): void {
  const locked = $('sk-buff-locked');
  const grid = $('sk-buff-grid');
  const current = $('sk-buff-current');
  // !!! TEST_MODE — 테스트는 deadline 무시 (즉시 bootstrap 가능). 운영만 deadline 가드. !!!
  const isBeforeDeadline = !testMode && new Date() < new Date(SURVEY_DEADLINE_ISO);
  const notBootstrapped = !buffState?.bootstrapped_at;
  const showLocked = isBeforeDeadline || notBootstrapped;
  locked.hidden = !showLocked;
  grid.hidden = showLocked;
  current.hidden = showLocked;
  if (showLocked) {
    const body = $('sk-buff-locked-body');
    body.textContent = isBeforeDeadline
      ? t('survey.kvkBuff.locked.bodyBeforeDeadline')
      : t('survey.kvkBuff.locked.bodyBootstrap');
  }
}

function renderCurrent(): void {
  const card = $('sk-buff-current');
  // 마감 분기 — admin 이 [예약 마감] 누른 후. "선택중" 영역 + 타이머 정지 + 별도 메시지.
  // .is-completed 도 같이 부여 → 기존 완료 시 시각 효과(스킵 버튼 숨김 등) 자동 적용.
  if (buffState?.finalized_at) {
    card.classList.add('is-completed');
    card.classList.add('is-finalized');
    card.classList.remove('is-expanded');
    return;
  }
  card.classList.remove('is-finalized');
  // 완료 판정 — current_turn_idx 가 max(turn_idx)+1 이상이면 모든 참가자 끝.
  // 5명 테스트 (turn_idx 0~4) 의 경우 5 도달 시 완료. 48명 운영의 경우 48 도달 시 완료.
  const maxTurn = participants.length > 0
    ? Math.max(...participants.map((p) => p.turn_idx))
    : -1;
  if (!buffState || buffState.current_turn_idx > maxTurn) {
    card.classList.add('is-completed');
    card.classList.remove('is-expanded');
    return;
  }
  card.classList.remove('is-completed');
  const cur = participants.find((p) => p.turn_idx === buffState!.current_turn_idx);
  if (!cur || !cur.survey) return;
  ($('sk-buff-current-photo-empty') as HTMLElement).textContent = cur.survey.nickname.charAt(0).toUpperCase();
  const photo = $<HTMLImageElement>('sk-buff-current-photo');
  if (cur.survey.avatar_url) {
    if (photo.src !== cur.survey.avatar_url) photo.src = cur.survey.avatar_url;
    photo.hidden = false;
  } else {
    photo.hidden = true;
    photo.removeAttribute('src');
  }
  $('sk-buff-current-name').textContent = cur.survey.nickname;
  $('sk-buff-current-id').textContent = `#${cur.kingshot_id} · TC ${cur.survey.city_level}`;

  // 다음 차례 큐 — current+1 부터 5명
  const queue = $('sk-buff-current-queue');
  queue.innerHTML = '';
  const next = participants
    .filter((p) => p.turn_idx > buffState!.current_turn_idx)
    .sort((a, b) => a.turn_idx - b.turn_idx)
    .slice(0, 5);
  if (next.length === 0) {
    const li = document.createElement('li');
    li.className = 'sk-buff-queue-empty';
    li.textContent = t('survey.kvkBuff.queueEmpty');
    queue.appendChild(li);
  } else {
    for (const p of next) {
      const li = document.createElement('li');
      li.textContent = p.survey?.nickname ?? p.kingshot_id;
      queue.appendChild(li);
    }
  }
}

function renderGrid(): void {
  const grid = $('sk-buff-grid');
  if (!buffState) {
    grid.innerHTML = '';
    return;
  }
  const occupied = new Map<number, Participant>();
  for (const p of participants) {
    if (p.slot_idx !== null) occupied.set(p.slot_idx, p);
  }
  // mockup 처럼 fragment 단위로 재구성. 갱신 잦지만 48개라 부담 X.
  grid.innerHTML = '';
  const slots = totalSlots();
  for (let i = 0; i < slots; i++) {
    const card = document.createElement('div');
    card.className = 'sk-buff-slot';
    card.dataset.slotIdx = String(i);
    const time = formatSlotTime(i, tzMode);
    const holder = occupied.get(i);
    if (holder) {
      const letter = escapeHtml(holder.survey?.nickname.charAt(0).toUpperCase() ?? '?');
      const avatar = holder.survey?.avatar_url ?? '';
      // letter placeholder 항상 깔고, avatar_url 있으면 img 로 위에 stack (grid:1/1).
      // img 가 늦게 로드되더라도 빈 자리/깜박임 없음.
      const photoHtml = avatar
        ? `<span class="sk-buff-slot-photo-letter">${letter}</span><img class="sk-buff-slot-photo-img" src="${escapeHtml(avatar)}" alt="" loading="lazy" />`
        : `<span class="sk-buff-slot-photo-letter">${letter}</span>`;
      card.innerHTML = `
        <span class="sk-buff-slot-time">${time}</span>
        <div class="sk-buff-slot-holder">
          <div class="sk-buff-slot-photo">${photoHtml}</div>
          <div class="sk-buff-slot-meta">
            <div class="sk-buff-slot-name">${escapeHtml(holder.survey?.nickname ?? holder.kingshot_id)}</div>
            <div class="sk-buff-slot-id">#${holder.kingshot_id}</div>
          </div>
        </div>
      `;
    } else {
      card.classList.add('is-selectable');
      card.innerHTML = `
        <span class="sk-buff-slot-time">${time}</span>
        <span class="sk-buff-slot-id">${t('survey.kvkBuff.slotEmpty')}</span>
      `;
    }
    grid.appendChild(card);
  }
  // polling 으로 grid 재생성된 후에도 admin swap selection 유지 — slot_idx 로 새 카드에 재마킹.
  if (swapSourceSlotIdx !== null) {
    grid.querySelector(`.sk-buff-slot[data-slot-idx="${swapSourceSlotIdx}"]`)
      ?.classList.add('is-swap-source');
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ===== 카운트다운 (turn_started_at 기준 경과) =====
function tickElapsed(): void {
  if (!buffState?.turn_started_at || (buffState.current_turn_idx >= totalSlots())) {
    $('sk-buff-current-elapsed').textContent = '';
    return;
  }
  const ms = Date.now() - new Date(buffState.turn_started_at).getTime();
  $('sk-buff-current-elapsed').textContent = formatElapsed(ms);
}

// ===== polling =====
async function pollState(): Promise<void> {
  try {
    const res = await callFn<StateResponse>({ action: 'get-state', token });
    if (!res.ok) return;
    buffState = res.state;
    participants = res.participants ?? [];
    me = res.me;
    renderAll();
  } catch (e) {
    console.error('poll failed', e);
  }
}

// ===== 슬롯 클릭 (pick / admin swap) =====
function onGridClick(e: Event): void {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.sk-buff-slot');
  if (!card) return;
  const slotIdx = Number(card.dataset.slotIdx);
  if (Number.isNaN(slotIdx)) return;

  // 마감 가드 — RPC 도 'finalized' 로 reject 하지만, UI 차원에서 confirm 다이얼로그 자체가
  // 안 뜨도록 차단 (swap 흐름의 첫 번째 클릭 후 마감된 경우 두 번째 클릭에서 dialog 가 떴던 회귀 막음).
  if (buffState?.finalized_at) {
    clearSwapSelection();
    return;
  }

  // (a) 빈 슬롯 — 본인 차례일 때만 pick confirm
  if (card.classList.contains('is-selectable')) {
    if (!me || !buffState) return;
    if (me.turn_idx !== buffState.current_turn_idx) {
      alert(t('survey.kvkBuff.error.notYourTurn'));
      return;
    }
    pendingSlotIdx = slotIdx;
    $('sk-buff-confirm-time').textContent = formatSlotTime(slotIdx, tzMode);
    const dlg = $<HTMLDialogElement>('sk-buff-confirm-dialog');
    if (!dlg.open) dlg.showModal();
    return;
  }

  // (b) 점유 슬롯 — admin 모드일 때만 swap
  if (!me?.is_admin) return;
  if (swapSourceSlotIdx === null) {
    swapSourceSlotIdx = slotIdx;
    card.classList.add('is-swap-source');
    return;
  }
  if (swapSourceSlotIdx === slotIdx) {
    // 같은 슬롯 다시 클릭 → 선택 해제
    card.classList.remove('is-swap-source');
    swapSourceSlotIdx = null;
    return;
  }
  // 두 번째 점유 슬롯 → swap confirm
  const sourceCard = document.querySelector<HTMLElement>(
    `.sk-buff-slot[data-slot-idx="${swapSourceSlotIdx}"]`,
  );
  const a = sourceCard?.querySelector<HTMLElement>('.sk-buff-slot-name')?.textContent ?? '';
  const b = card.querySelector<HTMLElement>('.sk-buff-slot-name')?.textContent ?? '';
  pendingSwapTargetSlotIdx = slotIdx;
  $('sk-buff-swap-body').textContent = t('survey.kvkBuff.confirm.swapBody', { a, b });
  $<HTMLDialogElement>('sk-buff-swap-dialog').showModal();
}

function clearSwapSelection(): void {
  // 모든 카드의 is-swap-source 제거 (현재 source 카드 또는 polling 으로 재생성된 것 모두 cover).
  document.querySelectorAll('.sk-buff-slot.is-swap-source')
    .forEach((el) => el.classList.remove('is-swap-source'));
  swapSourceSlotIdx = null;
  pendingSwapTargetSlotIdx = null;
}

/**
 * 서버 응답의 error 코드를 i18n 키로 찾아 친화적 메시지로 alert.
 *
 *   - 알려진 코드(turn_changed, slot_taken, …) → 해당 i18n 메시지
 *   - 미정의 키 (Edge Function 의 unexpected_error 포함, 또는 신규 코드가 사전에 미반영) →
 *     `survey.kvkBuff.error.unexpected_error` 로 fallback. raw 코드/JSON 절대 노출 안 함.
 *
 * t() 가 키 못 찾으면 key 자체 (문자열) 를 반환하는 동작을 활용해 fallback 분기.
 */
function alertError(errorCode: string | undefined): void {
  const code = errorCode ?? 'unexpected_error';
  const key = 'survey.kvkBuff.error.' + code;
  const translated = t(key);
  if (translated === key) {
    // i18n 사전에 키 없음 → unexpected_error 메시지 노출. console 에는 원본 코드 기록.
    console.warn('[kvk-buff] unmapped error code:', code);
    alert(t('survey.kvkBuff.error.unexpected_error'));
    return;
  }
  alert(translated);
}

// ===== confirm: pick slot =====
async function onPickConfirm(): Promise<void> {
  if (pendingSlotIdx === null || !buffState) return;
  const dlg = $<HTMLDialogElement>('sk-buff-confirm-dialog');
  const res = await callFn<{ ok: boolean; error?: string }>({
    action: 'pick-slot',
    token,
    slot_idx: pendingSlotIdx,
    expected_turn_idx: buffState.current_turn_idx,
  });
  pendingSlotIdx = null;
  dlg.close();
  if (!res.ok) {
    alertError(res.error);
  }
  await pollState();
}

// ===== admin: skip =====
async function onSkipConfirm(): Promise<void> {
  if (!buffState) return;
  const dlg = $<HTMLDialogElement>('sk-buff-skip-dialog');
  const res = await callFn<{ ok: boolean; error?: string }>({
    action: 'admin-skip',
    token,
    expected_turn_idx: buffState.current_turn_idx,
  });
  dlg.close();
  if (!res.ok) alertError(res.error);
  await pollState();
}

/** admin: 예약 마감 — confirm 후 state.finalized_at 세팅. 시스템 confirm() 사용 (페이지 일관). */
async function onFinalizeClick(): Promise<void> {
  if (!me?.is_admin) return;
  if (!confirm(t('survey.kvkBuff.confirm.finalize'))) return;
  const res = await callFn<{ ok: boolean; error?: string }>({ action: 'finalize', token });
  if (!res.ok) {
    alertError(res.error);
    return;
  }
  await pollState();
}

/** !!! TEST_MODE — _test 참가자 + state reset. confirm 후 실행. */
async function onResetTestClick(): Promise<void> {
  if (!testMode) return;
  if (!confirm(t('survey.kvkBuff.test.resetConfirm'))) return;
  // token 동봉 누락 시 Edge Function 의 authenticate(token) 가 invalid_token 으로 reject →
  // 사용자에겐 "가속권 현황 조사에서 먼저 로그인" 안내가 잘못 노출됨. 다른 admin 액션과 동일하게 token 전달.
  const res = await callFn<{ ok: boolean; error?: string }>({ action: 'admin-reset-test', token });
  if (!res.ok) {
    alertError(res.error);
    return;
  }
  await pollState();
}

function openSkipDialog(): void {
  if (!buffState || buffState.current_turn_idx >= totalSlots() - 1) return;
  const cur = participants.find((p) => p.turn_idx === buffState!.current_turn_idx);
  const next = participants.find((p) => p.turn_idx === buffState!.current_turn_idx + 1);
  if (!cur || !next) return;
  const body = t('survey.kvkBuff.confirm.skipBody', {
    cur: cur.survey?.nickname ?? cur.kingshot_id,
    curIdx: String(buffState.current_turn_idx + 1),
    next: next.survey?.nickname ?? next.kingshot_id,
    nextIdx: String(buffState.current_turn_idx + 2),
  });
  $('sk-buff-skip-body').textContent = body;
  $<HTMLDialogElement>('sk-buff-skip-dialog').showModal();
}

// ===== admin: swap =====
async function onSwapConfirm(): Promise<void> {
  if (swapSourceSlotIdx === null || pendingSwapTargetSlotIdx === null) return;
  const dlg = $<HTMLDialogElement>('sk-buff-swap-dialog');
  const slotA = swapSourceSlotIdx;
  const res = await callFn<{ ok: boolean; error?: string }>({
    action: 'admin-swap',
    token,
    slot_a_idx: slotA,
    slot_b_idx: pendingSwapTargetSlotIdx,
  });
  clearSwapSelection();
  dlg.close();
  if (!res.ok) alertError(res.error);
  await pollState();
}

// ===== 복사 =====
function onCopyClick(): void {
  const items: { time: string; name: string }[] = [];
  const occupied = new Map<number, Participant>();
  for (const p of participants) {
    if (p.slot_idx !== null) occupied.set(p.slot_idx, p);
  }
  const slots = totalSlots();
  for (let i = 0; i < slots; i++) {
    const holder = occupied.get(i);
    items.push({ time: formatSlotTime(i, tzMode), name: holder?.survey?.nickname ?? '❌' });
  }
  const URL_LINE = 'https://survey.kingshot.wooju-home.org/kvk-buff/';
  const text = items.map((it) => `${it.time} - ${it.name}`).join('\n') + `\n\n${URL_LINE}`;
  navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(ta);
  });
  const btn = $('sk-buff-copy-toggle');
  const original = btn.textContent;
  btn.textContent = t('survey.kvkBuff.copied');
  setTimeout(() => { btn.textContent = original; }, 1500);
}

// ===== init =====
function init(): void {
  token = loadToken();

  // 안내문 다이얼로그
  const noticeDlg = $<HTMLDialogElement>('sk-buff-notice-dialog');
  $('sk-buff-notice-trigger').addEventListener('click', () => {
    if (!noticeDlg.open) noticeDlg.showModal();
  });
  $('sk-buff-notice-close').addEventListener('click', () => noticeDlg.close());
  noticeDlg.addEventListener('click', (e) => { if (e.target === noticeDlg) noticeDlg.close(); });

  // 현재 사용자 카드 — 클릭 시 다음 차례 큐 펼침
  $('sk-buff-current').addEventListener('click', (e) => {
    // skip 버튼 클릭은 별도 처리
    if ((e.target as HTMLElement).closest('#sk-buff-skip-btn')) return;
    const card = $('sk-buff-current');
    if (card.classList.contains('is-completed')) return;
    card.classList.toggle('is-expanded');
  });

  // tz 토글
  $('sk-buff-tz-toggle').addEventListener('click', () => {
    tzMode = tzMode === 'UTC' ? 'KST' : 'UTC';
    $('sk-buff-tz-toggle').textContent = tzToggleLabel(tzMode);
    renderGrid();
  });

  // 남은 자리 필터
  const filterToggle = $('sk-buff-filter-toggle');
  filterToggle.addEventListener('click', () => {
    const grid = $('sk-buff-grid');
    if (!grid.style.minHeight) grid.style.minHeight = grid.offsetHeight + 'px';
    const filtered = grid.classList.toggle('is-filtered');
    filterToggle.textContent = filtered
      ? t('survey.kvkBuff.filterAll')
      : t('survey.kvkBuff.filterAvailable');
  });

  // 복사하기
  $('sk-buff-copy-toggle').addEventListener('click', onCopyClick);

  // 슬롯 그리드 click
  $('sk-buff-grid').addEventListener('click', onGridClick);

  // pick confirm
  $('sk-buff-confirm-cancel').addEventListener('click', () => {
    pendingSlotIdx = null;
    $<HTMLDialogElement>('sk-buff-confirm-dialog').close();
  });
  $('sk-buff-confirm-ok').addEventListener('click', onPickConfirm);

  // skip
  $('sk-buff-skip-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openSkipDialog();
  });
  $('sk-buff-skip-cancel').addEventListener('click', () => $<HTMLDialogElement>('sk-buff-skip-dialog').close());
  $('sk-buff-skip-ok').addEventListener('click', onSkipConfirm);

  // swap
  $('sk-buff-swap-cancel').addEventListener('click', () => {
    clearSwapSelection();
    $<HTMLDialogElement>('sk-buff-swap-dialog').close();
  });
  $('sk-buff-swap-ok').addEventListener('click', onSwapConfirm);

  // !!! TEST_MODE — admin 전용 [재시작] 버튼: _test 참가자 + state 일괄 reset.
  // 운영 호출 시 서버가 'test_mode_only' 로 거부 → 안전.
  document.getElementById('sk-buff-test-reset')?.addEventListener('click', onResetTestClick);

  // admin 전용 [예약 마감] — confirm() 후 finalize API 호출. 페이지 내 다른 흐름과 동일하게 시스템 confirm 사용.
  $('sk-buff-finalize-btn').addEventListener('click', onFinalizeClick);

  // 마감 전이면 잠금 화면 + 마감 시각까지 카운트다운만 띄움 (state 무관 우선 표시)
  renderLocked();

  // 언어 변경 시 dynamic 텍스트 재렌더
  onLangChange(() => {
    $('sk-buff-tz-toggle').textContent = tzToggleLabel(tzMode);
    const filterToggleEl = $('sk-buff-filter-toggle');
    const filtered = $('sk-buff-grid').classList.contains('is-filtered');
    filterToggleEl.textContent = filtered
      ? t('survey.kvkBuff.filterAll')
      : t('survey.kvkBuff.filterAvailable');
    renderAll();
  });
}

/** 다이얼로그 오픈 시 호출 — 첫 fetch + 5초 polling + 1초 tick 시작. */
export function startBuffPolling(): void {
  if (pollingTimer !== null) return; // 이미 polling 중
  // 첫 polling 응답 도착 (~수백ms) 전에 캐시 기반으로 .is-admin / .is-test 즉시 sync.
  // race 회귀 차단 — admin 이 다이얼로그 오픈 직후 잠깐 일반 사용자 UI 로 보이는 깜빡임 제거.
  applyAdminClass();
  void pollState();
  pollingTimer = window.setInterval(pollState, POLL_INTERVAL_MS);
  elapsedTimer = window.setInterval(tickElapsed, 1000);
}

/** 다이얼로그 close 시 호출 — polling/tick 중지 (네트워크/CPU 절약). */
export function stopBuffPolling(): void {
  if (pollingTimer !== null) {
    window.clearInterval(pollingTimer);
    pollingTimer = null;
  }
  if (elapsedTimer !== null) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

/** 가속권 페이지가 호출 — DOM 준비된 후 한 번만. 이벤트 핸들러 등록만 (polling X). */
export function setupBuffDialog(): void {
  init();
}

// 페이지 떠날 때 timer 정리 (HMR / SPA-ish 회복)
window.addEventListener('beforeunload', () => {
  if (pollingTimer !== null) window.clearInterval(pollingTimer);
  if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
});
