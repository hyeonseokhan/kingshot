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

import { t, onLangChange } from '@/i18n';
import { getSession, isAdminSession } from '@/scripts/pages/tile-match-auth';
import { optimizeImage, formatBytes } from '@/lib/image-optimize';
import { patchList, patchText } from '@/lib/dom-diff';
import { esc } from '@/lib/utils';
import { bindRefreshButton } from '@/lib/refresh-button';
import { appAlert, appConfirm } from '@/lib/dialog';
import { lookupPlayer } from '@/lib/api/centurygame';
import { bindPlayerSearchModal } from '@/lib/player-search-modal';
import { REST_BASE, STORAGE_BASE, restHeaders, restJsonHeaders } from '@/lib/supabase-rest';
import { runBatched } from '@/lib/batch';

const BUCKET = 'blacklist-evidence';

// 외부 centurygame API rate limit 고려해 5명씩 묶고 배치 사이 1s delay.
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES = 1000;

interface BlacklistEntry {
  id: string;
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  kingdom: number | null;
  level: number | null;
  note: string | null;
  image_path: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface LookupResult {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  kingdom: number | null;
  level: number | null;
}

let entries: BlacklistEntry[] = [];
let searchTerm = '';
let initialized = false;

let editingId: string | null = null;
let lookupResult: LookupResult | null = null;
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
  bindSearchModal();
  $('bl-copy-id-btn')?.addEventListener('click', copyKingshotId);
  $<HTMLInputElement>('bl-input-image')?.addEventListener('change', onImageSelected);
  $('bl-image-remove')?.addEventListener('click', clearPendingImage);
  $('bl-image-existing-remove')?.addEventListener('click', markExistingImageRemoved);

