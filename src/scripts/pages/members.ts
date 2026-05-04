/**
 * 연맹원 관리 페이지 — membersStore 기반 keyed 갱신.
 *
 * 트랙 1 (2/N): 모듈 변수 allMembers/membersData 제거 → 단일 출처는 membersStore.
 * 행은 patchList 로 keyed reconcile — innerHTML 통째 교체 패턴 제거 → 깜박임 없음.
 * row 내부도 patchText/photo swap 으로 부분 갱신 — 같은 사진은 재로드 X.
 */

import { supabase as sb, SUPABASE_URL } from '@/lib/supabase';
import { SUPABASE_ANON_KEY } from '@/lib/supabase';
import { esc, getLevelClass, formatPower, delay, toggleOverlay } from '@/lib/utils';
import {
  invalidateAccountsCache,
  getFailedRefresh,
  saveFailedRefresh,
  clearFailedRefresh,
} from '@/lib/cache';
import { membersStore, fetchMembers } from '@/lib/stores/members';
import { patchList, patchText } from '@/lib/dom-diff';
import type { Member, AllianceRank } from '@/lib/types';
import { t, onLangChange } from '@/i18n';
import { getSession, isAdminSession } from '@/scripts/pages/tile-match-auth';

const REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
const FN_ECONOMY_URL = SUPABASE_URL + '/functions/v1/economy';
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES = 500;

interface PlayerInfo {
  playerId: string;
  name: string;
  level: number;
  kingdom: string | null;
  profilePhoto: string | null;
}

interface RefreshStats {
  success: number;
  failed: number;
  errors: string[];
  failedIds: string[];
  failedNames: string[];
}

const RANK_WEIGHT: Record<AllianceRank, number> = { R5: 5, R4: 4, R3: 3, R2: 2, R1: 1 };

// ===== DOM 핸들 =====

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

// ===== 플레이어 조회 (외부 API) =====

function fetchPlayerInfo(playerId: string): Promise<PlayerInfo> {
  return fetch(REDEEM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'player', fid: playerId }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(t('members.errors.apiError', { status: r.status }));
      return r.json();
    })
    .then((json) => {
      if (json.code !== 0 || !json.data) {
        throw new Error(json.msg || t('members.errors.apiSearchFailed'));
      }
      return {
        playerId: String(json.data.fid),
        name: json.data.nickname,
        level: json.data.stove_lv || json.data.stove_lv_content || 0,
        kingdom: json.data.kid || null,
        profilePhoto: json.data.avatar_image || null,
      } satisfies PlayerInfo;
    });
}

// ===== view-model =====

/** store 값을 power desc 로 정렬 + alliance_rank_pos 부여한 view-model. */
function buildPositioned(): Member[] {
  const raw = membersStore.get();
  if (!raw) return [];
  return [...raw]
    .sort((a, b) => (b.power || 0) - (a.power || 0))
    .map((m, idx) => ({ ...m, alliance_rank_pos: idx + 1 }));
}

function findMember(id: string): Member | null {
  return buildPositioned().find((m) => m.id === id) ?? null;
}

function currentFailedSet(): Set<string> {
  const data = getFailedRefresh();
  return new Set(data?.ids ?? []);
}

// ===== row 생성 / 갱신 =====

function createRow(m: Member): HTMLElement {
  const row = document.createElement('div');
  row.innerHTML = `
    <div class="mc-photo-wrap"></div>
    <div class="mc-row-body">
      <div class="mc-name">
        <span class="mc-name-text"></span>
        <span class="mc-fail-badge" title="${esc(t('members.failBadgeTitle'))}" style="display:none">⚠</span>
      </div>
      <div class="mc-sub"></div>
    </div>
    <div class="mc-rank-cell"></div>
    <div class="mc-level"></div>
    <div class="mc-pos"></div>
    <div class="mc-power"></div>
    <button class="mc-manage-btn" title="${esc(t('members.manageButtonTitle'))}" type="button">⋮</button>
  `;
  // wrapper 가 곧 row — `<div>` 자체에 innerHTML 을 박았으니 outer 의 첫 자식들이 row 의 자식
  // 혼동 방지 위해 outer 를 그대로 row 로 사용
  row.className = 'member-row';
  updateRow(row, m);
  return row;
}

