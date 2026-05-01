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
import { patchText } from '@/lib/dom-diff';
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

// ===== SWR 캐시 (localStorage) =====
// 페이지 이동(SSR full reload) 시 매번 fetch 하면 깜박임 — 캐시된 값으로 즉시 표시 후
// 백그라운드 fetch 로 fresh 값 patch.
const CACHE_KEY = 'pnx-hu-cache-v1';

interface HuCache {
  player_id: string;
  balance: number | null;
  profile_photo: string | null;
  cached_at: number;
}

function readCache(playerId: string): HuCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as HuCache;
    return c.player_id === playerId ? c : null;
  } catch {
    return null;
  }
}

function writeCache(patch: Partial<HuCache> & { player_id: string }): void {
  try {
    const prev = readCache(patch.player_id) ?? {
      player_id: patch.player_id,
      balance: null,
      profile_photo: null,
      cached_at: 0,
    };
    const next: HuCache = { ...prev, ...patch, cached_at: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
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
  // patchText: 같은 값이면 no-op — broadcast 가 같은 값 반복 시 textContent 재할당 안 함
  patchText($('hu-crystal-value'), (balance ?? 0).toLocaleString('ko-KR'));
}

// 아바타 영역의 placeholder (initial 글자) 즉시 표시. 이미지 fetch 중에도 같은 자리에 글자가 보임.
function setAvatarPlaceholder(nickname: string): void {
  const wrap = $('hu-avatar');
  const img = $<HTMLImageElement>('hu-avatar-img');
  const initial = $('hu-avatar-initial');
  if (!wrap || !img || !initial) return;
  initial.textContent = (nickname || '?').slice(0, 1).toUpperCase();
  // 이전 사진 잔재 제거 — 다른 계정으로 swap 시
  img.classList.remove('loaded');
  wrap.classList.remove('has-img');
  img.removeAttribute('src');
}

// 사진 URL 이 도착하면 같은 26x26 원 안에서 in-place 로 placeholder 글자 위에 덮어씀.
function loadAvatarImage(url: string): void {
  const wrap = $('hu-avatar');
  const img = $<HTMLImageElement>('hu-avatar-img');
  if (!wrap || !img) return;
  img.onload = () => {
    img.classList.add('loaded');
    wrap.classList.add('has-img');
  };
  img.onerror = () => {
    img.classList.remove('loaded');
    wrap.classList.remove('has-img');
  };
  img.src = url;
}

function setState(state: 'loading' | 'loggedin' | 'loggedout'): void {
  const root = $('hu-root');
  if (root) root.dataset.state = state;
  if (state !== 'loggedin') closeDropdown();
}

function renderSession(session: AuthSession | null): void {
  if (!session?.player_id) {
    setState('loggedout');
    return;
  }
  // 1) 동기적으로 즉시 카드 표시 — 닉네임은 세션 정보, 캐시된 잔액/아바타로 깜박임 0.
  setState('loggedin');
  patchText($('hu-name'), session.nickname);
  patchText($('hu-dropdown-name'), session.nickname);
  setAvatarPlaceholder(session.nickname);

  // 2) SWR — 캐시 있으면 즉시 적용 (깜박임 0), 캐시 miss 면 placeholder 표시.
  const cache = readCache(session.player_id);
  if (cache) {
    if (typeof cache.balance === 'number') setCrystal(cache.balance);
    else patchText($('hu-crystal-value'), '—');
    if (cache.profile_photo) loadAvatarImage(cache.profile_photo);
  } else {
    patchText($('hu-crystal-value'), '—');
  }

  // 3) 백그라운드 fetch — fresh 도착하면 patchText (같은 값이면 no-op) + 캐시 업데이트.
  fetchProfilePhoto(session.player_id).then((url) => {
    if (url) {
      loadAvatarImage(url);
      writeCache({ player_id: session.player_id, profile_photo: url });
    }
  });
  fetchBalance(session.player_id).then((balance) => {
    setCrystal(balance);
    writeCache({ player_id: session.player_id, balance });
  });
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
  // 캐시도 같이 제거 — 다른 계정으로 로그인 시 옛 잔액/아바타 잠시라도 보이지 않게
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* */
  }
  setState('loggedout');
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

  // 잔액 갱신 이벤트 (tile-match 의 보상 응답 등에서 디스패치) — UI 갱신 + 캐시도 동시 업데이트
  window.addEventListener('crystal-balance-update', ((e: Event) => {
    const detail = (e as CustomEvent<{ balance: number }>).detail;
    if (detail && typeof detail.balance === 'number') {
      setCrystal(detail.balance);
      const sess = getSession();
      if (sess?.player_id) writeCache({ player_id: sess.player_id, balance: detail.balance });
    }
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
