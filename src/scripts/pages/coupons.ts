/**
 * 쿠폰 받기 페이지 — coupons.js 의 TypeScript 이식.
 * 로직 동등성 우선. Phase 7 에서 타입 강화 + 이벤트 위임 리팩터 검토.
 */

import { supabase as sb, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import {
  esc,
  formatDate,
  delay,
  isAlreadyRedeemed,
  describeRedeemError,
  REDEEM_STATUS,
  formatDateTime,
  formatRelativeTime,
} from '@/lib/utils';
import {
  getGiftCodesCache,
  setGiftCodesCache,
  getAccountsCache,
  setAccountsCache,
  invalidateAccountsCache,
} from '@/lib/cache';
import { patchList, patchText } from '@/lib/dom-diff';
import { membersStore, fetchMembers } from '@/lib/stores/members';
import type { ActiveCoupon, RedeemAccount, RedeemBatchResponse, Member } from '@/lib/types';
import { t, onLangChange } from '@/i18n';

// ===== 상수 =====

const GIFT_API = SUPABASE_URL + '/functions/v1/gift-codes';
const REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
const CACHE_REFRESH_MS = 60 * 60 * 1000;
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES = 1000;
const SUMMARY_DISPLAY_MS = 10000;
const HISTORY_PAGE_SIZE = 5;

// ===== 모듈 상태 =====

let activeCoupons: ActiveCoupon[] = [];
const couponHistory: Record<string, string> = {};
let allAccounts: RedeemAccount[] = [];
let redeemStats = { success: 0, already: 0, failed: 0, errors: [] as string[] };
let totalRedeemTasks = 0;
let completedRedeemTasks = 0;

let selectedCouponCode: string | null = null;
let searchKeyword = '';
let couponSearchData: SearchData | null = null;
let historyCurrentPage = 1;
let historyTotalCount = 0;
let historySearch = '';
let historySearchDebounce: number | null = null;
let nicknameMap: Record<string, string> = {};

interface SearchData {
  kingshot_id: string;
  nickname: string;
  level: number;
  kingdom: string | null;
  profile_photo: string | null;
}

// ===== SVG 아이콘 =====

const SVG = {
  gift: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12v10H4V12"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
  check:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
  trash:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

// ===== DOM 헬퍼 =====

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

function maybe<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ===== 쿠폰 목록 =====

function getSelectedCoupon(): ActiveCoupon | null {
  if (!selectedCouponCode) return null;
  return activeCoupons.find((c) => c.code === selectedCouponCode) || null;
}

function selectCoupon(code: string): void {
  selectedCouponCode = selectedCouponCode === code ? null : code;
  renderCoupons();
  renderAccounts();
}

function pruneSelectedCoupon(): void {
  if (!selectedCouponCode) return;
  if (!activeCoupons.some((c) => c.code === selectedCouponCode)) selectedCouponCode = null;
}

function loadCoupons(callback?: () => void): void {
  const cached = getGiftCodesCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_REFRESH_MS) {
    activeCoupons = cached.codes;
    pruneSelectedCoupon();
    renderCoupons();
    callback?.();
    return;
  }
  fetch(GIFT_API)
    .then((r) => r.json())
    .then((json) => {
      if (json.status === 'success' && json.data) {
        activeCoupons = (json.data.giftCodes || []) as ActiveCoupon[];
        setGiftCodesCache(activeCoupons);
      }
      pruneSelectedCoupon();
      pruneStaleHistory();
      renderCoupons();
    })
    .catch(() => renderCoupons())
    .finally(() => callback?.());
}

/**
 * 활성 쿠폰 list 에 없는 coupon_history row 를 모두 DELETE.
 * 안전장치: 활성 list 가 비어있으면 절대 실행하지 않음 (모든 row 삭제 방지).
 */
function pruneStaleHistory(): void {
  if (!activeCoupons.length) return;
  const codes = activeCoupons.map((c) => c.code).join(',');
  fetch(SUPABASE_URL + '/rest/v1/coupon_history?coupon_code=not.in.(' + codes + ')', {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      Prefer: 'return=representation',
    },
  })
    .then((r) => {
      if (!r.ok) return;
      return r.json().then((rows) => {
        if (rows?.length) {
          console.log('[coupons] pruned ' + rows.length + ' stale history rows');
        }
      });
    })
    .catch(() => {});
}

function daysUntilExpire(isoStr: string | null | undefined): number | null {
  if (!isoStr) return null;
  const diff = new Date(isoStr).getTime() - Date.now();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function createCouponCard(c: ActiveCoupon): HTMLElement {
  const card = document.createElement('div');
  card.className = 'coupon-card';
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.innerHTML = `
    <span class="coupon-badge-active"></span>
    <span class="coupon-code"></span>
    <span class="coupon-expires"></span>
  `;
  updateCouponCard(card, c);
  return card;
}

function updateCouponCard(card: HTMLElement, c: ActiveCoupon): void {
  const days = daysUntilExpire(c.expiresAt);
  const expiring = days !== null && days <= 3;
  const selected = selectedCouponCode === c.code;
  card.className =
    'coupon-card' +
    (expiring ? ' coupon-expiring' : '') +
    (selected ? ' coupon-selected' : '');
  card.dataset.code = c.code;

  patchText(
    card.querySelector<HTMLElement>('.coupon-badge-active'),
    selected ? t('coupons.card.selected') : t('coupons.card.active'),
  );
  patchText(card.querySelector<HTMLElement>('.coupon-code'), c.code);

  // 만료 영역은 텍스트 + 옵션 배지 → outerHTML 대신 자식 두 개로 분리
  const expiresEl = card.querySelector<HTMLElement>('.coupon-expires')!;
  const baseText = t('coupons.card.expires', {
    date: c.expiresAt ? formatDate(c.expiresAt) : t('coupons.card.unlimited'),
  });
  // 텍스트 노드만 갱신 (배지는 별도)
  let textNode = expiresEl.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    textNode = document.createTextNode('');
    expiresEl.insertBefore(textNode, expiresEl.firstChild);
  }
  if (textNode.textContent !== baseText) textNode.textContent = baseText;

  let badge = expiresEl.querySelector<HTMLElement>('.coupon-badge-expiring');
  if (expiring) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'coupon-badge-expiring';
      expiresEl.appendChild(badge);
    }
    patchText(
      badge,
      days! <= 0 ? t('coupons.card.expiringSoon') : t('coupons.card.daysLeft', { n: days! }),
    );
  } else {
    badge?.remove();
  }
}

