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
import { formatRelativeTime } from '@/lib/utils';
import { bindRefreshButton } from '@/lib/refresh-button';
import { estimateKvKScore } from '@/lib/kvk-score';
import { optimizeImage } from '@/lib/image-optimize';
import { appConfirm } from '@/lib/dialog';

const FN_URL = SUPABASE_URL + '/functions/v1/kvk-survey';

/** 인증샷 — 블랙리스트와 bucket 공유 (`blacklist-evidence`), 하위 폴더 `kvk-survey/` 로 격리.
 *  파일명 결정적: `{kingshot_id}.webp` → 1인 1장 자연 강제, upsert 만으로 갱신 → 고아 zero. */
const EVIDENCE_BUCKET = 'blacklist-evidence';
const EVIDENCE_PREFIX = 'kvk-survey/';

function evidencePath(kingshotId: string): string {
  return `${EVIDENCE_PREFIX}${kingshotId}.webp`;
}

/** Storage 객체의 public URL. evidence_uploaded_at(ms) 을 캐시버스터로 부착 — 갱신 시 즉시 무효화. */
function evidenceUrl(kingshotId: string, uploadedAtIso: string): string {
  const v = new Date(uploadedAtIso).getTime();
  return `${SUPABASE_URL}/storage/v1/object/public/${EVIDENCE_BUCKET}/${evidencePath(kingshotId)}?v=${v}`;
}

interface SurveyRow {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  training: number;
  construction: number;
  general: number;
  city_level: number; // list 응답은 city_level >= 26 만 — 항상 숫자
  evidence_uploaded_at: string | null; // ISO. null = 미인증.
  updated_at: string;
}

/** 토큰 API (login / verify-token / register) 가 반환하는 내 record. SurveyRow 의 subset.
 *  preferred_buff_time: 'HH:MM' 또는 null.
 *  evidence_uploaded_at: ISO 또는 null (미인증). */
interface MyRecord {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  training: number;
  construction: number;
  general: number;
  preferred_buff_time: string | null;
  evidence_uploaded_at: string | null;
}

interface PlayerInfo {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  city_level: number | null;
}

/** TC(센터) 레벨 최소 자격. 서버측 검증과 일치 유지 (kvk-survey/index.ts MIN_CITY_LEVEL). */
const MIN_CITY_LEVEL = 26;

/** 설문 등록 마감 시각 (UTC). 안내문의 UTC 5월 16일 01:00 과 일치 유지.
 *  TEMP: 5명 admin 실증 테스트 동안 임시 단축 (가속권 페이지의 [등록/수정] → [버프 예약] 자동 전환).
 *        운영 복귀 시 '2026-05-16T01:00:00Z' 로 원복. */
const SURVEY_DEADLINE_ISO = '2024-01-01T00:00:00Z';
/** urgency 단계 (남은 시간 ms): 24h 이하 = 노랑, 6h 이하 = 빨강 + pulse */
const URGENCY_WARN_MS = 24 * 60 * 60 * 1000;
const URGENCY_DANGER_MS = 6 * 60 * 60 * 1000;

/** 열람 잠금 해제 상태 키 — sessionStorage 라 탭 닫으면 자동 reset.
 *  토큰 기반 인증 도입 후에도 유지: localStorage AUTH 가 verify-token 으로 인증되면 이 키도 같이 세팅.
 *  (UI 의 .is-unlocked 클래스는 한 곳에서만 토글하면 됨) */
const UNLOCK_KEY = 'sk-unlocked';

/** 세션 토큰 + 캐시된 record — localStorage 영구. 90일 후 서버에서 만료.
 *  boot 시 verify-token API 로 검증 → 성공이면 자동 로그인.
 *  로그아웃 버튼 없음 (1인 1행 설문이라 다른 계정 전환 불필요). */
const AUTH_KEY = 'pnx-sk-auth-v1';

type SortKey =
  | 'training'
  | 'construction'
  | 'general'
  | 'score'
  | 'verified'
  | 'updated_at';

// ===== state =====

interface FormSession {
  player: PlayerInfo;
  pin: string;
  mode: 'register' | 'update';
  prefill?: {
    training: number;
    construction: number;
    general: number;
    preferred_buff_time: string | null;
    evidence_uploaded_at: string | null; // prefill 시점의 인증 상태 — 폼 입력 후 변경 비교용
  };
}

/** 폼이 열려있는 동안의 인증샷 임시 상태.
 *  - pendingBlob: 사용자가 새로 선택한 파일 (압축 후 blob). null = 변경 없음.
 *  - removed: 사용자가 [제거] 눌러 기존 인증샷을 지우려는 의도. */
interface PendingEvidence {
  pendingBlob: Blob | null;
  pendingName: string | null;
  removed: boolean;
  previewUrl: string | null; // object URL — exitFormMode 에서 revoke
}
let pendingEvidence: PendingEvidence = {
  pendingBlob: null,
  pendingName: null,
  removed: false,
  previewUrl: null,
};

function resetPendingEvidence(): void {
  if (pendingEvidence.previewUrl) URL.revokeObjectURL(pendingEvidence.previewUrl);
  pendingEvidence = { pendingBlob: null, pendingName: null, removed: false, previewUrl: null };
}

let session: FormSession | null = null;
let rowsCache: SurveyRow[] = [];
let sort: { key: SortKey; dir: 'asc' | 'desc' } = { key: 'general', dir: 'desc' };
/** 닉네임/ID 검색 — 소문자 trimmed. 빈 문자열이면 필터 off. */
let searchQuery = '';
/** 점수 기준 상위 48명의 kingshot_id 집합 — 정렬 키와 무관하게 항상 score top48. */
let topGiftIds = new Set<string>();
const TOP_GIFT_COUNT = 48;
/** 차단 step 의 "현재 레벨" 동적 텍스트 상태 — 언어 토글 시 재렌더용.
 *  undefined: 차단 dialog 표시한 적 없음. number: 알려진 레벨. null: API 응답 누락. */
let blockedDialogLevel: number | null | undefined = undefined;

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

