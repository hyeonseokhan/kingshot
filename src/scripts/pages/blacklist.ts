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
import { bindRefreshButton } from '@/lib/refresh-button';
import { appAlert } from '@/lib/dialog';

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

// 수정 모드에서 entry 의 원본 image_path. 저장 시점에 다음 두 케이스에서 storage 삭제 대상:
//   - 사용자가 새 이미지 첨부 → 교체된 옛 파일
//   - 사용자가 [제거] 클릭 → existingImageRemoved=true 와 함께
let existingImagePath: string | null = null;
// 수정 다이얼로그의 "현재 등록된 이미지 [제거]" 클릭 여부. 저장 시 image_path=NULL 로 PATCH.
let existingImageRemoved = false;

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
  $('bl-copy-id-btn')?.addEventListener('click', copyKingshotId);
  $<HTMLInputElement>('bl-input-image')?.addEventListener('change', onImageSelected);
  $('bl-image-remove')?.addEventListener('click', clearPendingImage);
  $('bl-image-existing-remove')?.addEventListener('click', markExistingImageRemoved);

  $<HTMLInputElement>('bl-search')?.addEventListener('input', (e) => {
    searchTerm = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderList();
  });
  bindRefreshButton('bl-refresh-btn', loadEntriesPromise);

  // 이미지 보기 lightbox — 아무 곳(이미지 포함) 클릭 시 닫힘 (KvK 가속권 가이드 패턴 동일)
  $('bl-image-dialog')?.addEventListener('click', () => {
    ($('bl-image-dialog') as HTMLDialogElement | null)?.close();
  });

  // 행 위임 (수정/삭제 버튼, 이미지 아이콘)
  $('bl-tbody')?.addEventListener('click', onRowClick);

  onLangChange(() => renderList());
  loadEntries();
}

// ===== 데이터 로드 =====

function loadEntries(): void {
  void loadEntriesPromise();
}