function updateRow(row: HTMLElement, m: Member): void {
  const rank = m.alliance_rank || 'R1';
  const lvl = m.level || 0;
  const lvClass = getLevelClass(lvl);
  const pos = m.alliance_rank_pos || '-';
  const powerStr = m.power ? formatPower(m.power) : '-';
  const isFailed = currentFailedSet().has(m.id);

  row.className = 'member-row rank-' + rank + (isFailed ? ' member-row-failed' : '');
  row.dataset.id = m.id;

  const wrap = row.querySelector<HTMLElement>('.mc-photo-wrap')!;
  wrap.className = 'mc-photo-wrap' + lvClass;
  syncPhoto(wrap, m);

  patchText(row.querySelector<HTMLElement>('.mc-name-text'), m.nickname);
  const failBadge = row.querySelector<HTMLElement>('.mc-fail-badge')!;
  failBadge.style.display = isFailed ? '' : 'none';
  patchText(
    row.querySelector<HTMLElement>('.mc-sub'),
    rank + ' · Lv.' + (lvl || '?') + ' · ' + powerStr + ' · ' + (m.kingdom || '?'),
  );
  patchText(row.querySelector<HTMLElement>('.mc-rank-cell'), rank);
  patchText(row.querySelector<HTMLElement>('.mc-level'), 'Lv.' + (lvl || '?'));
  patchText(row.querySelector<HTMLElement>('.mc-pos'), String(pos));
  patchText(row.querySelector<HTMLElement>('.mc-power'), powerStr);
}

/**
 * photo wrap 안 placeholder + img stack.
 * - .mc-photo-empty 는 항상 존재 (nickname 첫 글자) — 이미지 fetch 중에도 빈 박스 노출 차단
 * - <img> 는 url 있을 때만 생성, onload 시 .mc-photo-loaded 로 페이드 인
 * - 같은 url 이면 src 재할당 X (브라우저 재로드 차단)
 */