function renderCoupons(): void {
  const cardsEl = maybe('coupon-cards');
  const hintEl = maybe('coupon-select-hint');
  const statusEl = maybe('coupon-list-status');
  if (!cardsEl || !hintEl || !statusEl) return;

  if (activeCoupons.length === 0) {
    cardsEl.replaceChildren();
    hintEl.style.display = 'none';
    statusEl.style.display = '';
    statusEl.textContent = t('coupons.list.none');
    return;
  }

  statusEl.style.display = 'none';
  patchList({
    container: cardsEl,
    items: activeCoupons,
    key: (c) => c.code,
    render: createCouponCard,
    update: updateCouponCard,
  });

  hintEl.style.display = '';
  // hint 는 텍스트 + 옵션 strong → 한 번 build, selectedCouponCode 변화 시 patch
  if (selectedCouponCode) {
    hintEl.innerHTML = t('coupons.hint.selected', { code: esc(selectedCouponCode) });
  } else {
    patchText(hintEl, t('coupons.hint.default'));
  }
}

// ===== 대상 계정 =====

function loadAccounts(callback?: () => void): void {
  const cached = getAccountsCache();
  if (cached) {
    allAccounts = cached;
    callback?.();
    return;
  }
  // members 는 store 활용 (auto_coupon=true 는 client filter), coupon_accounts 는 별도 fetch
  Promise.all([
    membersStore.refresh(fetchMembers),
    sb.from('coupon_accounts').select('*'),
  ])
    .then((results) => {
      allAccounts = [];
      const memberRows = (results[0] as Member[]).filter((m) => m.auto_coupon === true);
      memberRows.forEach((m) => {
        allAccounts.push({
          kingshot_id: m.kingshot_id,
          nickname: m.nickname,
          level: m.level ?? null,
          kingdom: m.kingdom ?? null,
          profile_photo: m.profile_photo ?? null,
          source: 'member',
        });
      });
      if (results[1].data) {
        (results[1].data as Array<Record<string, unknown>>).forEach((a) => {
          allAccounts.push({
            id: a.id as string,
            kingshot_id: a.kingshot_id as string,
            nickname: a.nickname as string,
            level: (a.level as number) ?? null,
            kingdom: (a.kingdom as string) ?? null,
            profile_photo: (a.profile_photo as string) ?? null,
            source: 'extra',
          });
        });
      }
      allAccounts.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'ko'));
      setAccountsCache(allAccounts);
    })
    .catch(() => {
      // 네트워크 오류 시 빈 리스트로 진행 — 후속 chain 이 멈추지 않도록 (checkAutoRedeem 까지 도달 보장)
      allAccounts = [];
    })
    .finally(() => {
      callback?.();
    });
}

// ===== 수령 이력 =====

function loadHistory(callback?: () => void): void {
  const codes = activeCoupons.map((c) => c.code);
  if (codes.length === 0) {
    callback?.();
    return;
  }
  // async IIFE — Supabase query builder 가 PromiseLike 라 .catch()/.finally() 가 없으므로
  // try/catch/finally 로 콜백 누락(checkAutoRedeem 미발동) 방지.
  void (async () => {
    try {
      const res = await sb.from('coupon_history').select('kingshot_id,coupon_code,status').in('coupon_code', codes);
      for (const k of Object.keys(couponHistory)) delete couponHistory[k];
      if (res.data) {
        (res.data as Array<{ kingshot_id: string; coupon_code: string; status: string }>).forEach(
          (r) => {
            couponHistory[r.kingshot_id + ':' + r.coupon_code] = r.status;
          },
        );
      }
    } catch {
      for (const k of Object.keys(couponHistory)) delete couponHistory[k];
    } finally {
      callback?.();
    }
  })();
}

function getRedeemStatus(kingshotId: string): 'done' | 'pending' | 'none' {
  if (activeCoupons.length === 0) return 'none';
  for (const c of activeCoupons) {
    const s = couponHistory[kingshotId + ':' + c.code];
    if (s !== REDEEM_STATUS.SUCCESS && s !== REDEEM_STATUS.ALREADY) return 'pending';
  }
  return 'done';
}

function getCodesToRedeem(kingshotId: string): string[] {
  const sel = getSelectedCoupon();
  if (sel) {
    const s = couponHistory[kingshotId + ':' + sel.code];
    if (s === REDEEM_STATUS.SUCCESS || s === REDEEM_STATUS.ALREADY) return [];
    return [sel.code];
  }
  return getUnredeemedCodes(kingshotId);
}

