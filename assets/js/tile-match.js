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

  // 매 게임마다 16개 모양 중 하나가 랜덤 연맹원의 아바타로 교체됨 (재미 요소)
  var avatarTileValue = -1;     // 어떤 인덱스가 아바타로 대체될지 (0~15)
  var avatarTileUrl = null;     // 그 멤버의 profile_photo URL
  var avatarMemberName = null;  // 그 멤버의 nickname (보드 위 힌트용)

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

  // ===== Stage / 기록 =====
  var FN_AUTH_URL = SUPABASE_URL + '/functions/v1/tile-match-auth';
  var bestStage = 0;         // 인증된 사용자의 best_stage (서버 기록)
  var currentStage = 1;      // 이번 시도 stage (= bestStage + 1)
  var lastCleared = null;    // { stage, new_record, best_stage } — 결과 카드용

  // ===== DOM refs =====

  function $(id) { return document.getElementById(id); }

  // ===== 페이지 진입 시 한 번만 호출 =====

  function initPage() {
    if (!initialized) {
      initialized = true;
      $('tm-launch-btn').addEventListener('click', onLaunchClick);
      $('tm-dlg-close').addEventListener('click', requestClose);
      $('tm-overlay-restart').addEventListener('click', startNewGame);
      $('tm-overlay-quit').addEventListener('click', forceClose);
      $('tm-item-remove').addEventListener('click', useRemove);
      $('tm-item-undo').addEventListener('click', useUndo);
      $('tm-item-shuffle').addEventListener('click', useShuffle);
      var qrBtn = $('tm-shuffle-popup-qr');
      var cancelBtn = $('tm-shuffle-popup-cancel');
      if (qrBtn) qrBtn.addEventListener('click', onShufflePopupAction);
      if (cancelBtn) cancelBtn.addEventListener('click', onShufflePopupAction);
      window.addEventListener('resize', fitBoardToArea);
      setupViewportSync();
      setupBoardAreaObserver();

      var logoutBtn = $('tm-launch-user-logout');
      if (logoutBtn) logoutBtn.addEventListener('click', function() {
        if (window.TileMatchAuth) window.TileMatchAuth.clearSession();
        renderUserBadge(null);
        // 즉시 인증 다이얼로그 표시
        if (window.TileMatchAuth) window.TileMatchAuth.ensureAuth().then(renderUserBadge);
      });

      if (window.TileMatchAuth) {
        window.TileMatchAuth.initPage();
        window.TileMatchAuth.onSessionChange(function(s) {
          renderUserBadge(s);
          loadRanking();   // 본인 강조 갱신
        });
      }

      var refreshBtn = $('tm-ranking-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', loadRanking);
    }

    // 미니게임 탭 진입 시 인증 강제
    if (window.TileMatchAuth) {
      window.TileMatchAuth.ensureAuth().then(onSessionReady);
    }
    // 메인 페이지 진입 시 랭킹 로드
    loadRanking();
  }

  // 인증된 세션을 받았을 때 — 뱃지 + 서버 기록(best_stage) 조회 후 stage 표시 갱신.
  // 호출자가 게임 시작 전 await 할 수 있도록 Promise 반환 (최고 기록 동기화 후 시작 보장).
  function onSessionReady(session) {
    renderUserBadge(session);
    if (!session || !session.player_id) {
      bestStage = 0;
      currentStage = 1;
      renderStage();
      return Promise.resolve();
    }
    return callAuth('get-record', { player_id: session.player_id }).then(function(res) {
      bestStage = (res && res.ok) ? (res.best_stage || 0) : 0;
      currentStage = bestStage + 1;
      renderStage();
    });
  }

  function renderStage() {
    var el = $('tm-launch-stage');
    if (el) el.textContent = String(currentStage);
    var dlg = $('tm-dlg-stage');
    if (dlg) dlg.textContent = String(currentStage);
  }

  function renderUserBadge(session) {
    var box = $('tm-launch-user');
    var name = $('tm-launch-user-name');
    var idEl = $('tm-launch-user-id');
    if (!box || !name) return;
    if (session && session.player_id) {
      box.style.display = '';
      name.textContent = session.nickname;
      if (idEl) idEl.textContent = '(' + session.player_id + ')';
    } else {
      box.style.display = 'none';
    }
  }

  function onLaunchClick() {
    if (!window.TileMatchAuth) { openDialog(); return; }
    window.TileMatchAuth.ensureAuth().then(function(session) {
      if (!session) return;  // 사용자가 인증을 취소함
      // 인증 후 서버 기록(best_stage) 동기화 완료된 다음에 다이얼로그 오픈 →
      // 첫 게임이 stage 1 이 아니라 자신의 best+1 로 시작됨.
      onSessionReady(session).then(openDialog);
    });
  }

  // ===== Edge Function 호출 (auth + record 공용) =====
  // 503 BOOT_ERROR (cold start) 시 자동 재시도.
  function callAuth(action, body, retries) {
    retries = retries === undefined ? 2 : retries;
    return fetch(FN_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify(Object.assign({ action: action }, body))
    }).then(function(r) {
      if (r.status === 503 && retries > 0) {
        return new Promise(function(res) { setTimeout(res, 600); })
          .then(function() { return callAuth(action, body, retries - 1); });
      }
      return r.json();
    }).catch(function(err) {
      return { ok: false, error: String(err.message || err) };
    });
  }

  // ===== 랭킹 =====
  function fetchSupa(url) {
    return fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadRanking() {
    var box = $('tm-ranking-list');
    if (!box) return;
    box.innerHTML = '<div class="tm-ranking-empty">로딩 중...</div>';

    fetchSupa(SUPABASE_URL + '/rest/v1/tile_match_records?select=player_id,best_stage,total_clears,best_stage_at&order=best_stage.desc,best_stage_at.asc&limit=50')
      .then(function(records) {
        if (!records || !records.length) {
          box.innerHTML = '<div class="tm-ranking-empty">아직 기록이 없습니다 — 첫 클리어의 주인공이 되어보세요!</div>';
          return;
        }
        var ids = records.map(function(r) { return r.player_id; });
        return fetchSupa(
          SUPABASE_URL + '/rest/v1/members?kingshot_id=in.(' +
          ids.map(encodeURIComponent).join(',') + ')&select=kingshot_id,nickname,level,profile_photo'
        ).then(function(members) {
          var map = {};
          members.forEach(function(m) { map[m.kingshot_id] = m; });
          renderRanking(records, map);
        });
      })
      .catch(function(err) {
        box.innerHTML = '<div class="tm-ranking-empty">랭킹 조회 실패: ' + (err.message || err) + '</div>';
      });
  }

  function renderRanking(records, memberMap) {
    var box = $('tm-ranking-list');
    box.innerHTML = '';
    var session = window.TileMatchAuth && window.TileMatchAuth.getSession();
    var myId = session ? session.player_id : null;

    var frag = document.createDocumentFragment();
    records.forEach(function(r, i) {
      var rank = i + 1;
      var member = memberMap[r.player_id] || {};
      var row = document.createElement('div');
      row.className = 'tm-ranking-row';
      if (myId && r.player_id === myId) row.classList.add('tm-ranking-row-me');

      var rankClass = '';
      if (rank === 1) rankClass = 'gold';
      else if (rank === 2) rankClass = 'silver';
      else if (rank === 3) rankClass = 'bronze';

      // 1/2/3등 — 멤버 목록의 Lv.30/29/28 테두리 효과 동일 적용
      var effectClass = '';
      if (rank === 1) effectClass = ' rank-effect-1';
      else if (rank === 2) effectClass = ' rank-effect-2';
      else if (rank === 3) effectClass = ' rank-effect-3';

      var dateStr = r.best_stage_at ? formatRankingDate(r.best_stage_at) : '-';
      var photoInner = member.profile_photo
        ? '<img class="tm-rank-photo" src="' + escapeRankingHtml(member.profile_photo) + '" alt="">'
        : '<span class="tm-rank-photo tm-rank-photo-empty">' + escapeRankingHtml((member.nickname || '?').slice(0, 1).toUpperCase()) + '</span>';
      var photoHtml = '<div class="tm-rank-photo-wrap' + effectClass + '">' + photoInner + '</div>';
      row.innerHTML =
        '<span class="tm-rank-num ' + rankClass + '">' + rank + '</span>' +
        photoHtml +
        '<span class="tm-rank-name">' + escapeRankingHtml(member.nickname || r.player_id) +
        (member.level ? '<small>Lv.' + member.level + '</small>' : '') + '</span>' +
        '<span class="tm-rank-stage">' + r.best_stage + '<span> Stage</span></span>' +
        '<span class="tm-rank-meta">' + dateStr + '</span>';
      frag.appendChild(row);
    });
    box.appendChild(frag);
  }

  function formatRankingDate(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '-';
    var diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (diffSec < 30) return '방금 전';
    if (diffSec < 60) return diffSec + '초 전';
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + '분 전';
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + '시간 전';
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return diffDay + '일 전';
    var diffMon = Math.floor(diffDay / 30);
    if (diffMon < 12) return diffMon + '개월 전';
    return Math.floor(diffMon / 12) + '년 전';
  }

  function escapeRankingHtml(s) {
    return String(s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
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
    // 스테이지별 난이도 정책 (UI 에는 노출 X)
    //   1~10  : 난이도 1 고정 (입문)
    //  11~20  : 난이도 2 고정 (적응)
    //   21+   : 난이도 3~5 랜덤 (도전)
    currentDifficulty = difficultyForStage(currentStage);
    // 매 게임마다 16개 타일 모양 중 하나를 랜덤 연맹원 아바타로 대체 (재미 요소)
    pickAvatarTile();
    level = generateLevel(currentDifficulty);
    buildBoard();
  }

  function pickAvatarTile() {
    // 아바타 url + nickname 미리 결정. avatarTileValue 는 buildBoard 후
    // "보드에 실제 존재하는 value 중에서" 결정 (set 수가 16 미만이면 일부 value 미사용).
    avatarTileValue = -1;
    avatarTileUrl = null;
    avatarMemberName = null;
    var cached = (window.TileMatchAuth && window.TileMatchAuth._cachedMembers) || null;
    if (cached && cached.length) {
      var withPhotoCached = cached.filter(function(m) { return m && m.profile_photo; });
      if (withPhotoCached.length) {
        var picked = withPhotoCached[Math.floor(Math.random() * withPhotoCached.length)];
        avatarTileUrl = picked.profile_photo;
        avatarMemberName = picked.nickname || null;
      }
      return;
    }
    // fallback: 직접 fetch (nickname 도 함께)
    fetch(SUPABASE_URL + '/rest/v1/members?select=nickname,profile_photo&limit=200', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }
    }).then(function(r) { return r.json(); }).then(function(list) {
      var withPhoto = (list || []).filter(function(m) { return m && m.profile_photo; });
      if (!withPhoto.length) return;
      var picked = withPhoto[Math.floor(Math.random() * withPhoto.length)];
      avatarTileUrl = picked.profile_photo;
      avatarMemberName = picked.nickname || null;
      // 보드가 이미 그려졌고 avatarTileValue 가 결정됐다면 즉시 반영
      if (avatarTileValue >= 0) {
        refreshAvatarTiles();
        updateAvatarHint();
      }
    }).catch(function() {});
  }

  function updateAvatarHint() {
    var box = $('tm-avatar-hint');
    var nameEl = $('tm-avatar-hint-name');
    if (!box || !nameEl) return;
    if (avatarMemberName && avatarTileValue >= 0) {
      nameEl.textContent = avatarMemberName;
      box.style.display = '';
    } else {
      box.style.display = 'none';
    }
  }

  // buildBoard 끝에 호출 — 보드에 실제 존재하는 unique value 중 하나를 아바타로 마킹
  function assignAvatarValueFromBoard() {
    if (!avatarTileUrl || !tiles.length) {
      avatarTileValue = -1;
      return;
    }
    var seen = {};
    var values = [];
    tiles.forEach(function(t) {
      if (!seen[t.value]) { seen[t.value] = true; values.push(t.value); }
    });
    if (!values.length) { avatarTileValue = -1; return; }
    avatarTileValue = values[Math.floor(Math.random() * values.length)];
  }

  function refreshAvatarTiles() {
    if (!avatarTileUrl) return;
    tiles.forEach(function(t) {
      if (t.value === avatarTileValue && t.el) {
        var glyph = t.el.querySelector('.tm-tile-glyph');
        if (glyph) glyph.outerHTML = renderGlyph(t.value);
      }
    });
    // 버퍼 / 제거 큐 다시 그리기
    renderBuffer();
    renderRemoveQueue();
  }

  // 스테이지 → 난이도 매핑 (UI 에 노출하지 않음 — 사용자가 "난이도는 숨겨야 재미있다" 고 명시).
  // 5 스테이지마다 난이도 +1, 46 스테이지부터는 최고 난이도(10) 고정.
  function difficultyForStage(stage) {
    if (stage <= 0) return 1;
    if (stage >= 46) return 10;
    return Math.min(10, Math.floor((stage - 1) / 5) + 1);
  }

  // ===== 절차 생성 =====
  // 난이도별 파라미터 — sets 가 핵심 난이도(타일 수=sets*3). buffer=7 / match=3 고정에서
  // sets 를 등차 수열 가까이 늘려 체감 난이도가 의미 있게 증가하게 설계.
  // sets 증가: 5 → 7 → 9 → 12 → 15 → 18 → 22 → 26 → 30 → 34 (1차차분 2,2,3,3,3,4,4,4,4)
  // layers / cols / rows 도 함께 키워 보드가 단계적으로 풍성해짐.
  var DIFFICULTY_PARAMS = {
     1: { cols: 10, rows: 7,  layers: 3, sets: 5  },  //  15 tiles
     2: { cols: 10, rows: 7,  layers: 3, sets: 7  },  //  21 tiles
     3: { cols: 11, rows: 8,  layers: 4, sets: 9  },  //  27 tiles
     4: { cols: 12, rows: 9,  layers: 4, sets: 12 },  //  36 tiles
     5: { cols: 13, rows: 9,  layers: 5, sets: 15 },  //  45 tiles
     6: { cols: 14, rows: 10, layers: 5, sets: 18 },  //  54 tiles
     7: { cols: 15, rows: 10, layers: 6, sets: 22 },  //  66 tiles
     8: { cols: 16, rows: 11, layers: 6, sets: 26 },  //  78 tiles
     9: { cols: 17, rows: 12, layers: 7, sets: 30 },  //  90 tiles
    10: { cols: 18, rows: 13, layers: 7, sets: 34 }   // 102 tiles
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

    // 보드에 실제 존재하는 value 중에서 아바타 타일 value 결정
    assignAvatarValueFromBoard();

    renderBoard();
    renderBuffer();
    renderRemoveQueue();
    updateItemButtons();
    updateStatus();
    updateAvatarHint();  // 누구의 아바타가 끼어있는지 보드 위에 표시
    // 보드 영역 layout 이 잡힌 다음 fit
    requestAnimationFrame(fitBoardToArea);
  }

  // ===== 모바일 브라우저 chrome 변화 대응 =====
  // visualViewport.resize 가 가장 빠르게 잡히는 신호. CSS 변수 --vh-real 동기화.
  function setupViewportSync() {
    function sync() {
      var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      document.documentElement.style.setProperty('--vh-real', h + 'px');
      // viewport 변화는 보드 영역 크기 변화로도 이어짐 → 즉시 fit
      fitBoardToArea();
    }
    sync();
    window.addEventListener('resize', sync);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', sync);
      window.visualViewport.addEventListener('scroll', sync);
    }
  }

  // 보드 영역(.tm-board-area) 크기가 어떤 이유로든 변하면 자동 fit.
  // 제거 큐 토글 / chrome 변화 / orientation 등을 한 번에 커버.
  var _boardAreaObserver = null;
  function setupBoardAreaObserver() {
    if (_boardAreaObserver || typeof ResizeObserver === 'undefined') return;
    var area = document.querySelector('.tm-board-area');
    if (!area) return;
    _boardAreaObserver = new ResizeObserver(function() { fitBoardToArea(); });
    _boardAreaObserver.observe(area);
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
      el.innerHTML = renderGlyph(tile.value);
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
        slot.innerHTML = renderGlyph(entry.value);
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
        slot.innerHTML = renderGlyph(entry.value);
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
    // 제거 큐가 비워져 보드 영역이 다시 커지면 보드도 즉시 확대
    requestAnimationFrame(fitBoardToArea);
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
    // 제거 큐 노출로 보드 영역이 줄어들면 보드도 즉시 축소 — ResizeObserver 가 잡지만 보수적으로도 호출.
    requestAnimationFrame(fitBoardToArea);
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
  // 클릭 시 농담 결제 안내 팝업 → 어떤 버튼을 누르든 농담 토스트 + 실제 셔플 실행.
  function useShuffle() {
    if (freeUses.shuffle <= 0) return;
    var remaining = tiles.filter(function(t) { return !t.removed; });
    if (remaining.length <= 1) return;
    showShufflePopup();
  }

  function showShufflePopup() {
    var p = $('tm-shuffle-popup');
    if (p) p.style.display = '';
  }

  function hideShufflePopup() {
    var p = $('tm-shuffle-popup');
    if (p) p.style.display = 'none';
  }

  function onShufflePopupAction() {
    hideShufflePopup();
    showToast('농담입니다 껄.껄.껄');
    actuallyShuffle();
  }

  function actuallyShuffle() {
    if (freeUses.shuffle <= 0) return;
    var remaining = tiles.filter(function(t) { return !t.removed; });
    if (remaining.length <= 1) return;
    var values = remaining.map(function(t) { return t.value; });
    shuffleInPlace(values);
    remaining.forEach(function(t, i) {
      t.value = values[i];
      if (t.el) {
        // 아바타 타일과 일반 글리프 모두 안전하게 교체 — 통째로 다시 렌더
        var glyph = t.el.querySelector('.tm-tile-glyph');
        if (glyph) glyph.outerHTML = renderGlyph(t.value);
      }
    });
    freeUses.shuffle--;
    lastPick = null;
    canUndo = false;
    updateItemButtons();
  }

  var _toastTimer = null;
  function showToast(msg) {
    var el = $('tm-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('tm-toast-show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function() {
      el.classList.remove('tm-toast-show');
      _toastTimer = null;
    }, 1500);
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
      onClear();
      return;
    }
    if (buffer.length >= BUFFER_SIZE) {
      gameOver = true;
      showOverlay('💥', '슬롯이 가득 찼습니다.', false);
    }
  }

  // 클리어 시 — DB 기록 + 결과 카드
  function onClear() {
    var session = window.TileMatchAuth && window.TileMatchAuth.getSession();
    var clearedStage = currentStage;
    if (session && session.player_id) {
      // 일단 결과 카드 즉시 표시 (서버 응답 대기 X)
      showOverlay('🎉', 'Stage ' + clearedStage + ' 클리어!', true);
      callAuth('record-clear', { player_id: session.player_id, stage: clearedStage }).then(function(res) {
        if (!res || !res.ok) return;
        bestStage = res.best_stage || bestStage;
        lastCleared = { stage: clearedStage, new_record: !!res.new_record, best_stage: bestStage };
        // 결과 카드 메시지는 'Stage X 클리어!' 로 통일 — 최고기록 갱신 강조 문구는 노출하지 않음.
        // 다음 도전 stage 는 best+1
        currentStage = bestStage + 1;
        renderStage();
        // 랭킹 갱신
        loadRanking();
      });
    } else {
      showOverlay('🎉', 'Stage ' + clearedStage + ' 클리어!', true);
    }
  }

  function showOverlay(icon, msg, isSuccess) {
    $('tm-overlay-icon').textContent = icon;
    $('tm-overlay-msg').textContent = msg;
    $('tm-overlay').style.display = '';
    var primaryBtn = $('tm-overlay-restart');
    if (primaryBtn) primaryBtn.textContent = isSuccess ? '다음 단계' : '다시 하기';
  }

  function hideOverlay() {
    var ov = $('tm-overlay');
    if (ov) ov.style.display = 'none';
  }

  // ===== util =====

  function renderGlyph(value) {
    if (value === avatarTileValue && avatarTileUrl) {
      // wrapper span 안에 img — 부모 flex container 로 자동 중앙 정렬
      return '<span class="tm-tile-glyph"><img class="tm-tile-avatar" src="' + avatarTileUrl + '" alt=""></span>';
    }
    return '<span class="tm-tile-glyph">' + TILE_SHAPES[value] + '</span>';
  }

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
      pickAvatarTile();
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
    },
    // 검증용 — 모든 타일 즉시 클리어 (DB 기록 흐름 e2e 테스트)
    _autoClear: function() {
      if (!tiles || !tiles.length) return;
      tiles.forEach(function(t) { t.removed = true; });
      buffer = [];
      checkEnd();
    },
    // 검증용 — 버퍼 강제로 가득 채워서 실패 트리거
    _autoFail: function() {
      buffer = [];
      for (var i = 0; i < BUFFER_SIZE; i++) buffer.push({ value: i });
      checkEnd();
    }
  };

})();