function syncPhoto(wrap: HTMLElement, m: Member): void {
  const url = m.profile_photo;
  let empty = wrap.querySelector<HTMLElement>('.mc-photo-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'mc-photo-empty';
    wrap.appendChild(empty);
  }
  patchText(empty, m.nickname.charAt(0));

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

// ===== render =====

function renderMembers(): void {
  const positioned = buildPositioned();
  const filterSelect = $<HTMLSelectElement>('filter-level');
  const minLevel = parseInt(filterSelect.value, 10) || 0;

  const status = $('members-status');
  const rowsEl = $('members-rows');

  if (positioned.length === 0) {
    // 캐시 없음 / 첫 fetch 진행 중 — status 텍스트는 호출자(refreshFromStore) 가 관리
    rowsEl.replaceChildren();
    status.style.display = '';
    $('member-count').textContent = '';
    syncRefreshBanner();
    return;
  }

  const filtered = positioned
    .filter((m) => (m.level || 0) >= minLevel)
    .sort((a, b) => {
      const ra = a.alliance_rank ? RANK_WEIGHT[a.alliance_rank] : 0;
      const rb = b.alliance_rank ? RANK_WEIGHT[b.alliance_rank] : 0;
      if (ra !== rb) return rb - ra;
      if ((b.power || 0) !== (a.power || 0)) return (b.power || 0) - (a.power || 0);
      return (b.level || 0) - (a.level || 0);
    });

  $('member-count').textContent =
    minLevel > 0
      ? t('members.countWithLevel', { n: filtered.length, minLevel })
      : t('members.count', { n: filtered.length });

  if (filtered.length === 0) {
    rowsEl.replaceChildren();
    status.style.display = '';
    status.textContent = t('members.noFiltered');
    syncRefreshBanner();
    return;
  }

  status.style.display = 'none';
  patchList({
    container: rowsEl,
    items: filtered,
    key: (m) => m.id,
    render: createRow,
    update: updateRow,
  });
  syncRefreshBanner();
}

/**
 * store 갱신.
 * - force=false (기본): 캐시 신선하면 fetch 스킵 (페이지 진입용)
 * - force=true: 변경 이벤트 후 — TTL 무시하고 fetch 강제 (저장/삭제/등록/전체갱신)
 */
function refreshFromStore(force = false): Promise<Member[]> {
  const status = $('members-status');
  // 캐시 없으면 "로딩 중...", 캐시 있으면 백그라운드 갱신이라 status 손대지 않음
  if (membersStore.get() === null) {
    status.style.display = '';
    status.textContent = t('common.loading');
  }
  return membersStore.refresh(fetchMembers, force).catch((err: Error) => {
    status.style.display = '';
    status.textContent = t('members.loadError', { message: err.message });
    throw err;
  });
}

// ===== 관리 다이얼로그 =====

let currentDialogId: string | null = null;

function openDialog(id: string): void {
  const m = findMember(id);
  if (!m) return;
  currentDialogId = id;

  const rank = m.alliance_rank || 'R1';
  const lvl = m.level || 0;
  const lvClass = getLevelClass(lvl);

  const profileEl = document.querySelector('.md-profile') as HTMLElement | null;
  if (profileEl) profileEl.className = 'md-profile rank-' + rank;

  const avatarEl = $('md-avatar');
  avatarEl.className = 'md-photo-wrap' + lvClass;
  avatarEl.innerHTML = m.profile_photo
    ? '<img src="' + esc(m.profile_photo) + '">'
    : '<div class="md-avatar-empty">' + esc(m.nickname).charAt(0) + '</div>';

  $('md-name').textContent = m.nickname;
  $('md-id').textContent = 'ID: ' + m.kingshot_id;
  const metaParts = ['Lv.' + (lvl || '?')];
  if (m.power) metaParts.push(formatPower(m.power));
  if (m.alliance_rank_pos)
    metaParts.push(t('members.metaPosition', { n: m.alliance_rank_pos }));
  if (m.kingdom) metaParts.push(t('members.metaKingdom', { n: m.kingdom }));
  $('md-meta').textContent = metaParts.join(' · ');
  $<HTMLSelectElement>('md-rank').value = rank;
  $<HTMLInputElement>('md-auto-coupon').checked = m.auto_coupon !== false;

  // 관리자 섹션 — 로그인 세션의 is_admin 만 노출
  const adminSection = document.getElementById('md-admin-section');
  if (adminSection) {
    if (isAdminSession(getSession())) adminSection.removeAttribute('hidden');
    else adminSection.setAttribute('hidden', '');
  }

  toggleOverlay('manage-dialog-overlay', true);
}

function closeDialog(): void {
  toggleOverlay('manage-dialog-overlay', false);
  currentDialogId = null;
}

// ===== 등록 모달 =====

interface SearchData {
  kingshot_id: string;
  nickname: string;
  level: number;
  kingdom: string | null;
  profile_photo: string | null;
}
let searchData: SearchData | null = null;

function closeModal(): void {
  toggleOverlay('modal-overlay', false);
}

// ===== 갱신 (5명 병렬 배치) =====

function refreshAllMembers(): void {
  const positioned = buildPositioned();
  if (positioned.length === 0) {
    alert(t('members.refreshAllEmpty'));
    return;
  }
  if (!confirm(t('members.refreshAllConfirm', { n: positioned.length }))) return;
  refreshMembersByIds(positioned.map((m) => m.id));
}

function refreshMembersByIds(memberIds: string[]): void {
  if (!memberIds || memberIds.length === 0) return;
  const idSet = new Set(memberIds);
  const targets = buildPositioned().filter((m) => idSet.has(m.id));
  if (targets.length === 0) return;

  const btn = $<HTMLButtonElement>('btn-refresh-all');
  const originalText = btn.textContent || t('members.refreshAllButton');
  btn.disabled = true;

  const stats: RefreshStats = {
    success: 0,
    failed: 0,
    errors: [],
    failedIds: [],
    failedNames: [],
  };
  const total = targets.length;
  let done = 0;

  const updateBtnText = () => {
    btn.textContent = t('members.refreshingButton', { done, total });
  };
  updateBtnText();
  setBannerStatus('progress', done, total);

  const batches: Member[][] = [];
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    batches.push(targets.slice(i, i + BATCH_SIZE));
  }

  let chain: Promise<unknown> = Promise.resolve();
  batches.forEach((batch, idx) => {
    chain = chain
      .then(() =>
        Promise.all(batch.map((m) => refreshSingleMember(m, stats))).then(() => {
          done += batch.length;
          updateBtnText();
          setBannerStatus('progress', done, total);
        }),
      )
      .then(() => {
        if (idx < batches.length - 1) return delay(DELAY_BETWEEN_BATCHES);
      });
  });

  chain.then(() => {
    btn.textContent = originalText;
    btn.disabled = false;
    if (stats.failed > 0) {
      saveFailedRefresh(stats.failedIds, stats.failedNames);
    } else {
      clearFailedRefresh();
    }
    invalidateAccountsCache();
    refreshFromStore(true);
  });
}

