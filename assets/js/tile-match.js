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

  var CELL_W = 22;
  var CELL_H = 27;
  var CELL_DEPTH = 7;
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
  var gameOver = false;      // 클리어/실패 시 true

  // ===== DOM refs =====

  function $(id) { return document.getElementById(id); }

  // ===== 페이지 진입 시 한 번만 호출 =====

  function initPage() {
    if (initialized) return;
    initialized = true;
    $('tm-launch-btn').addEventListener('click', openDialog);
    $('tm-dlg-close').addEventListener('click', requestClose);
    $('tm-overlay-restart').addEventListener('click', startNewGame);
    $('tm-overlay-quit').addEventListener('click', forceClose);
    $('tm-item-remove').addEventListener('click', useRemove);
    $('tm-item-undo').addEventListener('click', useUndo);
    $('tm-item-shuffle').addEventListener('click', useShuffle);
    window.addEventListener('resize', fitBoardToArea);
  }

  // ===== 다이얼로그 open/close =====

  function openDialog() {
    $('tm-dialog-overlay').style.display = '';
    document.body.style.overflow = 'hidden';
    // 다이얼로그가 화면에 표시된 후 layout 이 잡힌 시점에 게임 시작 (보드 영역 측정 필요)
    requestAnimationFrame(function() { startNewGame(); });
  }

  function requestClose() {
    if (isGameInProgress()) {
      if (!window.confirm('정말 나가시겠습니까? 진행 상황이 사라집니다.')) return;
    }
    forceClose();
  }

  function forceClose() {
    $('tm-dialog-overlay').style.display = 'none';
    document.body.style.overflow = '';
    hideOverlay();
  }

  function isGameInProgress() {
    if (gameOver) return false;
    if (!tiles || tiles.length === 0) return false;
    return tiles.some(function(t) { return !t.removed; });
  }

  function startNewGame() {
    if (loading) return;
    hideOverlay();
    // 매 시작마다 새 레벨 절차 생성 (sample.json 사용 안 함)
    level = generateLevel(currentDifficulty);
    buildBoard();
  }

  // ===== 절차 생성 =====
  // 난이도별 파라미터 (UI 에 노출하지 않음 — 사용자가 "난이도는 숨겨야 재미있다" 고 명시)
  var DIFFICULTY_PARAMS = {
    1: { cols: 10, rows: 7,  layers: 3, sets: 5  },  // 15 tiles
    2: { cols: 11, rows: 8,  layers: 4, sets: 8  },  // 24 tiles
    3: { cols: 12, rows: 9,  layers: 5, sets: 12 },  // 36 tiles
    4: { cols: 14, rows: 10, layers: 6, sets: 16 },  // 48 tiles
    5: { cols: 16, rows: 11, layers: 7, sets: 20 }   // 60 tiles
  };
  var currentDifficulty = 3;

  function generateLevel(difficulty) {
    var d = DIFFICULTY_PARAMS[difficulty] || DIFFICULTY_PARAMS[3];
    return generateCustomLevel(d.cols, d.rows, d.layers, d.sets);
  }

  function generateCustomLevel(cols, rows, layerCount, setCount) {
    var totalTiles = setCount * 3;

    // 레이어별 weight: top 적게, bottom 많게. weights[0]=top 의 weight.
    var weights = [];
    var weightSum = 0;
    for (var w = 0; w < layerCount; w++) {
      weights.push(w + 1);
      weightSum += w + 1;
    }
    var layerTileCounts = [];
    var sum = 0;
    for (var i = 0; i < layerCount; i++) {
      layerTileCounts[i] = Math.floor(totalTiles * weights[i] / weightSum);
      sum += layerTileCounts[i];
    }
    // 합계 보정 — 부족분을 가장 큰 weight 쪽(=bottom)에 +1
    var diff = totalTiles - sum;
    var pad = 0;
    while (diff > 0) {
      layerTileCounts[layerCount - 1 - (pad % layerCount)]++;
      diff--; pad++;
    }

    // 각 레이어에 위치 생성 (l=0 이 가장 아래; weightIdx 매핑)
    // 홀수 레이어는 0.5 셀 오프셋 — 위 4개 블록의 정중앙에 1개가 끼어드는 패턴
    var stageLayers = [];
    for (var l = 0; l < layerCount; l++) {
      var weightIdx = layerCount - 1 - l;
      var n = layerTileCounts[weightIdx];
      var offset = (l % 2 === 1) ? 0.5 : 0;
      var positions = generateLayerPositions(cols, rows, n, l, offset);
      stageLayers.push({ layer: l, tiles: positions });
    }

    // matchCount(=3) 배수로 보정 — 충돌 회피로 부족분 발생 시 bottom 부터 1개씩 제거
    var totalGen = stageLayers.reduce(function(s, lyr) { return s + lyr.tiles.length; }, 0);
    var trim = totalGen % MATCH_COUNT;
    while (trim > 0) {
      var trimmedThisRound = false;
      for (var ll = 0; ll < layerCount && trim > 0; ll++) {
        if (stageLayers[ll].tiles.length > 0) {
          stageLayers[ll].tiles.pop();
          trim--;
          trimmedThisRound = true;
        }
      }
      if (!trimmedThisRound) break;
    }

    return { cols: cols, rows: rows, stageLayers: stageLayers, _generated: true };
  }

  function generateLayerPositions(cols, rows, n, layerIdx, offset) {
    offset = offset || 0;
    var positions = [];
    // 가용 격자: offset 적용 시 한 칸 줄어듦 (0.5..cols-1.5)
    var colMaxIdx = Math.floor(cols - 1 - offset);
    var rowMaxIdx = Math.floor(rows - 1 - offset);
    var maxAttempts = n * 300;
    var attempts = 0;
    while (positions.length < n && attempts < maxAttempts) {
      attempts++;
      var c = Math.floor(Math.random() * (colMaxIdx + 1)) + offset;
      var r = Math.floor(Math.random() * (rowMaxIdx + 1)) + offset;
      var ok = true;
      for (var i = 0; i < positions.length; i++) {
        if (Math.abs(positions[i].colIndex - c) < 2 && Math.abs(positions[i].rowIndex - r) < 2) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push({ colIndex: c, rowIndex: r, layer: layerIdx });
    }
    // 시도 초과 시에는 더 채우지 않음 (같은 레이어 충돌 방지). 부족분은 무시.
    return positions;
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
    gameOver = false;

    renderBoard();
    renderBuffer();
    renderRemoveQueue();
    updateItemButtons();
    updateStatus();
    // 보드 영역 layout 이 잡힌 다음 fit
    requestAnimationFrame(fitBoardToArea);
  }

  // ===== 보드 영역에 맞춰 가로/세로 모두 fit =====

  function fitBoardToArea() {
    var area = document.querySelector('.tm-board-area');
    var board = $('tm-board');
    if (!area || !board || !level) return;
    var availW = area.clientWidth;
    var availH = area.clientHeight;
    if (availW <= 0 || availH <= 0) return;
    var pad = 8;
    var boardW = parseFloat(board.style.width) || 1;
    var boardH = parseFloat(board.style.height) || 1;
    var scale = Math.min((availW - pad) / boardW, (availH - pad) / boardH, 1);
    board.style.transform = 'translate(-50%,-50%) scale(' + scale + ')';
  }

  // ===== 활성(active) 판정 =====

  // 두 타일이 픽셀 영역으로 겹치는지 — 타일은 2 cell 차지하므로 차이가 2 미만이면 겹침
  // 정수 좌표끼리는 ≤1 과 <2 가 동일하지만, 0.5 오프셋 레이어가 들어가면
  // 차이가 1.5 인 케이스가 발생하므로 strict less than 으로 판정해야 정확함.
  function isOverlap(t1, t2) {
    return Math.abs(t1.col - t2.col) < 2 && Math.abs(t1.row - t2.row) < 2;
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
    var layerCount = (level.stageLayers || []).length || 7;

    // 실제 타일 bounding box (양옆/위아래 빈 셀 제거)
    var minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    tiles.forEach(function(t) {
      if (t.col < minCol) minCol = t.col;
      if (t.col > maxCol) maxCol = t.col;
      if (t.row < minRow) minRow = t.row;
      if (t.row > maxRow) maxRow = t.row;
    });
    if (!isFinite(minCol)) { minCol = 0; maxCol = 0; minRow = 0; maxRow = 0; }

    var bboxCols = (maxCol - minCol) + 2;       // 타일 폭(2 cell) 보정
    var bboxRows = (maxRow - minRow) + 2;
    var w = bboxCols * CELL_W;
    var h = bboxRows * CELL_H + layerCount * CELL_DEPTH;
    board.style.width = w + 'px';
    board.style.height = h + 'px';

    var fragment = document.createDocumentFragment();
    tiles.forEach(function(tile) {
      var el = document.createElement('div');
      el.className = 'tm-tile';
      el.dataset.id = tile.id;
      el.style.width = (CELL_W * 2) + 'px';
      el.style.height = (CELL_H * 2 + CELL_DEPTH) + 'px';
      el.style.left = ((tile.col - minCol) * CELL_W) + 'px';
      el.style.top = ((layerCount - tile.layer - 1) * CELL_DEPTH + (tile.row - minRow) * CELL_H) + 'px';
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
        (function(idx) {
          slot.addEventListener('click', function() { onRemoveSlotClick(idx); });
        })(i);
      }
      slots.appendChild(slot);
    }
  }

  // 제거 큐의 슬롯 클릭 → 해당 타일을 다시 버퍼로 가져옴
  function onRemoveSlotClick(idx) {
    if (idx < 0 || idx >= removedQueue.length) return;
    if (buffer.length >= BUFFER_SIZE) return;
    var entry = removedQueue[idx];
    if (!entry) return;
    removedQueue.splice(idx, 1);
    buffer.push({ value: entry.value });
    buffer.sort(function(a, b) { return a.value - b.value; });
    eliminateMatches();
    // 제거 큐에서 가져온 동작 후엔 되돌리기 차단 (대상 타일이 다름)
    lastPick = null;
    canUndo = false;
    renderBuffer();
    renderRemoveQueue();
    updateItemButtons();
    updateStatus();
    checkEnd();
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

  // 사용자 요청 — 남은 타일 수를 노출하지 않음. 함수는 호출 호환을 위해 유지.
  function updateStatus() {}

  function checkEnd() {
    var remaining = tiles.filter(function(t) { return !t.removed; }).length;
    if (remaining === 0 && buffer.length === 0) {
      gameOver = true;
      showOverlay('🎉', '클리어! ' + totalTiles + '개의 타일을 모두 비웠습니다.');
      return;
    }
    if (buffer.length >= BUFFER_SIZE) {
      gameOver = true;
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

  window.TileMatch = {
    initPage: initPage,
    // 디버그/캡처용 — 특정 난이도로 다이얼로그 안에서 새 게임 시작
    _startWithDifficulty: function(d) {
      if (loading) return;
      currentDifficulty = d;
      $('tm-dialog-overlay').style.display = '';
      document.body.style.overflow = 'hidden';
      hideOverlay();
      level = generateLevel(d);
      buildBoard();
    },
    // 디버그/검증용 — 임의 파라미터로 새 게임 시작
    _startCustom: function(p) {
      if (loading) return;
      $('tm-dialog-overlay').style.display = '';
      document.body.style.overflow = 'hidden';
      hideOverlay();
      level = generateCustomLevel(p.cols || 12, p.rows || 9, p.layers || 5, p.sets || 12);
      buildBoard();
    },
    // 검증용 — 현재 보드의 모든 타일 데이터
    _getTiles: function() {
      return tiles.map(function(t) {
        return { id: t.id, col: t.col, row: t.row, layer: t.layer, removed: t.removed };
      });
    },
    // 검증용 — 코드의 isActive 결과
    _isActive: function(id) {
      for (var i = 0; i < tiles.length; i++) {
        if (tiles[i].id === id) return isActive(tiles[i]);
      }
      return null;
    }
  };

})();