function getEffectiveStatus(kingshotId: string): 'done' | 'pending' | 'none' {
  const sel = getSelectedCoupon();
  if (sel) {
    const s = couponHistory[kingshotId + ':' + sel.code];
    return s === REDEEM_STATUS.SUCCESS || s === REDEEM_STATUS.ALREADY ? 'done' : 'pending';
  }
  return getRedeemStatus(kingshotId);
}

function getUnredeemedCodes(kingshotId: string): string[] {
  return activeCoupons
    .filter((c) => {
      const s = couponHistory[kingshotId + ':' + c.code];
      return s !== REDEEM_STATUS.SUCCESS && s !== REDEEM_STATUS.ALREADY;
    })
    .map((c) => c.code);
}

function saveHistory(
  kingshotId: string,
  code: string,
  status: string,
  message?: string,
): void {
  couponHistory[kingshotId + ':' + code] = status;
  sb.from('coupon_history')
    .upsert(
      { kingshot_id: kingshotId, coupon_code: code, status, message },
      { onConflict: 'kingshot_id,coupon_code' },
    )
    .then(() => {});
}

/**
 * 단일 row 의 수령 버튼 상태만 갱신 — 전체 renderAccounts() 안 부르고 해당 row 의 버튼 클래스만 toggle.
 * 모든 쿠폰을 받은 상태가 되면 redeem 버튼을 done 으로 swap.
 */
function updateAccountRowStatus(kingshotId: string): void {
  if (getRedeemStatus(kingshotId) !== 'done') return;
  document
    .querySelectorAll<HTMLElement>(
      '.coupon-account-row[data-kingshot-id="' + kingshotId + '"]',
    )
    .forEach((row) => {
      const btn = row.querySelector<HTMLElement>('.cp-btn-redeem');
      if (btn) {
        btn.outerHTML =
          '<button class="cp-btn cp-btn-done cp-btn-just-done" disabled title="' +
          esc(t('coupons.rowAction.done')) +
          '">' +
          SVG.check +
          '</button>';
      }
    });
}

// ===== 계정 목록 렌더링 (keyed 갱신) =====

/** photo wrap 안 placeholder + img stack — members.ts 의 syncPhoto 와 동일 패턴 */
function syncAccountPhoto(wrap: HTMLElement, a: RedeemAccount): void {
  const url = a.profile_photo;
  let empty = wrap.querySelector<HTMLElement>('.mc-photo-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'mc-photo-empty';
    wrap.appendChild(empty);
  }
  patchText(empty, (a.nickname || '?').charAt(0));

  let img = wrap.querySelector<HTMLImageElement>('img.mc-photo');
  if (url) {
    if (!img) {
      img = document.createElement('img');
      img.className = 'mc-photo mc-photo-fade';
      img.decoding = 'async';
      img.addEventListener('load', () => img!.classList.add('mc-photo-loaded'));
      img.addEventListener('error', () => img!.classList.remove('mc-photo-loaded'));
      wrap.appendChild(img);
    }
    if (img.src !== url) {
      img.classList.remove('mc-photo-loaded');
      img.src = url;
    }
  } else {
    img?.remove();
  }
}

function createAccountRow(a: RedeemAccount, canDelete: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'coupon-account-row';
  row.innerHTML = `
    <div class="mc-photo-wrap"></div>
    <div class="mc-row-body">
      <div class="mc-name"></div>
      <div class="mc-sub"></div>
    </div>
    <div class="coupon-row-actions"></div>
  `;
  if (canDelete) row.dataset.canDelete = '1';
  updateAccountRow(row, a, canDelete);
  return row;
}

function updateAccountRow(row: HTMLElement, a: RedeemAccount, canDelete: boolean): void {
  row.dataset.kingshotId = a.kingshot_id;
  if (canDelete && a.id) row.dataset.accountId = a.id;
  const wrap = row.querySelector<HTMLElement>('.mc-photo-wrap')!;
  syncAccountPhoto(wrap, a);

  patchText(row.querySelector<HTMLElement>('.mc-name'), a.nickname || '');
  patchText(
    row.querySelector<HTMLElement>('.mc-sub'),
    'Lv.' + (a.level || '?') + ' · ' + (a.kingdom || '?'),
  );

  const status = getEffectiveStatus(a.kingshot_id);
  const actions = row.querySelector<HTMLElement>('.coupon-row-actions')!;
  // 버튼 영역은 status / canDelete 에 따라 통째 다시 그림 (작은 영역, 깜박임 영향 미미)
  const redeemBtn =
    status === 'done'
      ? '<button class="cp-btn cp-btn-done" disabled title="' +
        esc(t('coupons.rowAction.done')) +
        '">' +
        SVG.check +
        '</button>'
      : '<button class="cp-btn cp-btn-redeem" data-action="redeem" title="' +
        esc(t('coupons.rowAction.redeem')) +
        '">' +
        SVG.gift +
        '</button>';
  const deleteBtn = canDelete
    ? '<button class="cp-btn cp-btn-delete" data-action="remove" title="' +
      esc(t('coupons.rowAction.delete')) +
      '">' +
      SVG.trash +
      '</button>'
    : '';
  actions.innerHTML = redeemBtn + deleteBtn;
}