function refreshSingleMember(m: Member, stats: RefreshStats): Promise<void> {
  return fetchPlayerInfo(m.kingshot_id)
    .then((data) =>
      sb
        .from('members')
        .update({
          nickname: data.name,
          level: parseInt(String(data.level), 10) || 0,
          kingdom: data.kingdom || null,
          profile_photo: data.profilePhoto || null,
        })
        .eq('id', m.id)
        .then((res) => {
          if (res.error) throw new Error(res.error.message);
          stats.success++;
        }),
    )
    .catch((err: Error) => {
      stats.failed++;
      stats.errors.push(m.nickname + ': ' + err.message);
      stats.failedIds.push(m.id);
      stats.failedNames.push(m.nickname);
    });
}

// ===== 갱신 실패 배너 =====

function getBannerEl(): HTMLDivElement | null {
  const existing = document.getElementById('refresh-fail-banner');
  if (existing) return existing as HTMLDivElement;
  const listEl = document.getElementById('members-list');
  if (!listEl?.parentNode) return null;
  const el = document.createElement('div');
  el.id = 'refresh-fail-banner';
  el.className = 'refresh-fail-banner';
  listEl.parentNode.insertBefore(el, listEl);
  return el;
}

type BannerMode = 'idle' | 'progress' | 'failure';

function setBannerStatus(mode: BannerMode, done?: number, total?: number): void {
  if (mode === 'progress') {
    const data = getFailedRefresh();
    if (!data?.ids?.length) return;
    const el = getBannerEl();
    if (!el) return;
    el.innerHTML =
      '<div class="rfb-icon">↻</div>' +
      '<div class="rfb-text">' +
      t('members.banner.retrying', { done: done ?? 0, total: total ?? 0 }) +
      '</div>';
    return;
  }
  if (mode === 'failure') {
    const d = getFailedRefresh();
    if (!d?.ids?.length) {
      document.getElementById('refresh-fail-banner')?.remove();
      return;
    }
    const el = getBannerEl();
    if (!el) return;
    let preview = d.names.slice(0, 3).map(esc).join(', ');
    if (d.names.length > 3) preview += t('members.banner.failureMore', { n: d.names.length - 3 });
    el.innerHTML =
      '<div class="rfb-icon">⚠</div>' +
      '<div class="rfb-text">' +
      t('members.banner.failure', { n: d.names.length, preview }) +
      '</div>' +
      '<div class="rfb-actions">' +
      '<button class="btn btn-primary btn-sm" id="rfb-retry">' +
      esc(t('members.banner.retryButton')) +
      '</button>' +
      '<button class="btn btn-secondary btn-sm" id="rfb-close">' +
      esc(t('members.banner.closeButton')) +
      '</button>' +
      '</div>';
    document.getElementById('rfb-retry')?.addEventListener('click', () => {
      const data = getFailedRefresh();
      if (data && data.ids.length > 0) refreshMembersByIds(data.ids);
    });
    document.getElementById('rfb-close')?.addEventListener('click', () => {
      clearFailedRefresh();
      syncRefreshBanner();
      renderMembers();
    });
    return;
  }
  // idle
  document.getElementById('refresh-fail-banner')?.remove();
}

function syncRefreshBanner(): void {
  setBannerStatus('failure');
}

// ===== 초기화 =====

