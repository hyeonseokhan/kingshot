/**
 * 장비 강화 페이지 (Phase B).
 *
 * 동작:
 *   - 인증된 사용자: get-equipment 로 6슬롯 상태 fetch, 카드 렌더
 *   - 강화 버튼 클릭: enhance API 호출 → 결과 카드에 표시 + 잔액 broadcast
 *   - 비인증: 헤더 로그인 안내 표시 + 모든 강화 버튼 disabled
 *
 * 의존: tile-match-auth.ts (window.TileMatchAuth) — 인증 세션 공유
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import {
  EQUIPMENT_SLOTS,
  ENHANCE_MAX_LEVEL,
  enhanceCostFor,
  type EquipmentSlot,
} from '@/lib/balance';
import { patchText } from '@/lib/dom-diff';

const FN_ECONOMY_URL = SUPABASE_URL + '/functions/v1/economy';
const FN_EQUIPMENT_URL = SUPABASE_URL + '/functions/v1/equipment';

let initialized = false;
let currentBalance = 0;
const slotState = new Map<EquipmentSlot, { level: number; power: number }>();
let busySlots = new Set<EquipmentSlot>();

interface EquipmentResp {
  ok: boolean;
  error?: string;
  levels?: Array<{ slot: EquipmentSlot; level: number; power: number; last_attempt_at: string | null }>;
  total_power?: number;
}

interface EnhanceResp {
  ok: boolean;
  error?: string;
  success?: boolean;
  new_level?: number;
  new_power?: number;
  cost?: number;
  balance?: number;
  current_level?: number;
}

interface BalanceResp {
  ok: boolean;
  balance?: number;
}

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function slotEl(slot: EquipmentSlot): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.eq-slot[data-slot="${slot}"]`);
}

function field(parent: HTMLElement, key: string): HTMLElement | null {
  return parent.querySelector<HTMLElement>(`[data-field="${key}"]`);
}

// ===== API =====

function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  })
    .then((r) => r.json() as Promise<T>)
    .catch((err: Error) => ({ ok: false, error: String(err.message || err) }) as T);
}

function fetchEquipment(playerId: string): Promise<void> {
  return postJson<EquipmentResp>(FN_EQUIPMENT_URL, {
    action: 'get-equipment',
    player_id: playerId,
  }).then((res) => {
    if (!res.ok || !res.levels) return;
    res.levels.forEach((l) => slotState.set(l.slot, { level: l.level, power: l.power }));
    renderAllSlots();
    renderTotalPower(res.total_power ?? 0);
  });
}

function fetchBalance(playerId: string): Promise<void> {
  return postJson<BalanceResp>(FN_ECONOMY_URL, {
    action: 'get-balance',
    player_id: playerId,
  }).then((res) => {
    if (!res.ok) return;
    setBalance(res.balance ?? 0);
  });
}

// ===== 렌더 =====

function renderAllSlots(): void {
  EQUIPMENT_SLOTS.forEach((slot) => renderSlot(slot));
}

function renderSlot(slot: EquipmentSlot): void {
  const el = slotEl(slot);
  if (!el) return;
  const state = slotState.get(slot) ?? { level: 0, power: 0 };
  const next = enhanceCostFor(state.level);

  const levelEl = field(el, 'level');
  if (levelEl) {
    let label = '+' + state.level;
    if (state.level === 5) label += ' (Bronze)';
    else if (state.level === ENHANCE_MAX_LEVEL) label += ' (Silver)';
    patchText(levelEl, label);
  }
  const powerEl = field(el, 'power');
  if (powerEl) patchText(powerEl, '+' + state.power.toLocaleString('ko-KR'));

  const nextEl = field(el, 'next');
  const btn = el.querySelector<HTMLButtonElement>('button.eq-slot-btn');

  if (!next) {
    if (nextEl) {
      nextEl.classList.add('eq-slot-next-capped');
      nextEl.textContent = '최대 강화 도달';
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = '최대 강화';
    }
    return;
  }

  // 다음 단계 정보
  const costEl = field(el, 'cost');
  const deltaEl = field(el, 'delta');
  const rateEl = field(el, 'rate');
  if (costEl) patchText(costEl, next.cost.toLocaleString('ko-KR'));
  if (deltaEl) patchText(deltaEl, String(next.power));
  if (rateEl) patchText(rateEl, String(Math.round(next.rate * 100)));
  if (nextEl) nextEl.classList.remove('eq-slot-next-capped');

  // 버튼 상태
  if (btn) {
    const insufficient = currentBalance < next.cost;
    const busy = busySlots.has(slot);
    btn.disabled = insufficient || busy;
    btn.textContent = busy ? '처리 중...' : insufficient ? '크리스탈 부족' : '강화 시도';
  }
}

function renderTotalPower(total: number): void {
  const el = $('eq-total-power');
  if (el) patchText(el, '+' + total.toLocaleString('ko-KR'));
}

function setBalance(n: number): void {
  currentBalance = n;
  // 헤더 위젯에 broadcast
  window.dispatchEvent(
    new CustomEvent('crystal-balance-update', { detail: { balance: n } }),
  );
  renderAllSlots();
}

function showResult(slot: EquipmentSlot, kind: 'success' | 'fail' | 'error', msg: string): void {
  const el = slotEl(slot);
  if (!el) return;
  const resEl = field(el, 'result');
  if (!resEl) return;
  resEl.classList.remove('eq-slot-result-success', 'eq-slot-result-fail', 'eq-slot-result-error');
  resEl.classList.add('eq-slot-result-' + kind);
  resEl.textContent = msg;
  // 4초 후 사라짐
  window.setTimeout(() => {
    if (resEl.textContent === msg) {
      resEl.textContent = '';
      resEl.classList.remove('eq-slot-result-success', 'eq-slot-result-fail', 'eq-slot-result-error');
    }
  }, 4000);
}

// ===== 이벤트 =====

function handleEnhance(slot: EquipmentSlot): void {
  const session = window.TileMatchAuth?.getSession();
  if (!session?.player_id) {
    window.TileMatchAuth?.ensureAuth();
    return;
  }
  if (busySlots.has(slot)) return;
  const state = slotState.get(slot) ?? { level: 0, power: 0 };
  const next = enhanceCostFor(state.level);
  if (!next) return;
  if (currentBalance < next.cost) {
    showResult(slot, 'error', '크리스탈 부족');
    return;
  }

  busySlots.add(slot);
  renderSlot(slot);

  postJson<EnhanceResp>(FN_EQUIPMENT_URL, {
    action: 'enhance',
    player_id: session.player_id,
    slot,
  })
    .then((res) => {
      if (!res.ok) {
        if (res.error === 'insufficient_crystals') {
          showResult(slot, 'error', '크리스탈 부족');
        } else if (res.error === 'level_capped') {
          showResult(slot, 'error', '최대 강화 도달');
        } else if (res.error === 'level_mismatch') {
          // 다른 탭에서 갱신됐을 가능성 — 새로고침
          showResult(slot, 'error', '잠시 후 재시도');
          fetchEquipment(session.player_id);
        } else {
          showResult(slot, 'error', '오류: ' + (res.error ?? 'unknown'));
        }
        return;
      }
      // 성공/실패 처리
      slotState.set(slot, {
        level: res.new_level ?? state.level,
        power: res.new_power ?? state.power,
      });
      if (typeof res.balance === 'number') setBalance(res.balance);
      // 총 전투력 재계산
      const total = Array.from(slotState.values()).reduce((s, v) => s + v.power, 0);
      renderTotalPower(total);

      if (res.success) {
        showResult(slot, 'success', '✨ +' + res.new_level + ' 강화 성공!');
      } else {
        showResult(slot, 'fail', '💔 실패 (-' + (res.cost ?? next.cost).toLocaleString('ko-KR') + ' 💎)');
      }
      renderSlot(slot);
    })
    .finally(() => {
      busySlots.delete(slot);
      renderSlot(slot);
    });
}

function showAuthPrompt(): void {
  const prompt = $('eq-auth-prompt');
  if (prompt) prompt.style.display = '';
  // 모든 카드의 다음-단계 / 버튼은 그대로 두되 disabled
  document.querySelectorAll<HTMLButtonElement>('.eq-slot-btn').forEach((b) => {
    b.disabled = true;
    b.textContent = '인증 필요';
  });
  renderTotalPower(0);
}

function hideAuthPrompt(): void {
  const prompt = $('eq-auth-prompt');
  if (prompt) prompt.style.display = 'none';
}

function onSessionReady(session: { player_id: string; nickname: string } | null): void {
  if (session?.player_id) {
    hideAuthPrompt();
    fetchBalance(session.player_id);
    fetchEquipment(session.player_id);
  } else {
    showAuthPrompt();
  }
}

// ===== 진입 =====

export function initEquipment(): void {
  if (initialized) return;
  initialized = true;

  // 강화 버튼 (이벤트 위임)
  $('eq-grid')?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action="enhance"]');
    if (!target) return;
    const slot = target.getAttribute('data-slot') as EquipmentSlot | null;
    if (slot) handleEnhance(slot);
  });

  // 인증 세션 변화 리스닝
  if (window.TileMatchAuth) {
    window.TileMatchAuth.initPage();
    window.TileMatchAuth.onSessionChange(onSessionReady);
    window.TileMatchAuth.ensureAuth().then(onSessionReady);
  } else {
    showAuthPrompt();
  }
}

// 다른 페이지(타일 매치)에서 잔액이 갱신되면 우리도 반영
window.addEventListener('crystal-balance-update', ((e: Event) => {
  const detail = (e as CustomEvent<{ balance: number }>).detail;
  if (detail && typeof detail.balance === 'number' && detail.balance !== currentBalance) {
    currentBalance = detail.balance;
    renderAllSlots();
  }
}) as EventListener);