/** Storage 의 인증샷 객체 upsert (PUT — Supabase 의 conflict-safe 업로드). 같은 path 반복 시 덮어쓰기. */
async function putEvidenceBlob(blob: Blob, kingshotId: string): Promise<void> {
  const url = `${SUPABASE_URL}/storage/v1/object/${EVIDENCE_BUCKET}/${evidencePath(kingshotId)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000',
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`evidence upload ${res.status}: ${await res.text()}`);
}

/** Storage 의 인증샷 객체 삭제. 404/400 (이미 없음) 은 무시. */
async function deleteEvidenceBlob(kingshotId: string): Promise<void> {
  const url = `${SUPABASE_URL}/storage/v1/object/${EVIDENCE_BUCKET}/${evidencePath(kingshotId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok && res.status !== 404 && res.status !== 400) {
    throw new Error(`evidence delete ${res.status}: ${await res.text()}`);
  }
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
  // 다이얼로그가 사용자 cancel 로 닫히면 [버프 예약] 자동 redirect 의도도 취소.
  pendingBuffNavigate = false;
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

function showAuthStep(step: 'id' | 'confirm' | 'blocked'): void {
  ($('sk-step-id') as HTMLElement).hidden = step !== 'id';
  ($('sk-step-confirm') as HTMLElement).hidden = step !== 'confirm';
  ($('sk-step-blocked') as HTMLElement).hidden = step !== 'blocked';
}

/** 차단 step 의 "현재 레벨" 텍스트 — 언어 토글 시 호출 가능하도록 분리.
 *  data-i18n 마커를 못 쓰는 이유: t() 호출 결과에 {n} 치환이 필요. */
function renderBlockedCurrent(): void {
  if (blockedDialogLevel === undefined) return; // 차단 dialog 표시한 적 없음 → noop
  const el = $('sk-blocked-current');
  el.textContent =
    blockedDialogLevel === null
      ? t('survey.kvk.blocked.currentLevelUnknown')
      : t('survey.kvk.blocked.currentLevel', { n: blockedDialogLevel });
}

/** 열람 잠금/해제 — sessionStorage 상태 + DOM 클래스 동기. unlock 직후 목록 자동 fetch. */
function isUnlocked(): boolean {
  try {
    return sessionStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}
function applyUnlockState(): void {
  ($('sk-page') as HTMLElement).classList.toggle('is-unlocked', isUnlocked());
}
function setUnlocked(): void {
  try {
    sessionStorage.setItem(UNLOCK_KEY, '1');
  } catch {
    /* private mode etc. — 메모리상 클래스만 토글되고 새로고침 시 다시 잠김 */
  }
  applyUnlockState();
}

/** 인증 정보 영구 저장 / 조회 / 제거 — token + 캐시된 record. */
interface AuthState {
  token: string;
  expires_at: string; // ISO 8601
  record: MyRecord; // 마지막으로 알려진 내 데이터 (boot prefill, UI 캐시용)
}
function saveAuth(state: AuthState): void {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — 무시 */
  }
}
function getAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj?.token !== 'string' || typeof obj?.expires_at !== 'string' || !obj?.record) {
      return null;
    }
    return obj as AuthState;
  } catch {
    return null;
  }
}
function clearAuth(): void {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* */
  }
}
/** 현재 토큰 (localStorage). 없으면 null. mutation API 호출 시 사용. */
function getToken(): string | null {
  return getAuth()?.token ?? null;
}

function setStatus(id: string, msg: string, kind: 'ok' | 'err' | '' = ''): void {
  const el = $(id);
  el.textContent = msg;
  el.className = 'sk-status' + (kind ? ' sk-status-' + kind : '');
}

function setSearchBtnBusy(busy: boolean): void {
  // 텍스트는 항상 "조회" 유지 (data-i18n 마커가 언어 swap 담당) — busy 상태는
  // disabled 의 opacity dim + not-allowed 커서로 시각화. 텍스트 swap 은 폭 jitter +
  // 인접 input layout shift 유발해서 제거.
  ($<HTMLButtonElement>('sk-id-search')).disabled = busy;
}

function fillPlayerCard(prefix: 'sk-player' | 'sk-form' | 'sk-detail', player: PlayerInfo): void {
  const name = $(prefix + '-name');
  const idEl = $(prefix + '-id');
  const photo = $(prefix + '-photo') as HTMLImageElement;
  const empty = $(prefix + '-photo-empty');

  patchText(name, player.nickname);
  // city_level 있으면 "#ID · TC N" 형태, 없으면 "#ID" 만.
  // (lookup 실패 등으로 city_level NULL 케이스 — 차단 dialog 에서만 발생, 표시 자체 의미 적음)
  const idText =
    player.city_level !== null && player.city_level !== undefined
      ? `#${player.kingshot_id} · TC ${player.city_level}`
      : `#${player.kingshot_id}`;
  patchText(idEl, idText);
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
    // TC 레벨 게이트 — 26 미만이면 blocked step 으로 이동, PIN/폼 진행 차단.
    const cityLevel = json.player.city_level;
    if (cityLevel === null || cityLevel < MIN_CITY_LEVEL) {
      blockedDialogLevel = cityLevel;
      renderBlockedCurrent();
      showAuthStep('blocked');
      session = null;
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
    // 신규 등록: PIN 만 메모리에 보관 → 폼 모드 진입. register API 호출은 저장 시점.
    // 응답에서 token 받아서 saveAuth() 호출 → 다음 진입부터 자동 로그인.
    session.pin = pin;
    enterFormMode();
    return;
  }

  // 기존 사용자: login API (PIN verify + 토큰 발급). 토큰 받으면 영구 저장 + 폼 prefill.
  const json = await callFn<{
    ok: boolean;
    error?: string;
    token?: string;
    expires_at?: string;
    record?: MyRecord;
  }>({ action: 'login', kingshot_id: session.player.kingshot_id, pin });
  if (!json.ok || !json.token || !json.expires_at || !json.record) {
    setStatus('sk-pin-status', mapError(json.error), 'err');
    return;
  }
  saveAuth({ token: json.token, expires_at: json.expires_at, record: json.record });
  // 마감 후 [버프 예약] 클릭으로 진입한 흐름이면 폼 다이얼로그 skip + 즉시 /kvk-buff/.
  if (pendingBuffNavigate) {
    pendingBuffNavigate = false;
    closeAuthDialog();
    window.location.href = '/kvk-buff/';
    return;
  }
  session.pin = pin;
  session.prefill = {
    training: json.record.training,
    construction: json.record.construction,
    general: json.record.general,
    preferred_buff_time: json.record.preferred_buff_time ?? null,
    evidence_uploaded_at: json.record.evidence_uploaded_at ?? null,
  };
  enterFormMode();
}

