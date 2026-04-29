/**
 * 장비 강화 페이지 (Phase B — 캐릭터 중심 레이아웃 redesign).
 *
 * 동작:
 *   - 6슬롯 = 캐릭터(아바타) 좌우 3:3 절대 배치, 각 슬롯은 부위 이모지 + 좌상단 레벨 배지
 *   - 슬롯 클릭 → 강화 모달 (<dialog>) 열림: 현재→강화후 미리보기 + 비용/확률
 *   - 모달 안 "강화 시도" → enhance API → 결과 표시 + 카드/배지/총 전투력 갱신
 *   - 인증 안 됐으면 안내 박스 표시, 슬롯 클릭은 인증 다이얼로그 트리거
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import {
  EQUIPMENT_SLOTS,
  SLOT_LABEL,
  ENHANCE_MAX_LEVEL,
  enhanceCostFor,
  type EquipmentSlot,
} from '@/lib/balance';
import { patchText } from '@/lib/dom-diff';

const FN_ECONOMY_URL = SUPABASE_URL + '/functions/v1/economy';
const FN_EQUIPMENT_URL = SUPABASE_URL + '/functions/v1/equipment';
const REST_URL = SUPABASE_URL + '/rest/v1';

let initialized = false;
let currentBalance = 0;
const slotState = new Map<EquipmentSlot, { level: number; power: number }>();
const busySlots = new Set<EquipmentSlot>();
let activeModalSlot: EquipmentSlot | null = null;

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
}

interface BalanceResp {
  ok: boolean;
  balance?: number;
}

interface MemberRow {
  profile_photo: string | null;
  nickname: string;
}

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function slotEl(slot: EquipmentSlot): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`.eq-slot[data-slot="${slot}"]`);
}

function modal(): HTMLDialogElement | null {
  return $('eq-modal') as HTMLDialogElement | null;
}

function modalField(key: string): HTMLElement | null {
  return modal()?.querySelector<HTMLElement>(`[data-field="${key}"]`) ?? null;
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
    setStageState('ready');
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

function fetchProfilePhoto(playerId: string): Promise<void> {
  // 멤버 프로필 사진 — null 보장 X 환경이지만 안전하게 처리
  const url = `${REST_URL}/members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=profile_photo,nickname`;
  return fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      Accept: 'application/vnd.pgrst.object+json',
    },
  })
    .then((r) => (r.ok ? (r.json() as Promise<MemberRow>) : null))
    .then((row) => {
      const img = $('eq-avatar-img') as HTMLImageElement | null;
      if (!img || !row) return;
      img.src = row.profile_photo ?? '';
      img.alt = row.nickname || '';
    })
    .catch(() => {});
}

// ===== 렌더 =====

function setStageState(state: 'loading' | 'ready' | 'auth-required'): void {
  const stage = $('eq-stage');
  if (stage) stage.dataset.state = state;
}

function renderAllSlots(): void {
  EQUIPMENT_SLOTS.forEach((slot) => renderSlot(slot));
}

function renderSlot(slot: EquipmentSlot): void {
  const el = slotEl(slot);
  if (!el) return;
  const state = slotState.get(slot) ?? { level: 0, power: 0 };

  // 좌상단 레벨 배지: level 0 이면 hidden, 1~10 이면 +N
  const badge = el.querySelector<HTMLElement>('[data-field="badge"]');
  if (badge) {
    if (state.level === 0) {
      badge.hidden = true;
    } else {
      badge.hidden = false;
      patchText(badge, '+' + state.level);
      // tier 색상 표시
      el.classList.toggle('eq-slot-bronze', state.level === 5);
      el.classList.toggle('eq-slot-silver', state.level === ENHANCE_MAX_LEVEL);
    }
  }
  // 0 일 때는 색상 클래스 모두 해제
  if (state.level !== 5) el.classList.remove('eq-slot-bronze');
  if (state.level !== ENHANCE_MAX_LEVEL) el.classList.remove('eq-slot-silver');
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
  // 모달이 열려있으면 CTA 버튼 상태 갱신
  if (activeModalSlot) syncModalCtaState();
}

// ===== 모달 =====

function openModal(slot: EquipmentSlot): void {
  const session = window.TileMatchAuth?.getSession();
  if (!session?.player_id) {
    window.TileMatchAuth?.ensureAuth();
    return;
  }
  activeModalSlot = slot;
  renderModal(slot);
  modal()?.showModal();
}

function closeModal(): void {
  activeModalSlot = null;
  modal()?.close();
}

function renderModal(slot: EquipmentSlot): void {
  const state = slotState.get(slot) ?? { level: 0, power: 0 };
  const next = enhanceCostFor(state.level);
  const label = SLOT_LABEL[slot];

  const iconEl = modalField('icon');
  if (iconEl) iconEl.textContent = label.icon;
  const nameEl = modalField('name');
  if (nameEl) nameEl.textContent = label.name;
  const levelEl = modalField('level-text');
  if (levelEl) {
    let txt = '+' + state.level + ' 단계';
    if (state.level === 5) txt += ' (Bronze)';
    else if (state.level === ENHANCE_MAX_LEVEL) txt += ' (Silver)';
    levelEl.textContent = txt;
  }

  const curPowerEl = modalField('cur-power');
  if (curPowerEl) curPowerEl.textContent = '+' + state.power.toLocaleString('ko-KR');

  const afterRow = modalField('after-row');
  const costSection = modalField('cost-section');
  const noteEl = modalField('note');
  const cta = $('eq-modal-cta') as HTMLButtonElement | null;

  if (!next) {
    // max 도달
    if (afterRow) afterRow.style.display = 'none';
    if (costSection) costSection.style.display = 'none';
    if (noteEl) noteEl.textContent = '최대 강화 도달';
    if (cta) {
      cta.textContent = '최대 강화';
      cta.disabled = true;
    }
    return;
  }

  if (afterRow) afterRow.style.display = '';
  if (costSection) costSection.style.display = '';
  if (noteEl) noteEl.textContent = '실패해도 등급은 유지 — 크리스탈만 소모';

  const newPowerTotal = state.power + next.power;
  const nextPowerEl = modalField('next-power');
  if (nextPowerEl) nextPowerEl.textContent = '+' + newPowerTotal.toLocaleString('ko-KR');
  const deltaEl = modalField('delta');
  if (deltaEl) deltaEl.textContent = '(↑' + next.power + ')';

  const costEl = modalField('cost');
  if (costEl) costEl.textContent = next.cost.toLocaleString('ko-KR');
  const rateEl = modalField('rate');
  if (rateEl) rateEl.textContent = Math.round(next.rate * 100) + '%';

  // 결과 메시지 영역 초기화
  const resultEl = modalField('result');
  if (resultEl) {
    resultEl.textContent = '';
    resultEl.className = 'eq-modal-result';
  }

  syncModalCtaState();
}

function syncModalCtaState(): void {
  if (!activeModalSlot) return;
  const cta = $('eq-modal-cta') as HTMLButtonElement | null;
  if (!cta) return;
  const state = slotState.get(activeModalSlot) ?? { level: 0, power: 0 };
  const next = enhanceCostFor(state.level);
  if (!next) {
    cta.disabled = true;
    cta.textContent = '최대 강화';
    return;
  }
  const busy = busySlots.has(activeModalSlot);
  const insufficient = currentBalance < next.cost;
  cta.disabled = busy || insufficient;
  cta.textContent = busy ? '처리 중...' : insufficient ? '크리스탈 부족' : '강화 시도';
}

function showModalResult(kind: 'success' | 'fail' | 'error', msg: string): void {
  const el = modalField('result');
  if (!el) return;
  el.textContent = msg;
  el.className = 'eq-modal-result eq-modal-result-' + kind;
  // 성공/실패 메시지는 그대로 두고 사용자가 닫거나 재강화 시 초기화
}

// ===== 강화 액션 =====

function handleEnhance(): void {
  if (!activeModalSlot) return;
  const slot = activeModalSlot;
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
    showModalResult('error', '크리스탈이 부족해요');
    return;
  }

  busySlots.add(slot);
  syncModalCtaState();

  postJson<EnhanceResp>(FN_EQUIPMENT_URL, {
    action: 'enhance',
    player_id: session.player_id,
    slot,
  })
    .then((res) => {
      if (!res.ok) {
        if (res.error === 'insufficient_crystals') showModalResult('error', '크리스탈이 부족해요');
        else if (res.error === 'level_capped') showModalResult('error', '최대 강화 도달');
        else if (res.error === 'level_mismatch') {
          showModalResult('error', '잠시 후 재시도');
          fetchEquipment(session.player_id);
        } else showModalResult('error', '오류: ' + (res.error ?? 'unknown'));
        return;
      }
      // 성공/실패 처리 — slotState 갱신
      slotState.set(slot, {
        level: res.new_level ?? state.level,
        power: res.new_power ?? state.power,
      });
      if (typeof res.balance === 'number') setBalance(res.balance);
      // 총 전투력 재계산
      const total = Array.from(slotState.values()).reduce((s, v) => s + v.power, 0);
      renderTotalPower(total);
      renderSlot(slot);

      if (res.success) {
        showModalResult('success', '✨ +' + res.new_level + ' 강화 성공!');
      } else {
        showModalResult('fail', '💔 강화 실패');
      }
      // 모달 미리보기 정보 (다음 단계) 갱신
      renderModal(slot);
    })
    .finally(() => {
      busySlots.delete(slot);
      syncModalCtaState();
    });
}

// ===== 인증 흐름 =====

function showAuthPrompt(): void {
  const prompt = $('eq-auth-prompt');
  if (prompt) prompt.style.display = '';
  setStageState('auth-required');
  renderTotalPower(0);
}

function hideAuthPrompt(): void {
  const prompt = $('eq-auth-prompt');
  if (prompt) prompt.style.display = 'none';
}

function onSessionReady(session: { player_id: string; nickname: string } | null): void {
  if (session?.player_id) {
    hideAuthPrompt();
    fetchProfilePhoto(session.player_id);
    fetchBalance(session.player_id);
    fetchEquipment(session.player_id);
  } else {
    showAuthPrompt();
    closeModal();
  }
}

// ===== 진입 =====

export function initEquipment(): void {
  if (initialized) return;
  initialized = true;

  // 슬롯 클릭 → 모달 열기 (이벤트 위임)
  $('eq-stage')?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-action="open-modal"]',
    );
    if (!target) return;
    const slot = target.getAttribute('data-slot') as EquipmentSlot | null;
    if (slot) openModal(slot);
  });

  // 모달 내 버튼 핸들링 (close / enhance) — 단일 listener
  modal()?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-action="close-modal"]')) {
      closeModal();
      return;
    }
    if (t.closest('[data-action="enhance"]')) {
      handleEnhance();
      return;
    }
    // backdrop 클릭으로 닫기 (dialog 자체 클릭은 카드 밖 영역)
    if (t === modal()) closeModal();
  });

  // ESC 로 닫히면 activeModalSlot 정리
  modal()?.addEventListener('close', () => {
    activeModalSlot = null;
  });

  // 인증 세션
  if (window.TileMatchAuth) {
    window.TileMatchAuth.initPage();
    window.TileMatchAuth.onSessionChange(onSessionReady);
    window.TileMatchAuth.ensureAuth().then(onSessionReady);
  } else {
    showAuthPrompt();
  }
}

// 다른 페이지(타일 매치 등)에서 잔액 갱신 시 동기화
window.addEventListener('crystal-balance-update', ((e: Event) => {
  const detail = (e as CustomEvent<{ balance: number }>).detail;
  if (detail && typeof detail.balance === 'number' && detail.balance !== currentBalance) {
    currentBalance = detail.balance;
    if (activeModalSlot) syncModalCtaState();
  }
}) as EventListener);
