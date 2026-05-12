/**
 * 블랙리스트 페이지 클라 로직.
 *
 * 데이터 흐름:
 *   - 로드: GET /rest/v1/blacklist (anon, RLS SELECT public)
 *   - 등록: ID → /functions/v1/redeem-coupon (player) 로 nickname/avatar 조회
 *           → (선택) Canvas 로 이미지 1080@WebP q80 변환 → Storage 업로드
 *           → POST /rest/v1/blacklist
 *   - 수정/삭제: PATCH/DELETE 동일 endpoint. 권한은 클라에서 검증
 *               (admin 또는 created_by === 로그인 사용자 kingshot_id).
 *
 * 권한 체크는 UI 가드 — service_role 분리는 후속 작업.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import { t, onLangChange } from '@/i18n';
import { getSession, isAdminSession } from '@/scripts/pages/tile-match-auth';
import { optimizeImage, formatBytes } from '@/lib/image-optimize';
import { patchList, patchText } from '@/lib/dom-diff';
import { esc } from '@/lib/utils';

const REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
const REST_BASE = SUPABASE_URL + '/rest/v1';
const STORAGE_BASE = SUPABASE_URL + '/storage/v1';
const BUCKET = 'blacklist-evidence';

const restHeaders: Record<string, string> = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
};
const restJsonHeaders: Record<string, string> = {
  ...restHeaders,
  'Content-Type': 'application/json',
};

interface BlacklistEntry {
  id: string;
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  kingdom: number | null;
  note: string | null;
  image_path: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface PlayerLookup {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  kingdom: number | null;
}

let entries: BlacklistEntry[] = [];
let searchTerm = '';
let initialized = false;

let editingId: string | null = null;
let lookupResult: PlayerLookup | null = null;
let pendingImageBlob: Blob | null = null;
let pendingImageOriginalSize = 0;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

export function initBlacklist(): void {
  if (initialized) return;
  initialized = true;

  $('bl-add-btn')?.addEventListener('click', openAddModal);
  $('bl-modal-close')?.addEventListener('click', closeModal);
  $('bl-modal-cancel')?.addEventListener('click', closeModal);
  $('bl-modal-submit')?.addEventListener('click', submitForm);
  $('bl-modal-delete')?.addEventListener('click', handleDelete);
  $('bl-search-btn')?.addEventListener('click', searchPlayer);
  $<HTMLInputElement>('bl-input-id')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchPlayer();
  });
  $<HTMLInputElement>('bl-input-image')?.addEventListener('change', onImageSelected);
  $('bl-image-remove')?.addEventListener('click', clearPendingImage);

  $<HTMLInputElement>('bl-search')?.addEventListener('input', (e) => {
    searchTerm = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderList();
  });
  $('bl-refresh-btn')?.addEventListener('click', () => loadEntries({ showLoading: true }));

  // 이미지 보기 다이얼로그
  $('bl-image-dialog-close')?.addEventListener('click', () => {
    ($('bl-image-dialog') as HTMLDialogElement | null)?.close();
  });

  // 행 위임 (수정/삭제 버튼, 이미지 아이콘)
  $('bl-tbody')?.addEventListener('click', onRowClick);

  onLangChange(() => renderList());
  loadEntries();
}

// ===== 데이터 로드 =====

function loadEntries(opts: { showLoading?: boolean } = {}): void {
  const refreshBtn = $<HTMLButtonElement>('bl-refresh-btn');
  if (opts.showLoading && refreshBtn) refreshBtn.disabled = true;
  fetch(REST_BASE + '/blacklist?select=*&order=created_at.desc', {
    headers: restHeaders,
  })
    .then((r) => r.json())
    .then((rows: BlacklistEntry[]) => {
      entries = Array.isArray(rows) ? rows : [];
      renderList();
    })
    .catch(() => {
      entries = [];
      renderList();
    })
    .finally(() => {
      if (refreshBtn) refreshBtn.disabled = false;
    });
}

// ===== 렌더 =====

function getFiltered(): BlacklistEntry[] {
  if (!searchTerm) return entries;
  return entries.filter(
    (e) =>
      e.nickname.toLowerCase().includes(searchTerm) ||
      e.kingshot_id.toLowerCase().includes(searchTerm),
  );
}

function renderList(): void {
  const filtered = getFiltered();
  const tbody = $('bl-tbody');
  const empty = $('bl-empty');
  const count = $('bl-count');

  if (count) {
    count.textContent =
      searchTerm
        ? t('blacklist.countSearch', { found: filtered.length, total: entries.length })
        : t('blacklist.count', { n: entries.length });
  }

  if (!tbody) return;
  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (empty) {
      empty.style.display = '';
      empty.textContent = entries.length === 0
        ? t('blacklist.empty.noEntries')
        : t('blacklist.empty.noSearch');
    }
    return;
  }
  if (empty) empty.style.display = 'none';

  patchList({
    container: tbody,
    items: filtered,
    key: (e) => e.id,
    render: createRow,
    update: (el, e) => updateRow(el as HTMLTableRowElement, e),
  });
}

function createRow(e: BlacklistEntry): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'bl-row';
  row.innerHTML = `
    <td class="bl-td-avatar"><div class="bl-avatar"><img class="bl-avatar-img" alt=""/><span class="bl-avatar-empty"></span></div></td>
    <td class="bl-td-name"></td>
    <td class="bl-td-kingdom"></td>
    <td class="bl-td-id"></td>
    <td class="bl-td-note"></td>
    <td class="bl-td-image">
      <button class="bl-icon-btn" data-action="image" type="button" title="" aria-label="">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      </button>
    </td>
    <td class="bl-td-actions">
      <button class="bl-icon-btn" data-action="edit" type="button" title="" aria-label="">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
        </svg>
      </button>
    </td>
  `;
  // patchList 의 render 콜백은 신규 element 생성에만 호출되고 update 는 안 호출됨.
  // 첫 렌더 시 셀 데이터가 비어있는 문제 차단을 위해 createRow 안에서 updateRow 직접 호출
  // (members.ts 패턴 동일).
  updateRow(row, e);
  return row;
}

function updateRow(row: HTMLTableRowElement, e: BlacklistEntry): void {
  row.dataset.id = e.id;
  row.dataset.kingshotId = e.kingshot_id;
  row.dataset.createdBy = e.created_by ?? '';

  const img = row.querySelector<HTMLImageElement>('.bl-avatar-img')!;
  const emptyEl = row.querySelector<HTMLElement>('.bl-avatar-empty')!;
  if (e.avatar_url) {
    img.src = e.avatar_url;
    img.style.display = '';
    emptyEl.style.display = 'none';
  } else {
    img.style.display = 'none';
    emptyEl.style.display = '';
    emptyEl.textContent = (e.nickname || '?').charAt(0).toUpperCase();
  }

  patchText(row.querySelector<HTMLElement>('.bl-td-name'), e.nickname);
  patchText(
    row.querySelector<HTMLElement>('.bl-td-kingdom'),
    e.kingdom != null ? '#' + e.kingdom : '-',
  );
  patchText(row.querySelector<HTMLElement>('.bl-td-id'), e.kingshot_id);
  patchText(row.querySelector<HTMLElement>('.bl-td-note'), e.note || '-');

  const imgBtn = row.querySelector<HTMLButtonElement>('[data-action="image"]')!;
  if (e.image_path) {
    imgBtn.disabled = false;
    imgBtn.title = t('blacklist.badge.hasImage');
    imgBtn.setAttribute('aria-label', t('blacklist.badge.hasImage'));
  } else {
    imgBtn.disabled = true;
    imgBtn.title = t('blacklist.badge.noImage');
    imgBtn.setAttribute('aria-label', t('blacklist.badge.noImage'));
  }
  const editBtn = row.querySelector<HTMLButtonElement>('[data-action="edit"]')!;
  editBtn.title = t('blacklist.modal.editTitle');
  editBtn.setAttribute('aria-label', t('blacklist.modal.editTitle'));
}

// ===== 행 클릭 (이벤트 위임) =====

function onRowClick(ev: Event): void {
  const target = ev.target as HTMLElement;
  const btn = target.closest<HTMLElement>('[data-action]');
  if (!btn) return;
  const row = btn.closest<HTMLTableRowElement>('.bl-row');
  if (!row) return;
  const id = row.dataset.id!;
  const action = btn.dataset.action;

  if (action === 'image') {
    const entry = entries.find((e) => e.id === id);
    if (entry?.image_path) showImageDialog(entry.image_path);
  } else if (action === 'edit') {
    const entry = entries.find((e) => e.id === id);
    if (entry) openEditModal(entry);
  }
}

function showImageDialog(path: string): void {
  const dlg = $('bl-image-dialog') as HTMLDialogElement | null;
  const img = $<HTMLImageElement>('bl-image-dialog-img');
  if (!dlg || !img) return;
  img.src = storageUrl(path);
  dlg.showModal();
}

// ===== 모달 — 등록 / 수정 =====

function openAddModal(): void {
  if (!requireLogin()) return;
  resetModal();
  editingId = null;
  setText('bl-modal-title', t('blacklist.modal.addTitle'));
  setText('bl-modal-submit', t('blacklist.modal.submit'));
  ($('bl-modal-delete')!).style.display = 'none';
  $('bl-modal-overlay')!.classList.add('open');
}

function openEditModal(entry: BlacklistEntry): void {
  if (!requireLogin()) return;
  if (!canModify(entry)) {
    alert(t('blacklist.msg.noPermission'));
    return;
  }
  resetModal();
  editingId = entry.id;
  lookupResult = {
    kingshot_id: entry.kingshot_id,
    nickname: entry.nickname,
    avatar_url: entry.avatar_url,
    kingdom: entry.kingdom,
  };
  setText('bl-modal-title', t('blacklist.modal.editTitle'));
  setText('bl-modal-submit', t('blacklist.modal.submitEdit'));
  ($('bl-modal-delete')!).style.display = '';

  $<HTMLInputElement>('bl-input-id')!.value = entry.kingshot_id;
  $<HTMLInputElement>('bl-input-id')!.disabled = true;
  $<HTMLInputElement>('bl-input-note')!.value = entry.note || '';
  renderPreview(lookupResult);

  $('bl-modal-overlay')!.classList.add('open');
}

function closeModal(): void {
  $('bl-modal-overlay')!.classList.remove('open');
  resetModal();
}

function resetModal(): void {
  editingId = null;
  lookupResult = null;
  pendingImageBlob = null;
  pendingImageOriginalSize = 0;
  $<HTMLInputElement>('bl-input-id')!.value = '';
  $<HTMLInputElement>('bl-input-id')!.disabled = false;
  $<HTMLInputElement>('bl-input-note')!.value = '';
  $<HTMLInputElement>('bl-input-image')!.value = '';
  ($('bl-preview') as HTMLElement).style.display = 'none';
  ($('bl-image-status') as HTMLElement).style.display = 'none';
}

// ===== player 조회 =====

function searchPlayer(): void {
  const id = $<HTMLInputElement>('bl-input-id')!.value.trim();
  if (!/^\d{4,15}$/.test(id)) {
    alert(t('blacklist.msg.needSearch'));
    return;
  }
  // 중복 체크 (등록 모드에서만)
  if (!editingId && entries.some((e) => e.kingshot_id === id)) {
    alert(t('blacklist.msg.duplicate'));
    return;
  }

  setText('bl-search-btn', t('blacklist.modal.searchingButton'));
  ($('bl-search-btn') as HTMLButtonElement).disabled = true;

  fetch(REDEEM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'player', fid: id }),
  })
    .then((r) => r.json())
    .then((json) => {
      if (json.code !== 0 || !json.data) throw new Error(json.msg || t('blacklist.msg.apiSearchFailed'));
      lookupResult = {
        kingshot_id: String(json.data.fid),
        nickname: json.data.nickname,
        avatar_url: json.data.avatar_image ?? null,
        kingdom: json.data.kid ?? null,
      };
      renderPreview(lookupResult);
    })
    .catch((err: Error) => {
      alert(err.message || t('blacklist.msg.apiSearchFailed'));
    })
    .finally(() => {
      setText('bl-search-btn', t('blacklist.modal.searchButton'));
      ($('bl-search-btn') as HTMLButtonElement).disabled = false;
    });
}

function renderPreview(p: PlayerLookup): void {
  const img = $<HTMLImageElement>('bl-preview-img')!;
  if (p.avatar_url) {
    img.src = p.avatar_url;
    img.style.display = '';
  } else {
    img.style.display = 'none';
  }
  setText('bl-preview-name', p.nickname);
  setText('bl-preview-kingdom', p.kingdom != null ? '#' + p.kingdom : '-');
  $('bl-preview')!.style.display = '';
}

// ===== 이미지 선택 + 최적화 =====

async function onImageSelected(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  pendingImageOriginalSize = file.size;
  try {
    const result = await optimizeImage(file, { maxWidth: 1080, quality: 0.80, mimeType: 'image/webp' });
    pendingImageBlob = result.blob;
    showImageStatus(result.bytes);
  } catch (err) {
    alert(t('blacklist.msg.imageFailed', { message: (err as Error).message }));
    clearPendingImage();
  }
}

function showImageStatus(optimizedBytes: number): void {
  const wrap = $('bl-image-status')!;
  wrap.style.display = '';
  const meta = $('bl-image-meta')!;
  const percent = pendingImageOriginalSize > 0
    ? Math.round((1 - optimizedBytes / pendingImageOriginalSize) * 100)
    : 0;
  meta.innerHTML =
    '<div>' + esc(t('blacklist.modal.imageOriginal', { size: formatBytes(pendingImageOriginalSize) })) + '</div>' +
    '<div>' + esc(t('blacklist.modal.imageOptimized', { size: formatBytes(optimizedBytes), percent })) + '</div>';
  // 썸네일
  const thumb = $<HTMLImageElement>('bl-image-thumb-img')!;
  if (pendingImageBlob) thumb.src = URL.createObjectURL(pendingImageBlob);
}

function clearPendingImage(): void {
  pendingImageBlob = null;
  pendingImageOriginalSize = 0;
  $<HTMLInputElement>('bl-input-image')!.value = '';
  ($('bl-image-status') as HTMLElement).style.display = 'none';
}

// ===== 제출 (등록 / 수정) =====

async function submitForm(): Promise<void> {
  if (!requireLogin()) return;
  if (!lookupResult) {
    alert(t('blacklist.msg.needSearch'));
    return;
  }
  const note = $<HTMLInputElement>('bl-input-note')!.value.trim();
  const session = getSession()!;

  ($('bl-modal-submit') as HTMLButtonElement).disabled = true;

  try {
    let imagePath: string | null = null;
    if (pendingImageBlob) {
      imagePath = await uploadImage(pendingImageBlob, lookupResult.kingshot_id);
    }

    if (editingId) {
      // 수정: 기존 image_path 보존 OR 새 업로드면 갱신, 제거 의도 별도 미구현
      const patch: Record<string, unknown> = { note: note || null };
      if (imagePath) patch.image_path = imagePath;
      const res = await fetch(
        REST_BASE + '/blacklist?id=eq.' + encodeURIComponent(editingId),
        {
          method: 'PATCH',
          headers: { ...restJsonHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } else {
      const res = await fetch(REST_BASE + '/blacklist', {
        method: 'POST',
        headers: { ...restJsonHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          kingshot_id: lookupResult.kingshot_id,
          nickname: lookupResult.nickname,
          avatar_url: lookupResult.avatar_url,
          kingdom: lookupResult.kingdom,
          note: note || null,
          image_path: imagePath,
          created_by: session.player_id,
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    }

    closeModal();
    loadEntries();
  } catch (err) {
    alert(t('blacklist.msg.saveFailed', { message: (err as Error).message }));
  } finally {
    ($('bl-modal-submit') as HTMLButtonElement).disabled = false;
  }
}

// ===== 삭제 =====

async function handleDelete(): Promise<void> {
  if (!editingId) return;
  const entry = entries.find((e) => e.id === editingId);
  if (!entry) return;
  if (!canModify(entry)) {
    alert(t('blacklist.msg.noPermission'));
    return;
  }
  if (!confirm(t('blacklist.confirm.delete', { name: entry.nickname }))) return;

  try {
    if (entry.image_path) {
      // 첨부 이미지도 삭제 — 실패해도 row 삭제는 진행
      await fetch(STORAGE_BASE + '/object/' + BUCKET + '/' + entry.image_path, {
        method: 'DELETE',
        headers: restHeaders,
      }).catch(() => {});
    }
    const res = await fetch(
      REST_BASE + '/blacklist?id=eq.' + encodeURIComponent(entry.id),
      { method: 'DELETE', headers: restHeaders },
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    closeModal();
    loadEntries();
  } catch (err) {
    alert(t('blacklist.msg.deleteFailed', { message: (err as Error).message }));
  }
}

// ===== Storage 업로드 =====

async function uploadImage(blob: Blob, kingshotId: string): Promise<string> {
  // 파일명: {kingshot_id}-{timestamp}.webp — 충돌 방지 + 디버깅 용이
  const path = kingshotId + '-' + Date.now() + '.webp';
  const url = STORAGE_BASE + '/object/' + BUCKET + '/' + encodeURIComponent(path);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...restHeaders,
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000',
    },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(t('blacklist.msg.uploadFailed', { message: 'HTTP ' + res.status + ' ' + text.slice(0, 80) }));
  }
  return path;
}

function storageUrl(path: string): string {
  // public bucket → /object/public/<bucket>/<path>
  return STORAGE_BASE + '/object/public/' + BUCKET + '/' + path;
}

// ===== 헬퍼 =====

function requireLogin(): boolean {
  if (!getSession()?.player_id) {
    alert(t('blacklist.msg.needLogin'));
    return false;
  }
  return true;
}

function canModify(entry: BlacklistEntry): boolean {
  const s = getSession();
  if (!s) return false;
  if (isAdminSession(s)) return true;
  return entry.created_by === s.player_id;
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}