  $<HTMLInputElement>('bl-search')?.addEventListener('input', (e) => {
    searchTerm = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderList();
  });
  bindRefreshButton('bl-refresh-btn', refreshAllPlayerInfo);

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

// ===== 일괄 갱신 — 모든 entry 의 player 프로필을 외부 API 에서 재조회 후 DB 업데이트 =====
// coupons.ts 의 refreshAllExtras 와 동일 흐름. 5명씩 묶어 Promise.all,
// 배치 사이 1s delay 로 rate limit 보호.

async function refreshAllPlayerInfo(): Promise<void> {
  // 0건이면 단순 reload (entries 비어있을 수 있어 우선 한 번 fetch)
  if (entries.length === 0) {
    await loadEntriesPromise();
    if (entries.length === 0) return;
  }

  const ok = await appConfirm(t('blacklist.refreshAll.confirm', { n: entries.length }));
  if (!ok) return;

  const stats = { success: 0, failed: 0 };

  await runBatched({
    items: entries,
    batchSize: BATCH_SIZE,
    delayMs: DELAY_BETWEEN_BATCHES,
    handler: (e) => refreshSingleEntry(e, stats),
  });

  // DB 변경분 반영을 위해 entries 재로드 + 렌더
  await loadEntriesPromise();

  if (stats.failed === 0) {
    await appAlert(t('blacklist.refreshAll.done', { n: stats.success }));
  } else {
    await appAlert(
      t('blacklist.refreshAll.partial', { ok: stats.success, fail: stats.failed }),
    );
  }
}

function refreshSingleEntry(
  e: BlacklistEntry,
  stats: { success: number; failed: number },
): Promise<void> {
  return lookupPlayer(e.kingshot_id)
    .then((data) => {
      const patch = {
        nickname: data.nickname,
        avatar_url: data.avatarUrl,
        kingdom: data.kingdom,
        level: data.level || null,
      };
      return fetch(REST_BASE + '/blacklist?id=eq.' + encodeURIComponent(e.id), {
        method: 'PATCH',
        headers: { ...restJsonHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
    })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      stats.success++;
    })
    .catch(() => {
      stats.failed++;
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
    <td class="bl-td-level"></td>
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
    row.querySelector<HTMLElement>('.bl-td-level'),
    e.level != null ? 'Lv.' + e.level : '-',
  );
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
  // 같은 <img> 재사용이라 src 만 바꾸면 새 이미지 로드 중에 "이전 이미지" 가 잠깐 보임.
  // (1) 이전 src 비우기 → 이전 픽셀 즉시 제거
  // (2) opacity 0 으로 시작해 다이얼로그 열기 → 빈 영역만 보임
  // (3) onload 시 .loaded 클래스로 fade-in → 새 이미지가 자연스럽게 등장
  img.classList.remove('loaded');
  img.removeAttribute('src');
  dlg.showModal();
  img.onload = () => img.classList.add('loaded');
  img.src = storageUrl(path);
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
    appAlert(t('blacklist.msg.noPermission'));
    return;
  }
  resetModal();
  editingId = entry.id;
  lookupResult = {
    kingshot_id: entry.kingshot_id,
    nickname: entry.nickname,
    avatar_url: entry.avatar_url,
    kingdom: entry.kingdom,
    level: entry.level,
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

// ===== player 조회 — bindPlayerSearchModal 컨트롤러 사용 =====
//
// blacklist 는 등록/수정 양쪽 모드를 같은 모달이 공유 — 버튼 라벨이 모드별 분기.
// modal 컨트롤러는 클릭 흐름만 흡수, 저장은 별도 (submitForm). saveBtnId 미지정.
// 모드 전환 시 button text 는 openAddModal/openEditModal 에서 직접 set.

function bindSearchModal(): void {
  bindPlayerSearchModal({
    overlayId: 'bl-modal-overlay',
    inputId: 'bl-input-id',
    searchBtnId: 'bl-search-btn',
    searchingButtonText: () =>
      t(editingId ? 'blacklist.modal.refreshingButton' : 'blacklist.modal.searchingButton'),
    searchButtonText: () =>
      t(editingId ? 'blacklist.modal.refreshButton' : 'blacklist.modal.searchButton'),
    beforeSearch: (id) => {
      if (!/^\d{4,15}$/.test(id)) {
        appAlert(t('blacklist.msg.needSearch'));
        return false;
      }
      // 중복 체크 (등록 모드에서만)
      if (!editingId && entries.some((e) => e.kingshot_id === id)) {
        appAlert(t('blacklist.msg.duplicate'));
        return false;
      }
      return true;
    },
    onPreview: (data) => {
      lookupResult = {
        kingshot_id: data.kingshotId,
        nickname: data.nickname,
        avatar_url: data.avatarUrl,
        kingdom: data.kingdom !== null ? Number(data.kingdom) : null,
        level: data.level || null,
      };
      renderPreview(lookupResult);
    },
    onReset: () => {
      // resetModal() 이 별도로 lookupResult 와 preview 처리 — 여기선 no-op
    },
  });
}

function renderPreview(p: LookupResult): void {
  const img = $<HTMLImageElement>('bl-preview-img')!;
  if (p.avatar_url) {
    img.src = p.avatar_url;
    img.style.display = '';
  } else {
    img.style.display = 'none';
  }
  setText('bl-preview-name', p.nickname);
  setText('bl-preview-level', p.level != null ? 'Lv.' + p.level : '-');
  setText('bl-preview-kingdom', p.kingdom != null ? '#' + p.kingdom : '-');
  $('bl-preview')!.style.display = '';
}

// ===== 이미지 선택 + 최적화 =====

async function onImageSelected(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  pendingImageOriginalSize = file.size;
  try {
    const result = await optimizeImage(file, { maxWidth: 1080, quality: 0.80 });
    pendingImageBlob = result.blob;
    showImageStatus(result.bytes);
    // 새 파일을 골랐다는 건 기존 이미지를 교체할 의도 → 기존 영역 숨김. 저장 시 옛 storage 삭제는 submitForm 이 처리.
    ($('bl-image-existing') as HTMLElement).style.display = 'none';
  } catch (err) {
    await appAlert(t('blacklist.msg.imageFailed', { message: (err as Error).message }));
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
    await appAlert(t('blacklist.msg.needSearch'));
    return;
  }
  const note = $<HTMLInputElement>('bl-input-note')!.value.trim();

  ($('bl-modal-submit') as HTMLButtonElement).disabled = true;

  try {
    let newImagePath: string | null = null;
    if (pendingImageBlob) {
      newImagePath = await uploadImage(pendingImageBlob, lookupResult.kingshot_id);
    }

    if (editingId) {
      await updateEntry(editingId, lookupResult, note, newImagePath);
    } else {
      await createEntry(lookupResult, note, newImagePath);
    }

    closeModal();
    loadEntries();
  } catch (err) {
    await appAlert(t('blacklist.msg.saveFailed', { message: (err as Error).message }));
  } finally {
    ($('bl-modal-submit') as HTMLButtonElement).disabled = false;
  }
}

/**
 * 기존 entry 수정. 이미지 4 케이스:
 *   (a) 새 이미지 첨부              → image_path = newImagePath, 기존 storage 삭제
 *   (b) 기존 이미지 제거만           → image_path = NULL,        기존 storage 삭제
 *   (c) 새 첨부 + 기존 제거         → (a) 와 동일 (제거 의도는 새것으로 덮임)
 *   (d) 이미지 변경 없음            → patch 에서 image_path 생략 (보존)
 * player 필드(nickname/avatar_url/kingdom/level) 도 PATCH 에 포함 — "갱신" 후 저장 시
 * 최신값 반영. 갱신 안 했어도 lookupResult 는 entry 원본값으로 채워져있어 안전 (no-op).
 */
async function updateEntry(
  id: string,
  data: LookupResult,
  note: string,
  newImagePath: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    nickname: data.nickname,
    avatar_url: data.avatar_url,
    kingdom: data.kingdom,
    level: data.level,
    note: note || null,
  };
  if (newImagePath) {
    patch.image_path = newImagePath;
  } else if (existingImageRemoved) {
    patch.image_path = null;
  }
  const res = await fetch(
    REST_BASE + '/blacklist?id=eq.' + encodeURIComponent(id),
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
}

async function createEntry(
  data: LookupResult,
  note: string,
  newImagePath: string | null,
): Promise<void> {
  const session = getSession()!;
  const res = await fetch(REST_BASE + '/blacklist', {
    method: 'POST',
    headers: { ...restJsonHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      kingshot_id: data.kingshot_id,
      nickname: data.nickname,
      avatar_url: data.avatar_url,
      kingdom: data.kingdom,
      level: data.level,
      note: note || null,
      image_path: newImagePath,
      created_by: session.player_id,
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

// ===== 삭제 =====

async function handleDelete(): Promise<void> {
  if (!editingId) return;
  const entry = entries.find((e) => e.id === editingId);
  if (!entry) return;
  if (!canModify(entry)) {
    await appAlert(t('blacklist.msg.noPermission'));
    return;
  }
  if (!(await appConfirm(t('blacklist.confirm.delete', { name: entry.nickname }), { variant: 'danger' }))) return;

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
    await appAlert(t('blacklist.msg.deleteFailed', { message: (err as Error).message }));
  }
}

// ===== Storage 업로드 =====

async function uploadImage(blob: Blob, kingshotId: string): Promise<string> {
  // 파일명: {kingshot_id}-{timestamp}.{webp|jpg} — 충돌 방지 + 디버깅 용이.
  // 네이티브 WebP 인코딩 미지원 환경 (iOS 14 이하) 은 JPEG 폴백 → blob.type 으로 분기.
  const isJpeg = blob.type === 'image/jpeg';
  const ext = isJpeg ? 'jpg' : 'webp';
  const contentType = isJpeg ? 'image/jpeg' : 'image/webp';
  const path = kingshotId + '-' + Date.now() + '.' + ext;
  const url = STORAGE_BASE + '/object/' + BUCKET + '/' + encodeURIComponent(path);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...restHeaders,
      'Content-Type': contentType,
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
    appAlert(t('blacklist.msg.needLogin'));
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
