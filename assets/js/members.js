// ===== 연맹원 관리 (Supabase CRUD + Kingshot API) =====

(function() {
  'use strict';

  if (typeof SUPABASE_URL === 'undefined') return;

  var PLAYER_API = SUPABASE_URL + '/functions/v1/player-info';
  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var listEl = document.getElementById('members-list');

  // ===== 킹샷 API 호출 (캐싱) =====
  var CACHE_TTL = 10 * 60 * 1000;

  function getCached(playerId) {
    try {
      var raw = sessionStorage.getItem('player_' + playerId);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (Date.now() - cached.ts > CACHE_TTL) {
        sessionStorage.removeItem('player_' + playerId);
        return null;
      }
      return cached.data;
    } catch(e) { return null; }
  }

  function setCache(playerId, data) {
    try {
      sessionStorage.setItem('player_' + playerId, JSON.stringify({ data: data, ts: Date.now() }));
    } catch(e) {}
  }

  function fetchPlayerInfo(playerId, skipCache) {
    if (!skipCache) {
      var cached = getCached(playerId);
      if (cached) return Promise.resolve(cached);
    }
    return fetch(PLAYER_API + '?playerId=' + encodeURIComponent(playerId))
      .then(function(r) {
        if (r.status === 429) throw new Error('API 요청 제한 (분당 6회). 잠시 후 다시 시도하세요.');
        if (r.status === 400) throw new Error('유효하지 않은 Player ID입니다.');
        if (!r.ok) throw new Error('API 오류 (' + r.status + ')');
        return r.json();
      })
      .then(function(json) {
        if (json.status !== 'success' || !json.data) {
          throw new Error(json.message || 'API 조회 실패');
        }
        setCache(playerId, json.data);
        return json.data;
      });
  }

  // ===== 필터 초기화 =====
  var filterSelect = document.getElementById('filter-level');
  for (var i = 30; i >= 1; i--) {
    var opt = document.createElement('option');
    opt.value = i;
    opt.textContent = 'Lv.' + i;
    filterSelect.appendChild(opt);
  }
  filterSelect.addEventListener('change', function() { renderMembers(); });

  var allMembers = [];

  // ===== 목록 조회 =====
  function loadMembers() {
    listEl.innerHTML = '<div class="empty-cell">로딩 중...</div>';
    sb.from('members').select('*').order('alliance_rank', { ascending: false }).order('level', { ascending: false })
      .then(function(res) {
        if (res.error) {
          listEl.innerHTML = '<div class="empty-cell">오류: ' + res.error.message + '</div>';
          return;
        }
        if (!res.data || res.data.length === 0) {
          listEl.innerHTML = '<div class="empty-cell">등록된 연맹원이 없습니다</div>';
          document.getElementById('member-count').textContent = '';
          return;
        }

        allMembers = res.data;
        membersData = {};
        res.data.forEach(function(m) { membersData[m.id] = m; });
        renderMembers();
      });
  }

  function renderMembers() {
    var minLevel = parseInt(filterSelect.value, 10) || 0;
    var filtered = allMembers.filter(function(m) { return (m.level || 0) >= minLevel; });

    document.getElementById('member-count').textContent = '전체 ' + filtered.length + '명' +
      (minLevel > 0 ? ' (Lv.' + minLevel + ' 이상)' : '');

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-cell">조건에 맞는 연맹원이 없습니다</div>';
      return;
    }

    var thead = '<div class="members-thead">' +
      '<div></div><div>닉네임</div><div>등급</div><div>레벨</div><div>서버</div><div>메모</div><div></div>' +
      '</div>';

        var rows = filtered.map(function(m) {
          var rank = m.alliance_rank || 'R1';
          var lvl = m.level || 0;

          // 프로필 이미지 (레벨별 테두리 래퍼)
          var lvClass = lvl >= 30 ? ' lv-30' : lvl === 29 ? ' lv-29' : lvl === 28 ? ' lv-28' : '';
          var avatarInner = m.profile_photo
            ? '<img src="' + esc(m.profile_photo) + '" class="mc-photo">'
            : '<div class="mc-photo-empty">' + esc(m.nickname).charAt(0) + '</div>';
          var avatar = '<div class="mc-photo-wrap' + lvClass + '">' + avatarInner + '</div>';

          var memoFull = m.memo ? esc(m.memo) : '';
          var memoPc = memoFull.length > 20 ? memoFull.slice(0, 20) + '…' : (memoFull || '<span class="mc-memo-empty">-</span>');
          var memoMb = memoFull.length > 10 ? memoFull.slice(0, 10) + '…' : memoFull;
          var memoDisplay = '<span class="memo-pc">' + memoPc + '</span><span class="memo-mb">' + memoMb + '</span>';

          var sub = rank + ' · Lv.' + (lvl || '?') + ' · ' + (m.kingdom || '?');
          if (memoMb) sub += ' · ' + memoMb;

          return '<div class="member-row rank-' + rank + '" data-id="' + m.id + '">' +
            avatar +
            '<div class="mc-row-body">' +
              '<div class="mc-name">' + esc(m.nickname) + '</div>' +
              '<div class="mc-sub">' + sub + '</div>' +
            '</div>' +
            '<div class="mc-rank-cell">' + rank + '</div>' +
            '<div class="mc-level">Lv.' + (lvl || '?') + '</div>' +
            '<div class="mc-kingdom">' + (m.kingdom || '?') + '</div>' +
            '<div class="mc-memo-cell">' + memoDisplay + '</div>' +
            '<button class="mc-manage-btn" onclick="Members.openDialog(\'' + m.id + '\')" title="관리">⋮</button>' +
          '</div>';
        }).join('');

        listEl.innerHTML = thead + rows;
  }

  var membersData = {};

  // ===== 관리 다이얼로그 =====
  var dialogOverlay = document.getElementById('manage-dialog-overlay');
  var currentDialogId = null;

  function openDialog(id) {
    var m = membersData[id];
    if (!m) return;
    currentDialogId = id;

    // 프로필 세팅
    var rank = m.alliance_rank || 'R1';
    var lvl = m.level || 0;
    var lvClass = lvl >= 30 ? ' lv-30' : lvl === 29 ? ' lv-29' : lvl === 28 ? ' lv-28' : '';

    // 프로필 영역에 등급 배경 적용
    var profileEl = document.querySelector('.md-profile');
    profileEl.className = 'md-profile rank-' + rank;

    // 아바타에 레벨 테두리 적용
    var avatarEl = document.getElementById('md-avatar');
    if (m.profile_photo) {
      avatarEl.className = 'md-photo-wrap' + lvClass;
      avatarEl.innerHTML = '<img src="' + esc(m.profile_photo) + '">';
    } else {
      avatarEl.className = 'md-photo-wrap' + lvClass;
      avatarEl.innerHTML = '<div class="md-avatar-empty">' + esc(m.nickname).charAt(0) + '</div>';
    }
    document.getElementById('md-name').textContent = m.nickname;
    document.getElementById('md-id').textContent = 'ID: ' + m.kingshot_id;
    document.getElementById('md-meta').textContent = 'Lv.' + (lvl || '?') + ' · ' + (m.kingdom || '?');
    document.getElementById('md-rank').value = m.alliance_rank || 'R1';
    document.getElementById('md-memo').value = m.memo || '';

    dialogOverlay.classList.add('open');
  }

  function closeDialog() {
    dialogOverlay.classList.remove('open');
    currentDialogId = null;
  }

  document.getElementById('md-close').addEventListener('click', closeDialog);
  dialogOverlay.addEventListener('click', function(e) {
    if (e.target === dialogOverlay) closeDialog();
  });

  // 저장 (메모)
  document.getElementById('md-save').addEventListener('click', function() {
    if (!currentDialogId) return;
    var memo = document.getElementById('md-memo').value.trim();
    var rank = document.getElementById('md-rank').value;
    sb.from('members').update({ memo: memo || null, alliance_rank: rank }).eq('id', currentDialogId)
      .then(function(res) {
        if (res.error) { alert('저장 실패: ' + res.error.message); return; }
        closeDialog();
        loadMembers();
      });
  });

  // 갱신 (API 재조회)
  document.getElementById('md-refresh').addEventListener('click', function() {
    if (!currentDialogId) return;
    var m = membersData[currentDialogId];
    if (!m) return;
    var btn = document.getElementById('md-refresh');
    btn.textContent = '갱신 중...';
    btn.disabled = true;

    fetchPlayerInfo(m.kingshot_id, true)
      .then(function(data) {
        return sb.from('members').update({
          nickname: data.name,
          level: parseInt(data.level, 10) || 0,
          kingdom: data.kingdom || null,
          profile_photo: data.profilePhoto || null
        }).eq('id', currentDialogId);
      })
      .then(function(res) {
        if (res.error) { alert('갱신 실패: ' + res.error.message); return; }
        closeDialog();
        loadMembers();
      })
      .catch(function(err) { alert('갱신 실패: ' + err.message); })
      .finally(function() { btn.textContent = '정보 갱신'; btn.disabled = false; });
  });

  // 삭제
  document.getElementById('md-delete').addEventListener('click', function() {
    if (!currentDialogId) return;
    var m = membersData[currentDialogId];
    if (!confirm(m.nickname + '을(를) 삭제하시겠습니까?')) return;
    sb.from('members').delete().eq('id', currentDialogId)
      .then(function(res) {
        if (res.error) { alert('삭제 실패: ' + res.error.message); return; }
        closeDialog();
        loadMembers();
      });
  });

  // ===== 등록 모달 =====
  var modal = document.getElementById('modal-overlay');
  var searchData = null;

  document.getElementById('btn-add-member').addEventListener('click', function() {
    document.getElementById('input-kingshot-id').value = '';
    document.getElementById('input-memo').value = '';
    document.getElementById('search-result').style.display = 'none';
    document.getElementById('btn-modal-save').disabled = true;
    modal.classList.add('open');
  });

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', function(e) {
    if (e.target === modal) closeModal();
  });

  function closeModal() { modal.classList.remove('open'); }

  document.getElementById('btn-search-id').addEventListener('click', function() {
    var kingshotId = document.getElementById('input-kingshot-id').value.trim();
    if (!kingshotId) return;

    var btn = document.getElementById('btn-search-id');
    btn.textContent = '조회 중...';
    btn.disabled = true;
    document.getElementById('search-result').style.display = 'none';

    fetchPlayerInfo(kingshotId)
      .then(function(data) {
        searchData = {
          kingshot_id: data.playerId,
          nickname: data.name,
          level: parseInt(data.level, 10) || 0,
          kingdom: data.kingdom || null,
          profile_photo: data.profilePhoto || null
        };
        document.getElementById('res-nickname').textContent = searchData.nickname;
        document.getElementById('res-level').textContent = searchData.level;
        document.getElementById('res-kingdom').textContent = searchData.kingdom || '-';
        var photo = document.getElementById('res-photo');
        if (searchData.profile_photo) {
          photo.src = searchData.profile_photo;
          photo.style.display = '';
        } else {
          photo.style.display = 'none';
        }
        document.getElementById('search-result').style.display = '';
        document.getElementById('btn-modal-save').disabled = false;
      })
      .catch(function(err) {
        alert('조회 실패: ' + err.message);
        searchData = null;
        document.getElementById('btn-modal-save').disabled = true;
      })
      .finally(function() { btn.textContent = '조회'; btn.disabled = false; });
  });

  document.getElementById('btn-modal-save').addEventListener('click', function() {
    if (!searchData) { alert('먼저 킹샷 ID를 조회하세요.'); return; }
    var memo = document.getElementById('input-memo').value.trim();
    sb.from('members').insert({
      kingshot_id: searchData.kingshot_id,
      nickname: searchData.nickname,
      level: searchData.level,
      kingdom: searchData.kingdom,
      profile_photo: searchData.profile_photo,
      memo: memo || null
    }).then(function(res) {
      if (res.error) {
        if (res.error.message.indexOf('duplicate') !== -1 || res.error.message.indexOf('unique') !== -1) {
          alert('이미 등록된 킹샷 ID입니다.');
        } else { alert('저장 실패: ' + res.error.message); }
        return;
      }
      searchData = null;
      closeModal();
      loadMembers();
    });
  });

  // ===== 유틸 =====
  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ===== 초기화 =====
  var loaded = false;
  var observer = new MutationObserver(function() {
    var manageTab = document.getElementById('tab-manage');
    if (manageTab && manageTab.classList.contains('active') && !loaded) {
      loaded = true;
      loadMembers();
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

  window.Members = {
    openDialog: openDialog,
    reload: loadMembers
  };

})();
