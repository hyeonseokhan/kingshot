/**
 * 미니게임 본인 인증 — tile-match-auth.js 의 TypeScript 이식.
 * tile-match.ts / partner-draw.ts 가 import + window.TileMatchAuth 양쪽으로 사용.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import { membersStore, fetchMembers } from '@/lib/stores/members';
import { t } from '@/i18n';

const SESSION_KEY = 'tileMatchAuth';
const FN_AUTH_URL = SUPABASE_URL + '/functions/v1/tile-match-auth';

export interface AuthSession {
  player_id: string;
  nickname: string;
  /** 관리자 여부 — 기존 sessionStorage 의 구버전 세션은 undefined → false 로 취급. */
  is_admin?: boolean;
}

/** 세션 객체에서 admin 여부를 안전하게 읽음 (구버전 세션 호환). */
export function isAdminSession(s: AuthSession | null | undefined): boolean {
  return !!s?.is_admin;
}

// 인증 다이얼로그가 표시하는 멤버 정보 — Member 의 subset.
interface MemberLite {
  kingshot_id: string;
  nickname: string;
  level?: number | null;
  profile_photo?: string | null;
}

function getMembers(): MemberLite[] {
  return (membersStore.get() ?? []) as MemberLite[];
}

// ===== 모듈 상태 =====
let initialized = false;
let selectedMember: MemberLite | null = null;
let pinMode: 'set' | 'verify' | null = null;
let pinInput = '';
let firstPin: string | null = null;
let pendingResolve: ((s: AuthSession | null) => void) | null = null;
const changeListeners: Array<(s: AuthSession | null) => void> = [];

// ===== util =====
function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// 세션 저장소 — localStorage (탭 닫혀도 유지). 카톡 in-app 브라우저처럼 매 진입이
// 새 탭인 환경에서도 자동 로그인 유지. 명시 로그아웃 버튼으로만 세션 종료.
//
// 보안 trade-off: PIN 4자리 + 연맹 도구 컨텍스트라 영구 세션 위험도 낮음. 서버는 매 호출시
// DB 에서 is_admin 등 권한 재검증 → localStorage 캐시 stale 영향은 UI 표시 한정.
//
// 다중 탭 sync: 'storage' 이벤트 listener 가 다른 탭 변경을 즉시 반영
// (현재 탭 변경은 setSession/clearSession 직후 notifyChange() 가 manual trigger).
export function getSession(): AuthSession | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as AuthSession | null;
  } catch {
    return null;
  }
}

function setSession(s: AuthSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  notifyChange();
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  notifyChange();
}

export function onSessionChange(fn: (s: AuthSession | null) => void): void {
  changeListeners.push(fn);
}

function notifyChange(): void {
  const s = getSession();
  changeListeners.forEach((fn) => {
    try {
      fn(s);
    } catch {
      /* */
    }
  });
}

// 다른 탭에서 로그인/로그아웃 시 현재 탭 UI 도 즉시 sync.
// `storage` 이벤트는 본인 탭 외 다른 탭에서만 발화 (본인 탭은 setSession 직후 notifyChange 로 처리).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY) notifyChange();
  });
}

// ===== 다이얼로그 open/close =====
function openAuth(): Promise<AuthSession | null> {
  return new Promise<AuthSession | null>((resolve) => {
    pendingResolve = resolve;
    const overlay = $('tm-auth-overlay');
    if (overlay) overlay.style.display = '';
    document.body.style.overflow = 'hidden';
    resetState();
    showStep('select');
    loadMembers();
    const s = $<HTMLInputElement>('tm-auth-search');
    if (s) {
      s.value = '';
      setTimeout(() => s.focus(), 200);
    }
  });
}