// ===== 흐름: 폼 모드 진입/저장 =====

function enterFormMode(): void {
  if (!session) return;
  closeAuthDialog();
  const dlg = $<HTMLDialogElement>('sk-form-dialog');
  fillPlayerCard('sk-form', session.player);
  setNumericInputValue('sk-input-general', session.prefill?.general ?? null);
  setNumericInputValue('sk-input-training', session.prefill?.training ?? null);
  setNumericInputValue('sk-input-construction', session.prefill?.construction ?? null);
  // 시간 select prefill — 미선택은 빈 placeholder option 으로
  ($('sk-input-preferred-time') as HTMLSelectElement).value =
    session.prefill?.preferred_buff_time ?? '';
  // 인증샷 prefill — 기존 업로드 있으면 thumb 표시, 없으면 empty
  resetPendingEvidence();
  syncEvidenceUI();
  // file input value 초기화 — 같은 파일 다시 선택 시 change 이벤트 발화 보장
  ($('sk-input-evidence') as HTMLInputElement).value = '';
  // 수정 모드일 때만 삭제 버튼 노출
  ($('sk-form-delete') as HTMLButtonElement).hidden = session.mode !== 'update';
  ($('sk-form-save') as HTMLButtonElement).disabled = false;
  ($('sk-form-delete') as HTMLButtonElement).disabled = false;
  setStatus('sk-form-status', '');
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $<HTMLInputElement>('sk-input-general').focus(), 50);
}

/** 인증샷 영역 표시 동기화 — pendingEvidence + session.prefill 의 evidence_uploaded_at 종합:
 *   - pendingBlob 있으면 새 파일 (thumb = blob preview)
 *   - removed=true 면 empty 상태
 *   - prefill 의 기존 인증샷 있으면 stored thumb (URL 로)
 *   - 그 외 empty (미인증) */
function syncEvidenceUI(): void {
  const row = $('sk-form-row-image');
  const thumbImg = $('sk-evidence-thumb-img') as HTMLImageElement;
  const nameEl = $('sk-evidence-name');

  let showAttached = false;
  let thumbSrc = '';
  let displayName = '';

  if (pendingEvidence.pendingBlob && pendingEvidence.previewUrl) {
    showAttached = true;
    thumbSrc = pendingEvidence.previewUrl;
    displayName = pendingEvidence.pendingName ?? 'screenshot.webp';
  } else if (!pendingEvidence.removed && session?.prefill?.evidence_uploaded_at) {
    showAttached = true;
    thumbSrc = evidenceUrl(session.player.kingshot_id, session.prefill.evidence_uploaded_at);
    displayName = `screenshot.webp`;
  }

  row.classList.toggle('has-image', showAttached);
  if (showAttached) {
    if (thumbImg.src !== thumbSrc) thumbImg.src = thumbSrc;
    patchText(nameEl, displayName);
  }
}