function renderAccountGroup(
  rowsId: string,
  labelId: string,
  items: RedeemAccount[],
  canDelete: boolean,
): void {
  const rowsEl = maybe(rowsId);
  const labelEl = maybe(labelId);
  if (!rowsEl || !labelEl) return;
  if (items.length === 0) {
    labelEl.style.display = 'none';
    rowsEl.replaceChildren();
    return;
  }
  labelEl.style.display = '';
  patchList({
    container: rowsEl,
    items,
    // members 은 kingshot_id, extras 는 a.id (uuid) 가 stable key
    key: (a) => (canDelete && a.id ? 'x:' + a.id : 'm:' + a.kingshot_id),
    render: (a) => createAccountRow(a, canDelete),
    update: (el, a) => updateAccountRow(el, a, canDelete),
  });
}

function renderAccounts(): void {
  const listEl = maybe('coupon-members-list');
  if (!listEl) return;

  const kw = searchKeyword.trim().toLowerCase();
  const filterFn = (a: RedeemAccount) =>
    !kw || (a.nickname || '').toLowerCase().indexOf(kw) !== -1;

  const members = allAccounts.filter((a) => a.source === 'member').filter(filterFn);
  const extras = allAccounts.filter((a) => a.source === 'extra').filter(filterFn);
  const total = members.length + extras.length;
  const totalAll = allAccounts.length;

  patchText(
    $('coupon-member-count'),
    kw
      ? t('coupons.count.search', { found: total, total: totalAll })
      : t('coupons.count.all', { n: totalAll }),
  );

  const status = $('coupon-accounts-status');
  if (totalAll === 0) {
    renderAccountGroup('coupon-rows-members', 'coupon-group-members', [], false);
    renderAccountGroup('coupon-rows-extras', 'coupon-group-extras', [], true);
    status.style.display = '';
    status.textContent = t('coupons.empty.noTargets');
    return;
  }
  if (total === 0) {
    renderAccountGroup('coupon-rows-members', 'coupon-group-members', [], false);
    renderAccountGroup('coupon-rows-extras', 'coupon-group-extras', [], true);
    status.style.display = '';
    status.textContent = t('coupons.empty.noSearch');
    return;
  }

  status.style.display = 'none';
  renderAccountGroup('coupon-rows-members', 'coupon-group-members', members, false);
  renderAccountGroup('coupon-rows-extras', 'coupon-group-extras', extras, true);
}

// ===== 추가 계정 등록 모달 =====

function closeCouponModal(): void {
  const ov = maybe('coupon-modal-overlay');
  if (ov) ov.classList.remove('open');
}

// ===== 계정 삭제 =====

function removeAccount(id: string): void {
  if (!confirm(t('coupons.confirm.deleteAccount'))) return;
  sb.from('coupon_accounts')
    .delete()
    .eq('id', id)
    .then((res) => {
      if (res.error) {
        alert(t('coupons.msg.deleteFailed', { message: res.error.message }));
        return;
      }
      invalidateAccountsCache();
      initPage();
    });
}

// ===== 쿠폰 수령 =====

function redeemOne(fid: string, nickname: string): void {
  const codes = getCodesToRedeem(fid);
  if (codes.length === 0) {
    const sel = getSelectedCoupon();
    alert(
      sel
        ? t('coupons.msg.onePersonAlready', { name: nickname, code: sel.code })
        : t('coupons.msg.onePersonAllAlready', { name: nickname }),
    );
    return;
  }
  redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
  totalRedeemTasks = codes.length;
  completedRedeemTasks = 0;
  showProgress(t('coupons.progress.onePersonStart', { name: nickname }));
  redeemForMember(fid, nickname).then(() => {
    showSummary();
    renderAccounts();
  });
}

function redeemForMember(fid: string, nickname: string): Promise<void> {
  const codes = getCodesToRedeem(fid);
  if (codes.length === 0) return Promise.resolve();

  return fetch(REDEEM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'redeem_batch',
      fid,
      cdks: codes,
      captcha_code: 'none',
    }),
  })
    .then((r) => r.json() as Promise<RedeemBatchResponse>)
    .then((json) => {
      if (json.code !== 0 || !Array.isArray(json.results)) {
        const topLabel = describeRedeemError(json);
        codes.forEach((code) => {
          completedRedeemTasks++;
          redeemStats.failed++;
          redeemStats.errors.push(nickname + ' — ' + code + ': ' + topLabel);
        });
        showProgress(t('coupons.progress.onePersonError', { name: nickname, label: topLabel }));
        return;
      }
      json.results.forEach((r) => {
        completedRedeemTasks++;
        const code = r.cdk;
        const fakeJson = { code: r.code, msg: r.msg, err_code: r.err_code };
        if (r.code === 0) {
          redeemStats.success++;
          saveHistory(fid, code, REDEEM_STATUS.SUCCESS, r.msg);
          showProgress(t('coupons.progress.couponDone', { name: nickname, code }));
        } else if (isAlreadyRedeemed(fakeJson)) {
          redeemStats.already++;
          saveHistory(fid, code, REDEEM_STATUS.ALREADY, r.msg);
          showProgress(t('coupons.progress.couponAlready', { name: nickname, code }));
        } else {
          const label = describeRedeemError(fakeJson);
          redeemStats.failed++;
          redeemStats.errors.push(nickname + ' — ' + code + ': ' + label);
          showProgress(
            t('coupons.progress.couponFailed', { name: nickname, code, label }),
          );
        }
      });
      updateAccountRowStatus(fid);
    })
    .catch((err: Error) => {
      codes.forEach((code) => {
        completedRedeemTasks++;
        redeemStats.failed++;
        redeemStats.errors.push(
          nickname + ' — ' + code + ': ' + (err.message || t('coupons.msg.networkError')),
        );
      });
      showProgress(t('coupons.progress.onePersonNetError', { name: nickname }));
    });
}

