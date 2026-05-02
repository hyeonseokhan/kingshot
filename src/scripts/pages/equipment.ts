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
  tierForLevel,
  type EquipmentSlot,
  type EquipmentTier,
} from '@/lib/balance';
import { patchText } from '@/lib/dom-diff';
import { applyStageTier, lowestStageTier } from '@/lib/equipment-tier-fx';
import { t, getLang, onLangChange } from '@/i18n';

// 슬롯/등급 라벨 — 사전 키로 즉시 매핑 (lang 변경 시 자동으로 새 값 반환)
function slotName(slot: EquipmentSlot): string {
  return t('equipment.slots.' + slot);
}
function tierName(tier: EquipmentTier): string {
  return t('equipment.tiers.' + tier);
}
function localeForLang(): string {
  return getLang() === 'ko' ? 'ko-KR' : 'en-US';
}

const FN_ECONOMY_URL = SUPABASE_URL + '/functions/v1/economy';
const FN_EQUIPMENT_URL = SUPABASE_URL + '/functions/v1/equipment';
const REST_URL = SUPABASE_URL + '/rest/v1';

let initialized = false;
let currentBalance = 0;
let balanceLoaded = false;          // false 면 fetch 전 — 클라이언트 잔액 차단 적용 X
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
  // 6슬롯 최저 등급 검사 후 아바타 글로우 + stage 배경 효과 갱신
  applyAvatarTierEffect();
  applyStageBgEffect();
  // aria-label 도 같이 갱신 (lang swap 시 호출되는 진입점)
  updateAriaLabels();
}

const TIER_KEYS: ReadonlyArray<EquipmentTier> = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
];

/** 메인 stage 6 슬롯 + tier-preview stage 6 슬롯 + tier-preview dot 6개 aria-label 일괄 갱신.
 *  data-i18n-attr 패턴으로는 {name} placeholder 치환 불가라 여기서 수동 처리. */
function updateAriaLabels(): void {
  EQUIPMENT_SLOTS.forEach((slot) => {
    const name = slotName(slot);
    const main = slotEl(slot);
    if (main) main.setAttribute('aria-label', t('equipment.slotAria', { name }));
    const preview = document.querySelector<HTMLElement>(`[data-tier-preview-slot="${slot}"]`);
    if (preview) preview.setAttribute('aria-label', t('equipment.preview.slotAria', { name }));
    const modalIcon = modalField('icon') as HTMLImageElement | null;
    if (modalIcon && activeModalSlot === slot) modalIcon.alt = name;
  });
  // tier-preview dot 6개
  document.querySelectorAll<HTMLElement>('.tier-preview-dot').forEach((dot) => {
    const idx = parseInt(dot.dataset.tierPreviewIdx ?? '-1', 10);
    const tier = TIER_KEYS[idx];
    if (tier) dot.setAttribute('aria-label', tierName(tier));
  });
}

const ALL_TIER_CLASSES: ReadonlyArray<string> = (
  ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const
).map((t) => 'eq-slot-tier-' + t);

const ALL_AVATAR_TIER_CLASSES: ReadonlyArray<string> = (
  ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const
).map((t) => 'eq-avatar-tier-' + t);

const TIER_ORDER: EquipmentTier[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
];

/** 6 슬롯 중 최저 등급 반환. 하나라도 common(일반/+0)이면 효과 X. */
function lowestTier(): EquipmentTier | null {
  if (slotState.size < EQUIPMENT_SLOTS.length) return null;
  const tiers = Array.from(slotState.values()).map((s) => tierForLevel(s.level));
  let minIdx = TIER_ORDER.length - 1;
  for (const t of tiers) {
    const i = TIER_ORDER.indexOf(t);
    if (i < minIdx) minIdx = i;
  }
  const min = TIER_ORDER[minIdx];
  if (!min || min === 'common') return null;
  return min;
}

/** 6 슬롯 등급 검사 후 아바타 글로우 효과 적용/해제. iOS Safari 색 잔상 방지 위해
 *  tier 변경 직전 .eq-avatar-glow 의 animation 을 명시적으로 reset. */
function applyAvatarTierEffect(): void {
  const avatar = document.querySelector<HTMLElement>('.eq-avatar');
  if (!avatar) return;
  ALL_AVATAR_TIER_CLASSES.forEach((c) => avatar.classList.remove(c));
  const tier = lowestTier();
  if (tier) {
    restartAvatarGlow(avatar);
    avatar.classList.add('eq-avatar-tier-' + tier);
  }
}