function exitFormMode(): void {
  const dlg = $<HTMLDialogElement>('sk-form-dialog');
  if (dlg.open) dlg.close();
  resetPendingEvidence();
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

function readFormValues(): {
  training: number;
  construction: number;
  general: number;
  preferred_buff_time: string | null;
} | null {
  const tr = parseNumericInput('sk-input-training');
  const co = parseNumericInput('sk-input-construction');
  const ge = parseNumericInput('sk-input-general');
  if (![tr, co, ge].every((v) => Number.isInteger(v) && v >= 0 && v <= 9_999_999)) return null;
  // 시간 미선택은 빈 문자열 → null 로 정규화. 서버 검증은 정규식 + null OK.
  const rawTime = ($('sk-input-preferred-time') as HTMLSelectElement).value;
  const preferred_buff_time = rawTime === '' ? null : rawTime;
  return { training: tr, construction: co, general: ge, preferred_buff_time };
}

async function onDeleteForm(): Promise<void> {
  if (!session || session.mode !== 'update') return;
  if (!window.confirm(t('survey.kvk.form.deleteConfirm'))) return;
  const saveBtn = $<HTMLButtonElement>('sk-form-save');
  const delBtn = $<HTMLButtonElement>('sk-form-delete');
  saveBtn.disabled = true;
  delBtn.disabled = true;
  setStatus('sk-form-status', t('survey.kvk.form.deleting'), '');
  try {
    const token = getToken();
    const json = await callFn<{ ok: boolean; error?: string }>({
      action: 'delete',
      token,
    });
    if (!json.ok) {
      // 토큰 만료/무효 시 — 다음 부팅에서 자동 logout
      if (json.error === 'token_expired' || json.error === 'invalid_token') clearAuth();
      setStatus('sk-form-status', mapError(json.error), 'err');
      saveBtn.disabled = false;
      delBtn.disabled = false;
      return;
    }
    // 삭제 성공 → 인증 정보도 같이 정리 (DB row 자체가 사라졌으니 토큰도 무효).
    clearAuth();
    setStatus('sk-form-status', t('survey.kvk.form.deleted'), 'ok');
    await refreshList();
    setTimeout(() => exitFormMode(), 600);
  } catch (err) {
    setStatus('sk-form-status', mapError(String((err as Error).message)), 'err');
    saveBtn.disabled = false;
    delBtn.disabled = false;
  }
}

async function onSaveForm(): Promise<void> {
  if (!session) return;
  const values = readFormValues();
  if (!values) {
    setStatus('sk-form-status', t('survey.kvk.form.errors.invalidAmount'), 'err');
    return;
  }

  // 인증샷 미첨부 경고 — 보상 순위에서 감점 사유 (이미지 인증 = 1순위 자격).
  // 신규 첨부 없고 기존 인증샷도 없으면 (수정 모드에서 [제거] 한 경우 포함) 확인 받음.
  const willHaveImage =
    pendingEvidence.pendingBlob !== null ||
    (!pendingEvidence.removed && session.prefill?.evidence_uploaded_at != null);
  if (!willHaveImage) {
    const ok = await appConfirm(t('survey.kvk.form.noImageWarn'));
    if (!ok) return;
  }

  const btn = $<HTMLButtonElement>('sk-form-save');
  btn.disabled = true;
  setStatus('sk-form-status', t('survey.kvk.form.saving'), '');
  try {
    let json:
      | {
          ok: boolean;
          error?: string;
          token?: string;
          expires_at?: string;
          record?: MyRecord;
        }
      | { ok: boolean; error?: string };
    if (session.mode === 'register') {
      // 신규 — PIN 전송. 응답에서 token + record 받음 → saveAuth.
      json = await callFn<{
        ok: boolean;
        error?: string;
        token?: string;
        expires_at?: string;
        record?: MyRecord;
      }>({
        action: 'register',
        kingshot_id: session.player.kingshot_id,
        pin: session.pin,
        ...values,
      });
    } else {
      // 수정 — token 전송 (login 시 받은 것). 응답엔 ok 만.
      const token = getToken();
      json = await callFn<{ ok: boolean; error?: string }>({
        action: 'update',
        token,
        ...values,
      });
    }
    if (!json.ok) {
      // 토큰 만료/무효 시 자동 로그아웃 + 다이얼로그 안내
      if (json.error === 'token_expired' || json.error === 'invalid_token') {
        clearAuth();
        setUnlocked(); // 이미 표시된 목록은 그대로 두되 다음 boot 부터 잠금 풀려있어도 verify-token 실패로 lock
      }
      setStatus('sk-form-status', mapError(json.error), 'err');
      btn.disabled = false;
      return;
    }
    // 등록인 경우 응답에서 token + record 저장
    if (session.mode === 'register') {
      const j = json as { ok: true; token: string; expires_at: string; record: MyRecord };
      if (j.token && j.expires_at && j.record) {
        saveAuth({ token: j.token, expires_at: j.expires_at, record: j.record });
      }
    } else {
      // 수정 — 캐시된 record 갱신 (로컬에서 즉시 일관성 유지)
      const auth = getAuth();
      if (auth) {
        saveAuth({
          ...auth,
          record: { ...auth.record, ...values },
        });
      }
    }

    // 인증샷 처리 — DB 저장 성공 후 Storage 업로드/삭제 + set-evidence 호출
    // 실패해도 가속권 자체 저장은 이미 완료 → 폼은 닫고 인증샷 실패만 별도 표시.
    const evidenceOk = await applyPendingEvidence(session.player.kingshot_id);

    if (evidenceOk) {
      setStatus('sk-form-status', t('survey.kvk.form.saved'), 'ok');
    }
    setUnlocked();
    await refreshList();
    setTimeout(() => exitFormMode(), evidenceOk ? 600 : 1500);
  } catch (err) {
    setStatus('sk-form-status', mapError(String((err as Error).message)), 'err');
    btn.disabled = false;
  } finally {
    btn.disabled = false;
  }
}

/** 폼 저장 직후 호출 — pendingEvidence 의 상태에 따라 Storage upsert/delete + set-evidence API 호출.
 *  반환: true=성공 또는 변경 없음, false=실패 (호출자가 status 메시지 보존하도록).
 *  실패해도 가속권 자체 DB 저장은 이미 완료된 상태라 throw 안 함. */
async function applyPendingEvidence(kingshotId: string): Promise<boolean> {
  if (!pendingEvidence.pendingBlob && !pendingEvidence.removed) return true;

  try {
    if (pendingEvidence.pendingBlob) {
      setStatus('sk-form-status', t('survey.kvk.form.evidenceUploading'), '');
      await putEvidenceBlob(pendingEvidence.pendingBlob, kingshotId);
      const token = getToken();
      const setRes = await callFn<{ ok: boolean; error?: string; evidence_uploaded_at?: string }>({
        action: 'set-evidence',
        token,
        has_evidence: true,
      });
      if (setRes.ok && setRes.evidence_uploaded_at) {
        const a = getAuth();
        if (a) saveAuth({ ...a, record: { ...a.record, evidence_uploaded_at: setRes.evidence_uploaded_at } });
      }
    } else if (pendingEvidence.removed) {
      await deleteEvidenceBlob(kingshotId);
      const token = getToken();
      await callFn<{ ok: boolean }>({ action: 'set-evidence', token, has_evidence: false });
      const a = getAuth();
      if (a) saveAuth({ ...a, record: { ...a.record, evidence_uploaded_at: null } });
    }
    return true;
  } catch (e) {
    setStatus(
      'sk-form-status',
      t('survey.kvk.form.evidenceUploadFailed') + ` (${(e as Error).message})`,
      'err',
    );
    return false;
  }
}

// ===== 목록 =====

async function refreshList(): Promise<void> {
  // 잠금 상태에선 list API 호출 자체 차단 — 서버 부하 절감 + 잠금 placeholder 유지.
  if (!isUnlocked()) return;
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
  // 점수 기준 top48 집합 — 정렬/검색과 무관하게 전체에서 계산.
  topGiftIds = computeTopGiftIds(rowsCache);

  const sorted = sortRows(rowsCache, sort);
  const filtered = filterRows(sorted, searchQuery);
  const empty = $('sk-empty');
  empty.hidden = filtered.length > 0;
  // 검색 결과가 0이면 "검색 결과 없음", 아니면 일반 빈 메시지
  patchText(
    empty,
    searchQuery
      ? t('survey.kvk.list.emptySearch')
      : t('survey.kvk.list.empty'),
  );

  // count 는 항상 전체 제출자 수 ("68명 제출"). 검색 필터로 영향 X.
  patchText($('sk-list-count'), t('survey.kvk.list.count', { n: rowsCache.length }));

  patchList<SurveyRow & { rank: number; total: number }>({
    container: tbody,
    items: filtered.map((r, i) => ({ ...r, rank: i + 1, total: rowTotal(r) })),
    key: (r) => r.kingshot_id,
    render: (r) => buildRow(r),
    update: (el, r) => updateRow(el, r),
  });

  // 정렬 활성 표시 — 상단 .sk-sort-chip (PC/모바일 공용)
  document.querySelectorAll<HTMLElement>('.sk-sort-chip').forEach((btn) => {
    btn.dataset.active = btn.dataset.sort === sort.key ? 'true' : 'false';
  });
}

/** 시간 select 에 placeholder + 48개 옵션 (00:00 ~ 23:30, 30분 단위) 채움.
 *  init 에서 한 번만 호출. 언어 변경 시 placeholder 텍스트 갱신은 onLangChange 에서 처리. */
function populateTimeOptions(): void {
  const sel = $<HTMLSelectElement>('sk-input-preferred-time');
  if (sel.options.length > 0) return; // 이미 채워졌으면 noop
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.hidden = true;
  placeholder.textContent = t('survey.kvk.form.preferredTimePlaceholder');
  placeholder.dataset.placeholder = '1';
  sel.appendChild(placeholder);
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const v = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
  }
  sel.value = ''; // placeholder 가 보이도록
}