/** 갱신 버튼 등에서 await 가능한 형태. 결과는 entries 에 저장 + renderList. */
function loadEntriesPromise(): Promise<void> {
  return fetch(REST_BASE + '/blacklist?select=*&order=created_at.desc', {
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
}

// ===== 행 클릭 (이벤트 위임) =====

function onRowClick(ev: Event): void {
  const target = ev.target as HTMLElement;
  const row = target.closest<HTMLTableRowElement>('.bl-row');
  if (!row) return;
  const entry = entries.find((e) => e.id === row.dataset.id);
  if (!entry) return;

  // 이미지 버튼 클릭 — image_path 있을 때만 lightbox, 없으면 fall through 해서 상세 다이얼로그
  const imgBtn = target.closest<HTMLElement>('[data-action="image"]');
  if (imgBtn && entry.image_path) {
    showImageDialog(entry.image_path);
    return;
  }
  // 행 어디든 클릭 → 상세 다이얼로그 (구 ✏️ 버튼 대체)
  openEditModal(entry);
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
  setText('bl-search-btn', t('blacklist.modal.searchButton'));
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
  // 수정 모드: ID 는 변경 불가, 조회 → 갱신 (재조회로 player info 최신화).
  setText('bl-search-btn', t('blacklist.modal.refreshButton'));
  ($('bl-modal-delete')!).style.display = '';

  $<HTMLInputElement>('bl-input-id')!.value = entry.kingshot_id;
  $<HTMLInputElement>('bl-input-id')!.disabled = true;
  $<HTMLInputElement>('bl-input-note')!.value = entry.note || '';
  renderPreview(lookupResult);

  // 현재 저장 이미지가 있으면 썸네일 + [제거] 영역 노출
  if (entry.image_path) {
    existingImagePath = entry.image_path;
    const img = $<HTMLImageElement>('bl-image-existing-img');
    if (img) img.src = storageUrl(entry.image_path);
    ($('bl-image-existing') as HTMLElement).style.display = '';
  }

  $('bl-modal-overlay')!.classList.add('open');
}

/** 수정 다이얼로그의 "현재 등록된 이미지 [제거]" 클릭 핸들러.
 *  실제 storage 삭제는 저장 시점에 (취소 시 되돌릴 수 있도록 의도만 마킹). */
function markExistingImageRemoved(): void {
  existingImageRemoved = true;
  ($('bl-image-existing') as HTMLElement).style.display = 'none';
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
  existingImagePath = null;
  existingImageRemoved = false;
  $<HTMLInputElement>('bl-input-id')!.value = '';
  $<HTMLInputElement>('bl-input-id')!.disabled = false;
  $<HTMLInputElement>('bl-input-note')!.value = '';
  $<HTMLInputElement>('bl-input-image')!.value = '';
  ($('bl-preview') as HTMLElement).style.display = 'none';
  ($('bl-image-status') as HTMLElement).style.display = 'none';
  ($('bl-image-existing') as HTMLElement).style.display = 'none';
}

// ===== 복사 (킹샷 ID) =====

async function copyKingshotId(): Promise<void> {
  const id = $<HTMLInputElement>('bl-input-id')?.value.trim();
  if (!id) return;
  const btn = $<HTMLButtonElement>('bl-copy-id-btn');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    // 권한 없거나 비-https 등 — fallback (legacy execCommand)
    try {
      const ta = document.createElement('textarea');
      ta.value = id;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch {
      return; // 둘 다 실패 시 silent
    }
  }
  // 시각 피드백 — 버튼 라벨 1초간 "복사됨" 으로 swap
  const original = btn.textContent || '';
  btn.textContent = t('blacklist.modal.copyIdDone');
  btn.disabled = true;
  window.setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1000);
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

  // 라벨은 모드별 분기 — 등록: 조회/조회중, 수정: 갱신/갱신중.
  const inProgressKey = editingId ? 'blacklist.modal.refreshingButton' : 'blacklist.modal.searchingButton';
  setText('bl-search-btn', t(inProgressKey));
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
      // 외부 API 의 raw msg ("Sign Error" 등) 노출 금지 — 사용자 친화 메시지로 매핑.
      const isNotFound = /not.*exist|not.*found/i.test(err.message);
      appAlert(t(isNotFound ? 'common.playerLookupNotFound' : 'common.playerLookupFailed'));
    })
    .finally(() => {
      const idleKey = editingId ? 'blacklist.modal.refreshButton' : 'blacklist.modal.searchButton';
      setText('bl-search-btn', t(idleKey));
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
    // 새 파일을 골랐다는 건 기존 이미지를 교체할 의도 → 기존 영역 숨김. 저장 시 옛 storage 삭제는 submitForm 이 처리.
    ($('bl-image-existing') as HTMLElement).style.display = 'none';
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
  // 새 파일 선택을 취소 → 기존 이미지가 있고 사용자가 명시적으로 제거하지 않았다면 다시 표시 (이미지 유지로 되돌림).
  if (existingImagePath && !existingImageRemoved) {
    ($('bl-image-existing') as HTMLElement).style.display = '';
  }
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
    let newImagePath: string | null = null;
    if (pendingImageBlob) {
      newImagePath = await uploadImage(pendingImageBlob, lookupResult.kingshot_id);
    }

    if (editingId) {
      // 수정 케이스 4종:
      //   (a) 새 이미지 첨부              → image_path = newImagePath, 기존 storage 삭제
      //   (b) 기존 이미지 제거만           → image_path = NULL,        기존 storage 삭제
      //   (c) 새 첨부 + 기존 제거         → (a) 와 동일 (제거 의도는 새것으로 덮임)
      //   (d) 이미지 변경 없음            → patch 에서 image_path 생략 (보존)
      // player 필드(nickname/avatar_url/kingdom) 도 PATCH 에 포함 — "갱신" 후 저장 시
      // 최신값 반영. 갱신 안 했어도 lookupResult 는 entry 원본값으로 채워져있어 안전 (no-op).
      const patch: Record<string, unknown> = {
        nickname: lookupResult.nickname,
        avatar_url: lookupResult.avatar_url,
        kingdom: lookupResult.kingdom,
        note: note || null,
      };
      if (newImagePath) {
        patch.image_path = newImagePath;
      } else if (existingImageRemoved) {
        patch.image_path = null;
      }
      const res = await fetch(
        REST_BASE + '/blacklist?id=eq.' + encodeURIComponent(editingId),
        {
          method: 'PATCH',
          headers: { ...restJsonHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // DB PATCH 성공 후에만 storage 정리 (PATCH 실패 시 기존 파일 보존). 실패해도 row 변경은 살림.
      if (existingImagePath && (newImagePath || existingImageRemoved)) {
        await deleteStorageObject(existingImagePath).catch(() => {});
      }
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
          image_path: newImagePath,
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
      await deleteStorageObject(entry.image_path).catch(() => {});
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
  // 파일명: {kingshot_id}-{timestamp}.webp — 충돌 방지 + 디버깅 용이.
  // optimizeImage 가 모든 환경에서 WebP 보장 (네이티브 미지원 시 WASM 폴백).
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

/** Storage 의 단일 객체 삭제. 호출자가 .catch(() => {}) 로 무시할 수 있도록 promise 반환. */
async function deleteStorageObject(path: string): Promise<void> {
  const res = await fetch(STORAGE_BASE + '/object/' + BUCKET + '/' + path, {
    method: 'DELETE',
    headers: restHeaders,
  });
  if (!res.ok) throw new Error('storage delete ' + res.status);
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