/** glow element 의 animation 을 강제 재시작 — none 적용 + reflow + 원복. iOS Safari
 *  의 ::before 또는 자식 element 의 background-image 전환 시 이전 색이 잔상으로 남는
 *  현상 (ex: epic 보라 위에 uncommon 녹색 잔상) 회피. */
function restartAvatarGlow(avatar: HTMLElement): void {
  const glow = avatar.querySelector<HTMLElement>('.eq-avatar-glow');
  if (!glow) return;
  glow.style.animation = 'none';
  // Force reflow — 브라우저가 두 상태 사이에 연속성을 끊도록
  void glow.offsetWidth;
  glow.style.animation = '';
}

/** 6 슬롯 최저 등급 → stage 배경 효과 적용. 모든 슬롯이 채워져야 의미 있음. */
function applyStageBgEffect(): void {
  const stage = $('eq-stage');
  if (!stage) return;
  const rows: Array<{ slot: string; level: number }> = [];
  slotState.forEach((s, slot) => rows.push({ slot, level: s.level }));
  const tier = lowestStageTier(rows);
  applyStageTier(stage, tier);
}

function renderSlot(slot: EquipmentSlot): void {
  const el = slotEl(slot);
  if (!el) return;
  const state = slotState.get(slot) ?? { level: 0, power: 0 };

  // 좌상단 레벨 배지 — level 0 이면 hidden
  const badge = el.querySelector<HTMLElement>('[data-field="badge"]');
  if (badge) {
    if (state.level === 0) {
      badge.hidden = true;
    } else {
      badge.hidden = false;
      patchText(badge, '+' + state.level);
    }
  }

  // 등급 클래스 — 슬롯 배경 + 배지 색상이 함께 변경됨
  const tier: EquipmentTier = tierForLevel(state.level);
  ALL_TIER_CLASSES.forEach((c) => el.classList.remove(c));
  el.classList.add('eq-slot-tier-' + tier);
}

function renderTotalPower(total: number): void {
  const el = $('eq-total-power');
  if (el) patchText(el, '+' + total.toLocaleString(localeForLang()));
}

function setBalance(n: number, broadcast = true): void {
  currentBalance = n;
  balanceLoaded = true;
  // 헤더 위젯에 broadcast (단, 외부 broadcast 를 받아 갱신할 때는 false 로 무한루프 차단)
  if (broadcast) {
    window.dispatchEvent(
      new CustomEvent('crystal-balance-update', { detail: { balance: n } }),
    );
  }
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
  const tier = tierForLevel(state.level);

  const iconEl = modalField('icon') as HTMLImageElement | null;
  if (iconEl) {
    iconEl.src = label.image;
    iconEl.alt = slotName(slot);
  }
  // 모달 슬롯 미니어처 — 페이지 슬롯과 동일한 등급 색상 + 배지 적용
  const iconWrap = modalField('icon-wrap');
  if (iconWrap) {
    ALL_TIER_CLASSES.forEach((c) => iconWrap.classList.remove(c));
    iconWrap.classList.add('eq-slot-tier-' + tier);
  }
  const modalBadge = modalField('modal-badge');
  if (modalBadge) {
    if (state.level === 0) {
      modalBadge.hidden = true;
    } else {
      modalBadge.hidden = false;
      modalBadge.textContent = '+' + state.level;
    }
  }

  const nameEl = modalField('name');
  if (nameEl) nameEl.textContent = slotName(slot);
  const levelEl = modalField('level-text');
  if (levelEl) {
    levelEl.textContent = t('equipment.modal.levelText', {
      level: state.level,
      tier: tierName(tier),
    });
  }

  const curPowerEl = modalField('cur-power');
  if (curPowerEl) curPowerEl.textContent = '+' + state.power.toLocaleString(localeForLang());

  const afterRow = modalField('after-row');
  const costSection = modalField('cost-section');
  const noteEl = modalField('note');
  const cta = $('eq-modal-cta') as HTMLButtonElement | null;

  if (!next) {
    // max 도달
    if (afterRow) afterRow.style.display = 'none';
    if (costSection) costSection.style.display = 'none';
    if (noteEl) noteEl.textContent = t('equipment.modal.maxReached');
    if (cta) {
      cta.textContent = t('equipment.modal.ctaMaxed');
      cta.disabled = true;
    }
    return;
  }

  if (afterRow) afterRow.style.display = '';
  if (costSection) costSection.style.display = '';
  if (noteEl) noteEl.textContent = t('equipment.modal.note');

  const newPowerTotal = state.power + next.power;
  const nextPowerEl = modalField('next-power');
  if (nextPowerEl)
    nextPowerEl.textContent = '+' + newPowerTotal.toLocaleString(localeForLang());
  const deltaEl = modalField('delta');
  if (deltaEl) deltaEl.textContent = t('equipment.modal.deltaLabel', { n: next.power });

  const costEl = modalField('cost');
  if (costEl) costEl.textContent = next.cost.toLocaleString(localeForLang());
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
    cta.replaceChildren(t('equipment.modal.ctaMaxed'));
    return;
  }
  const busy = busySlots.has(activeModalSlot);
  // 잔액 fetch 가 완료된 상태에서만 클라이언트 차단 적용
  // (fetch 전 / 실패 시엔 currentBalance=0 이라 잘못 차단되므로)
  const insufficient = balanceLoaded && currentBalance < next.cost;
  cta.disabled = busy || insufficient;
  if (busy) {
    cta.replaceChildren(t('equipment.modal.ctaProcessing'));
  } else if (insufficient) {
    // 메인: "크리스탈 부족" + 서브: "💎 234 / 1,000" (잔액 빨강, 필요량 기본)
    cta.replaceChildren(
      buildCtaLine('eq-modal-cta-main', t('equipment.modal.ctaInsufficient')),
      buildInsufficientSub(currentBalance, next.cost),
    );
  } else {
    cta.replaceChildren(t('equipment.modal.cta'));
  }
}