function closeAuth(success: boolean): void {
  const overlay = $('tm-auth-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  const resolve = pendingResolve;
  pendingResolve = null;
  if (resolve) resolve(success ? getSession() : null);
}

function resetState(): void {
  selectedMember = null;
  pinMode = null;
  pinInput = '';
  firstPin = null;
}

export function ensureAuth(): Promise<AuthSession | null> {
  const s = getSession();
  if (s && s.player_id) return Promise.resolve(s);
  return openAuth();
}

function showStep(step: 'select' | 'pin'): void {
  const sel = $('tm-auth-step-select');
  const pin = $('tm-auth-step-pin');
  const back = $('tm-auth-back');
  if (sel) sel.style.display = step === 'select' ? '' : 'none';
  if (pin) pin.style.display = step === 'pin' ? '' : 'none';
  if (back) back.style.display = step === 'pin' ? '' : 'none';
}

// ===== 연맹원 목록 — membersStore 공유 =====
function loadMembers(): void {
  const box = $('tm-auth-list');
  if (!box) return;
  // 캐시 있으면 즉시 표시 + 백그라운드 새로고침. store freshness 체크가 자동으로 fetch 스킵.
  const cached = getMembers();
  if (cached.length > 0) {
    renderList(cached);
  } else {
    box.innerHTML = '<div class="tm-auth-empty">' + escapeHtml(t('authDialog.loadingMembers')) + '</div>';
  }
  membersStore
    .refresh(fetchMembers)
    .then((list) => renderList(list as MemberLite[]))
    .catch((err: Error) => {
      if (cached.length === 0) {
        box.innerHTML =
          '<div class="tm-auth-empty">' +
          escapeHtml(t('authDialog.loadFailed', { message: err.message || String(err) })) +
          '</div>';
      }
    });
}

function filterMembers(q: string): MemberLite[] {
  const all = getMembers();
  q = (q || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter((m) => {
    const nick = (m.nickname || '').toLowerCase();
    const pid = String(m.kingshot_id || '').toLowerCase();
    return nick.indexOf(q) !== -1 || pid.indexOf(q) !== -1;
  });
}

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return map[c]!;
  });
}

function renderList(list: MemberLite[]): void {
  const box = $('tm-auth-list');
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="tm-auth-empty">' + escapeHtml(t('authDialog.searchEmpty')) + '</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  list.slice(0, 50).forEach((m) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tm-auth-item';
    const photoHtml = m.profile_photo
      ? '<img class="tm-auth-item-photo" src="' + escapeHtml(m.profile_photo) + '" alt="">'
      : '<span class="tm-auth-item-photo-empty">' +
        escapeHtml((m.nickname || '?').slice(0, 1).toUpperCase()) +
        '</span>';
    el.innerHTML =
      photoHtml +
      '<span class="tm-auth-item-text">' +
      '<span class="tm-auth-item-name">' +
      escapeHtml(m.nickname || '') +
      '</span>' +
      '<span class="tm-auth-item-id">ID ' +
      escapeHtml(m.kingshot_id || '') +
      (m.level ? ' · Lv.' + m.level : '') +
      '</span>' +
      '</span>';
    el.addEventListener('click', () => onSelectMember(m));
    frag.appendChild(el);
  });
  box.appendChild(frag);
}

// ===== 연맹원 선택 → pin-status =====
function onSelectMember(m: MemberLite): void {
  selectedMember = m;
  pinMode = null;
  firstPin = null;
  setMsg('');
  const sel = $('tm-auth-selected');
  if (sel) sel.textContent = m.nickname + ' (' + m.kingshot_id + ')';
  const prompt = $('tm-auth-pin-prompt');
  if (prompt) prompt.textContent = t('authDialog.checking');
  showStep('pin');
  setPinValue('');
  const inp = $<HTMLInputElement>('tm-pin-input');
  if (inp) inp.focus();

  callAuth('pin-status', { player_id: m.kingshot_id }).then((res) => {
    if (!res.ok) {
      setMsg(
        res.error === 'member_not_found'
          ? t('authDialog.memberNotFound')
          : t('authDialog.loadFailed', { message: res.error || '' }),
      );
      const p = $('tm-auth-pin-prompt');
      if (p) p.textContent = '';
      return;
    }
    pinMode = res.registered ? 'verify' : 'set';
    const p = $('tm-auth-pin-prompt');
    if (p)
      p.textContent =
        pinMode === 'set' ? t('authDialog.pinSetPrompt') : t('auth.pinPrompt');
    if (pinInput.length === 4) submitPin();
  });
}

// ===== PIN =====
function renderPinBoxes(): void {
  const boxes = document.querySelectorAll<HTMLElement>('#tm-pin-boxes .tm-pin-box');
  for (let i = 0; i < 4; i++) {
    if (!boxes[i]) continue;
    boxes[i]!.textContent = pinInput[i] ? '●' : '';
    boxes[i]!.classList.toggle('tm-pin-box-filled', !!pinInput[i]);
    boxes[i]!.classList.toggle('tm-pin-box-active', i === pinInput.length);
  }
}

function setPinValue(v: string): void {
  pinInput = v;
  const inp = $<HTMLInputElement>('tm-pin-input');
  if (inp && inp.value !== v) inp.value = v;
  renderPinBoxes();
}

