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
import type { ActiveCoupon, RedeemAccount, RedeemBatchResponse } from '@/lib/types';

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

function renderCoupons(): void {
  const el = maybe('coupon-list');
  if (!el) return;
  if (activeCoupons.length === 0) {
    el.innerHTML = '<div class="empty-cell">현재 사용 가능한 쿠폰이 없습니다</div>';
    return;
  }
  const cardsHtml = activeCoupons
    .map((c) => {
      const days = daysUntilExpire(c.expiresAt);
      const expiring = days !== null && days <= 3;
      const badge = expiring
        ? '<span class="coupon-badge-expiring">' +
          (days! <= 0 ? '곧 만료' : 'D-' + days) +
          '</span>'
        : '';
      const selected = selectedCouponCode === c.code;
      const classNames =
        'coupon-card' +
        (expiring ? ' coupon-expiring' : '') +
        (selected ? ' coupon-selected' : '');
      return (
        '<div class="' +
        classNames +
        '" data-code="' +
        esc(c.code) +
        '" role="button" tabindex="0">' +
        '<span class="coupon-badge-active">' +
        (selected ? '선택됨' : 'ACTIVE') +
        '</span>' +
        '<span class="coupon-code">' +
        esc(c.code) +
        '</span>' +
        '<span class="coupon-expires">만료: ' +
        (c.expiresAt ? formatDate(c.expiresAt) : '무기한') +
        badge +
        '</span>' +
        '</div>'
      );
    })
    .join('');
  el.innerHTML =
    cardsHtml +
    '<div class="coupon-select-hint">' +
    (selectedCouponCode
      ? '<strong>' +
        esc(selectedCouponCode) +
        '</strong> 만 수령합니다. 다시 클릭하면 전체 모드로 돌아갑니다.'
      : '쿠폰 카드를 클릭하면 해당 쿠폰만 받게 됩니다 (자격 미달 쿠폰 분리 수령용).') +
    '</div>';

  el.querySelectorAll<HTMLElement>('.coupon-card').forEach((card) => {
    card.addEventListener('click', () => {
      const code = card.getAttribute('data-code');
      if (code) selectCoupon(code);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const code = card.getAttribute('data-code');
        if (code) selectCoupon(code);
      }
    });
  });
}

// ===== 대상 계정 =====