/** 닉네임 또는 ID 부분일치 (대소문자 무시). 빈 query 면 그대로 반환. */
function filterRows(rows: SurveyRow[], query: string): SurveyRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.nickname.toLowerCase().includes(q) || r.kingshot_id.toLowerCase().includes(q),
  );
}

/** 점수 기준 상위 N명의 ID 집합. 데이터가 N보다 적으면 전부 포함. */
function computeTopGiftIds(rows: SurveyRow[]): Set<string> {
  const ranked = rows
    .map((r) => ({ id: r.kingshot_id, score: rowScore(r) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_GIFT_COUNT);
  return new Set(ranked.map((r) => r.id));
}

function rowTotal(r: SurveyRow): number {
  return r.general + r.training + r.construction;
}

/** 행의 KvK 예상 점수 합 (1일차 + 4일차). 정렬 비교용. */
function rowScore(r: SurveyRow): number {
  const s = estimateKvKScore({
    construction: r.construction,
    training: r.training,
    general: r.general,
    cityLevel: r.city_level,
  });
  return s.day1.value + s.day4.value;
}

function sortRows(rows: SurveyRow[], s: typeof sort): SurveyRow[] {
  const out = rows.slice();
  out.sort((a, b) => {
    // 인증 정렬 — primary: verified 여부, secondary: score(desc).
    // dir desc(기본) = 인증 먼저 / dir asc = 미인증 먼저. 사용자 요청 의미상 인증 안된 사람은
    // 점수가 높더라도 인증된 사람 아래로 밀려야 함.
    if (s.key === 'verified') {
      const va = a.evidence_uploaded_at !== null ? 1 : 0;
      const vb = b.evidence_uploaded_at !== null ? 1 : 0;
      if (va !== vb) return s.dir === 'asc' ? va - vb : vb - va;
      const sa = rowScore(a);
      const sb = rowScore(b);
      return sb - sa; // 같은 인증 bucket 안에선 항상 점수 desc
    }
    let av: number;
    let bv: number;
    if (s.key === 'updated_at') {
      av = Date.parse(a.updated_at);
      bv = Date.parse(b.updated_at);
    } else if (s.key === 'score') {
      av = rowScore(a);
      bv = rowScore(b);
    } else {
      av = a[s.key];
      bv = b[s.key];
    }
    return s.dir === 'asc' ? (av < bv ? -1 : av > bv ? 1 : 0) : av < bv ? 1 : av > bv ? -1 : 0;
  });
  return out;
}

function buildRow(r: SurveyRow & { rank: number; total: number }): HTMLElement {
  const tr = document.createElement('tr');
  tr.className = 'sk-tr';
  tr.dataset.id = r.kingshot_id;
  // 각 가속권 셀은 [라벨][값] 페어 — 데스크탑은 라벨 숨김, 모바일 카드 모드에선 라벨 노출.
  // sk-td-total 은 PC 전용 (모바일에선 CSS 로 display:none).
  tr.innerHTML = `
    <td class="sk-td sk-td-rank"></td>
    <td class="sk-td sk-td-player">
      <div class="sk-row-player">
        <div class="sk-row-photo-wrap">
          <div class="sk-row-photo-empty"></div>
          <img class="sk-row-photo" hidden alt="" />
          <span class="sk-row-gift" aria-hidden="true" hidden>🎁</span>
        </div>
        <div class="sk-row-meta">
          <div class="sk-row-name"></div>
          <div class="sk-row-id"></div>
        </div>
      </div>
    </td>
    <td class="sk-td sk-td-num sk-td-general">
      <span class="sk-cell-value"></span>
    </td>
    <td class="sk-td sk-td-num sk-td-training">
      <span class="sk-cell-value"></span>
    </td>
    <td class="sk-td sk-td-num sk-td-construction">
      <span class="sk-cell-value"></span>
    </td>
    <td class="sk-td sk-td-num sk-td-total"></td>
    <td class="sk-td sk-td-verified"></td>
    <td class="sk-td sk-td-time sk-td-updated">
      <span class="sk-mobile-verified"></span><span class="sk-mobile-sep"> · </span><span class="sk-updated-text"></span>
    </td>
  `;
  updateRow(tr, r);
  return tr;
}

function updateRow(tr: HTMLElement, r: SurveyRow & { rank: number; total: number }): void {
  patchText(tr.querySelector<HTMLElement>('.sk-td-rank'), String(r.rank));
  patchText(tr.querySelector<HTMLElement>('.sk-row-name'), r.nickname);
  patchText(
    tr.querySelector<HTMLElement>('.sk-row-id'),
    `#${r.kingshot_id} · TC ${r.city_level}`,
  );

  patchText(
    tr.querySelector<HTMLElement>('.sk-td-general .sk-cell-value'),
    formatDuration(r.general),
  );
  patchText(
    tr.querySelector<HTMLElement>('.sk-td-training .sk-cell-value'),
    formatDuration(r.training),
  );
  patchText(
    tr.querySelector<HTMLElement>('.sk-td-construction .sk-cell-value'),
    formatDuration(r.construction),
  );
  patchText(tr.querySelector<HTMLElement>('.sk-td-total'), formatDuration(r.total));

  // 인증 상태 — PC: 별도 컬럼, 모바일: 등록시간 셀 좌측 인라인 (CSS 가 display 토글)
  const isVerified = r.evidence_uploaded_at !== null;
  const verifiedLabel = isVerified ? t('survey.kvk.list.verified') : t('survey.kvk.list.unverified');
  const verifiedCell = tr.querySelector<HTMLElement>('.sk-td-verified');
  if (verifiedCell) {
    patchText(verifiedCell, verifiedLabel);
    verifiedCell.dataset.verified = isVerified ? 'true' : 'false';
  }
  // 모바일용 inline 라벨 — 등록시간 셀 안에 같이 표시
  const mobileVerifiedEl = tr.querySelector<HTMLElement>('.sk-mobile-verified');
  if (mobileVerifiedEl) {
    patchText(mobileVerifiedEl, verifiedLabel);
    mobileVerifiedEl.dataset.verified = isVerified ? 'true' : 'false';
  }
  patchText(tr.querySelector<HTMLElement>('.sk-updated-text'), formatRelativeTime(r.updated_at));

  const empty = tr.querySelector<HTMLElement>('.sk-row-photo-empty')!;
  const img = tr.querySelector<HTMLImageElement>('.sk-row-photo')!;
  const gift = tr.querySelector<HTMLElement>('.sk-row-gift')!;
  // 점수 기준 top48 인 사용자만 🎁 노출 (정렬 키와 무관, 검색 필터와도 무관)
  gift.hidden = !topGiftIds.has(r.kingshot_id);
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

// ===== 이미지 다이얼로그 =====

/** 첫 fetch 결과 blob: URL — 브라우저 네트워크 캐시 우회 (dev server `no-cache` + 카운트다운
 *  tick 조합으로 매초 refetch 되던 문제 해결). 한 번 만들어두면 페이지 lifetime 동안 메모리에 상주. */
let speedupStatsBlobUrl: string | null = null;

async function openImageDialog(): Promise<void> {
  const dlg = $<HTMLDialogElement>('sk-image-dialog');
  const img = $<HTMLImageElement>('sk-image-dialog-img');
  if (img && !img.src && img.dataset.src) {
    if (!speedupStatsBlobUrl) {
      try {
        const res = await fetch(img.dataset.src);
        const blob = await res.blob();
        speedupStatsBlobUrl = URL.createObjectURL(blob);
      } catch {
        // 네트워크 실패 시 직접 URL fallback (production 에선 어차피 cache hit, dev 에선 매초 fetch 부활하지만 graceful)
        speedupStatsBlobUrl = img.dataset.src;
      }
    }
    img.src = speedupStatsBlobUrl;
  }
  if (!dlg.open) dlg.showModal();
}

function closeImageDialog(): void {
  const dlg = $<HTMLDialogElement>('sk-image-dialog');
  if (dlg.open) dlg.close();
}

// ===== 상세 다이얼로그 (읽기 전용) =====

/** 마지막으로 표시한 행 — 다이얼로그 열린 상태에서 언어 토글 시 재렌더용. */
let detailDialogRow: SurveyRow | null = null;

function openDetailDialog(row: SurveyRow): void {
  detailDialogRow = row;
  renderDetailDialog();
  const dlg = $<HTMLDialogElement>('sk-detail-dialog');
  if (!dlg.open) dlg.showModal();
}

function renderDetailDialog(): void {
  const row = detailDialogRow;
  if (!row) return;
  fillPlayerCard('sk-detail', {
    kingshot_id: row.kingshot_id,
    nickname: row.nickname,
    avatar_url: row.avatar_url,
    city_level: row.city_level,
  });
  patchText($('sk-detail-updated'), formatRelativeTime(row.updated_at));

  // 인증샷 버튼 — 이미지 있으면 enabled(초록), 없으면 disabled(회색)
  const evBtn = $<HTMLButtonElement>('sk-detail-evidence-btn');
  const hasEvidence = row.evidence_uploaded_at !== null;
  evBtn.disabled = !hasEvidence;
  evBtn.title = hasEvidence
    ? t('survey.kvk.detail.evidenceButtonTitle')
    : t('survey.kvk.detail.evidenceButtonTitleEmpty');

  const total = rowTotal(row);
  setBar('general', row.general, total);
  setBar('training', row.training, total);
  setBar('construction', row.construction, total);
  patchText($('sk-detail-total'), formatDuration(total));

  // KvK 예상 점수 — PLAN.md 의 계산식. city_level 필수 (>=26 이라 항상 숫자).
  const score = estimateKvKScore({
    construction: row.construction,
    training: row.training,
    general: row.general,
    cityLevel: row.city_level,
  });
  patchText(
    $('sk-detail-day1-value'),
    t('survey.kvk.detail.scores.points', { n: formatNum(score.day1.value) }),
  );
  patchText(
    $('sk-detail-day1-range'),
    t('survey.kvk.detail.scores.range', {
      min: formatNum(score.day1.min),
      max: formatNum(score.day1.max),
    }),
  );
  patchText(
    $('sk-detail-day4-value'),
    t('survey.kvk.detail.scores.points', { n: formatNum(score.day4.value) }),
  );
  // 4일차 meta 는 범위 + 티어 노트 한 줄에 결합
  const day4Range = t('survey.kvk.detail.scores.range', {
    min: formatNum(score.day4.min),
    max: formatNum(score.day4.max),
  });
  const day4Tier = t('survey.kvk.detail.scores.tierNote', {
    tier: score.day4.tier,
    level: row.city_level,
  });
  patchText($('sk-detail-day4-range'), `${day4Range} · ${day4Tier}`);
}

/** 각 가속권 row 의 값/막대/퍼센트 갱신. total=0 케이스(신규 등록 직전) 는 0% 로 표시. */
function setBar(
  slot: 'general' | 'training' | 'construction',
  value: number,
  total: number,
): void {
  patchText($(`sk-detail-${slot}`), formatDuration(value));
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  ($(`sk-detail-bar-${slot}`) as HTMLElement).style.width = pct + '%';
  patchText($(`sk-detail-pct-${slot}`), pct + '%');
}

function closeDetailDialog(): void {
  const dlg = $<HTMLDialogElement>('sk-detail-dialog');
  if (dlg.open) dlg.close();
  detailDialogRow = null;
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
    case 'city_level_too_low':
      return t('survey.kvk.auth.errors.cityLevelTooLow');
    case 'invalid_amount':
      return t('survey.kvk.form.errors.invalidAmount');
    case 'invalid_preferred_time':
      return t('survey.kvk.form.errors.invalidPreferredTime');
    default:
      return t('survey.kvk.errors.generic') + (code ? ` (${code})` : '');
  }
}

// ===== boot =====

function init(): void {
  // 등록/수정 버튼 — 로그인 상태(=토큰 유효)면 폼 다이얼로그 바로, 미로그인이면 인증 다이얼로그.
  $('sk-list-add').addEventListener('click', () => {
    const auth = getAuth();
    if (auth) {
      // 이미 로그인된 사용자 — PIN step skip 하고 폼 직진.
      // 캐시된 record + 최신 nickname/avatar 는 server 갱신본을 update 응답에서 받음.
      session = {
        player: {
          kingshot_id: auth.record.kingshot_id,
          nickname: auth.record.nickname,
          avatar_url: auth.record.avatar_url,
          city_level: MIN_CITY_LEVEL, // 자격 미달이면 update API 가 다시 차단 (서버 게이트)
        },
        pin: '',
        mode: 'update',
        prefill: {
          training: auth.record.training,
          construction: auth.record.construction,
          general: auth.record.general,
          preferred_buff_time: auth.record.preferred_buff_time ?? null,
          evidence_uploaded_at: auth.record.evidence_uploaded_at ?? null,
        },
      };
      enterFormMode();
    } else {
      openAuthDialog();
    }
  });
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
  // sk-pin-confirm 버튼은 제거됨 — 4자리 자동 호출 + Enter 키로 충분.

  // 차단 step — 닫기 클릭 시 다이얼로그 종료 (목록은 여전히 잠긴 상태)
  $('sk-blocked-close').addEventListener('click', closeAuthDialog);

  // PIN 박스 동기화 — input/focus/blur 모두 박스 갱신
  const pinInput = $<HTMLInputElement>('sk-pin-input');
  pinInput.addEventListener('input', () => {
    // 숫자만 유지
    pinInput.value = pinInput.value.replace(/[^0-9]/g, '').slice(0, 4);
    syncPinBoxes();
    // 4자리 완성 → 자동으로 "확인" (Enter 또는 확인 버튼 클릭과 동일).
    // 80ms 지연: 마지막 박스 채워지는 시각 효과 + 사용자가 빠르게 5번째 키 누른 경우 skip 보장.
    if (pinInput.value.length === 4) {
      window.setTimeout(() => {
        if (pinInput.value.length === 4) onConfirmPin();
      }, 80);
    }
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

  // 폼 다이얼로그
  $('sk-form-cancel').addEventListener('click', exitFormMode);
  $('sk-form-close').addEventListener('click', exitFormMode);
  $('sk-form-save').addEventListener('click', onSaveForm);
  $('sk-form-delete').addEventListener('click', onDeleteForm);
  // ESC 또는 다른 경로로 dialog 가 닫힐 때도 session 정리 (close 이벤트는 모든 닫힘 경로 캐치)
  $('sk-form-dialog').addEventListener('close', () => {
    session = null;
  });

  // 시간 select option 채우기 — placeholder + 48개 (00:00 ~ 23:30, 30분 단위).
  populateTimeOptions();

  // 폼 input — 입력 중 천 단위 콤마 자동 포맷
  ['sk-input-general', 'sk-input-training', 'sk-input-construction'].forEach((id) => {
    $(id).addEventListener('input', onNumericInput);
  });

  // 폼 엔터 흐름: 공용 → 병사 → 건설 → 저장.
  // DOM 순서대로 다음 input 이 있으면 focus, 마지막(건설)에서 엔터면 onSaveForm.
  const formInputs = ['sk-input-general', 'sk-input-training', 'sk-input-construction'];
  formInputs.forEach((id, i) => {
    $(id).addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      e.preventDefault();
      const next = formInputs[i + 1];
      if (next) {
        const el = $<HTMLInputElement>(next);
        el.focus();
        el.select();
      } else {
        onSaveForm();
      }
    });
  });

  // 닉네임/ID 검색 — 입력 즉시 필터링 (debounce 없음 — 22~수백명 규모라 부담 X)
  const searchInput = $<HTMLInputElement>('sk-list-search');
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderList();
  });

  // 인증샷 — 파일 선택 시 압축 → 메모리 blob 으로 보관 (실제 업로드는 [저장] 클릭 시)
  const evidenceInput = $<HTMLInputElement>('sk-input-evidence');
  evidenceInput.addEventListener('change', async () => {
    const file = evidenceInput.files?.[0];
    if (!file) return;
    try {
      // image-optimize 기본값: 1080px / WebP / quality 0.80 + iOS17 폴백
      const result = await optimizeImage(file);
      if (pendingEvidence.previewUrl) URL.revokeObjectURL(pendingEvidence.previewUrl);
      pendingEvidence = {
        pendingBlob: result.blob,
        pendingName: file.name.replace(/\.[^/.]+$/, '') + '.webp',
        removed: false,
        previewUrl: URL.createObjectURL(result.blob),
      };
      syncEvidenceUI();
    } catch (e) {
      setStatus(
        'sk-form-status',
        t('survey.kvk.form.evidenceUploadFailed') + ` (${(e as Error).message})`,
        'err',
      );
    } finally {
      // 같은 파일 다시 선택 시 change 이벤트 발화 보장
      evidenceInput.value = '';
    }
  });

  // 인증샷 [제거] — 임시 상태만 변경 (Storage 호출 X, 저장 시 일괄)
  $('sk-evidence-remove').addEventListener('click', () => {
    if (pendingEvidence.previewUrl) URL.revokeObjectURL(pendingEvidence.previewUrl);
    pendingEvidence = { pendingBlob: null, pendingName: null, removed: true, previewUrl: null };
    syncEvidenceUI();
  });

  // 가속권 도움말 이미지 다이얼로그
  $('sk-help-image-trigger').addEventListener('click', openImageDialog);
  // 다이얼로그 어디 클릭하든 닫힘 (이미지 자체 포함)
  $('sk-image-dialog').addEventListener('click', closeImageDialog);

  // 목록 — 새로고침 버튼은 공용 헬퍼 사용 (.is-loading 토글 → SVG spin)
  bindRefreshButton('sk-list-refresh', refreshList);

  // 정렬 chip (PC + 모바일 공용)
  document.querySelectorAll<HTMLButtonElement>('.sk-sort-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort as SortKey | undefined;
      if (!key) return;
      onSortClick(key);
    });
  });

  // 행 클릭 → 상세 다이얼로그 (이벤트 위임 — tbody 가 patchList 로 매번 갱신돼도 안전)
  $('sk-tbody').addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('.sk-tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (!id) return;
    const row = rowsCache.find((r) => r.kingshot_id === id);
    if (row) openDetailDialog(row);
  });

  // 상세 다이얼로그 닫기 — X 버튼 + backdrop 클릭
  $('sk-detail-close').addEventListener('click', closeDetailDialog);
  $('sk-detail-dialog').addEventListener('click', (e) => {
    // dialog 본체(backdrop)는 dialog 자체가 target. 카드 내부는 stop.
    if (e.target === e.currentTarget) closeDetailDialog();
  });

  // 필독 안내문 다이얼로그 — 트리거 click → showModal, close/backdrop → close
  const noticeDlg = $<HTMLDialogElement>('sk-notice-dialog');
  $('sk-notice-trigger').addEventListener('click', () => {
    if (!noticeDlg.open) noticeDlg.showModal();
  });
  $('sk-notice-close').addEventListener('click', () => noticeDlg.close());
  noticeDlg.addEventListener('click', (e) => {
    if (e.target === noticeDlg) noticeDlg.close();
  });

  // 인증샷 lightbox — 상세 다이얼로그의 인증샷 버튼 클릭 → 현재 행의 evidence_uploaded_at 으로 URL 계산.
  // 같은 <img> element 재사용이라 src 만 바꾸면 새 이미지 로드 중에 "이전 사용자 인증샷" 이 잠깐 보임.
  //   (1) .loaded 클래스 제거 → opacity 0 으로 리셋
  //   (2) src 비우기 → 이전 픽셀 즉시 제거
  //   (3) showModal → 빈 영역으로 다이얼로그 열림 (사용자 클릭 반응 즉시)
  //   (4) onload 시 .loaded → 새 이미지 fade-in
  $('sk-detail-evidence-btn').addEventListener('click', () => {
    const row = detailDialogRow;
    if (!row || !row.evidence_uploaded_at) return;
    const url = evidenceUrl(row.kingshot_id, row.evidence_uploaded_at);
    const img = $<HTMLImageElement>('sk-evidence-lightbox-img');
    img.classList.remove('loaded');
    img.removeAttribute('src');
    const dlg = $<HTMLDialogElement>('sk-evidence-lightbox');
    if (!dlg.open) dlg.showModal();
    img.onload = () => img.classList.add('loaded');
    img.src = url;
  });
  // lightbox — 어디 클릭하든 닫힘
  $('sk-evidence-lightbox').addEventListener('click', () => {
    const dlg = $<HTMLDialogElement>('sk-evidence-lightbox');
    if (dlg.open) dlg.close();
  });

  // 언어 변경 시 동적 텍스트 재렌더 — data-i18n 으로 못 잡는 JS 가 textContent 박은 값들
  onLangChange(() => {
    renderList();
    renderBlockedCurrent(); // "현재 레벨: TC N" 동적 텍스트 (있을 때만)
    renderDetailDialog(); // 상세 다이얼로그 점수/시간 동적 텍스트 (열려있을 때만)
    // 시간 select 의 placeholder 옵션 텍스트 (동적 생성된 항목)
    const ph = document.querySelector<HTMLOptionElement>(
      '#sk-input-preferred-time option[data-placeholder="1"]',
    );
    if (ph) ph.textContent = t('survey.kvk.form.preferredTimePlaceholder');
  });

  // 마감 카운트다운 — 등록/수정 버튼 안 카운트다운 텍스트 + urgency 색 단계 갱신.
  startDeadlineCountdown();

  // boot — 저장된 토큰 있으면 서버 verify-token 으로 검증 후 자동 로그인 + 잠금 해제.
  // verify-token 실패 (만료/무효/강등) 시 토큰 제거 → 잠금 placeholder 노출.
  void bootVerifyAuth();
}