function initPage(): void {
  // 필터 옵션 30 → 1
  const filterSelect = $<HTMLSelectElement>('filter-level');
  for (let i = 30; i >= 1; i--) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = 'Lv.' + i;
    filterSelect.appendChild(opt);
  }
  filterSelect.addEventListener('change', () => renderMembers());

  // 이벤트 위임 — ⋮ 관리 버튼 클릭
  $('members-rows').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.mc-manage-btn');
    if (!btn) return;
    const row = btn.closest<HTMLElement>('.member-row');
    const id = row?.dataset.id;
    if (id) openDialog(id);
  });

  // 다이얼로그 핸들러
  const dialogOverlay = $('manage-dialog-overlay');
  dialogOverlay.addEventListener('click', (e) => {
    if (e.target === dialogOverlay) closeDialog();
  });
  $('md-close').addEventListener('click', closeDialog);

  // 다이얼로그: 갱신
  $('md-refresh').addEventListener('click', () => {
    if (!currentDialogId) return;
    const m = findMember(currentDialogId);
    if (!m) return;
    const btn = $<HTMLButtonElement>('md-refresh');
    btn.disabled = true;

    fetchPlayerInfo(m.kingshot_id)
      .then((data) =>
        sb
          .from('members')
          .update({
            nickname: data.name,
            level: parseInt(String(data.level), 10) || 0,
            kingdom: data.kingdom || null,
            profile_photo: data.profilePhoto || null,
          })
          .eq('id', currentDialogId!)
          .then((res) => {
            if (res.error) throw new Error(res.error.message);
            invalidateAccountsCache();
            $('md-name').textContent = data.name;
            $('md-meta').textContent =
              'Lv.' + (data.level || '?') + ' · ' + (data.kingdom || '?');
            if (data.profilePhoto) {
              $('md-avatar').innerHTML = '<img src="' + esc(data.profilePhoto) + '">';
            }
            btn.innerHTML =
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
            setTimeout(() => {
              btn.innerHTML =
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
            }, 1500);
            // 백그라운드로 store 강제 갱신 — 변경 사항 반영을 위해 캐시 무시
            refreshFromStore(true);
          }),
      )
      .catch((err: Error) => alert(t('members.errors.refreshFailed', { message: err.message })))
      .finally(() => {
        btn.disabled = false;
      });
  });

  // 다이얼로그: 저장
  $('md-save').addEventListener('click', () => {
    if (!currentDialogId) return;
    sb.from('members')
      .update({
        alliance_rank: $<HTMLSelectElement>('md-rank').value,
        auto_coupon: $<HTMLInputElement>('md-auto-coupon').checked,
      })
      .eq('id', currentDialogId)
      .then((res) => {
        if (res.error) {
          alert(t('members.errors.saveFailed', { message: res.error.message }));
          return;
        }
        invalidateAccountsCache();
        closeDialog();
        refreshFromStore(true);
      });
  });

  // 다이얼로그: 삭제
  $('md-delete').addEventListener('click', () => {
    if (!currentDialogId) return;
    const m = findMember(currentDialogId);
    if (!m || !confirm(t('members.errors.confirmDelete', { name: m.nickname }))) return;
    sb.from('members')
      .delete()
      .eq('id', currentDialogId)
      .then((res) => {
        if (res.error) {
          alert(t('members.errors.deleteFailed', { message: res.error.message }));
          return;
        }
        invalidateAccountsCache();
        closeDialog();
        refreshFromStore(true);
      });
  });

  // 등록 모달
  $('btn-add-member').addEventListener('click', () => {
    $<HTMLInputElement>('input-kingshot-id').value = '';
    $('search-result').style.display = 'none';
    $<HTMLButtonElement>('btn-modal-save').disabled = true;
    toggleOverlay('modal-overlay', true);
  });
  $('modal-close').addEventListener('click', closeModal);
  $('btn-modal-cancel').addEventListener('click', closeModal);
  $('modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('modal-overlay')) closeModal();
  });

  // 등록 모달: 조회
  $('btn-search-id').addEventListener('click', () => {
    const kingshotId = $<HTMLInputElement>('input-kingshot-id').value.trim();
    if (!kingshotId) return;
    const btn = $<HTMLButtonElement>('btn-search-id');
    btn.textContent = t('members.modal.searchingButton');
    btn.disabled = true;
    $('search-result').style.display = 'none';

    fetchPlayerInfo(kingshotId)
      .then((data) => {
        searchData = {
          kingshot_id: data.playerId,
          nickname: data.name,
          level: parseInt(String(data.level), 10) || 0,
          kingdom: data.kingdom || null,
          profile_photo: data.profilePhoto || null,
        };
        $('res-nickname').textContent = searchData.nickname;
        $('res-level').textContent = String(searchData.level);
        $('res-kingdom').textContent = searchData.kingdom || '-';
        const photo = $<HTMLImageElement>('res-photo');
        if (searchData.profile_photo) {
          photo.src = searchData.profile_photo;
          photo.style.display = '';
        } else {
          photo.style.display = 'none';
        }
        $('search-result').style.display = '';
        $<HTMLButtonElement>('btn-modal-save').disabled = false;
      })
      .catch((err: Error) => {
        alert(t('members.errors.refreshFailed', { message: err.message }));
        searchData = null;
        $<HTMLButtonElement>('btn-modal-save').disabled = true;
      })
      .finally(() => {
        btn.textContent = t('members.modal.searchButton');
        btn.disabled = false;
      });
  });

  // 등록 모달: 저장
  $('btn-modal-save').addEventListener('click', () => {
    if (!searchData) {
      alert(t('members.errors.needSearch'));
      return;
    }
    const data = searchData;
    sb.from('members')
      .insert({
        kingshot_id: data.kingshot_id,
        nickname: data.nickname,
        level: data.level,
        kingdom: data.kingdom,
        profile_photo: data.profile_photo,
      })
      .then((res) => {
        if (res.error) {
          if (
            res.error.message.indexOf('duplicate') !== -1 ||
            res.error.message.indexOf('unique') !== -1
          ) {
            alert(t('members.errors.duplicate'));
          } else {
            alert(t('members.errors.saveFailed', { message: res.error.message }));
          }
          return;
        }
        // coupon_accounts 에 동일 ID 가 있으면 자동 정리 (연맹원 우선)
        sb.from('coupon_accounts')
          .delete()
          .eq('kingshot_id', data.kingshot_id)
          .then(() => {
            invalidateAccountsCache();
            searchData = null;
            closeModal();
            refreshFromStore(true);
          });
      });
  });

  // 전체 갱신
  $('btn-refresh-all').addEventListener('click', refreshAllMembers);

  // 관리자 — 크리스탈 지급
  initAdminGrant();

  // Esc → 모든 오버레이 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['modal-overlay', 'manage-dialog-overlay'].forEach((id) => {
      const el = document.getElementById(id);
      if (el?.classList.contains('open')) el.classList.remove('open');
    });
  });

  // store 변경 구독 → 자동 렌더 (캐시 있으면 즉시 1회 호출 → 깜박임 없는 첫 표시)
  membersStore.subscribe(() => renderMembers());
  // 백그라운드 fetch — 캐시 있어도 stale-while-revalidate
  refreshFromStore();

  // 언어 변경 시 동적 텍스트 (count / 메타 / 배너 등) 재계산.
  onLangChange(() => renderMembers());
}