function focusPinInput(): void {
  setTimeout(() => {
    const inp = $<HTMLInputElement>('tm-pin-input');
    if (inp) inp.focus();
  }, 60);
}

function submitPin(): void {
  if (pinInput.length !== 4 || !selectedMember) return;
  if (!pinMode) return;
  if (pinMode === 'set') {
    if (firstPin === null) {
      firstPin = pinInput;
      const p = $('tm-auth-pin-prompt');
      if (p) p.textContent = t('authDialog.pinSetConfirm');
      setMsg('');
      setPinValue('');
      focusPinInput();
    } else if (firstPin !== pinInput) {
      setMsg(t('authDialog.pinMismatch'));
      firstPin = null;
      const p = $('tm-auth-pin-prompt');
      if (p) p.textContent = t('authDialog.pinSetPrompt');
      setPinValue('');
      focusPinInput();
    } else {
      const member = selectedMember;
      callAuth('set-pin', { player_id: member.kingshot_id, pin: pinInput }).then((res) => {
        if (res.ok) {
          setSession({
            player_id: member.kingshot_id,
            nickname: member.nickname,
            is_admin: !!res.is_admin,
          });
          closeAuth(true);
        } else {
          setMsg(t('authDialog.pinSetFailed', { error: res.error || '' }));
          firstPin = null;
          setPinValue('');
          focusPinInput();
        }
      });
    }
  } else {
    const member = selectedMember;
    callAuth('verify-pin', { player_id: member.kingshot_id, pin: pinInput }).then((res) => {
      if (res.ok) {
        setSession({
          player_id: member.kingshot_id,
          nickname: member.nickname,
          is_admin: !!res.is_admin,
        });
        closeAuth(true);
      } else {
        setMsg(t('authDialog.pinVerifyFailed'));
        setPinValue('');
        focusPinInput();
      }
    });
  }
}

function setMsg(m: string): void {
  const el = $('tm-auth-msg');
  if (el) el.textContent = m || '';
}

interface AuthResponse {
  ok: boolean;
  error?: string;
  registered?: boolean;
  is_admin?: boolean;
}

function callAuth(action: string, body: Record<string, unknown>): Promise<AuthResponse> {
  return fetch(FN_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(Object.assign({ action }, body)),
  })
    .then((r) => r.json() as Promise<AuthResponse>)
    .catch((err: Error) => ({ ok: false, error: String(err.message || err) }));
}

// ===== init =====
export function initAuthPage(): void {
  if (initialized) return;
  initialized = true;

  const search = $<HTMLInputElement>('tm-auth-search');
  if (search) {
    search.addEventListener('input', () => renderList(filterMembers(search.value)));
  }

  const pinIn = $<HTMLInputElement>('tm-pin-input');
  if (pinIn) {
    pinIn.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      const v = (target.value || '').replace(/\D/g, '').slice(0, 4);
      setPinValue(v);
      if (v.length === 4) setTimeout(submitPin, 120);
    });
    pinIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && pinInput.length === 4) {
        e.preventDefault();
        submitPin();
      }
    });
    const wrap = $('tm-pin-wrap');
    if (wrap) wrap.addEventListener('click', focusPinInput);
  }

  const closeBtn = $('tm-auth-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeAuth(false));

  const backBtn = $('tm-auth-back');
  if (backBtn)
    backBtn.addEventListener('click', () => {
      resetState();
      showStep('select');
      setMsg('');
      const s = $<HTMLInputElement>('tm-auth-search');
      if (s) s.value = '';
      renderList(getMembers());
    });

  // store freshness 체크가 자동으로 fetch 스킵 — 매번 호출해도 OK
  loadMembers();
}

/** 다른 모듈(타일매치/파트너)이 멤버 목록 재사용. */
export function getCachedMembers(): MemberLite[] {
  return getMembers();
}

// 전역 노출 (cross-module 호환)
declare global {
  interface Window {
    TileMatchAuth: {
      initPage: () => void;
      ensureAuth: () => Promise<AuthSession | null>;
      getSession: () => AuthSession | null;
      clearSession: () => void;
      onSessionChange: (fn: (s: AuthSession | null) => void) => void;
      readonly _cachedMembers: MemberLite[];
    };
  }
}

window.TileMatchAuth = {
  initPage: initAuthPage,
  ensureAuth,
  getSession,
  clearSession,
  onSessionChange,
  get _cachedMembers() {
    return getMembers();
  },
};