/** 마감까지 남은 시간 포맷. 항상 초 단위 포함. 큰 단위는 0 일 때 자동 truncate. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 등록/수정 버튼의 카운트다운 텍스트 + urgency 클래스 1초마다 갱신.
 *  마감 시 disabled + "등록 마감" 라벨로 전환 + interval 정리. */
let countdownTimer: number | null = null;

/** 마감 후 [버프 예약] 클릭 시점에 미인증이면 auth-dialog 오픈 + 이 플래그 set.
 *  인증 성공 (saveAuth 호출 후) → 자동 /kvk-buff/ 리다이렉트. */
let pendingBuffNavigate = false;

function startDeadlineCountdown(): void {
  const btn = $<HTMLButtonElement>('sk-list-add');
  const txt = $('sk-list-add-countdown-text');
  const labelEl = btn.querySelector<HTMLElement>('.sk-list-add-label');
  const deadline = new Date(SURVEY_DEADLINE_ISO).getTime();

  function tick() {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // 마감 후 — 등록 차단하고 [버프 예약] 페이지 진입 버튼으로 자동 전환.
      btn.classList.remove('is-warning', 'is-danger', 'is-closed');
      btn.classList.add('is-buff-link');
      btn.disabled = false;
      if (labelEl) patchText(labelEl, t('survey.kvk.list.buffBookingButton'));
      const cd = btn.querySelector<HTMLElement>('.sk-list-add-countdown');
      if (cd) cd.style.display = 'none';
      // 클릭 시:
      //  - 인증된 사용자 → 즉시 /kvk-buff/ 이동
      //  - 미인증 → 기존 auth-dialog (ID + PIN). 인증 성공 후 자동 이동 (pendingBuffNavigate).
      btn.onclick = () => {
        if (getAuth()) {
          window.location.href = '/kvk-buff/';
        } else {
          pendingBuffNavigate = true;
          openAuthDialog();
        }
      };
      if (countdownTimer !== null) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      return;
    }
    patchText(txt, formatCountdown(remaining));
    btn.classList.toggle(
      'is-warning',
      remaining <= URGENCY_WARN_MS && remaining > URGENCY_DANGER_MS,
    );
    btn.classList.toggle('is-danger', remaining <= URGENCY_DANGER_MS);
  }
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

async function bootVerifyAuth(): Promise<void> {
  const auth = getAuth();
  if (!auth) {
    // 토큰 없음 — 잠금 상태로 placeholder 표시
    applyUnlockState();
    refreshList(); // 잠금이라 list API 호출 안 함 (refreshList 자체가 가드)
    return;
  }
  // 토큰 있음 — verify-token 으로 서버 검증
  try {
    const json = await callFn<{ ok: boolean; error?: string; record?: MyRecord }>({
      action: 'verify-token',
      token: auth.token,
    });
    if (json.ok && json.record) {
      // 서버 record 로 캐시 갱신 (게임 닉네임/수치 변경 반영)
      saveAuth({ ...auth, record: json.record });
      setUnlocked();
    } else {
      // 만료/무효/강등 — 토큰 폐기
      clearAuth();
    }
  } catch {
    // 네트워크 오류 — 캐시 신뢰하고 일단 unlock (다음 mutation 에서 재검증)
    setUnlocked();
  }
  applyUnlockState();
  refreshList();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