// ===== 관리자 — 크리스탈 지급 =====

interface AdminGrantResp {
  ok: boolean;
  error?: string;
  amount_applied?: number;
  duplicate?: boolean;
  target_balance?: number;
  target_kingshot_id?: string;
}

function setGrantStatus(text: string, tone: 'idle' | 'error' | 'success' = 'idle'): void {
  const el = document.getElementById('grant-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function openGrantDialog(): void {
  if (!currentDialogId) return;
  const m = findMember(currentDialogId);
  if (!m) return;
  if (!isAdminSession(getSession())) return;

  const dlg = document.getElementById('grant-dialog') as HTMLDialogElement | null;
  if (!dlg) return;

  // 매번 신선한 상태로 — 이전 입력 잔재 제거
  const targetEl = document.getElementById('grant-target');
  if (targetEl) targetEl.textContent = '→ ' + m.nickname + ' (' + m.kingshot_id + ')';
  (document.getElementById('grant-amount') as HTMLInputElement).value = '';
  (document.getElementById('grant-source') as HTMLSelectElement).value = 'event';
  (document.getElementById('grant-memo') as HTMLTextAreaElement).value = '';
  setGrantStatus('');
  const submitBtn = document.getElementById('grant-submit') as HTMLButtonElement;
  if (submitBtn) submitBtn.disabled = false;

  dlg.showModal();
}

function closeGrantDialog(): void {
  const dlg = document.getElementById('grant-dialog') as HTMLDialogElement | null;
  if (dlg?.open) dlg.close();
}

function submitGrant(): void {
  if (!currentDialogId) return;
  const target = findMember(currentDialogId);
  const session = getSession();
  if (!target || !session?.player_id || !isAdminSession(session)) return;

  const amountInput = document.getElementById('grant-amount') as HTMLInputElement;
  const sourceSelect = document.getElementById('grant-source') as HTMLSelectElement;
  const memoInput = document.getElementById('grant-memo') as HTMLTextAreaElement;
  const submitBtn = document.getElementById('grant-submit') as HTMLButtonElement;

  const amountStr = amountInput.value.trim();
  // 정규식: 1~99,999 | 100,000~299,999 | 300000
  const amountRegex = /^([1-9][0-9]{0,4}|[1-2][0-9]{5}|300000)$/;
  if (!amountRegex.test(amountStr)) {
    setGrantStatus(t('members.grantDialog.errors.invalidAmount'), 'error');
    amountInput.setAttribute('aria-invalid', 'true');
    amountInput.focus();
    return;
  }
  amountInput.removeAttribute('aria-invalid');
  const amount = parseInt(amountStr, 10);
  const sourceKind = sourceSelect.value;
  const memo = memoInput.value.trim();
  // UUID — 행위 1회당 새로 생성. 재시도(네트워크 등)는 같은 키 재사용 → 서버 UNIQUE 가 중복 차단.
  const idempotencyKey = (crypto as Crypto & { randomUUID?: () => string }).randomUUID
    ? crypto.randomUUID()
    : 'fallback-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

  submitBtn.disabled = true;
  setGrantStatus(t('members.grantDialog.status.sending'), 'idle');

  fetch(FN_ECONOMY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      action: 'admin-grant',
      player_id: session.player_id,
      target_kingshot_id: target.kingshot_id,
      amount,
      source_kind: sourceKind,
      memo,
      idempotency_key: idempotencyKey,
    }),
  })
    .then((r) => r.json() as Promise<AdminGrantResp>)
    .then((res) => {
      if (!res.ok) {
        setGrantStatus(t('members.grantDialog.errors.serverError', { error: res.error || '' }), 'error');
        submitBtn.disabled = false;
        return;
      }
      // 자기 자신에게 지급한 경우 헤더 잔액 즉시 갱신
      if (res.target_kingshot_id === session.player_id && typeof res.target_balance === 'number') {
        window.dispatchEvent(
          new CustomEvent('crystal-balance-update', { detail: { balance: res.target_balance } }),
        );
      }
      const msgKey = res.duplicate
        ? 'members.grantDialog.status.duplicate'
        : 'members.grantDialog.status.success';
      setGrantStatus(
        t(msgKey, { amount: amount.toLocaleString('ko-KR'), name: target.nickname }),
        'success',
      );
      // 잠시 보여준 뒤 자동 닫기
      setTimeout(() => closeGrantDialog(), 1200);
    })
    .catch((err: Error) => {
      setGrantStatus(t('members.grantDialog.errors.networkError', { message: err.message }), 'error');
      submitBtn.disabled = false;
    });
}

function initAdminGrant(): void {
  document.getElementById('md-admin-grant')?.addEventListener('click', openGrantDialog);
  document.getElementById('grant-cancel')?.addEventListener('click', () => closeGrantDialog());
  document.getElementById('grant-submit')?.addEventListener('click', submitGrant);

  // backdrop 클릭 시 닫기
  document.getElementById('grant-dialog')?.addEventListener('click', (e) => {
    const dlg = e.currentTarget as HTMLDialogElement;
    if (e.target === dlg) closeGrantDialog();
  });
}

// 외부 노출 — 다른 페이지에서 reload 호출용 (현재는 사용 X 지만 보존)
declare global {
  interface Window {
    Members: {
      openDialog: (id: string) => void;
      reload: () => Promise<Member[]>;
    };
  }
}
window.Members = { openDialog, reload: refreshFromStore };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPage);
} else {
  initPage();
}
