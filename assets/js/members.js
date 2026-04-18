// ===== 연맹원 관리 (Supabase CRUD + Kingshot API) =====

(function() {
  'use strict';

  if (typeof SUPABASE_URL === 'undefined') return;

  var PLAYER_API = SUPABASE_URL + '/functions/v1/player-info';
  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var modal = document.getElementById('modal-overlay');
  var tbody = document.getElementById('members-tbody');

  // ===== 킹샷 API 호출 (Supabase Edge Function 프록시) =====
  function fetchPlayerInfo(playerId) {
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
        return json.data;
      });
  }

  // ===== 목록 조회 =====
  function loadMembers() {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">로딩 중...</td></tr>';
    sb.from('members').select('*').order('created_at', { ascending: true })
      .then(function(res) {
        if (res.error) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">오류: ' + res.error.message + '</td></tr>';
          return;
        }
        if (!res.data || res.data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">등록된 연맹원이 없습니다</td></tr>';
          return;
        }
        tbody.innerHTML = res.data.map(function(m) {
          var avatar = m.profile_photo
            ? '<img src="' + esc(m.profile_photo) + '" class="member-avatar">'
            : '<span class="member-avatar-placeholder">?</span>';
          return '<tr data-id="' + m.id + '">' +
            '<td class="cell-name">' + avatar + '<strong>' + esc(m.nickname) + '</strong></td>' +
            '<td>' + (m.level || '-') + '</td>' +
            '<td>' + (m.kingdom || '-') + '</td>' +
            '<td>' + formatNum(m.power) + '</td>' +
            '<td>' + esc(m.memo || '') + '</td>' +
            '<td><div class="manage-actions">' +
              '<button class="btn-icon" onclick="Members.refresh(\'' + m.id + '\',\'' + esc(m.kingshot_id) + '\')" title="갱신">&#x21bb;</button>' +
              '<button class="btn-icon danger" onclick="Members.remove(\'' + m.id + '\')" title="삭제">&#x2715;</button>' +
            '</div></td></tr>';
        }).join('');
      });
  }

  // ===== 등록 모달 =====
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

  function closeModal() {
    modal.classList.remove('open');
  }

  // ===== 킹샷 ID 조회 =====
  var searchData = null;

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
        document.getElementById('res-level').textContent = 'Lv.' + searchData.level;
        document.getElementById('res-power').textContent = searchData.kingdom ? 'K' + searchData.kingdom : '-';
        document.getElementById('search-result').style.display = '';
        document.getElementById('btn-modal-save').disabled = false;
      })
      .catch(function(err) {
        alert('조회 실패: ' + err.message);
        searchData = null;
        document.getElementById('btn-modal-save').disabled = true;
      })
      .finally(function() {
        btn.textContent = '조회';
        btn.disabled = false;
      });
  });

  // ===== 저장 =====
  document.getElementById('btn-modal-save').addEventListener('click', function() {
    if (!searchData) {
      alert('먼저 킹샷 ID를 조회하세요.');
      return;
    }
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
        } else {
          alert('저장 실패: ' + res.error.message);
        }
        return;
      }
      searchData = null;
      closeModal();
      loadMembers();
    });
  });

  // ===== 갱신 (API 재조회 → DB 업데이트) =====
  function refreshMember(id, kingshotId) {
    fetchPlayerInfo(kingshotId)
      .then(function(data) {
        return sb.from('members').update({
          nickname: data.name,
          level: parseInt(data.level, 10) || 0,
          kingdom: data.kingdom || null,
          profile_photo: data.profilePhoto || null
        }).eq('id', id);
      })
      .then(function(res) {
        if (res.error) {
          alert('갱신 실패: ' + res.error.message);
          return;
        }
        loadMembers();
      })
      .catch(function(err) {
        alert('갱신 실패: ' + err.message);
      });
  }

  // ===== 삭제 =====
  function removeMember(id) {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    sb.from('members').delete().eq('id', id)
      .then(function(res) {
        if (res.error) {
          alert('삭제 실패: ' + res.error.message);
          return;
        }
        loadMembers();
      });
  }

  // ===== 유틸 =====
  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatNum(n) {
    if (!n) return '-';
    return Number(n).toLocaleString();
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
    refresh: refreshMember,
    remove: removeMember,
    reload: loadMembers
  };

})();
