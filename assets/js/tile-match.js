/**
 * 타일 매치 미니게임 (3-Match Mahjong, 양적양 스타일)
 *
 * 게임 규칙:
 *  - 보드: 여러 레이어로 쌓인 타일들
 *  - 같은 레이어 내 ±1 col/row 범위 → "겹침"
 *  - 활성(active): 더 위 레이어에 자기와 겹치는 타일이 없는 상태
 *  - 활성 타일 클릭 → 슬롯(buffer)으로 이동
 *  - 슬롯에 같은 모양 3개 모이면 자동 소거
 *  - 슬롯이 가득 차면 게임 오버, 모든 타일 비우면 승리
 *
 * 아이템:
 *  - 제거: 버퍼 앞쪽 3개를 "제거 큐"로 옮김 (영구 제거)
 *  - 되돌리기: 직전에 클릭한 타일을 보드로 복귀 (단, 매치 발생 직후엔 불가)
 *  - 재배치: 보드에 남은 타일들의 모양을 다시 셔플
 *  - 각 아이템은 회당 무료 1회씩 제공
 */
(function() {
  'use strict';

  // ===== 상수 =====

  var LEVEL_URL_ABS = '/assets/data/tile-match-level.json';

  var TILE_SHAPES = [
    '🐶', '🐱', '🐰', '🐻', '🐼', '🦁', '🐯', '🐸',
    '🐵', '🐔', '🐧', '🐦', '🐢', '🐍', '🐠', '🐳'
  ];

  var CELL_W = 18;
  var CELL_H = 22;
  var CELL_DEPTH = 6;
  var BUFFER_SIZE = 7;
  var MATCH_COUNT = 3;
  var REMOVE_QUEUE_SIZE = 3;
  var INITIAL_FREE_USES = { remove: 1, undo: 1, shuffle: 1 };

  // ===== 상태 =====

  var level = null;
  var tiles = [];
  var buffer = [];
  var removedQueue = [];     // 제거 아이템으로 옮겨진 항목들 (최대 3)
  var totalTiles = 0;
  var initialized = false;
  var loading = false;

  var freeUses = { remove: 0, undo: 0, shuffle: 0 };
  var lastPick = null;       // 직전에 클릭된 타일 (되돌리기 대상)
  var canUndo = false;       // 매치 발생 시 false 로 초기화

  // ===== DOM refs =====

  function $(id) { return document.getElementById(id); }

  // ===== 페이지 진입 시 한 번만 호출 =====

  function initPage() {
    if (initialized) return;
    initialized = true;
    $('tm-restart').addEventListener('click', startNewGame);
    $('tm-overlay-restart').addEventListener('click', startNewGame);
    $('tm-item-remove').addEventListener('click', useRemove);
    $('tm-item-undo').addEventListener('click', useUndo);
    $('tm-item-shuffle').addEventListener('click', useShuffle);
    startNewGame();
  }

  function startNewGame() {
    if (loading) return;
    hideOverlay();
    if (level) {
      buildBoard();
      return;
    }
    loading = true;
    fetch(LEVEL_URL_ABS)
      .then(function(r) {
        if (!r.ok) throw new Error('레벨 로드 실패: HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        level = data;
        buildBoard();
      })
      .catch(function(err) {
        $('tm-board').innerHTML = '<div class="empty-cell">레벨 로드 실패: ' + (err.message || err) + '</div>';
      })
      .finally(function() { loading = false; });
  }

  // ===== 보드 생성 + 타일 배치 =====

  function buildBoard() {
    var stageLayers = level.stageLayers || [];
    var matchCount = level.matchCount || MATCH_COUNT;
    var bufferSize = level.bufferSize || BUFFER_SIZE;

    var stageTiles = [];
    stageLayers.forEach(function(layer) {
      (layer.tiles || []).forEach(function(t) { stageTiles.push(t); });
    });
    totalTiles = stageTiles.length;

    var groupCount = Math.ceil(totalTiles / matchCount);
    var valuePool = [];
    for (var i = 0; i < TILE_SHAPES.length; i++) valuePool.push(i);
    shuffleInPlace(valuePool);

    var queue = [];
    var idx = 0;
    while (queue.length < totalTiles) {
      var v = valuePool[idx % valuePool.length];
      for (var j = 0; j < matchCount && queue.length < totalTiles; j++) {
        queue.push(v);
      }
      idx++;
      if (idx % valuePool.length === 0) shuffleInPlace(valuePool);
    }

    var sortedLayers = stageLayers.slice().sort(function(a, b) { return a.layer - b.layer; });
    tiles = [];
    var tileId = 0;
    var bufWindow = bufferSize * 2;
    sortedLayers.forEach(function(layer) {
      var layerTiles = (layer.tiles || []).slice();
      shuffleInPlace(layerTiles);
      layerTiles.sort(function(a, b) { return a.rowIndex - b.rowIndex; });
      layerTiles.forEach(function(st) {
        var pickRange = Math.min(queue.length, bufWindow);
        var pick = Math.floor(Math.random() * pickRange);
        var value = queue.splice(pick, 1)[0];
        tiles.push({
          id: tileId++,
          value: value,
          layer: st.layer,
          col: st.colIndex,
          row: st.rowIndex,
          removed: false,
          el: null
        });
      });
    });

    // 게임 상태 초기화
    buffer = [];
    removedQueue = [];
    freeUses = { remove: INITIAL_FREE_USES.remove, undo: INITIAL_FREE_USES.undo, shuffle: INITIAL_FREE_USES.shuffle };
    lastPick = null;
    canUndo = false;

    renderBoard();
    renderBuffer();
    renderRemoveQueue();
    updateItemButtons();
    updateStatus();
  }

  // ===== 활성(active) 판정 =====

  function isOverlap(t1, t2) {
    return Math.abs(t1.col - t2.col) <= 1 && Math.abs(t1.row - t2.row) <= 1;
  }

  function isActive(tile) {
    if (tile.removed) return false;
    for (var i = 0; i < tiles.length; i++) {
      var other = tiles[i];
      if (other === tile || other.removed) continue;
      if (other.layer > tile.layer && isOverlap(other, tile)) return false;
    }
    return true;
  }

  // ===== 보드 렌더링 =====

  function renderBoard() {
    var board = $('tm-board');
    board.innerHTML = '';
    var cols = level.cols || 40;
    var rows = level.rows || 25;
    var layerCount = (level.stageLayers || []).length || 7;
    var w = (cols + 2) * CELL_W;
    var h = (rows + 2) * CELL_H + layerCount * CELL_DEPTH;
    board.style.width = w + 'px';
    board.style.height = h + 'px';

    var fragment = document.createDocumentFragment();
    tiles.forEach(function(tile) {
      var el = document.createElement('div');
      el.className = 'tm-tile';
      el.dataset.id = tile.id;
      el.style.width = (CELL_W * 2) + 'px';
      el.style.height = (CELL_H * 2 + CELL_DEPTH) + 'px';
      el.style.left = (tile.col * CELL_W) + 'px';
      el.style.top = ((layerCount - tile.layer - 1) * CELL_DEPTH + tile.row * CELL_H) + 'px';
      el.style.zIndex = tile.layer + 1;
      el.innerHTML = '<span class="tm-tile-glyph">' + TILE_SHAPES[tile.value] + '</span>';
      el.addEventListener('click', function() { onTileClick(tile); });
      tile.el = el;
      fragment.appendChild(el);
    });
    board.appendChild(fragment);

    refreshActiveStates();
  }

  function refreshActiveStates() {
    tiles.forEach(function(tile) {
      if (!tile.el) return;
      if (tile.removed) {
        tile.el.style.display = 'none';
        return;
      }
      tile.el.style.display = '';
      tile.el.classList.toggle('tm-inactive', !isActive(tile));
    });
  }

  // ===== 버퍼 (슬롯) 렌더링 =====

  function renderBuffer() {
    var bufEl = $('tm-buffer');
    bufEl.innerHTML = '';
    for (var i = 0; i < BUFFER_SIZE; i++) {
      var slot = document.createElement('div');
      slot.className = 'tm-slot';
      var entry = buffer[i];
      if (entry) {
        slot.classList.add('tm-slot-filled');
        slot.innerHTML = '<span class="tm-tile-glyph">' + TILE_SHAPES[entry.value] + '</span>';
      }
      bufEl.appendChild(slot);
    }
  }

  // ===== 제거 큐 렌더링 =====

  function renderRemoveQueue() {
    var box = $('tm-remove-queue');
    var slots = $('tm-remove-slots');
    if (removedQueue.length === 0) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    slots.innerHTML = '';
    for (var i = 0; i < REMOVE_QUEUE_SIZE; i++) {
      var slot = document.createElement('div');
      slot.className = 'tm-slot';
      var entry = removedQueue[i];
      if (entry) {
        slot.classList.add('tm-slot-filled');
        slot.innerHTML = '<span class="tm-tile-glyph">' + TILE_SHAPES[entry.value] + '</span>';
      }
      slots.appendChild(slot);
    }
  }

  // ===== 타일 클릭 =====

  function onTileClick(tile) {
    if (tile.removed || !isActive(tile)) return;

    var prevBufferLen = buffer.length;

    tile.removed = true;
    if (tile.el) tile.el.classList.add('tm-removing');

    buffer.push({ value: tile.value });
    buffer.sort(function(a, b) { return a.value - b.value; });

    eliminateMatches();

    // 매치 발생 여부로 되돌리기 가능 여부 결정
    if (buffer.length > prevBufferLen) {
      lastPick = tile;
      canUndo = true;
    } else {
      lastPick = null;
      canUndo = false;
    }

    setTimeout(function() {
      if (tile.el) {
        tile.el.classList.remove('tm-removing');
        if (tile.removed) tile.el.style.display = 'none';
      }
      refreshActiveStates();
      renderBuffer();
      updateItemButtons();
      updateStatus();
      checkEnd();
    }, 120);
  }

  function eliminateMatches() {
    for (var i = 0; i <= buffer.length - MATCH_COUNT; i++) {
      var v = buffer[i].value;
      var allSame = true;
      for (var j = 1; j < MATCH_COUNT; j++) {
        if (buffer[i + j].value !== v) { allSame = false; break; }
      }
      if (allSame) {
        buffer.splice(i, MATCH_COUNT);
        i--;
      }
    }
  }

  // ===== 아이템: 제거 =====
  function useRemove() {
    if (freeUses.remove <= 0 || buffer.length === 0) return;
    var n = Math.min(REMOVE_QUEUE_SIZE, buffer.length);
    var picked = buffer.splice(0, n);
    removedQueue = picked.slice(0, REMOVE_QUEUE_SIZE);
    freeUses.remove--;
    lastPick = null;
    canUndo = false;
    renderBuffer();
    renderRemoveQueue();
    updateItemButtons();
    updateStatus();
  }

  // ===== 아이템: 되돌리기 =====
  function useUndo() {
    if (freeUses.undo <= 0 || !canUndo || !lastPick) return;
    var tile = lastPick;
    tile.removed = false;
    if (tile.el) {
      tile.el.style.display = '';
      tile.el.classList.remove('tm-removing');
    }
    // 버퍼에서 같은 value 항목 하나 제거 (가장 마지막에 들어간 것)
    for (var i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].value === tile.value) {
        buffer.splice(i, 1);
        break;
      }
    }
    lastPick = null;
    canUndo = false;
    freeUses.undo--;
    refreshActiveStates();
    renderBuffer();
    updateStatus();
    updateItemButtons();
  }

  // ===== 아이템: 재배치 =====
  function useShuffle() {
    if (freeUses.shuffle <= 0) return;
    var remaining = tiles.filter(function(t) { return !t.removed; });
    if (remaining.length <= 1) return;
    var values = remaining.map(function(t) { return t.value; });
    shuffleInPlace(values);
    remaining.forEach(function(t, i) {
      t.value = values[i];
      if (t.el) {
        var glyph = t.el.querySelector('.tm-tile-glyph');
        if (glyph) glyph.textContent = TILE_SHAPES[t.value];
      }
    });
    freeUses.shuffle--;
    lastPick = null;
    canUndo = false;
    updateItemButtons();
  }

  // ===== 버튼 상태 / 카운터 =====

  function updateItemButtons() {
    var rb = $('tm-item-remove'), ub = $('tm-item-undo'), sb = $('tm-item-shuffle');
    if (!rb || !ub || !sb) return;
    rb.disabled = (freeUses.remove <= 0 || buffer.length === 0 || removedQueue.length > 0);
    ub.disabled = (freeUses.undo <= 0 || !canUndo || !lastPick);
    sb.disabled = (freeUses.shuffle <= 0);
    $('tm-item-remove-badge').textContent = 'Free ×' + freeUses.remove;
    $('tm-item-undo-badge').textContent = 'Free ×' + freeUses.undo;
    $('tm-item-shuffle-badge').textContent = 'Free ×' + freeUses.shuffle;
  }

  function updateStatus() {
    var remaining = tiles.filter(function(t) { return !t.removed; }).length;
    $('tm-remaining').textContent = remaining;
    $('tm-total').textContent = totalTiles;
  }

  function checkEnd() {
    var remaining = tiles.filter(function(t) { return !t.removed; }).length;
    if (remaining === 0 && buffer.length === 0) {
      showOverlay('🎉', '클리어! ' + totalTiles + '개의 타일을 모두 비웠습니다.');
      return;
    }
    if (buffer.length >= BUFFER_SIZE) {
      showOverlay('💥', '슬롯이 가득 찼습니다. 다시 도전해 보세요.');
    }
  }

  function showOverlay(icon, msg) {
    $('tm-overlay-icon').textContent = icon;
    $('tm-overlay-msg').textContent = msg;
    $('tm-overlay').style.display = '';
  }

  function hideOverlay() {
    var ov = $('tm-overlay');
    if (ov) ov.style.display = 'none';
  }

  // ===== util =====

  function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ===== Public API =====

  window.TileMatch = { initPage: initPage };

})();