// ===== 전체 수령 =====

function startBulkRedeem(skipConfirm: boolean): void {
  // skipConfirm 의 의미: confirm prompt 만 생략 — 결과 알림은 항상 표시 (URL 트리거든 버튼 클릭이든
  // 사용자가 명시적으로 액션을 취한 상태이므로 묵음 종료는 혼란만 야기)
  if (activeCoupons.length === 0) {
    showInfoPanel(t('coupons.msg.noActiveCoupons'));
    return;
  }
  const sel = getSelectedCoupon();
  const pending = allAccounts.filter((a) => getCodesToRedeem(a.kingshot_id).length > 0);
  if (pending.length === 0) {
    showInfoPanel(
      sel
        ? t('coupons.msg.selectedAlreadyAll', { code: sel.code })
        : t('coupons.msg.allAlreadyAll'),
    );
    return;
  }
  const confirmMsg = sel
    ? t('coupons.confirm.redeemSelected', { n: pending.length, code: sel.code })
    : t('coupons.confirm.redeemAll', { n: pending.length });
  if (!skipConfirm && !confirm(confirmMsg)) return;

  redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
  totalRedeemTasks = pending.reduce(
    (sum, a) => sum + getCodesToRedeem(a.kingshot_id).length,
    0,
  );
  completedRedeemTasks = 0;
  const startMsg = sel
    ? t('coupons.progress.selectedStart', { code: sel.code, n: pending.length })
    : t('coupons.progress.allStart', { n: pending.length, tasks: totalRedeemTasks });
  showProgress(startMsg);

  const batches: RedeemAccount[][] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  let chain: Promise<unknown> = Promise.resolve();
  batches.forEach((batch, idx) => {
    chain = chain
      .then(() => {
        showProgress(
          t('coupons.progress.batch', { idx: idx + 1, total: batches.length }),
        );
        return Promise.all(batch.map((a) => redeemForMember(a.kingshot_id, a.nickname)));
      })
      .then(() => {
        if (idx < batches.length - 1) return delay(DELAY_BETWEEN_BATCHES);
      });
  });
  chain.then(() => {
    showSummary();
    renderAccounts();
  });
}

// ===== 진행 표시 =====
//
// info / progress / summary 모드 — element 구조는 한 번만 build, 모드 전환 시
// 자식 display 토글 + textContent / fill width 만 patch. 1초 단위 진행 갱신 시
// innerHTML 통째 교체로 인한 깜박임 차단.

interface ProgressPanel {
  root: HTMLDivElement;
  textEl: HTMLElement;
  barEl: HTMLElement;
  fillEl: HTMLElement;
  countEl: HTMLElement;
  summaryEl: HTMLElement;
}

let progressHideTimer: number | null = null;

function getProgressPanel(): ProgressPanel {
  let root = maybe<HTMLDivElement>('redeem-progress');
  if (!root) {
    root = document.createElement('div');
    root.id = 'redeem-progress';
    root.className = 'redeem-progress';
    root.innerHTML = `
      <div class="redeem-progress-text"></div>
      <div class="redeem-progress-bar"><div class="redeem-progress-fill" style="width:0%"></div></div>
      <div class="redeem-progress-count"></div>
      <div class="redeem-summary"></div>
    `;
    const toolbar = document.querySelector<HTMLElement>('#page-coupons .members-toolbar');
    toolbar?.parentNode?.insertBefore(root, toolbar.nextSibling);
  }
  return {
    root,
    textEl: root.querySelector<HTMLElement>('.redeem-progress-text')!,
    barEl: root.querySelector<HTMLElement>('.redeem-progress-bar')!,
    fillEl: root.querySelector<HTMLElement>('.redeem-progress-fill')!,
    countEl: root.querySelector<HTMLElement>('.redeem-progress-count')!,
    summaryEl: root.querySelector<HTMLElement>('.redeem-summary')!,
  };
}

function scheduleAutoHide(p: ProgressPanel): void {
  if (progressHideTimer != null) window.clearTimeout(progressHideTimer);
  progressHideTimer = window.setTimeout(() => {
    p.root.style.display = 'none';
    progressHideTimer = null;
  }, SUMMARY_DISPLAY_MS);
}

// 즉시 끝난 액션 (활성 쿠폰 0 / 모두 이미 수령)을 사용자에게 알리는 패널.
// auto-redeem URL 진입 시 화면이 깜깜하지 않도록 보장하는 핵심 — silent return 금지.
function showInfoPanel(text: string): void {
  const p = getProgressPanel();
  p.root.style.display = '';
  p.textEl.style.display = 'none';
  p.barEl.style.display = 'none';
  p.countEl.style.display = 'none';
  p.summaryEl.style.display = '';
  p.summaryEl.className = 'redeem-summary summary-ok';
  // info 는 한 줄 — span 한 개만 두고 텍스트만 patch
  let span = p.summaryEl.querySelector<HTMLElement>('span.summary-info');
  if (!span) {
    p.summaryEl.replaceChildren();
    span = document.createElement('span');
    span.className = 'summary-info';
    p.summaryEl.appendChild(span);
  }
  patchText(span, text);
  scheduleAutoHide(p);
}