function buildCtaLine(cls: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function buildInsufficientSub(have: number, need: number): HTMLElement {
  const sub = document.createElement('span');
  sub.className = 'eq-modal-cta-sub';
  const haveEl = document.createElement('span');
  haveEl.className = 'eq-modal-cta-have';
  haveEl.textContent = have.toLocaleString(localeForLang());
  const sep = document.createElement('span');
  sep.className = 'eq-modal-cta-sep';
  sep.textContent = '/';
  const needEl = document.createElement('span');
  needEl.className = 'eq-modal-cta-need';
  needEl.textContent = need.toLocaleString(localeForLang());
  sub.append(haveEl, sep, needEl);
  return sub;
}

function showModalResult(kind: 'success' | 'fail' | 'error', msg: string): void {
  const el = modalField('result');
  if (!el) return;
  el.textContent = msg;
  el.className = 'eq-modal-result eq-modal-result-' + kind;
  // 성공/실패 메시지는 그대로 두고 사용자가 닫거나 재강화 시 초기화
}

// 강화 결과 토스트 — 모달 dialog 안 absolute 로 카드 위에 떠오름.
// dialog 가 top layer 라 backdrop 블러 위에 표시 → 가시성 100%.
function showResultToast(kind: 'success' | 'fail', msg: string): void {
  const toast = $('eq-result-toast');
  if (!toast) return;
  toast.className = 'eq-result-toast eq-result-toast-' + kind;
  toast.textContent = msg;
  // animation 재시작 (data-active 토글 + reflow trick)
  toast.dataset.active = 'false';
  void toast.offsetHeight;
  toast.dataset.active = 'true';
  window.setTimeout(() => {
    if (toast.textContent === msg) toast.dataset.active = 'false';
  }, 1800);
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
  // 잔액 fetch 완료 + 실제 부족인 경우만 클라이언트 차단. fetch 전엔 서버 응답으로 결정
  if (balanceLoaded && currentBalance < next.cost) {
    showModalResult('error', t('equipment.modal.insufficient'));
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
        if (res.error === 'insufficient_crystals')
          showModalResult('error', t('equipment.modal.insufficient'));
        else if (res.error === 'level_capped')
          showModalResult('error', t('equipment.modal.maxReached'));
        else if (res.error === 'level_mismatch') {
          showModalResult('error', t('equipment.modal.levelMismatch'));
          fetchEquipment(session.player_id);
        } else
          showModalResult('error', t('equipment.modal.error', { error: res.error ?? 'unknown' }));
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
      // 한 슬롯 등급 변화 → 6 슬롯 최저 등급 재검사 (아바타 효과 갱신)
      applyAvatarTierEffect();

      if (res.success) {
        const successMsg = t('equipment.modal.success', { level: res.new_level ?? 0 });
        showModalResult('success', successMsg);
        showResultToast('success', successMsg);
      } else {
        const failMsg = t('equipment.modal.fail');
        showModalResult('fail', failMsg);
        showResultToast('fail', failMsg);
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
  // 이전 사용자 데이터 클리어 — 로그아웃 / 세션 만료 시
  slotState.clear();
  busySlots.clear();
  currentBalance = 0;
  balanceLoaded = false;
  // 아바타 이미지 초기화 (이전 사용자 사진 잔존 방지)
  const img = $('eq-avatar-img') as HTMLImageElement | null;
  if (img) {
    img.removeAttribute('src');
    img.alt = '';
  }
  renderAllSlots();
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

  // 효과 미리보기 다이얼로그 — 6 등급 좌/우 + 스와이프 + 키보드 + dot
  initTierPreview();

  // 첫 mount 시 aria-label 한 번 갱신 (SSR 한글 → 현재 lang 적용)
  updateAriaLabels();

  // 언어 변경 시 동적 텍스트 (모달 라벨 / 슬롯 aria / 미리보기 / 총전투력) 재계산.
  onLangChange(() => {
    updateAriaLabels();
    // 총 전투력 재계산 (locale 분기 적용)
    const total = Array.from(slotState.values()).reduce((s, v) => s + v.power, 0);
    renderTotalPower(total);
    // 모달이 열려있으면 현재 슬롯 다시 그림
    if (activeModalSlot) renderModal(activeModalSlot);
    // 미리보기 dialog 가 열려있으면 다시 그림
    const previewDlg = document.getElementById('tier-preview-dialog') as HTMLDialogElement | null;
    if (previewDlg?.open) renderTierPreview();
  });
}

// ============================================================
// 효과 미리보기 다이얼로그 — 6 등급 (일반~신화) 분위기 미리 살펴보기
// ============================================================

interface TierPreviewSpec {
  tier: EquipmentTier;
  level: number;      // 대표 레벨 (각 등급의 최고)
  totalPower: number; // 표시용 대략값 — 실제 power 와 무관 (UI 만)
}

const TIER_PREVIEW_SPECS: ReadonlyArray<TierPreviewSpec> = [
  { tier: 'common',    level: 0,   totalPower: 0     },
  { tier: 'uncommon',  level: 9,   totalPower: 750   },
  { tier: 'rare',      level: 24,  totalPower: 3000  },
  { tier: 'epic',      level: 44,  totalPower: 7500  },
  { tier: 'legendary', level: 69,  totalPower: 14000 },
  { tier: 'mythic',    level: 100, totalPower: 30000 },
];

let tierPreviewIdx = 0;

function initTierPreview(): void {
  const dlg = document.getElementById('tier-preview-dialog') as HTMLDialogElement | null;
  const trigger = $('tier-preview-trigger');
  if (!dlg || !trigger) return;

  trigger.addEventListener('click', () => {
    // 미리보기는 본인 아바타 사진을 사용 — 비인증 시 사진이 없어 빈 화면이 됨.
    // 우선 인증 다이얼로그로 유도하고, 인증 완료 후에만 미리보기 열기.
    const ensure = window.TileMatchAuth?.ensureAuth?.();
    if (!ensure) {
      // TileMatchAuth 미초기화 — fallback 으로 그냥 열기 (placeholder 보임)
      tierPreviewIdx = 0;
      renderTierPreview();
      dlg.showModal();
      return;
    }
    ensure.then((session) => {
      if (!session) return; // 사용자가 인증 취소 → 미리보기 열지 않음
      tierPreviewIdx = 0;
      renderTierPreview();
      dlg.showModal();
    });
  });

  $('tier-preview-prev')?.addEventListener('click', () => {
    if (tierPreviewIdx > 0) {
      tierPreviewIdx--;
      renderTierPreview();
    }
  });
  $('tier-preview-next')?.addEventListener('click', () => {
    if (tierPreviewIdx < TIER_PREVIEW_SPECS.length - 1) {
      tierPreviewIdx++;
      renderTierPreview();
    }
  });

  $('tier-preview-close')?.addEventListener('click', () => dlg.close());

  // backdrop 클릭 → 닫기
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });

  // dot 클릭 → 해당 인덱스로 점프
  $('tier-preview-dots')?.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.tier-preview-dot');
    if (!t) return;
    const idx = parseInt(t.dataset.tierPreviewIdx ?? '-1', 10);
    if (idx >= 0 && idx < TIER_PREVIEW_SPECS.length) {
      tierPreviewIdx = idx;
      renderTierPreview();
    }
  });

  // 키보드 ←/→ — dialog open 상태에서만 작동
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && tierPreviewIdx > 0) {
      tierPreviewIdx--;
      renderTierPreview();
      e.preventDefault();
    } else if (e.key === 'ArrowRight' && tierPreviewIdx < TIER_PREVIEW_SPECS.length - 1) {
      tierPreviewIdx++;
      renderTierPreview();
      e.preventDefault();
    }
  });

  // 스와이프 — pointerdown/up 으로 가로 swipe 감지 (수직 스크롤 방해 X)
  const stageEl = $('tier-preview-stage');
  if (stageEl) {
    let startX = 0;
    let startY = 0;
    let active = false;
    stageEl.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      active = true;
    });
    stageEl.addEventListener('pointerup', (e) => {
      if (!active) return;
      active = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // 수평 이동이 더 크고 임계값 (40px) 이상이면 스와이프로 인정
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0 && tierPreviewIdx < TIER_PREVIEW_SPECS.length - 1) {
          // 좌→우 X (→ 손가락이 왼쪽으로) = 다음 등급
          tierPreviewIdx++;
          renderTierPreview();
        } else if (dx > 0 && tierPreviewIdx > 0) {
          // 우→좌 X (→ 손가락이 오른쪽으로) = 이전 등급
          tierPreviewIdx--;
          renderTierPreview();
        }
      }
    });
    stageEl.addEventListener('pointercancel', () => {
      active = false;
    });
  }

  // 다이얼로그 열릴 때 본인 사진을 미리보기 아바타로 — 비인증이면 placeholder
  // (트리거 클릭 시점에 갱신 — 이후 같은 사진 유지)
}