function loadAccounts(callback?: () => void): void {
  const cached = getAccountsCache();
  if (cached) {
    allAccounts = cached;
    callback?.();
    return;
  }
  Promise.all([
    sb
      .from('members')
      .select('kingshot_id,nickname,level,kingdom,profile_photo')
      .eq('auto_coupon', true),
    sb.from('coupon_accounts').select('*'),
  ]).then((results) => {
    allAccounts = [];
    if (results[0].data) {
      (results[0].data as Array<Record<string, unknown>>).forEach((m) => {
        allAccounts.push({
          kingshot_id: m.kingshot_id as string,
          nickname: m.nickname as string,
          level: (m.level as number) ?? null,
          kingdom: (m.kingdom as string) ?? null,
          profile_photo: (m.profile_photo as string) ?? null,
          source: 'member',
        });
      });
    }
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
  sb.from('coupon_history')
    .select('kingshot_id,coupon_code,status')
    .in('coupon_code', codes)
    .then((res) => {
      for (const k of Object.keys(couponHistory)) delete couponHistory[k];
      if (res.data) {
        (res.data as Array<{ kingshot_id: string; coupon_code: string; status: string }>).forEach(
          (r) => {
            couponHistory[r.kingshot_id + ':' + r.coupon_code] = r.status;
          },
        );
      }
      callback?.();
    });
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

function updateAccountRowStatus(kingshotId: string): void {
  if (getRedeemStatus(kingshotId) !== 'done') return;
  document.querySelectorAll<HTMLElement>('.coupon-account-row').forEach((row) => {
    const btn = row.querySelector('.cp-btn-redeem[onclick*="' + kingshotId + '"]');
    if (btn) {
      btn.outerHTML =
        '<button class="cp-btn cp-btn-done cp-btn-just-done" disabled title="수령 완료">' +
        SVG.check +
        '</button>';
    }
  });
}

// ===== 계정 목록 렌더링 =====

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

  const countText = kw
    ? '검색 ' + total + ' / 전체 ' + totalAll + '명'
    : '전체 ' + totalAll + '명';
  $('coupon-member-count').textContent = countText;

  if (totalAll === 0) {
    listEl.innerHTML = '<div class="empty-cell">쿠폰 수령 대상이 없습니다</div>';
    return;
  }
  if (total === 0) {
    listEl.innerHTML = '<div class="empty-cell">검색 결과가 없습니다</div>';
    return;
  }

  let html = '';
  if (members.length > 0) {
    html += '<div class="coupon-group-label">연맹원</div>';
    html += members.map((a) => renderAccountRow(a, false)).join('');
  }
  if (extras.length > 0) {
    html += '<div class="coupon-group-label">추가 계정</div>';
    html += extras.map((a) => renderAccountRow(a, true)).join('');
  }
  listEl.innerHTML = html;
}

function renderAccountRow(a: RedeemAccount, canDelete: boolean): string {
  const status = getEffectiveStatus(a.kingshot_id);
  const avatar = a.profile_photo
    ? '<img src="' + esc(a.profile_photo) + '" class="mc-photo">'
    : '<div class="mc-photo-empty">' + esc(a.nickname).charAt(0) + '</div>';

  const redeemBtn =
    status === 'done'
      ? '<button class="cp-btn cp-btn-done" disabled title="수령 완료">' + SVG.check + '</button>'
      : "<button class=\"cp-btn cp-btn-redeem\" onclick=\"Coupons.redeemOne('" +
        esc(a.kingshot_id) +
        "','" +
        esc(a.nickname) +
        "')\" title=\"쿠폰 수령\">" +
        SVG.gift +
        '</button>';

  const deleteBtn = canDelete
    ? "<button class=\"cp-btn cp-btn-delete\" onclick=\"Coupons.removeAccount('" +
      a.id +
      "')\" title=\"삭제\">" +
      SVG.trash +
      '</button>'
    : '';

  return (
    '<div class="coupon-account-row">' +
    '<div class="mc-photo-wrap">' +
    avatar +
    '</div>' +
    '<div class="mc-row-body">' +
    '<div class="mc-name">' +
    esc(a.nickname) +
    '</div>' +
    '<div class="mc-sub">Lv.' +
    (a.level || '?') +
    ' · ' +
    (a.kingdom || '?') +
    '</div>' +
    '</div>' +
    '<div class="coupon-row-actions">' +
    redeemBtn +
    deleteBtn +
    '</div>' +
    '</div>'
  );
}

// ===== 추가 계정 등록 모달 =====

function closeCouponModal(): void {
  const ov = maybe('coupon-modal-overlay');
  if (ov) ov.classList.remove('open');
}

// ===== 계정 삭제 =====

function removeAccount(id: string): void {
  if (!confirm('이 계정을 삭제하시겠습니까?')) return;
  sb.from('coupon_accounts')
    .delete()
    .eq('id', id)
    .then((res) => {
      if (res.error) {
        alert('삭제 실패: ' + res.error.message);
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
      nickname +
        ': ' +
        (sel ? sel.code + ' 쿠폰을 이미 수령했습니다.' : '모든 쿠폰이 이미 수령되었습니다.'),
    );
    return;
  }
  redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
  totalRedeemTasks = codes.length;
  completedRedeemTasks = 0;
  showProgress(nickname + ' 수령 시작...');
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
        showProgress('⚠️ ' + nickname + ' 오류: ' + topLabel);
        return;
      }
      json.results.forEach((r) => {
        completedRedeemTasks++;
        const code = r.cdk;
        const fakeJson = { code: r.code, msg: r.msg, err_code: r.err_code };
        if (r.code === 0) {
          redeemStats.success++;
          saveHistory(fid, code, REDEEM_STATUS.SUCCESS, r.msg);
          showProgress('✅ ' + nickname + ' — ' + code + ' 수령 완료');
        } else if (isAlreadyRedeemed(fakeJson)) {
          redeemStats.already++;
          saveHistory(fid, code, REDEEM_STATUS.ALREADY, r.msg);
          showProgress('✅ ' + nickname + ' — ' + code + ' 이미 수령됨');
        } else {
          const label = describeRedeemError(fakeJson);
          redeemStats.failed++;
          redeemStats.errors.push(nickname + ' — ' + code + ': ' + label);
          showProgress('⚠️ ' + nickname + ' — ' + code + ': ' + label);
        }
      });
      updateAccountRowStatus(fid);
    })
    .catch((err: Error) => {
      codes.forEach((code) => {
        completedRedeemTasks++;
        redeemStats.failed++;
        redeemStats.errors.push(
          nickname + ' — ' + code + ': ' + (err.message || '네트워크 오류'),
        );
      });
      showProgress('⚠️ ' + nickname + ' 네트워크 오류');
    });
}

