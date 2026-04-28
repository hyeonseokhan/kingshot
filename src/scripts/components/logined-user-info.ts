/**
 * 헤더 우측 인증 위젯의 클라이언트 로직.
 *
 * 책임:
 *   - sessionStorage 의 인증 세션을 읽고 UI 상태(로그인/비로그인) 반영
 *   - 로그인 클릭 → ensureAuth (AuthDialog 띄움)
 *   - 로그아웃 클릭 → clearSession + ensureAuth (자동으로 다시 로그인 다이얼로그)
 *   - crystal-balance-update 이벤트 listen → 💎 값 즉시 갱신
 *   - 모바일에서 트리거 클릭 → 드롭다운 토글
 *
 * AuthDialog DOM 이 페이지에 없으면 ensureAuth 가 무한 대기함 → BaseLayout 에 항상 마운트 보장.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import {
  getSession,
  clearSession,
  ensureAuth,
  onSessionChange,
  initAuthPage,
  type AuthSession,
} from '@/scripts/pages/tile-match-auth';

const FN_ECONOMY_URL = SUPABASE_URL + '/functions/v1/economy';

interface BalanceResponse {
  ok?: boolean;
  balance?: number;
  error?: string;
}

interface MemberLite {
  kingshot_id: string;
  profile_photo?: string | null;
}

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function fetchBalance(playerId: string): Promise<number | null> {
  return fetch(FN_ECONOMY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: 'get-balance', player_id: playerId }),
  })
    .then((r) => r.json() as Promise<BalanceResponse>)
    .then((d) => (d?.ok && typeof d.balance === 'number' ? d.balance : null))
    .catch(() => null);
}

function fetchProfilePhoto(playerId: string): Promise<string | null> {
  return fetch(
    SUPABASE_URL +
      '/rest/v1/members?select=profile_photo&kingshot_id=eq.' +
      encodeURIComponent(playerId),
    {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    },
  )
    .then((r) => r.json() as Promise<MemberLite[]>)
    .then((rows) => rows?.[0]?.profile_photo ?? null)
    .catch(() => null);
}

function setCrystal(balance: number | null): void {
  const v = $('hu-crystal-value');
  if (!v) return;
  v.textContent = (balance ?? 0).toLocaleString('ko-KR');
}

function setAvatar(url: string | null, nickname: string): void {
  const wrap = $('hu-avatar');
  const img = $<HTMLImageElement>('hu-avatar-img');
  const initial = $('hu-avatar-initial');
  if (!wrap || !img || !initial) return;
  initial.textContent = (nickname || '?').slice(0, 1).toUpperCase();
  if (url) {
    img.onload = () => {
      img.classList.add('loaded');
      wrap.classList.add('has-img');
    };
    img.onerror = () => {
      img.classList.remove('loaded');
      wrap.classList.remove('has-img');
    };
    img.src = url;
  } else {
    img.removeAttribute('src');
    img.classList.remove('loaded');
    wrap.classList.remove('has-img');
  }
}

function setState(loggedIn: boolean): void {
  const root = $('hu-root');
  if (root) root.dataset.state = loggedIn ? 'loggedin' : 'loggedout';
  if (!loggedIn) closeDropdown();
}

function renderSession(session: AuthSession | null): void {
  if (!session?.player_id) {
    setState(false);
    return;
  }
  setState(true);
  const name = $('hu-name');
  const dropdownName = $('hu-dropdown-name');
  if (name) name.textContent = session.nickname;
  if (dropdownName) dropdownName.textContent = session.nickname;

  // 아바타: members 테이블 1회 조회 (캐시 안 함 — 잔액 fetch 와 동일 라이프사이클)
  fetchProfilePhoto(session.player_id).then((url) => setAvatar(url, session.nickname));

  // 잔액
  fetchBalance(session.player_id).then(setCrystal);
}

function openDropdown(): void {
  const dd = $('hu-dropdown');
  const trigger = $('hu-trigger');
  if (!dd || !trigger) return;
  dd.dataset.open = 'true';
  dd.removeAttribute('hidden');
  trigger.setAttribute('aria-expanded', 'true');
}

function closeDropdown(): void {
  const dd = $('hu-dropdown');
  const trigger = $('hu-trigger');
  if (!dd || !trigger) return;
  dd.dataset.open = 'false';
  dd.setAttribute('hidden', '');
  trigger.setAttribute('aria-expanded', 'false');
}

function toggleDropdown(): void {
  const dd = $('hu-dropdown');
  if (!dd) return;
  if (dd.dataset.open === 'true') closeDropdown();
  else openDropdown();
}

function onLogout(): void {
  closeDropdown();
  clearSession();
  setState(false);
  // 사용자가 로그아웃 직후 곧장 다른 계정/같은 계정으로 다시 로그인할 가능성이 높음 → 즉시 다이얼로그
  ensureAuth().then((s) => {
    if (s) renderSession(s);
  });
}

function onLogin(): void {
  ensureAuth().then((s) => {
    if (s) renderSession(s);
  });
}

function init(): void {
  // AuthDialog 핸들러 등록 (멱등 — 다른 페이지에서 이미 호출됐어도 안전)
  initAuthPage();

  $('hu-login')?.addEventListener('click', onLogin);
  $('hu-logout-desktop')?.addEventListener('click', onLogout);
  $('hu-logout-mobile')?.addEventListener('click', onLogout);
  $('hu-trigger')?.addEventListener('click', (e) => {
    // 모바일에서만 드롭다운 토글. 데스크톱은 4요소(아바타/닉네임/크리스탈/로그아웃) 가 이미 다 펼쳐져있으므로 클릭 무시.
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    e.stopPropagation();
    toggleDropdown();
  });

  // 드롭다운 외부 클릭 시 닫기
  document.addEventListener('click', (e) => {
    const dd = $('hu-dropdown');
    if (!dd || dd.dataset.open !== 'true') return;
    if (e.target instanceof Node && !dd.contains(e.target)) closeDropdown();
  });

  // 잔액 갱신 이벤트 (tile-match 의 보상 응답 등에서 디스패치)
  window.addEventListener('crystal-balance-update', ((e: Event) => {
    const detail = (e as CustomEvent<{ balance: number }>).detail;
    if (detail && typeof detail.balance === 'number') setCrystal(detail.balance);
  }) as EventListener);

  // 다른 모듈이 setSession/clearSession 할 때마다 알림
  onSessionChange(renderSession);

  // 첫 렌더
  renderSession(getSession());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