function renderTierPreview(): void {
  const spec = TIER_PREVIEW_SPECS[tierPreviewIdx];
  if (!spec) return;

  // 헤더 라벨
  patchText($('tier-preview-name'), tierName(spec.tier));
  patchText($('tier-preview-level'), '+' + spec.level);

  // 화살표 disabled
  ($('tier-preview-prev') as HTMLButtonElement | null)?.toggleAttribute('disabled', tierPreviewIdx === 0);
  ($('tier-preview-next') as HTMLButtonElement | null)?.toggleAttribute(
    'disabled',
    tierPreviewIdx === TIER_PREVIEW_SPECS.length - 1,
  );

  // dot active 토글
  document.querySelectorAll<HTMLElement>('.tier-preview-dot').forEach((d) => {
    const idx = parseInt(d.dataset.tierPreviewIdx ?? '-1', 10);
    d.classList.toggle('active', idx === tierPreviewIdx);
  });

  // stage 자체 — 배경 효과 + 6 슬롯 등급 + 총 전투력
  const stage = document.getElementById('tier-preview-stage');
  if (!stage) return;
  applyStageTier(stage, spec.tier);

  // 6 슬롯 — 모두 spec.tier 로 통일 + 배지에 +level 표시
  EQUIPMENT_SLOTS.forEach((slot) => {
    const el = stage.querySelector<HTMLElement>(`[data-tier-preview-slot="${slot}"]`);
    if (!el) return;
    ALL_TIER_CLASSES.forEach((c) => el.classList.remove(c));
    el.classList.add('eq-slot-tier-' + spec.tier);
    const badge = el.querySelector<HTMLElement>('[data-tier-preview-field="badge"]');
    if (badge) {
      if (spec.level === 0) {
        badge.hidden = true;
      } else {
        badge.hidden = false;
        patchText(badge, '+' + spec.level);
      }
    }
  });

  // 아바타 글로우 — common 은 제외 (의도). iOS Safari 색 잔상 방지 위해 animation reset.
  const avatar = stage.querySelector<HTMLElement>('.eq-avatar');
  if (avatar) {
    ALL_AVATAR_TIER_CLASSES.forEach((c) => avatar.classList.remove(c));
    if (spec.tier !== 'common') {
      restartAvatarGlow(avatar);
      avatar.classList.add('eq-avatar-tier-' + spec.tier);
    }
  }

  // 미리보기 아바타 사진 — 본인 사진 재사용 (이미 #eq-avatar-img 에 src 있음)
  const mainAvatar = $<HTMLImageElement>('eq-avatar-img');
  const previewAvatar = $<HTMLImageElement>('tier-preview-avatar');
  if (previewAvatar && mainAvatar?.src) previewAvatar.src = mainAvatar.src;

  // 총 전투력
  patchText($('tier-preview-total'), '+' + spec.totalPower.toLocaleString(localeForLang()));
}

// 다른 페이지(타일 매치 등) / 헤더 위젯에서 잔액 갱신 broadcast 받을 때 동기화.
// 자기 자신이 broadcast 한 것도 받지만 값이 같으면 early return 해서 무한루프 차단됨.
window.addEventListener('crystal-balance-update', ((e: Event) => {
  const detail = (e as CustomEvent<{ balance: number }>).detail;
  if (detail && typeof detail.balance === 'number' && detail.balance !== currentBalance) {
    setBalance(detail.balance, false);
    return;
  }
}) as EventListener);