// ===== 전체 수령 =====

function startBulkRedeem(skipConfirm: boolean): void {
  if (activeCoupons.length === 0) {
    if (!skipConfirm) alert('사용 가능한 쿠폰이 없습니다.');
    return;
  }
  const sel = getSelectedCoupon();
  const pending = allAccounts.filter((a) => getCodesToRedeem(a.kingshot_id).length > 0);
  if (pending.length === 0) {
    if (!skipConfirm) {
      alert(
        sel
          ? sel.code + ' 쿠폰을 모든 계정이 이미 수령했습니다.'
          : '모든 계정이 이미 쿠폰을 수령했습니다.',
      );
    }
    return;
  }
  const confirmMsg = sel
    ? pending.length + '명에게 ' + sel.code + ' 쿠폰을 수령하시겠습니까?'
    : pending.length + '명에게 미수령 쿠폰을 수령하시겠습니까?';
  if (!skipConfirm && !confirm(confirmMsg)) return;

  redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
  totalRedeemTasks = pending.reduce(
    (sum, a) => sum + getCodesToRedeem(a.kingshot_id).length,
    0,
  );
  completedRedeemTasks = 0;
  const startMsg = sel
    ? sel.code + ' 수령 시작 (' + pending.length + '명)...'
    : '전체 수령 시작 (' + pending.length + '명, ' + totalRedeemTasks + '건)...';
  showProgress(startMsg);

  const batches: RedeemAccount[][] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  let chain: Promise<unknown> = Promise.resolve();
  batches.forEach((batch, idx) => {
    chain = chain
      .then(() => {
        showProgress('배치 ' + (idx + 1) + '/' + batches.length + ' 처리 중...');
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

function showProgress(text: string): void {
  let el = maybe<HTMLDivElement>('redeem-progress');
  if (!el) {
    el = document.createElement('div');
    el.id = 'redeem-progress';
    el.className = 'redeem-progress';
    const toolbar = document.querySelector<HTMLElement>('#page-coupons .members-toolbar');
    toolbar?.parentNode?.insertBefore(el, toolbar.nextSibling);
  }
  const pct = totalRedeemTasks > 0 ? Math.round((completedRedeemTasks / totalRedeemTasks) * 100) : 0;
  el.innerHTML =
    '<div class="redeem-progress-text">' +
    esc(text) +
    '</div>' +
    '<div class="redeem-progress-bar"><div class="redeem-progress-fill" style="width:' +
    pct +
    '%"></div></div>' +
    '<div class="redeem-progress-count">' +
    completedRedeemTasks +
    ' / ' +
    totalRedeemTasks +
    '</div>';
  el.style.display = '';
}

function showSummary(): void {
  const el = maybe('redeem-progress');
  if (el) {
    const cls = redeemStats.failed > 0 ? 'summary-warn' : 'summary-ok';
    el.innerHTML =
      '<div class="redeem-summary ' +
      cls +
      '">' +
      '<span>✅ 성공 ' +
      redeemStats.success +
      '</span>' +
      (redeemStats.already > 0 ? '<span>📋 이미 수령 ' + redeemStats.already + '</span>' : '') +
      (redeemStats.failed > 0 ? '<span>⚠️ 실패 ' + redeemStats.failed + '</span>' : '') +
      '</div>';
    setTimeout(() => {
      el.style.display = 'none';
    }, SUMMARY_DISPLAY_MS);
  }
  if (redeemStats.failed > 0) {
    alert('실패 상세:\n' + redeemStats.errors.join('\n'));
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
  const ov = maybe('history-dialog-overlay');
  if (ov) ov.classList.add('open');
  loadHistoryPage();
}

function loadHistoryPage(): void {
  const body = $('history-body');
  body.innerHTML = '<div class="empty-cell">로딩 중...</div>';

  const from = (historyCurrentPage - 1) * HISTORY_PAGE_SIZE;
  const to = from + HISTORY_PAGE_SIZE - 1;

  sb.from('coupon_history')
    .select('kingshot_id,coupon_code,redeemed_at', { count: 'exact' })
    .eq('status', REDEEM_STATUS.SUCCESS)
    .order('redeemed_at', { ascending: false })
    .range(from, to)
    .then((res) => {
      if (res.error) {
        body.innerHTML = '<div class="empty-cell">조회 실패: ' + res.error.message + '</div>';
        return;
      }
      historyTotalCount = res.count || 0;
      $('history-total').textContent = '전체 ' + historyTotalCount + '건';
      renderHistoryTable(
        (res.data || []) as Array<{
          kingshot_id: string;
          coupon_code: string;
          redeemed_at: string | null;
        }>,
      );
      renderHistoryPagination();
    });
}

function renderHistoryTable(
  rows: Array<{ kingshot_id: string; coupon_code: string; redeemed_at: string | null }>,
): void {
  const body = $('history-body');
  if (rows.length === 0) {
    body.innerHTML = '<div class="empty-cell">수령 이력이 없습니다</div>';
    return;
  }
  let html =
    '<table class="history-table">' +
    '<thead><tr><th>계정</th><th>쿠폰</th><th>수령일시</th></tr></thead><tbody>';
  html += rows
    .map((r) => {
      const nick = nicknameMap[r.kingshot_id] || r.kingshot_id;
      return (
        '<tr title="' +
        formatDateTime(r.redeemed_at) +
        '">' +
        '<td>' +
        esc(nick) +
        '</td>' +
        '<td class="col-code">' +
        esc(r.coupon_code) +
        '</td>' +
        '<td class="col-date">' +
        formatRelativeTime(r.redeemed_at) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
  html += '</tbody></table>';
  body.innerHTML = html;
}

function renderHistoryPagination(): void {
  const el = $('history-pagination');
  const totalPages = Math.max(1, Math.ceil(historyTotalCount / HISTORY_PAGE_SIZE));

  let html = '';
  html +=
    '<button ' +
    (historyCurrentPage === 1 ? 'disabled' : '') +
    ' data-page="' +
    (historyCurrentPage - 1) +
    '">&lsaquo;</button>';

  let start = Math.max(1, historyCurrentPage - 2);
  const end = Math.min(totalPages, start + 4);
  if (end - start < 4) start = Math.max(1, end - 4);
  for (let i = start; i <= end; i++) {
    html +=
      '<button class="' +
      (i === historyCurrentPage ? 'active' : '') +
      '" data-page="' +
      i +
      '">' +
      i +
      '</button>';
  }

  html +=
    '<button ' +
    (historyCurrentPage >= totalPages ? 'disabled' : '') +
    ' data-page="' +
    (historyCurrentPage + 1) +
    '">&rsaquo;</button>';

  el.innerHTML = html;
  el.querySelectorAll<HTMLButtonElement>('button[data-page]').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      historyCurrentPage = parseInt(btn.dataset.page || '1', 10);
      loadHistoryPage();
    });
  });
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
    btn.textContent = '조회 중...';
    btn.disabled = true;

    fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'player', fid: id }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.code !== 0 || !json.data) throw new Error(json.msg || '조회 실패');
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
        alert('조회 실패: ' + err.message);
        couponSearchData = null;
      })
      .finally(() => {
        btn.textContent = '조회';
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
          alert(
            '이 계정은 이미 연맹원으로 등록되어 있습니다.\n연맹원 관리 페이지에서 "쿠폰 자동 받기"를 활성화하세요.',
          );
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
                alert('이미 등록된 계정입니다.');
              } else {
                alert('저장 실패: ' + res2.error.message);
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
