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
 */
(function() {
  'use strict';

  // ===== 상수 =====

  var LEVEL_URL = (window.location.pathname.replace(/\/[^/]*$/, '') || '') + '/assets/data/tile-match-level.json';
  // Jekyll baseurl 대응: 단순화. 사실 기본 URL은 / 이므로 절대 경로로 안전 처리.
  var LEVEL_URL_ABS = '/assets/data/tile-match-level.json';

  // 타일 모양 (이모지) — 각 타일은 0..N-1 의 value 를 가짐
  var TILE_SHAPES = [
    '🐶', '🐱', '🐰', '🐻', '🐼', '🦁', '🐯', '🐸',
    '🐵', '🐔', '🐧', '🐦', '🐢', '🐍', '🐠', '🐳'
  ];

  // 셀 크기 (px). 타일 자체는 2x2 셀 = 36x44 + 깊이.
  var CELL_W = 18;
  var CELL_H = 22;
  var CELL_DEPTH = 6;
  var BUFFER_SIZE = 7;
  var MATCH_COUNT = 3;

  // ===== 상태 =====

  var level = null;          // { cols, rows, stageLayers, ... }
  var tiles = [];            // [{ id, value, layer, col, row, removed, el }]
  var buffer = [];           // [{ value, el }]  (length up to BUFFER_SIZE)
  var totalTiles = 0;
  var initialized = false;
  var loading = false;

  // ===== DOM refs =====

  function $(id) { return document.getElementById(id); }

  // ===== 페이지 진입 시 한 번만 호출 =====

  function initPage() {
    if (initialized) return;
    initialized = true;
    $('tm-restart').addEventListener('click', startNewGame);
    $('tm-overlay-restart').addEventListener('click', startNewGame);
    startNewGame();
  }

  function startNewGame() {
    if (loading) return;
    hideOverlay();
    if (level) {
      // 이미 로드되어 있으면 재배치만
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

    // 1) 모든 stageTile 수집
    var stageTiles = [];
    stageLayers.forEach(function(layer) {
      (layer.tiles || []).forEach(function(t) { stageTiles.push(t); });
    });
    totalTiles = stageTiles.length;

    // 2) 값(value) 큐 생성: matchCount 묶음씩 같은 value 채우고, TILE_SHAPES 길이 모자라면 순환
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

    // 3) 레이어를 아래→위 순으로, 각 레이어 내 위치 셔플 후 큐에서 값 할당
    //    GamePlay.fillTiles 와 동일하게 "지나치게 쉬워지는 대신 항상 풀 가능한" 알고리즘
    var sortedLayers = stageLayers.slice().sort(function(a, b) { return a.layer - b.layer; });
    tiles = [];
    var tileId = 0;
    var bufWindow = bufferSize * 2;  // 큐에서 무작위 선택할 윈도우 크기
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

    // 4) 버퍼 초기화
    buffer = [];

    renderBoard();
    renderBuffer();
    updateStatus();
  }

  // ===== 활성(active) 판정 — 자기 위 더 높은 레이어에 겹치는 타일이 있으면 비활성 =====

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
    // 보드 크기: tile 은 2 cell 너비/높이, depth 만큼 추가
    var w = (cols + 2) * CELL_W;
    var h = (rows + 2) * CELL_H + layerCount * CELL_DEPTH;
    board.style.width = w + 'px';
    board.style.height = h + 'px';

    var fragment = document.createDocumentFragment();
    // 아래 레이어가 위 레이어에 가려지도록 z-index = layer
    tiles.forEach(function(tile) {
      var el = document.createElement('div');
      el.className = 'tm-tile';
      el.dataset.id = tile.id;
      el.style.width = (CELL_W * 2) + 'px';
      el.style.height = (CELL_H * 2 + CELL_DEPTH) + 'px';
      el.style.left = (tile.col * CELL_W) + 'px';
      // 위층일수록 화면 위쪽으로 (layer 가 클수록 작은 y)
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
        tile.el.classList.add('tm-removed');
        return;
      }
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

  // ===== 타일 클릭 처리 =====

  function onTileClick(tile) {
    if (tile.removed || !isActive(tile)) return;
    // 1) 보드에서 제거 표시
    tile.removed = true;
    if (tile.el) tile.el.classList.add('tm-removing');

    // 2) 버퍼에 추가 후 동일 value 그룹 정렬
    buffer.push({ value: tile.value });
    buffer.sort(function(a, b) { return a.value - b.value; });

    // 3) 버퍼에서 연속된 같은 값 MATCH_COUNT 개 제거
    eliminateMatches();

    // 4) UI 갱신
    setTimeout(function() {
      if (tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
      refreshActiveStates();
      renderBuffer();
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

  function updateStatus() {
    var remaining = tiles.filter(function(t) { return !t.removed; }).length;
    $('tm-remaining').textContent = remaining;
    $('tm-total').textContent = totalTiles;
  }

  function checkEnd() {
    var remaining = tiles.filter(function(t) { return !t.removed; }).length;
    if (remaining === 0) {
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
