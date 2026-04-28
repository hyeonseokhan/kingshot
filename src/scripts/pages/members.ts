/**
 * 연맹원 관리 페이지 — members.js 의 TypeScript 이식.
 * 로직 동등성 우선. 타입은 점진적 (Phase 7 에서 강화).
 */

import { supabase as sb, SUPABASE_URL } from '@/lib/supabase';
import { esc, getLevelClass, formatPower, delay, toggleOverlay } from '@/lib/utils';
import {
  invalidateAccountsCache,
  getFailedRefresh,
  saveFailedRefresh,
  clearFailedRefresh,
} from '@/lib/cache';
import type { Member, AllianceRank } from '@/lib/types';

const REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES = 500;

// 모듈 상태
let allMembers: Member[] = [];
const membersData: Record<string, Member> = {};

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

// ===== 플레이어 조회 =====

function fetchPlayerInfo(playerId: string): Promise<PlayerInfo> {
  return fetch(REDEEM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'player', fid: playerId }),
  })
    .then((r) => {
      if (!r.ok) throw new Error('API 오류 (' + r.status + ')');
      return r.json();
    })
    .then((json) => {
      if (json.code !== 0 || !json.data) {
        throw new Error(json.msg || 'API 조회 실패');
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

// ===== 목록 로드/렌더 =====

function loadMembers(): void {
  const listEl = $('members-list');
  listEl.innerHTML = '<div class="empty-cell">로딩 중...</div>';
  sb.from('members')
    .select('*')
    .order('power', { ascending: false })
    .then((res) => {
      if (res.error) {
        listEl.innerHTML = '<div class="empty-cell">오류: ' + res.error.message + '</div>';
        return;
      }
      if (!res.data || res.data.length === 0) {
        listEl.innerHTML = '<div class="empty-cell">등록된 연맹원이 없습니다</div>';
        $('member-count').textContent = '';
        return;
      }
      allMembers = res.data as Member[];
      // 기존 캐시 클리어 후 새로 채움
      for (const k of Object.keys(membersData)) delete membersData[k];
      allMembers.forEach((m, idx) => {
        m.alliance_rank_pos = idx + 1;
        membersData[m.id] = m;
      });
      renderMembers();
    });
}

function renderMembers(): void {
  const listEl = $('members-list');
  const filterSelect = $<HTMLSelectElement>('filter-level');
  const minLevel = parseInt(filterSelect.value, 10) || 0;
  const failedData = getFailedRefresh();
  const failedSet: Record<string, boolean> = {};
  if (failedData?.ids) failedData.ids.forEach((id) => (failedSet[id] = true));

  const filtered = allMembers.filter((m) => (m.level || 0) >= minLevel);

  filtered.sort((a, b) => {
    const ra = a.alliance_rank ? RANK_WEIGHT[a.alliance_rank] : 0;
    const rb = b.alliance_rank ? RANK_WEIGHT[b.alliance_rank] : 0;
    if (ra !== rb) return rb - ra;
    if ((b.power || 0) !== (a.power || 0)) return (b.power || 0) - (a.power || 0);
    return (b.level || 0) - (a.level || 0);
  });

  $('member-count').textContent =
    '전체 ' + filtered.length + '명' + (minLevel > 0 ? ' (Lv.' + minLevel + ' 이상)' : '');

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty-cell">조건에 맞는 연맹원이 없습니다</div>';
    return;
  }

  const thead =
    '<div class="members-thead">' +
    '<div></div><div>닉네임</div><div>등급</div><div>레벨</div>' +
    '<div>랭킹</div><div>전투력</div><div></div>' +
    '</div>';

  const rows = filtered
    .map((m) => {
      const rank = m.alliance_rank || 'R1';
      const lvl = m.level || 0;
      const lvClass = getLevelClass(lvl);
      const pos = m.alliance_rank_pos || '-';
      const powerStr = m.power ? formatPower(m.power) : '-';

      const avatarInner = m.profile_photo
        ? '<img src="' + esc(m.profile_photo) + '" class="mc-photo">'
        : '<div class="mc-photo-empty">' + esc(m.nickname).charAt(0) + '</div>';
      const avatar = '<div class="mc-photo-wrap' + lvClass + '">' + avatarInner + '</div>';

      const sub =
        rank + ' · Lv.' + (lvl || '?') + ' · ' + powerStr + ' · ' + (m.kingdom || '?');
      const isFailed = !!failedSet[m.id];
      const failedClass = isFailed ? ' member-row-failed' : '';
      const failBadge = isFailed
        ? '<span class="mc-fail-badge" title="갱신 실패 — 재시도 필요">⚠</span>'
        : '';

      return (
        '<div class="member-row rank-' +
        rank +
        failedClass +
        '" data-id="' +
        m.id +
        '">' +
        avatar +
        '<div class="mc-row-body">' +
        '<div class="mc-name">' +
        esc(m.nickname) +
        failBadge +
        '</div>' +
        '<div class="mc-sub">' +
        sub +
        '</div>' +
        '</div>' +
        '<div class="mc-rank-cell">' +
        rank +
        '</div>' +
        '<div class="mc-level">Lv.' +
        (lvl || '?') +
        '</div>' +
        '<div class="mc-pos">' +
        pos +
        '</div>' +
        '<div class="mc-power">' +
        powerStr +
        '</div>' +
        "<button class=\"mc-manage-btn\" onclick=\"Members.openDialog('" +
        m.id +
        "')\" title=\"관리\">⋮</button>" +
        '</div>'
      );
    })
    .join('');

  listEl.innerHTML = thead + rows;
  syncRefreshBanner();
}

// ===== 관리 다이얼로그 =====

let currentDialogId: string | null = null;

function openDialog(id: string): void {
  const m = membersData[id];
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
  if (m.alliance_rank_pos) metaParts.push('연맹 ' + m.alliance_rank_pos + '위');
  if (m.kingdom) metaParts.push('서버 ' + m.kingdom);
  $('md-meta').textContent = metaParts.join(' · ');
  $<HTMLSelectElement>('md-rank').value = rank;
  $<HTMLInputElement>('md-auto-coupon').checked = m.auto_coupon !== false;

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
  if (allMembers.length === 0) {
    alert('갱신할 연맹원이 없습니다.');
    return;
  }
  if (!confirm(allMembers.length + '명의 프로필을 모두 갱신하시겠습니까?')) return;
  refreshMembersByIds(allMembers.map((m) => m.id));
}

function refreshMembersByIds(memberIds: string[]): void {
  if (!memberIds || memberIds.length === 0) return;
  const idSet: Record<string, boolean> = {};
  memberIds.forEach((id) => (idSet[id] = true));
  const targets = allMembers.filter((m) => idSet[m.id]);
  if (targets.length === 0) return;

  const btn = $<HTMLButtonElement>('btn-refresh-all');
  const originalText = btn.textContent || '전체 갱신';
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
    btn.textContent = '갱신 중 (' + done + '/' + total + ')';
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
    loadMembers();
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
      '<div class="rfb-text"><strong>재시도 중</strong> (' +
      done +
      '/' +
      total +
      ')...</div>';
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
    if (d.names.length > 3) preview += ' 외 ' + (d.names.length - 3) + '명';
    el.innerHTML =
      '<div class="rfb-icon">⚠</div>' +
      '<div class="rfb-text"><strong>갱신 실패 ' +
      d.names.length +
      '명</strong>: ' +
      preview +
      '</div>' +
      '<div class="rfb-actions">' +
      '<button class="btn btn-primary btn-sm" id="rfb-retry">↻ 실패한 멤버만 다시 갱신</button>' +
      '<button class="btn btn-secondary btn-sm" id="rfb-close">닫기</button>' +
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

  // 다이얼로그 핸들러
  const dialogOverlay = $('manage-dialog-overlay');
  dialogOverlay.addEventListener('click', (e) => {
    if (e.target === dialogOverlay) closeDialog();
  });
  $('md-close').addEventListener('click', closeDialog);

  // 다이얼로그: 갱신
  $('md-refresh').addEventListener('click', () => {
    if (!currentDialogId) return;
    const m = membersData[currentDialogId];
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
          }),
      )
      .catch((err: Error) => alert('갱신 실패: ' + err.message))
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
          alert('저장 실패: ' + res.error.message);
          return;
        }
        invalidateAccountsCache();
        closeDialog();
        loadMembers();
      });
  });

  // 다이얼로그: 삭제
  $('md-delete').addEventListener('click', () => {
    if (!currentDialogId) return;
    const m = membersData[currentDialogId];
    if (!m || !confirm(m.nickname + '을(를) 삭제하시겠습니까?')) return;
    sb.from('members')
      .delete()
      .eq('id', currentDialogId)
      .then((res) => {
        if (res.error) {
          alert('삭제 실패: ' + res.error.message);
          return;
        }
        invalidateAccountsCache();
        closeDialog();
        loadMembers();
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
    btn.textContent = '조회 중...';
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
        alert('조회 실패: ' + err.message);
        searchData = null;
        $<HTMLButtonElement>('btn-modal-save').disabled = true;
      })
      .finally(() => {
        btn.textContent = '조회';
        btn.disabled = false;
      });
  });

  // 등록 모달: 저장
  $('btn-modal-save').addEventListener('click', () => {
    if (!searchData) {
      alert('먼저 킹샷 ID를 조회하세요.');
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
            alert('이미 등록된 킹샷 ID입니다.');
          } else {
            alert('저장 실패: ' + res.error.message);
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
            loadMembers();
          });
      });
  });

  // 전체 갱신
  $('btn-refresh-all').addEventListener('click', refreshAllMembers);

  // Esc → 모든 오버레이 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['modal-overlay', 'manage-dialog-overlay'].forEach((id) => {
      const el = document.getElementById(id);
      if (el?.classList.contains('open')) el.classList.remove('open');
    });
  });

  loadMembers();
}

// 전역 노출 — 인라인 onclick 패턴 유지 (Phase 7 에서 이벤트 위임으로 리팩터)
declare global {
  interface Window {
    Members: {
      openDialog: (id: string) => void;
      reload: () => void;
    };
  }
}
window.Members = { openDialog, reload: loadMembers };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPage);
} else {
  initPage();
}
