/**
 * Header 의 크리스탈 잔액 배지 동기화.
 *
 * 동작:
 *   1) 페이지 로드 시 sessionStorage 의 tile-match 세션을 확인.
 *      세션이 있으면 economy Edge Function 으로 잔액 fetch → 배지 표시.
 *   2) 'crystal-balance-update' 이벤트를 listen → 잔액 즉시 갱신.
 *      (tile-match 의 보상 청구 응답 시 디스패치됨)
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';

const FN_ECONOMY_URL = SUPABASE_URL + '/functions/v1/economy';
const SESSION_STORAGE_KEY = 'tileMatchAuth';

interface BalanceResponse {
  ok?: boolean;
  balance?: number;
  error?: string;
}

function getStoredPlayerId(): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { player_id?: string };
    return parsed?.player_id ?? null;
  } catch {
    return null;
  }
}

async function fetchBalance(playerId: string): Promise<number | null> {
  try {
    const res = await fetch(FN_ECONOMY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ action: 'get-balance', player_id: playerId }),
    });
    const data = (await res.json()) as BalanceResponse;
    if (!data.ok || typeof data.balance !== 'number') return null;
    return data.balance;
  } catch {
    return null;
  }
}

function setBadge(balance: number | null): void {
  const badge = document.getElementById('header-crystal-badge');
  const valueEl = document.getElementById('header-crystal-value');
  if (!badge || !valueEl) return;
  if (balance === null) {
    badge.style.display = 'none';
    return;
  }
  valueEl.textContent = balance.toLocaleString('ko-KR');
  badge.style.display = '';
}

function init(): void {
  const playerId = getStoredPlayerId();
  if (playerId) {
    fetchBalance(playerId).then(setBadge);
  } else {
    setBadge(null);
  }

  window.addEventListener('crystal-balance-update', ((e: Event) => {
    const detail = (e as CustomEvent<{ balance: number }>).detail;
    if (detail && typeof detail.balance === 'number') {
      setBadge(detail.balance);
    }
  }) as EventListener);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