function showProgress(text: string): void {
  const p = getProgressPanel();
  // 진행 중엔 auto-hide 타이머 끄기 — summary 호출 시 다시 schedule
  if (progressHideTimer != null) {
    window.clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
  p.root.style.display = '';
  p.textEl.style.display = '';
  p.barEl.style.display = '';
  p.countEl.style.display = '';
  p.summaryEl.style.display = 'none';
  patchText(p.textEl, text);
  const pct =
    totalRedeemTasks > 0 ? Math.round((completedRedeemTasks / totalRedeemTasks) * 100) : 0;
  p.fillEl.style.width = pct + '%';
  patchText(p.countEl, completedRedeemTasks + ' / ' + totalRedeemTasks);
}

function showSummary(): void {
  const p = getProgressPanel();
  p.root.style.display = '';
  p.textEl.style.display = 'none';
  p.barEl.style.display = 'none';
  p.countEl.style.display = 'none';
  p.summaryEl.style.display = '';
  const cls = redeemStats.failed > 0 ? 'summary-warn' : 'summary-ok';
  p.summaryEl.className = 'redeem-summary ' + cls;
  // 3개의 span 을 stable key 로 reconcile — 빈도 낮은 호출이지만 일관성 유지
  const segs = [
    { key: 'success', text: t('coupons.summary.success', { n: redeemStats.success }), show: true },
    {
      key: 'already',
      text: t('coupons.summary.already', { n: redeemStats.already }),
      show: redeemStats.already > 0,
    },
    {
      key: 'failed',
      text: t('coupons.summary.failed', { n: redeemStats.failed }),
      show: redeemStats.failed > 0,
    },
  ];
  patchList({
    container: p.summaryEl,
    items: segs.filter((s) => s.show),
    key: (s) => s.key,
    render: (s) => {
      const span = document.createElement('span');
      span.textContent = s.text;
      return span;
    },
    update: (el, s) => patchText(el, s.text),
  });
  scheduleAutoHide(p);
  if (redeemStats.failed > 0) {
    alert(t('coupons.summary.detailsHeader', { details: redeemStats.errors.join('\n') }));
  }
}

// ===== 수령 이력 다이얼로그 =====

function buildNicknameMap(): void {
  nicknameMap = {};
  allAccounts.forEach((a) => (nicknameMap[a.kingshot_id] = a.nickname));
}

function openHistoryDialog(): void {
  buildNicknameMap();
  historyCurrentPage = 1;
  historySearch = '';
  const searchInput = maybe<HTMLInputElement>('history-search');
  if (searchInput) searchInput.value = '';
  const ov = maybe('history-dialog-overlay');
  if (ov) ov.classList.add('open');
  loadHistoryPage();
}

/** 검색어 → 매칭되는 kingshot_id 집합. 빈 검색이면 null (필터 X).
 *  매칭 0건이면 빈 배열 — 호출 측이 즉시 빈 결과 처리. */
function getMatchingKingshotIds(): string[] | null {
  const q = historySearch.trim().toLowerCase();
  if (!q) return null;
  const ids: string[] = [];
  for (const a of allAccounts) {
    const id = a.kingshot_id;
    const name = (a.nickname || '').toLowerCase();
    if (id.toLowerCase().includes(q) || name.includes(q)) ids.push(id);
  }
  return ids;
}

interface HistoryRow {
  kingshot_id: string;
  coupon_code: string;
  redeemed_at: string | null;
}

function loadHistoryPage(): void {
  const status = $('history-status');
  const tbody = $('history-rows');
  // 첫 진입(row 없음) 만 "로딩 중..." 표시. 페이지 변경 시엔 기존 row 유지 →
  // dialog 가 커졌다 작아지는 깜박임 차단.
  if (tbody.children.length === 0) {
    status.style.display = '';
    status.textContent = t('common.loading');
  }

  const from = (historyCurrentPage - 1) * HISTORY_PAGE_SIZE;
  const to = from + HISTORY_PAGE_SIZE - 1;

  const matchedIds = getMatchingKingshotIds();
  // 검색어 있고 매칭 0건 — 서버 query 스킵하고 빈 결과 즉시 표시
  if (matchedIds !== null && matchedIds.length === 0) {
    historyTotalCount = 0;
    patchText($('history-total'), t('coupons.history.total', { n: 0 }));
    renderHistoryTable([]);
    renderHistoryPagination();
    return;
  }

  let query = sb
    .from('coupon_history')
    .select('kingshot_id,coupon_code,redeemed_at', { count: 'exact' })
    .eq('status', REDEEM_STATUS.SUCCESS);
  if (matchedIds !== null) query = query.in('kingshot_id', matchedIds);

  query
    .order('redeemed_at', { ascending: false })
    .range(from, to)
    .then((res) => {
      if (res.error) {
        $('history-table').style.display = 'none';
        status.style.display = '';
        status.textContent = t('coupons.history.queryFailed', { message: res.error.message });
        return;
      }
      historyTotalCount = res.count || 0;
      patchText($('history-total'), t('coupons.history.total', { n: historyTotalCount }));
      renderHistoryTable((res.data || []) as HistoryRow[]);
      renderHistoryPagination();
    });
}

function renderHistoryTable(rows: HistoryRow[]): void {
  const status = $('history-status');
  const table = $('history-table');
  const tbody = $('history-rows');
  if (rows.length === 0) {
    table.style.display = 'none';
    status.style.display = '';
    status.textContent = historySearch.trim()
      ? t('coupons.history.noSearch')
      : t('coupons.history.none');
    tbody.replaceChildren();
    return;
  }
  status.style.display = 'none';
  table.style.display = '';
  patchList({
    container: tbody,
    items: rows,
    // 같은 (kingshot_id, coupon_code, redeemed_at) 조합이 페이지간 같을 가능성 낮음 —
    // 그래도 page 내부 정렬 변경이나 데이터 갱신 시 안정적인 key 보장
    key: (r) => r.kingshot_id + ':' + r.coupon_code + ':' + (r.redeemed_at ?? ''),
    render: (r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td></td>
        <td class="col-code"></td>
        <td class="col-date"></td>
      `;
      updateHistoryRow(tr, r);
      return tr;
    },
    update: updateHistoryRow,
  });
}

function updateHistoryRow(tr: HTMLElement, r: HistoryRow): void {
  tr.title = formatDateTime(r.redeemed_at);
  const cells = tr.querySelectorAll<HTMLElement>('td');
  patchText(cells[0]!, nicknameMap[r.kingshot_id] || r.kingshot_id);
  patchText(cells[1]!, r.coupon_code);
  patchText(cells[2]!, formatRelativeTime(r.redeemed_at));
}

function renderHistoryPagination(): void {
  const el = $('history-pagination');
  const totalPages = Math.max(1, Math.ceil(historyTotalCount / HISTORY_PAGE_SIZE));

  // 가시 페이지 범위 계산 (현재 ±2, 끝쪽 보정)
  let start = Math.max(1, historyCurrentPage - 2);
  const end = Math.min(totalPages, start + 4);
  if (end - start < 4) start = Math.max(1, end - 4);

  // 버튼 items: prev (page-1) → 페이지번호들 → next (page+1)
  // 같은 buttons 의 active/disabled 상태만 patch — element 재사용
  interface PageBtn {
    key: string;
    page: number;
    label: string;
    disabled: boolean;
    active: boolean;
  }
  const items: PageBtn[] = [
    {
      key: 'prev',
      page: historyCurrentPage - 1,
      label: '‹',
      disabled: historyCurrentPage === 1,
      active: false,
    },
  ];
  for (let i = start; i <= end; i++) {
    items.push({
      key: 'p' + i,
      page: i,
      label: String(i),
      disabled: false,
      active: i === historyCurrentPage,
    });
  }
  items.push({
    key: 'next',
    page: historyCurrentPage + 1,
    label: '›',
    disabled: historyCurrentPage >= totalPages,
    active: false,
  });

  patchList({
    container: el,
    items,
    key: (b) => b.key,
    render: (b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.page = String(b.page);
      patchText(btn, b.label);
      btn.disabled = b.disabled;
      btn.classList.toggle('active', b.active);
      return btn;
    },
    update: (btn, b) => {
      btn.dataset.page = String(b.page);
      patchText(btn, b.label);
      (btn as HTMLButtonElement).disabled = b.disabled;
      btn.classList.toggle('active', b.active);
    },
  });

  // 컨테이너 위임 — 한 번만 등록 (idempotent)
  if (!el.dataset.bound) {
    el.dataset.bound = '1';
    el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-page]');
      if (!btn || btn.disabled) return;
      historyCurrentPage = parseInt(btn.dataset.page ?? '1', 10);
      loadHistoryPage();
    });
  }
}

// ===== 초기화 =====

function initPage(): void {
  loadCoupons(() => {
    loadAccounts(() => {
      loadHistory(() => {
        renderAccounts();
        checkAutoRedeem();
      });
    });
  });
}

function checkAutoRedeem(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('auto-redeem') === 'true') {
    const url = new URL(window.location.href);
    url.searchParams.delete('auto-redeem');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    setTimeout(() => startBulkRedeem(true), 500);
  }
}

function bindEventListeners(): void {
  // 검색
  const searchInput = maybe<HTMLInputElement>('coupon-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchKeyword = searchInput.value;
      renderAccounts();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchKeyword = '';
        renderAccounts();
      }
    });
  }

  // 쿠폰 카드 클릭/키보드 — 컨테이너 위임 (patchList 가 element 재사용해도 listener 한 번만)
  const couponCardsEl = maybe('coupon-cards');
  if (couponCardsEl) {
    couponCardsEl.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.coupon-card');
      if (!card) return;
      const code = card.dataset.code;
      if (code) selectCoupon(code);
    });
    couponCardsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = (e.target as HTMLElement).closest<HTMLElement>('.coupon-card');
      if (!card) return;
      e.preventDefault();
      const code = card.dataset.code;
      if (code) selectCoupon(code);
    });
  }

  // 계정 row 의 redeem / remove 버튼 — 인라인 onclick 대신 컨테이너 위임
  ['coupon-rows-members', 'coupon-rows-extras'].forEach((id) => {
    maybe(id)?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-action]',
      );
      if (!btn) return;
      const row = btn.closest<HTMLElement>('.coupon-account-row');
      if (!row) return;
      const action = btn.dataset.action;
      if (action === 'redeem') {
        const kingshotId = row.dataset.kingshotId;
        const nickname = row.querySelector<HTMLElement>('.mc-name')?.textContent ?? '';
        if (kingshotId) redeemOne(kingshotId, nickname);
      } else if (action === 'remove') {
        const accountId = row.dataset.accountId;
        if (accountId) removeAccount(accountId);
      }
    });
  });

  // 추가 계정 등록 모달
  $('btn-add-coupon-account').addEventListener('click', () => {
    $<HTMLInputElement>('coupon-input-id').value = '';
    $('coupon-search-result').style.display = 'none';
    $<HTMLButtonElement>('coupon-modal-save').disabled = true;
    const ov = maybe('coupon-modal-overlay');
    if (ov) ov.classList.add('open');
  });
  $('coupon-modal-close').addEventListener('click', closeCouponModal);
  $('coupon-modal-cancel').addEventListener('click', closeCouponModal);
  $('coupon-modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('coupon-modal-overlay')) closeCouponModal();
  });

  // 모달: 조회
  $('coupon-btn-search').addEventListener('click', () => {
    const id = $<HTMLInputElement>('coupon-input-id').value.trim();
    if (!id) return;
    const btn = $<HTMLButtonElement>('coupon-btn-search');
    btn.textContent = t('coupons.modal.searchingButton');
    btn.disabled = true;

    fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'player', fid: id }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.code !== 0 || !json.data)
          throw new Error(json.msg || t('members.errors.apiSearchFailed'));
        couponSearchData = {
          kingshot_id: String(json.data.fid),
          nickname: json.data.nickname,
          level: json.data.stove_lv || 0,
          kingdom: json.data.kid || null,
          profile_photo: json.data.avatar_image || null,
        };
        $('coupon-res-nickname').textContent = couponSearchData.nickname;
        $('coupon-res-level').textContent = String(couponSearchData.level);
        $('coupon-res-kingdom').textContent = couponSearchData.kingdom || '-';
        const photo = $<HTMLImageElement>('coupon-res-photo');
        if (couponSearchData.profile_photo) {
          photo.src = couponSearchData.profile_photo;
          photo.style.display = '';
        } else {
          photo.style.display = 'none';
        }
        $('coupon-search-result').style.display = '';
        $<HTMLButtonElement>('coupon-modal-save').disabled = false;
      })
      .catch((err: Error) => {
        alert(t('coupons.msg.searchFailed', { message: err.message }));
        couponSearchData = null;
      })
      .finally(() => {
        btn.textContent = t('coupons.modal.searchButton');
        btn.disabled = false;
      });
  });

  // 모달: 저장
  $('coupon-modal-save').addEventListener('click', () => {
    if (!couponSearchData) return;
    const data = couponSearchData;
    sb.from('members')
      .select('kingshot_id')
      .eq('kingshot_id', data.kingshot_id)
      .then((res) => {
        if (res.data && res.data.length > 0) {
          alert(t('coupons.msg.memberAlreadyRegistered'));
          return;
        }
        sb.from('coupon_accounts')
          .insert({
            kingshot_id: data.kingshot_id,
            nickname: data.nickname,
            level: data.level,
            kingdom: data.kingdom,
            profile_photo: data.profile_photo,
          })
          .then((res2) => {
            if (res2.error) {
              if (
                res2.error.message.indexOf('duplicate') !== -1 ||
                res2.error.message.indexOf('unique') !== -1
              ) {
                alert(t('coupons.msg.duplicate'));
              } else {
                alert(t('coupons.msg.saveFailed', { message: res2.error.message }));
              }
              return;
            }
            couponSearchData = null;
            invalidateAccountsCache();
            closeCouponModal();
            initPage();
          });
      });
  });

  // 전체 수령
  $('btn-redeem-all').addEventListener('click', () => startBulkRedeem(false));

  // 수령 이력
  $('btn-history').addEventListener('click', openHistoryDialog);
  $('history-close').addEventListener('click', () => {
    const ov = maybe('history-dialog-overlay');
    if (ov) ov.classList.remove('open');
  });

  // 이력 검색 — debounce 200ms 로 typing 중 과도한 쿼리 방지
  const historySearchInput = maybe<HTMLInputElement>('history-search');
  if (historySearchInput) {
    historySearchInput.addEventListener('input', () => {
      if (historySearchDebounce !== null) window.clearTimeout(historySearchDebounce);
      historySearchDebounce = window.setTimeout(() => {
        historySearch = historySearchInput.value;
        historyCurrentPage = 1;
        loadHistoryPage();
      }, 200);
    });
    historySearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        historySearchInput.value = '';
        historySearch = '';
        historyCurrentPage = 1;
        loadHistoryPage();
      }
    });
  }
  $('history-dialog-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      const ov = maybe('history-dialog-overlay');
      if (ov) ov.classList.remove('open');
    }
  });

  // Esc → 모든 오버레이 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['coupon-modal-overlay', 'history-dialog-overlay'].forEach((id) => {
      const el = document.getElementById(id);
      if (el?.classList.contains('open')) el.classList.remove('open');
    });
  });

  // 언어 변경 시 동적 렌더 텍스트 (hint / count / 카드 라벨 / 시간 등) 재계산.
  // 정적 마크업의 라벨은 applyTranslations() 가 자동 swap, 동적 textContent 는 마커 없어 이 경로로 수동 갱신.
  onLangChange(() => {
    renderCoupons();
    renderAccounts();
    if (maybe('history-dialog-overlay')?.classList.contains('open')) loadHistoryPage();
  });
}

// 전역 노출 — 인라인 onclick 패턴 유지
declare global {
  interface Window {
    Coupons: {
      redeemOne: (fid: string, nickname: string) => void;
      removeAccount: (id: string) => void;
      initPage: () => void;
      invalidateAccountsCache: () => void;
    };
  }
}
window.Coupons = { redeemOne, removeAccount, initPage, invalidateAccountsCache };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindEventListeners();
    initPage();
  });
} else {
  bindEventListeners();
  initPage();
}
