/**
 * 타일 매치 미니게임 — tile-match.js 의 TypeScript 이식.
 * 절차적 보드 생성 + 모바일 viewport 동기화 + ResizeObserver 자동 스케일.
 *
 * 의존: tile-match-auth.ts (window.TileMatchAuth) — 인증 + 멤버 캐시.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import { rewardForStage } from '@/lib/balance';
import { renderRankingTable, type Column, type RankItem } from '@/lib/ranking-table';
import { membersStore, fetchMembers } from '@/lib/stores/members';

// ===== 상수 =====

const TILE_SHAPES = [
  '🐶', '🐱', '🐰', '🐻', '🐼', '🦁', '🐯', '🐸',
  '🐵', '🐔', '🐧', '🐦', '🐢', '🐍', '🐠', '🐳',
];

const CELL_W = 22;
const CELL_H = 27;
const CELL_DEPTH = 7;
const BUFFER_SIZE = 7;
const MATCH_COUNT = 3;
const REMOVE_QUEUE_SIZE = 3;
const INITIAL_FREE_USES = { remove: 1, undo: 1, shuffle: 1 };

const FN_AUTH_URL = SUPABASE_URL + '/functions/v1/tile-match-auth';
const FN_ECONOMY_URL = SUPABASE_URL + '/functions/v1/economy';

// ===== 상태 =====

interface Tile {
  id: number;
  value: number;
  layer: number;
  col: number;
  row: number;
  removed: boolean;
  el: HTMLElement | null;
}

interface LayerSpec {
  layer: number;
  tiles: Array<{ colIndex: number; rowIndex: number; layer: number }>;
}

interface Level {
  cols: number;
  rows: number;
  stageLayers: LayerSpec[];
  matchCount?: number;
  bufferSize?: number;
  _generated?: boolean;
}

interface BufferEntry {
  value: number;
}

let avatarTileValue = -1;
let avatarTileUrl: string | null = null;
let avatarMemberName: string | null = null;

let level: Level | null = null;
let tiles: Tile[] = [];
let buffer: BufferEntry[] = [];
let removedQueue: BufferEntry[] = [];
let totalTiles = 0;
let initialized = false;
const loading = false;

let freeUses = { remove: 0, undo: 0, shuffle: 0 };
let lastPick: Tile | null = null;
let canUndo = false;
let gameOver = false;

let bestStage = 0;
let currentStage = 1;

let currentDifficulty = 3;
const DIFFICULTY_PARAMS: Record<number, { cols: number; rows: number; layers: number; sets: number }> = {
  1: { cols: 10, rows: 7, layers: 3, sets: 5 },
  2: { cols: 10, rows: 7, layers: 3, sets: 7 },
  3: { cols: 11, rows: 8, layers: 4, sets: 9 },
  4: { cols: 12, rows: 9, layers: 4, sets: 12 },
  5: { cols: 13, rows: 9, layers: 5, sets: 15 },
  6: { cols: 14, rows: 10, layers: 5, sets: 18 },
  7: { cols: 15, rows: 10, layers: 6, sets: 22 },
  8: { cols: 16, rows: 11, layers: 6, sets: 26 },
  9: { cols: 17, rows: 12, layers: 7, sets: 30 },
  10: { cols: 18, rows: 13, layers: 7, sets: 34 },
};

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

interface AuthCallResult {
  ok?: boolean;
  error?: string;
  best_stage?: number;
  new_record?: boolean;
}

interface EconomyCallResult {
  ok?: boolean;
  error?: string;
  amount?: number;
  balance?: number;
  duplicate?: boolean;
  stage?: number;
  total_earned?: number;
  total_spent?: number;
}

// ===== Edge Function (auth + record 공용) =====
function callAuth(
  action: string,
  body: Record<string, unknown>,
  retries = 2,
): Promise<AuthCallResult> {
  return fetch(FN_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(Object.assign({ action }, body)),
  })
    .then((r) => {
      if (r.status === 503 && retries > 0) {
        return new Promise((res) => setTimeout(res, 600)).then(() =>
          callAuth(action, body, retries - 1),
        );
      }
      return r.json() as Promise<AuthCallResult>;
    })
    .catch((err: Error) => ({ ok: false, error: String(err.message || err) }));
}

// ===== Edge Function (economy: 크리스탈 잔액 + 보상 청구) =====
function callEconomy(
  action: string,
  body: Record<string, unknown>,
  retries = 2,
): Promise<EconomyCallResult> {
  return fetch(FN_ECONOMY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(Object.assign({ action }, body)),
  })
    .then((r) => {
      if (r.status === 503 && retries > 0) {
        return new Promise((res) => setTimeout(res, 600)).then(() =>
          callEconomy(action, body, retries - 1),
        );
      }
      return r.json() as Promise<EconomyCallResult>;
    })
    .catch((err: Error) => ({ ok: false, error: String(err.message || err) }));
}

// 잔액이 갱신될 때마다 헤더(또는 다른 UI)가 동기화되도록 글로벌 이벤트로 broadcast.
function broadcastCrystalBalance(balance: number): void {
  window.dispatchEvent(
    new CustomEvent('crystal-balance-update', { detail: { balance } }),
  );
}

// ===== 페이지 진입 =====
export function initTileMatch(): void {
  if (initialized) return;
  initialized = true;

  $('tm-launch-btn')?.addEventListener('click', onLaunchClick);
  $('tm-dlg-close')?.addEventListener('click', requestClose);
  $('tm-overlay-restart')?.addEventListener('click', startNewGame);
  $('tm-overlay-quit')?.addEventListener('click', forceClose);
  $('tm-item-remove')?.addEventListener('click', useRemove);
  $('tm-item-undo')?.addEventListener('click', useUndo);
  $('tm-item-shuffle')?.addEventListener('click', useShuffle);
  $('tm-shuffle-popup-qr')?.addEventListener('click', onShufflePopupAction);
  $('tm-shuffle-popup-cancel')?.addEventListener('click', onShufflePopupAction);

  window.addEventListener('resize', fitBoardToArea);
  setupViewportSync();
  setupBoardAreaObserver();

  if (window.TileMatchAuth) {
    window.TileMatchAuth.initPage();
    window.TileMatchAuth.onSessionChange(() => {
      loadRanking();
    });
  }

  $('tm-ranking-refresh')?.addEventListener('click', loadRanking);

  if (window.TileMatchAuth) {
    window.TileMatchAuth.ensureAuth().then(onSessionReady);
  }
  loadRanking();
}

interface Session {
  player_id: string;
  nickname: string;
}

function onSessionReady(session: Session | null): Promise<void> {
  if (!session?.player_id) {
    bestStage = 0;
    currentStage = 1;
    renderStage();
    return Promise.resolve();
  }
  return callAuth('get-record', { player_id: session.player_id }).then((res) => {
    bestStage = res?.ok ? res.best_stage || 0 : 0;
    currentStage = bestStage + 1;
    renderStage();
  });
}

function renderStage(): void {
  const el = $('tm-launch-stage');
  if (el) el.textContent = String(currentStage);
  const dlg = $('tm-dlg-stage');
  if (dlg) dlg.textContent = String(currentStage);
}

function onLaunchClick(): void {
  if (!window.TileMatchAuth) {
    openDialog();
    return;
  }
  window.TileMatchAuth.ensureAuth().then((session) => {
    if (!session) return;
    onSessionReady(session).then(openDialog);
  });
}

// ===== 랭킹 =====
function fetchSupa(url: string): Promise<unknown> {
  return fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
  }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

interface RankingRecord {
  player_id: string;
  best_stage: number;
  total_clears: number;
  best_stage_at: string | null;
}

interface MemberLite {
  kingshot_id: string;
  nickname: string;
  level?: number | null;
  profile_photo?: string | null;
}

function hasRankingRows(): boolean {
  const box = $('tm-ranking-list');
  return !!box && !!box.querySelector('.rank-row');
}

function loadRanking(): void {
  const box = $('tm-ranking-list');
  if (!box) return;
  // 새로고침 버튼 spinning 표시 (사용자에게 클릭 동작 인지). 본문은 stale 유지 — 갱신 시 keyed reconcile.
  const refreshBtn = $('tm-ranking-refresh');
  if (refreshBtn) refreshBtn.classList.add('is-loading');

  fetchSupa(
    SUPABASE_URL +
      '/rest/v1/tile_match_records?select=player_id,best_stage,total_clears,best_stage_at&order=best_stage.desc,best_stage_at.asc&limit=50',
  )
    .then((records) => {
      const list = records as RankingRecord[];
      // ranking 의 player_id 들을 store 에서 매핑 — store 캐시 hit 시 fetch 0번
      return membersStore.refresh(fetchMembers).then((all) => {
        const map: Record<string, MemberLite> = {};
        for (const m of all as MemberLite[]) {
          map[m.kingshot_id] = m;
        }
        renderRanking(list ?? [], map);
      });
    })
    .catch((err: Error) => {
      // refresh 중 실패 — stale row 가 있으면 보존 (빈 화면 X). 비어있다면 에러 메시지로 채움.
      if (!hasRankingRows()) {
        box.innerHTML =
          '<div class="rank-empty">랭킹 조회 실패: ' +
          (err.message || String(err)) +
          '</div>';
      }
    })
    .finally(() => {
      // spinning 멈춤 — 너무 빨리 끝나면 사용자가 인지 못 하니 최소 400ms 유지
      window.setTimeout(() => refreshBtn?.classList.remove('is-loading'), 400);
    });
}

function formatRankingDate(iso: string | null): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '-';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 30) return '방금 전';
  if (diffSec < 60) return diffSec + '초 전';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + '분 전';
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + '시간 전';
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return diffDay + '일 전';
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return diffMon + '개월 전';
  return Math.floor(diffMon / 12) + '년 전';
}

const RANKING_COLUMNS: ReadonlyArray<Column> = [
  { key: 'stage', label: 'Stage', width: '60px', align: 'right', cellClass: 'rank-cell-stage' },
  { key: 'time', label: '시간', width: '64px', align: 'right', cellClass: 'rank-cell-time' },
];

function renderRanking(records: RankingRecord[], memberMap: Record<string, MemberLite>): void {
  const session = window.TileMatchAuth?.getSession();
  const myId = session ? session.player_id : null;

  const items: RankItem[] = records.map((r, i) => {
    const member = memberMap[r.player_id] || ({} as MemberLite);
    return {
      id: r.player_id,
      rank: i + 1,
      name: member.nickname || r.player_id,
      photoUrl: member.profile_photo ?? null,
      isMe: !!myId && r.player_id === myId,
      cells: {
        stage: r.best_stage + ' Stage',
        time: r.best_stage_at ? formatRankingDate(r.best_stage_at) : '-',
      },
    };
  });

  renderRankingTable({
    bodyId: 'tm-ranking-list',
    columns: RANKING_COLUMNS,
    items,
    emptyMessage: '아직 기록이 없습니다 — 첫 클리어의 주인공이 되어보세요!',
  });
}

// ===== 다이얼로그 =====
function openDialog(): void {
  const ov = $('tm-dialog-overlay');
  if (ov) ov.style.display = '';
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => startNewGame());
}

function requestClose(): void {
  if (isGameInProgress()) {
    if (!window.confirm('정말 나가시겠습니까? 진행 상황이 사라집니다.')) return;
  }
  forceClose();
}

function forceClose(): void {
  const ov = $('tm-dialog-overlay');
  if (ov) ov.style.display = 'none';
  document.body.style.overflow = '';
  hideOverlay();
}

function isGameInProgress(): boolean {
  if (gameOver) return false;
  if (!tiles?.length) return false;
  return tiles.some((t) => !t.removed);
}

function startNewGame(): void {
  if (loading) return;
  hideOverlay();
  currentDifficulty = difficultyForStage(currentStage);
  pickAvatarTile();
  level = generateLevel(currentDifficulty);
  buildBoard();
}

function pickAvatarTile(): void {
  avatarTileValue = -1;
  avatarTileUrl = null;
  avatarMemberName = null;
  const cached = window.TileMatchAuth?._cachedMembers;
  if (cached?.length) {
    const withPhoto = cached.filter((m) => m?.profile_photo);
    if (withPhoto.length) {
      const picked = withPhoto[Math.floor(Math.random() * withPhoto.length)]!;
      avatarTileUrl = picked.profile_photo || null;
      avatarMemberName = picked.nickname || null;
    }
    return;
  }
  fetch(SUPABASE_URL + '/rest/v1/members?select=nickname,profile_photo&limit=200', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
  })
    .then((r) => r.json())
    .then((list: unknown) => {
      const arr = Array.isArray(list) ? (list as MemberLite[]) : [];
      const withPhoto = arr.filter((m) => m?.profile_photo);
      if (!withPhoto.length) return;
      const picked = withPhoto[Math.floor(Math.random() * withPhoto.length)]!;
      avatarTileUrl = picked.profile_photo || null;
      avatarMemberName = picked.nickname || null;
      if (avatarTileValue >= 0) {
        refreshAvatarTiles();
        updateAvatarHint();
      }
    })
    .catch(() => {});
}

function updateAvatarHint(): void {
  const box = $('tm-avatar-hint');
  const nameEl = $('tm-avatar-hint-name');
  if (!box || !nameEl) return;
  if (avatarMemberName && avatarTileValue >= 0) {
    nameEl.textContent = avatarMemberName;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

function assignAvatarValueFromBoard(): void {
  if (!avatarTileUrl || !tiles.length) {
    avatarTileValue = -1;
    return;
  }
  const seen: Record<number, boolean> = {};
  const values: number[] = [];
  tiles.forEach((t) => {
    if (!seen[t.value]) {
      seen[t.value] = true;
      values.push(t.value);
    }
  });
  if (!values.length) {
    avatarTileValue = -1;
    return;
  }
  avatarTileValue = values[Math.floor(Math.random() * values.length)]!;
}

function refreshAvatarTiles(): void {
  if (!avatarTileUrl) return;
  tiles.forEach((t) => {
    if (t.value === avatarTileValue && t.el) {
      const glyph = t.el.querySelector('.tm-tile-glyph');
      if (glyph) glyph.outerHTML = renderGlyph(t.value);
    }
  });
  renderBuffer();
  renderRemoveQueue();
}

function difficultyForStage(stage: number): number {
  if (stage <= 0) return 1;
  if (stage >= 46) return 10;
  return Math.min(10, Math.floor((stage - 1) / 5) + 1);
}

function generateLevel(difficulty: number): Level {
  const d = DIFFICULTY_PARAMS[difficulty] || DIFFICULTY_PARAMS[3]!;
  return generateCustomLevel(d.cols, d.rows, d.layers, d.sets);
}

function generateCustomLevel(
  cols: number,
  rows: number,
  layerCount: number,
  setCount: number,
): Level {
  const totalTilesLocal = setCount * 3;

  const weights: number[] = [];
  let weightSum = 0;
  for (let w = 0; w < layerCount; w++) {
    weights.push(w + 1);
    weightSum += w + 1;
  }
  const layerTileCounts: number[] = [];
  let sum = 0;
  for (let i = 0; i < layerCount; i++) {
    layerTileCounts[i] = Math.floor((totalTilesLocal * weights[i]!) / weightSum);
    sum += layerTileCounts[i]!;
  }
  let diff = totalTilesLocal - sum;
  let pad = 0;
  while (diff > 0) {
    layerTileCounts[layerCount - 1 - (pad % layerCount)]!++;
    diff--;
    pad++;
  }

  const stageLayers: LayerSpec[] = [];
  for (let l = 0; l < layerCount; l++) {
    const weightIdx = layerCount - 1 - l;
    const n = layerTileCounts[weightIdx]!;
    const offset = l % 2 === 1 ? 0.5 : 0;
    const positions = generateLayerPositions(cols, rows, n, l, offset);
    stageLayers.push({ layer: l, tiles: positions });
  }

  const totalGen = stageLayers.reduce((s, lyr) => s + lyr.tiles.length, 0);
  let trim = totalGen % MATCH_COUNT;
  while (trim > 0) {
    let trimmedThisRound = false;
    for (let ll = 0; ll < layerCount && trim > 0; ll++) {
      if (stageLayers[ll]!.tiles.length > 0) {
        stageLayers[ll]!.tiles.pop();
        trim--;
        trimmedThisRound = true;
      }
    }
    if (!trimmedThisRound) break;
  }

  return { cols, rows, stageLayers, _generated: true };
}

function generateLayerPositions(
  cols: number,
  rows: number,
  n: number,
  layerIdx: number,
  offset = 0,
): Array<{ colIndex: number; rowIndex: number; layer: number }> {
  const positions: Array<{ colIndex: number; rowIndex: number; layer: number }> = [];
  const colMaxIdx = Math.floor(cols - 1 - offset);
  const rowMaxIdx = Math.floor(rows - 1 - offset);
  const maxAttempts = n * 300;
  let attempts = 0;
  while (positions.length < n && attempts < maxAttempts) {
    attempts++;
    const c = Math.floor(Math.random() * (colMaxIdx + 1)) + offset;
    const r = Math.floor(Math.random() * (rowMaxIdx + 1)) + offset;
    let ok = true;
    for (const p of positions) {
      if (Math.abs(p.colIndex - c) < 2 && Math.abs(p.rowIndex - r) < 2) {
        ok = false;
        break;
      }
    }
    if (ok) positions.push({ colIndex: c, rowIndex: r, layer: layerIdx });
  }
  return positions;
}

// ===== 보드 생성 =====
function buildBoard(): void {
  if (!level) return;
  const stageLayers = level.stageLayers || [];
  const matchCount = level.matchCount || MATCH_COUNT;
  const bufferSize = level.bufferSize || BUFFER_SIZE;

  const stageTiles: Array<{ colIndex: number; rowIndex: number; layer: number }> = [];
  stageLayers.forEach((layer) => {
    (layer.tiles || []).forEach((t) => stageTiles.push(t));
  });
  totalTiles = stageTiles.length;

  const valuePool: number[] = [];
  for (let i = 0; i < TILE_SHAPES.length; i++) valuePool.push(i);
  shuffleInPlace(valuePool);

  const queue: number[] = [];
  let idx = 0;
  while (queue.length < totalTiles) {
    const v = valuePool[idx % valuePool.length]!;
    for (let j = 0; j < matchCount && queue.length < totalTiles; j++) {
      queue.push(v);
    }
    idx++;
    if (idx % valuePool.length === 0) shuffleInPlace(valuePool);
  }

  const sortedLayers = stageLayers.slice().sort((a, b) => a.layer - b.layer);
  tiles = [];
  let tileId = 0;
  const bufWindow = bufferSize * 2;
  sortedLayers.forEach((layer) => {
    const layerTiles = (layer.tiles || []).slice();
    shuffleInPlace(layerTiles);
    layerTiles.sort((a, b) => a.rowIndex - b.rowIndex);
    layerTiles.forEach((st) => {
      const pickRange = Math.min(queue.length, bufWindow);
      const pick = Math.floor(Math.random() * pickRange);
      const value = queue.splice(pick, 1)[0]!;
      tiles.push({
        id: tileId++,
        value,
        layer: st.layer,
        col: st.colIndex,
        row: st.rowIndex,
        removed: false,
        el: null,
      });
    });
  });

  buffer = [];
  removedQueue = [];
  freeUses = {
    remove: INITIAL_FREE_USES.remove,
    undo: INITIAL_FREE_USES.undo,
    shuffle: INITIAL_FREE_USES.shuffle,
  };
  lastPick = null;
  canUndo = false;
  gameOver = false;

  assignAvatarValueFromBoard();

  renderBoard();
  renderBuffer();
  renderRemoveQueue();
  updateItemButtons();
  updateAvatarHint();
  requestAnimationFrame(fitBoardToArea);
}

// ===== 모바일 viewport / ResizeObserver =====
function setupViewportSync(): void {
  function sync(): void {
    const h =
      (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    document.documentElement.style.setProperty('--vh-real', h + 'px');
    fitBoardToArea();
  }
  sync();
  window.addEventListener('resize', sync);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sync);
    window.visualViewport.addEventListener('scroll', sync);
  }
}

let _boardAreaObserver: ResizeObserver | null = null;
function setupBoardAreaObserver(): void {
  if (_boardAreaObserver || typeof ResizeObserver === 'undefined') return;
  const area = document.querySelector('.tm-board-area');
  if (!area) return;
  _boardAreaObserver = new ResizeObserver(() => fitBoardToArea());
  _boardAreaObserver.observe(area);
}

function fitBoardToArea(): void {
  const area = document.querySelector<HTMLElement>('.tm-board-area');
  const board = $('tm-board');
  if (!area || !board || !level) return;
  const availW = area.clientWidth;
  const availH = area.clientHeight;
  if (availW <= 0 || availH <= 0) return;
  const pad = 8;
  const boardW = parseFloat(board.style.width) || 1;
  const boardH = parseFloat(board.style.height) || 1;
  const scale = Math.min((availW - pad) / boardW, (availH - pad) / boardH, 1);
  board.style.transform = 'translate(-50%,-50%) scale(' + scale + ')';
}

// ===== active 판정 + 렌더링 =====
function isOverlap(t1: { col: number; row: number }, t2: { col: number; row: number }): boolean {
  return Math.abs(t1.col - t2.col) < 2 && Math.abs(t1.row - t2.row) < 2;
}

function isActive(tile: Tile): boolean {
  if (tile.removed) return false;
  for (const other of tiles) {
    if (other === tile || other.removed) continue;
    if (other.layer > tile.layer && isOverlap(other, tile)) return false;
  }
  return true;
}

function renderBoard(): void {
  const board = $('tm-board');
  if (!board || !level) return;
  board.innerHTML = '';
  const layerCount = (level.stageLayers || []).length || 7;

  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  tiles.forEach((t) => {
    if (t.col < minCol) minCol = t.col;
    if (t.col > maxCol) maxCol = t.col;
    if (t.row < minRow) minRow = t.row;
    if (t.row > maxRow) maxRow = t.row;
  });
  if (!isFinite(minCol)) {
    minCol = 0;
    maxCol = 0;
    minRow = 0;
    maxRow = 0;
  }

  const bboxCols = maxCol - minCol + 2;
  const bboxRows = maxRow - minRow + 2;
  const w = bboxCols * CELL_W;
  const h = bboxRows * CELL_H + layerCount * CELL_DEPTH;
  board.style.width = w + 'px';
  board.style.height = h + 'px';

  const fragment = document.createDocumentFragment();
  tiles.forEach((tile) => {
    const el = document.createElement('div');
    el.className = 'tm-tile';
    el.dataset.id = String(tile.id);
    el.style.width = CELL_W * 2 + 'px';
    el.style.height = CELL_H * 2 + CELL_DEPTH + 'px';
    el.style.left = (tile.col - minCol) * CELL_W + 'px';
    el.style.top =
      (layerCount - tile.layer - 1) * CELL_DEPTH + (tile.row - minRow) * CELL_H + 'px';
    el.style.zIndex = String(tile.layer + 1);
    el.innerHTML = renderGlyph(tile.value);
    el.addEventListener('click', () => onTileClick(tile));
    tile.el = el;
    fragment.appendChild(el);
  });
  board.appendChild(fragment);

  refreshActiveStates();
}

function refreshActiveStates(): void {
  tiles.forEach((tile) => {
    if (!tile.el) return;
    if (tile.removed) {
      tile.el.style.display = 'none';
      return;
    }
    tile.el.style.display = '';
    tile.el.classList.toggle('tm-inactive', !isActive(tile));
  });
}

function renderBuffer(): void {
  const bufEl = $('tm-buffer');
  if (!bufEl) return;
  bufEl.innerHTML = '';
  for (let i = 0; i < BUFFER_SIZE; i++) {
    const slot = document.createElement('div');
    slot.className = 'tm-slot';
    const entry = buffer[i];
    if (entry) {
      slot.classList.add('tm-slot-filled');
      slot.innerHTML = renderGlyph(entry.value);
    }
    bufEl.appendChild(slot);
  }
}

function renderRemoveQueue(): void {
  const box = $('tm-remove-queue');
  const slots = $('tm-remove-slots');
  if (!box || !slots) return;
  if (removedQueue.length === 0) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  slots.innerHTML = '';
  for (let i = 0; i < REMOVE_QUEUE_SIZE; i++) {
    const slot = document.createElement('div');
    slot.className = 'tm-slot';
    const entry = removedQueue[i];
    if (entry) {
      slot.classList.add('tm-slot-filled');
      slot.innerHTML = renderGlyph(entry.value);
      const idx = i;
      slot.addEventListener('click', () => onRemoveSlotClick(idx));
    }
    slots.appendChild(slot);
  }
}

function onRemoveSlotClick(idx: number): void {
  if (idx < 0 || idx >= removedQueue.length) return;
  if (buffer.length >= BUFFER_SIZE) return;
  const entry = removedQueue[idx];
  if (!entry) return;
  removedQueue.splice(idx, 1);
  buffer.push({ value: entry.value });
  buffer.sort((a, b) => a.value - b.value);
  eliminateMatches();
  lastPick = null;
  canUndo = false;
  renderBuffer();
  renderRemoveQueue();
  updateItemButtons();
  checkEnd();
  requestAnimationFrame(fitBoardToArea);
}

function onTileClick(tile: Tile): void {
  if (tile.removed || !isActive(tile)) return;
  const prevBufferLen = buffer.length;

  tile.removed = true;
  if (tile.el) tile.el.classList.add('tm-removing');

  buffer.push({ value: tile.value });
  buffer.sort((a, b) => a.value - b.value);

  eliminateMatches();

  if (buffer.length > prevBufferLen) {
    lastPick = tile;
    canUndo = true;
  } else {
    lastPick = null;
    canUndo = false;
  }

  setTimeout(() => {
    if (tile.el) {
      tile.el.classList.remove('tm-removing');
      if (tile.removed) tile.el.style.display = 'none';
    }
    refreshActiveStates();
    renderBuffer();
    updateItemButtons();
    checkEnd();
  }, 120);
}

function eliminateMatches(): void {
  for (let i = 0; i <= buffer.length - MATCH_COUNT; i++) {
    const v = buffer[i]!.value;
    let allSame = true;
    for (let j = 1; j < MATCH_COUNT; j++) {
      if (buffer[i + j]!.value !== v) {
        allSame = false;
        break;
      }
    }
    if (allSame) {
      buffer.splice(i, MATCH_COUNT);
      i--;
    }
  }
}

// ===== 아이템 =====
function useRemove(): void {
  if (freeUses.remove <= 0 || buffer.length === 0) return;
  const n = Math.min(REMOVE_QUEUE_SIZE, buffer.length);
  const picked = buffer.splice(0, n);
  removedQueue = picked.slice(0, REMOVE_QUEUE_SIZE);
  freeUses.remove--;
  lastPick = null;
  canUndo = false;
  renderBuffer();
  renderRemoveQueue();
  updateItemButtons();
  requestAnimationFrame(fitBoardToArea);
}

function useUndo(): void {
  if (freeUses.undo <= 0 || !canUndo || !lastPick) return;
  const tile = lastPick;
  tile.removed = false;
  if (tile.el) {
    tile.el.style.display = '';
    tile.el.classList.remove('tm-removing');
  }
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i]!.value === tile.value) {
      buffer.splice(i, 1);
      break;
    }
  }
  lastPick = null;
  canUndo = false;
  freeUses.undo--;
  refreshActiveStates();
  renderBuffer();
  updateItemButtons();
}

function useShuffle(): void {
  if (freeUses.shuffle <= 0) return;
  const remaining = tiles.filter((t) => !t.removed);
  if (remaining.length <= 1) return;
  showShufflePopup();
}

function showShufflePopup(): void {
  const p = $('tm-shuffle-popup');
  if (p) p.style.display = '';
}

function hideShufflePopup(): void {
  const p = $('tm-shuffle-popup');
  if (p) p.style.display = 'none';
}

function onShufflePopupAction(): void {
  hideShufflePopup();
  showToast('농담입니다 껄.껄.껄');
  actuallyShuffle();
}

function actuallyShuffle(): void {
  if (freeUses.shuffle <= 0) return;
  const remaining = tiles.filter((t) => !t.removed);
  if (remaining.length <= 1) return;
  const values = remaining.map((t) => t.value);
  shuffleInPlace(values);
  remaining.forEach((t, i) => {
    t.value = values[i]!;
    if (t.el) {
      const glyph = t.el.querySelector('.tm-tile-glyph');
      if (glyph) glyph.outerHTML = renderGlyph(t.value);
    }
  });
  freeUses.shuffle--;
  lastPick = null;
  canUndo = false;
  updateItemButtons();
}

let _toastTimer: number | null = null;
function showToast(msg: string): void {
  const el = $('tm-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('tm-toast-show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = window.setTimeout(() => {
    el.classList.remove('tm-toast-show');
    _toastTimer = null;
  }, 1500);
}

function updateItemButtons(): void {
  const rb = $<HTMLButtonElement>('tm-item-remove');
  const ub = $<HTMLButtonElement>('tm-item-undo');
  const sb = $<HTMLButtonElement>('tm-item-shuffle');
  if (!rb || !ub || !sb) return;
  rb.disabled = freeUses.remove <= 0 || buffer.length === 0 || removedQueue.length > 0;
  ub.disabled = freeUses.undo <= 0 || !canUndo || !lastPick;
  sb.disabled = freeUses.shuffle <= 0;
  $('tm-item-remove-badge')!.textContent = 'Free ×' + freeUses.remove;
  $('tm-item-undo-badge')!.textContent = 'Free ×' + freeUses.undo;
  $('tm-item-shuffle-badge')!.textContent = 'Free ×' + freeUses.shuffle;
}

function checkEnd(): void {
  const remaining = tiles.filter((t) => !t.removed).length;
  if (remaining === 0 && buffer.length === 0) {
    gameOver = true;
    onClear();
    return;
  }
  if (buffer.length >= BUFFER_SIZE) {
    gameOver = true;
    showOverlay('💥', '슬롯이 가득 찼습니다.', false);
  }
}

function onClear(): void {
  const session = window.TileMatchAuth?.getSession();
  const clearedStage = currentStage;
  // 클라이언트 측 사전 계산 — 서버 응답 기다리지 않고 다이얼로그를 즉시 완성형으로 표시.
  // (재플레이 X 도메인 가정: 같은 stage 두 번 클리어 시나리오 없음 → duplicate 분기 불필요)
  const reward = session?.player_id ? rewardForStage(clearedStage) : 0;
  showOverlay('🎉', 'Stage ' + clearedStage + ' 클리어!', true, reward);

  if (!session?.player_id) return;

  callAuth('record-clear', { player_id: session.player_id, stage: clearedStage }).then((res) => {
    if (!res?.ok) return;
    bestStage = res.best_stage || bestStage;
    currentStage = bestStage + 1;
    renderStage();
    loadRanking();
  });

  // 보상 청구는 fire-and-forget — UI 는 이미 reward 표시 끝났고, 응답은 잔액 broadcast 용으로만 사용.
  // 사용자가 다이얼로그 닫고 브라우저를 빠르게 종료해도 서버는 청구를 처리함.
  callEconomy('claim-stage-reward', {
    player_id: session.player_id,
    stage: clearedStage,
  }).then((res) => {
    if (res?.ok && typeof res.balance === 'number') {
      broadcastCrystalBalance(res.balance);
      return;
    }
    // 청구 실패 — 다이얼로그엔 이미 +N 표시했지만 서버 누적 안 됨.
    // silent 누적 손실 차단을 위해 사용자에게 명시적 알림 (이전에 stage>200 cap 으로
    // 무성공 누적된 회귀의 재발 방지).
    console.warn('[tile-match] claim-stage-reward 실패:', res);
    showClaimFailureToast(clearedStage, res?.error || 'unknown');
  });
}

function showClaimFailureToast(stage: number, errorCode: string): void {
  const host = document.body;
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'tm-claim-fail-toast';
  el.textContent =
    '⚠️ Stage ' + stage + ' 보상 처리 실패 (' + errorCode + ') — 운영자에게 알려주세요';
  host.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function showOverlay(icon: string, msg: string, isSuccess: boolean, rewardAmount = 0): void {
  const iconEl = $('tm-overlay-icon');
  const msgEl = $('tm-overlay-msg');
  const ov = $('tm-overlay');
  if (iconEl) iconEl.textContent = icon;
  if (msgEl) msgEl.textContent = msg;
  if (ov) ov.style.display = '';
  const primaryBtn = $('tm-overlay-restart');
  if (primaryBtn) primaryBtn.textContent = isSuccess ? '다음 단계' : '다시 하기';

  const rewardBox = $('tm-overlay-reward');
  const rewardAmt = $('tm-overlay-reward-amount');
  if (rewardBox && rewardAmt) {
    if (rewardAmount > 0) {
      rewardAmt.textContent = '+' + rewardAmount.toLocaleString('ko-KR');
      rewardBox.style.display = '';
      // 매번 다이얼로그가 뜰 때마다 슬라이드업 애니메이션 재시작
      restartAnimation(rewardAmt);
    } else {
      rewardBox.style.display = 'none';
    }
  }

  // 폭죽 wiggle 도 매번 재시작
  if (iconEl) restartAnimation(iconEl);
}

// CSS 애니메이션 재시작 트릭: animation 속성을 잠깐 none 으로 비웠다가 다시 비움(원래 CSS 값으로 복귀).
// 사이에 강제 reflow 한 번을 끼워서 브라우저가 두 상태를 다른 시점으로 보도록 한다.
function restartAnimation(el: HTMLElement): void {
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

function hideOverlay(): void {
  const ov = $('tm-overlay');
  if (ov) ov.style.display = 'none';
}

function renderGlyph(value: number): string {
  if (value === avatarTileValue && avatarTileUrl) {
    return (
      '<span class="tm-tile-glyph"><img class="tm-tile-avatar" src="' +
      avatarTileUrl +
      '" alt=""></span>'
    );
  }
  return '<span class="tm-tile-glyph">' + TILE_SHAPES[value] + '</span>';
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

// 전역 노출 (디버그)
declare global {
  interface Window {
    TileMatch: {
      initPage: () => void;
    };
  }
}
window.TileMatch = { initPage: initTileMatch };
