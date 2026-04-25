/**
 * @fileoverview 연맹원 관리 모듈
 * Supabase DB와 centurygame API를 통해 연맹원 CRUD를 처리합니다.
 * @requires Utils - 공통 유틸리티 (utils.js)
 * @requires supabase - Supabase JS SDK
 */

(function() {
  'use strict';

  if (typeof SUPABASE_URL === 'undefined') return;

  var REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var listEl = document.getElementById('members-list');
  var allMembers = [];
  var membersData = {};

  // ===== 플레이어 조회 =====

  /**
   * centurygame API를 통해 플레이어 정보를 조회합니다.
   * @param {string} playerId - 킹샷 플레이어 ID
   * @returns {Promise<Object>} 플레이어 정보 {playerId, name, level, kingdom, profilePhoto}
   */
  function fetchPlayerInfo(playerId) {
    return fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'player', fid: playerId })
    })
    .then(function(r) {
      if (!r.ok) throw new Error('API 오류 (' + r.status + ')');
      return r.json();
    })
    .then(function(json) {
      if (json.code !== 0 || !json.data) {
        throw new Error(json.msg || 'API 조회 실패');
      }
      return {
        playerId: String(json.data.fid),
        name: json.data.nickname,
        level: json.data.stove_lv || json.data.stove_lv_content || 0,
        kingdom: json.data.kid || null,
        profilePhoto: json.data.avatar_image || null
      };
    });
  }

  // ===== 필터 / 정렬 초기화 =====

  var filterSelect = document.getElementById('filter-level');
  for (var i = 30; i >= 1; i--) {
    var opt = document.createElement('option');
    opt.value = i;
    opt.textContent = 'Lv.' + i;
    filterSelect.appendChild(opt);
  }
  filterSelect.addEventListener('change', function() { renderMembers(); });

  /**
   * 전투력을 표시용 문자열로 변환. 1M 이상은 "XX.XM" 형태.
   */
  function formatPower(n) {
    n = Number(n) || 0;
    if (n >= 1000000) {
      var m = n / 1000000;
      return (m >= 100 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, '') + 'M';
    }
    return n.toLocaleString('ko-KR');
  }

  // 연맹 랭크 가중치 (정렬용)
  var RANK_WEIGHT = { R5: 5, R4: 4, R3: 3, R2: 2, R1: 1 };

  // ===== 목록 =====

  /**
   * Supabase에서 연맹원 목록을 조회하고 렌더링합니다.
   * 등급 내림차순 → 레벨 내림차순으로 정렬됩니다.
   */
  function loadMembers() {
    listEl.innerHTML = '<div class="empty-cell">로딩 중...</div>';
    sb.from('members').select('*')
      .order('power', { ascending: false })
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
        // Power-desc ordering defines alliance-internal rank (1..N)
        res.data.forEach(function(m, idx) {
          m.alliance_rank_pos = idx + 1;
          membersData[m.id] = m;
        });
        renderMembers();
      });
  }

  /**
   * 필터링된 연맹원 목록을 HTML로 렌더링합니다.
   * 최소 레벨 필터를 적용하고, 테이블 헤더 + 행을 생성합니다.
   */
  function renderMembers() {
    var minLevel = parseInt(filterSelect.value, 10) || 0;
    var failedData = getFailedRefresh();
    var failedSet = {};
    if (failedData && failedData.ids) {
      failedData.ids.forEach(function(id) { failedSet[id] = true; });
    }

    var filtered = allMembers.filter(function(m) { return (m.level || 0) >= minLevel; });

    // 고정 우선순위 정렬: 등급 → 전투력 → 레벨 (모두 내림차순)
    filtered.sort(function(a, b) {
      var ra = RANK_WEIGHT[a.alliance_rank] || 0;
      var rb = RANK_WEIGHT[b.alliance_rank] || 0;
      if (ra !== rb) return rb - ra;
      if ((b.power || 0) !== (a.power || 0)) return (b.power || 0) - (a.power || 0);
      return (b.level || 0) - (a.level || 0);
    });

    document.getElementById('member-count').textContent = '전체 ' + filtered.length + '명' +
      (minLevel > 0 ? ' (Lv.' + minLevel + ' 이상)' : '');

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-cell">조건에 맞는 연맹원이 없습니다</div>';
      return;
    }

    var thead = '<div class="members-thead">' +
      '<div></div><div>닉네임</div><div>등급</div><div>레벨</div>' +
      '<div>랭킹</div><div>전투력</div><div></div>' +
      '</div>';

    var rows = filtered.map(function(m) {
      var rank = m.alliance_rank || 'R1';
      var lvl = m.level || 0;
      var lvClass = Utils.getLevelClass(lvl);
      var pos = m.alliance_rank_pos || '-';
      var powerStr = m.power ? formatPower(m.power) : '-';

      var avatarInner = m.profile_photo
        ? '<img src="' + Utils.esc(m.profile_photo) + '" class="mc-photo">'
        : '<div class="mc-photo-empty">' + Utils.esc(m.nickname).charAt(0) + '</div>';
      var avatar = '<div class="mc-photo-wrap' + lvClass + '">' + avatarInner + '</div>';

      var sub = rank + ' · Lv.' + (lvl || '?') + ' · ⚔ ' + powerStr + ' · ' + (m.kingdom || '?');
      var isFailed = !!failedSet[m.id];
      var failedClass = isFailed ? ' member-row-failed' : '';
      var failBadge = isFailed ? '<span class="mc-fail-badge" title="갱신 실패 — 재시도 필요">⚠</span>' : '';

      return '<div class="member-row rank-' + rank + failedClass + '" data-id="' + m.id + '">' +
        avatar +
        '<div class="mc-row-body">' +
          '<div class="mc-name">' + Utils.esc(m.nickname) + failBadge + '</div>' +
          '<div class="mc-sub">' + sub + '</div>' +
        '</div>' +
        '<div class="mc-rank-cell">' + rank + '</div>' +
        '<div class="mc-level">Lv.' + (lvl || '?') + '</div>' +
        '<div class="mc-pos">' + pos + '</div>' +
        '<div class="mc-power">' + powerStr + '</div>' +
        '<button class="mc-manage-btn" onclick="Members.openDialog(\'' + m.id + '\')" title="관리">⋮</button>' +
      '</div>';
    }).join('');

    listEl.innerHTML = thead + rows;
    syncRefreshBanner();
  }

  // ===== 관리 다이얼로그 =====

  var dialogOverlay = document.getElementById('manage-dialog-overlay');
  var currentDialogId = null;

  /**
   * 연맹원 관리 다이얼로그를 엽니다.
   * @param {string} id - 연맹원 DB ID (UUID)
   */
  function openDialog(id) {
    var m = membersData[id];
    if (!m) return;
    currentDialogId = id;

    var rank = m.alliance_rank || 'R1';
    var lvl = m.level || 0;
    var lvClass = Utils.getLevelClass(lvl);

    document.querySelector('.md-profile').className = 'md-profile rank-' + rank;

    var avatarEl = document.getElementById('md-avatar');
    avatarEl.className = 'md-photo-wrap' + lvClass;
    avatarEl.innerHTML = m.profile_photo
      ? '<img src="' + Utils.esc(m.profile_photo) + '">'
      : '<div class="md-avatar-empty">' + Utils.esc(m.nickname).charAt(0) + '</div>';

    document.getElementById('md-name').textContent = m.nickname;
    document.getElementById('md-id').textContent = 'ID: ' + m.kingshot_id;
    var metaParts = ['Lv.' + (lvl || '?')];
    if (m.power) metaParts.push('⚔ ' + formatPower(m.power));
    if (m.alliance_rank_pos) metaParts.push('연맹 ' + m.alliance_rank_pos + '위');
    if (m.kingdom) metaParts.push('서버 ' + m.kingdom);
    document.getElementById('md-meta').textContent = metaParts.join(' · ');
    document.getElementById('md-rank').value = rank;
    document.getElementById('md-auto-coupon').checked = m.auto_coupon !== false;

    Utils.toggleOverlay('manage-dialog-overlay', true);
  }

  /** 관리 다이얼로그를 닫습니다. */
  function closeDialog() {
    Utils.toggleOverlay('manage-dialog-overlay', false);
    currentDialogId = null;
  }

  dialogOverlay.addEventListener('click', function(e) {
    if (e.target === dialogOverlay) closeDialog();
  });
  document.getElementById('md-close').addEventListener('click', closeDialog);

  // ===== 다이얼로그 액션 =====

  /** 프로필 갱신: API에서 최신 정보를 조회하여 즉시 DB에 저장합니다. */
  document.getElementById('md-refresh').addEventListener('click', function() {
    if (!currentDialogId) return;
    var m = membersData[currentDialogId];
    if (!m) return;
    var btn = document.getElementById('md-refresh');
    btn.disabled = true;

    fetchPlayerInfo(m.kingshot_id)
      .then(function(data) {
        return sb.from('members').update({
          nickname: data.name,
          level: parseInt(data.level, 10) || 0,
          kingdom: data.kingdom || null,
          profile_photo: data.profilePhoto || null
        }).eq('id', currentDialogId).then(function(res) {
          if (res.error) throw new Error(res.error.message);
          if (window.Coupons) window.Coupons.invalidateAccountsCache();
          document.getElementById('md-name').textContent = data.name;
          document.getElementById('md-meta').textContent = 'Lv.' + (data.level || '?') + ' · ' + (data.kingdom || '?');
          if (data.profilePhoto) {
            document.getElementById('md-avatar').innerHTML = '<img src="' + Utils.esc(data.profilePhoto) + '">';
          }
          btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
          setTimeout(function() {
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
          }, 1500);
        });
      })
      .catch(function(err) { alert('갱신 실패: ' + err.message); })
      .finally(function() { btn.disabled = false; });
  });

  /** 폼 저장: 등급, 쿠폰 자동 받기를 DB에 저장합니다. */
  document.getElementById('md-save').addEventListener('click', function() {
    if (!currentDialogId) return;
    sb.from('members').update({
      alliance_rank: document.getElementById('md-rank').value,
      auto_coupon: document.getElementById('md-auto-coupon').checked
    }).eq('id', currentDialogId)
      .then(function(res) {
        if (res.error) { alert('저장 실패: ' + res.error.message); return; }
        if (window.Coupons) window.Coupons.invalidateAccountsCache();
        closeDialog();
        loadMembers();
      });
  });

  /** 연맹원 삭제: 확인 후 DB에서 삭제합니다. */
  document.getElementById('md-delete').addEventListener('click', function() {
    if (!currentDialogId) return;
    var m = membersData[currentDialogId];
    if (!confirm(m.nickname + '을(를) 삭제하시겠습니까?')) return;
    sb.from('members').delete().eq('id', currentDialogId)
      .then(function(res) {
        if (res.error) { alert('삭제 실패: ' + res.error.message); return; }
        if (window.Coupons) window.Coupons.invalidateAccountsCache();
        closeDialog();
        loadMembers();
      });
  });

  // ===== 등록 모달 =====

  var searchData = null;

  /** 연맹원 등록 모달을 엽니다. */
  document.getElementById('btn-add-member').addEventListener('click', function() {
    document.getElementById('input-kingshot-id').value = '';
    document.getElementById('search-result').style.display = 'none';
    document.getElementById('btn-modal-save').disabled = true;
    Utils.toggleOverlay('modal-overlay', true);
  });

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  function closeModal() { Utils.toggleOverlay('modal-overlay', false); }

  /** 킹샷 ID를 조회하여 프로필 카드를 표시합니다. */
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
        if (searchData.profile_photo) { photo.src = searchData.profile_photo; photo.style.display = ''; }
        else { photo.style.display = 'none'; }
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

  /** 조회된 플레이어를 연맹원으로 등록합니다. coupon_accounts에 있으면 자동 삭제. */
  document.getElementById('btn-modal-save').addEventListener('click', function() {
    if (!searchData) { alert('먼저 킹샷 ID를 조회하세요.'); return; }
    var kingshotId = searchData.kingshot_id;
    sb.from('members').insert({
      kingshot_id: kingshotId,
      nickname: searchData.nickname,
      level: searchData.level,
      kingdom: searchData.kingdom,
      profile_photo: searchData.profile_photo
    }).then(function(res) {
      if (res.error) {
        if (res.error.message.indexOf('duplicate') !== -1 || res.error.message.indexOf('unique') !== -1) {
          alert('이미 등록된 킹샷 ID입니다.');
        } else { alert('저장 실패: ' + res.error.message); }
        return;
      }
      // coupon_accounts에 동일 계정이 있으면 자동 정리 (연맹원 우선)
      sb.from('coupon_accounts').delete().eq('kingshot_id', kingshotId).then(function() {
        if (window.Coupons) window.Coupons.invalidateAccountsCache();
        searchData = null;
        closeModal();
        loadMembers();
      });
    });
  });

  // ===== 전체 갱신 (5명 병렬 배치) =====

  var BATCH_SIZE = 5;
  var DELAY_BETWEEN_BATCHES = 500;

  // ===== 실패 갱신 상태 관리 (sessionStorage) =====

  var FAILED_REFRESH_KEY = 'members_failed_refresh_v1';

  /** 마지막 갱신에서 실패한 멤버 정보 ({ ids, names, ts }) 또는 null */
  function getFailedRefresh() {
    try {
      var raw = sessionStorage.getItem(FAILED_REFRESH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveFailedRefresh(ids, names) {
    try {
      sessionStorage.setItem(FAILED_REFRESH_KEY, JSON.stringify({
        ids: ids, names: names, ts: Date.now()
      }));
    } catch (e) {}
  }

  function clearFailedRefresh() {
    try { sessionStorage.removeItem(FAILED_REFRESH_KEY); } catch (e) {}
  }

  /**
   * 모든 연맹원의 프로필을 갱신합니다.
   * 사용자가 "전체 갱신" 버튼을 클릭할 때 호출됩니다.
   */
  function refreshAllMembers() {
    if (allMembers.length === 0) { alert('갱신할 연맹원이 없습니다.'); return; }
    if (!confirm(allMembers.length + '명의 프로필을 모두 갱신하시겠습니까?')) return;
    refreshMembersByIds(allMembers.map(function(m) { return m.id; }));
  }

  /**
   * 지정된 ID 의 연맹원만 갱신합니다 (5명씩 병렬 배치).
   * 실패하면 sessionStorage에 저장하고 상단 배너로 표시합니다.
   * @param {string[]} memberIds - 갱신할 연맹원의 DB ID 배열
   */
  function refreshMembersByIds(memberIds) {
    if (!memberIds || memberIds.length === 0) return;
    var idSet = {};
    memberIds.forEach(function(id) { idSet[id] = true; });
    var targets = allMembers.filter(function(m) { return idSet[m.id]; });
    if (targets.length === 0) return;

    var btn = document.getElementById('btn-refresh-all');
    var originalText = btn.textContent;
    btn.disabled = true;

    var stats = { success: 0, failed: 0, errors: [], failedIds: [], failedNames: [] };
    var total = targets.length;
    var done = 0;

    function updateBtnText() {
      btn.textContent = '갱신 중 (' + done + '/' + total + ')';
    }
    updateBtnText();
    setBannerStatus('progress', done, total);

    var batches = [];
    for (var i = 0; i < targets.length; i += BATCH_SIZE) {
      batches.push(targets.slice(i, i + BATCH_SIZE));
    }

    var chain = Promise.resolve();
    batches.forEach(function(batch, idx) {
      chain = chain.then(function() {
        return Promise.all(batch.map(function(m) { return refreshSingleMember(m, stats); }))
          .then(function() {
            done += batch.length;
            updateBtnText();
            setBannerStatus('progress', done, total);
          });
      }).then(function() {
        if (idx < batches.length - 1) return Utils.delay(DELAY_BETWEEN_BATCHES);
      });
    });

    chain.then(function() {
      btn.textContent = originalText;
      btn.disabled = false;
      if (stats.failed > 0) {
        saveFailedRefresh(stats.failedIds, stats.failedNames);
      } else {
        clearFailedRefresh();
      }
      if (window.Coupons) window.Coupons.invalidateAccountsCache();
      loadMembers();  // re-renders with fail badges + restores banner via syncRefreshBanner()
    });
  }

  /**
   * 한 연맹원의 프로필 정보를 조회하여 DB에 업데이트합니다.
   * 실패 시 stats.failedIds / failedNames 에 누적합니다.
   * @param {Object} m - 연맹원 데이터
   * @param {Object} stats - 통계 객체 (success/failed/errors/failedIds/failedNames)
   * @returns {Promise<void>}
   */
  function refreshSingleMember(m, stats) {
    return fetchPlayerInfo(m.kingshot_id)
      .then(function(data) {
        return sb.from('members').update({
          nickname: data.name,
          level: parseInt(data.level, 10) || 0,
          kingdom: data.kingdom || null,
          profile_photo: data.profilePhoto || null
        }).eq('id', m.id).then(function(res) {
          if (res.error) throw new Error(res.error.message);
          stats.success++;
        });
      })
      .catch(function(err) {
        stats.failed++;
        stats.errors.push(m.nickname + ': ' + err.message);
        stats.failedIds.push(m.id);
        stats.failedNames.push(m.nickname);
      });
  }

  // ===== 갱신 실패 배너 =====

  function getBannerEl() {
    var el = document.getElementById('refresh-fail-banner');
    if (el) return el;
    var listEl = document.getElementById('members-list');
    if (!listEl) return null;
    el = document.createElement('div');
    el.id = 'refresh-fail-banner';
    el.className = 'refresh-fail-banner';
    listEl.parentNode.insertBefore(el, listEl);
    return el;
  }

  /**
   * 배너 상태를 업데이트합니다.
   * @param {string} mode - 'idle' | 'progress' | 'failure'
   * @param {number} [done] - 진행 중일 때 처리 완료 건수
   * @param {number} [total] - 진행 중일 때 총 건수
   */
  function setBannerStatus(mode, done, total) {
    if (mode === 'progress') {
      var data = getFailedRefresh();
      if (!data || !data.ids || data.ids.length === 0) return;  // 실패 정보 없으면 진행 표시 안 함
      var el = getBannerEl();
      if (!el) return;
      el.innerHTML =
        '<div class="rfb-icon">↻</div>' +
        '<div class="rfb-text"><strong>재시도 중</strong> (' + done + '/' + total + ')...</div>';
    } else if (mode === 'failure') {
      var d = getFailedRefresh();
      if (!d || !d.ids || d.ids.length === 0) {
        var existing = document.getElementById('refresh-fail-banner');
        if (existing) existing.remove();
        return;
      }
      var el2 = getBannerEl();
      if (!el2) return;
      var preview = d.names.slice(0, 3).map(Utils.esc).join(', ');
      if (d.names.length > 3) preview += ' 외 ' + (d.names.length - 3) + '명';
      el2.innerHTML =
        '<div class="rfb-icon">⚠</div>' +
        '<div class="rfb-text"><strong>갱신 실패 ' + d.names.length + '명</strong>: ' + preview + '</div>' +
        '<div class="rfb-actions">' +
          '<button class="btn btn-primary btn-sm" id="rfb-retry">↻ 실패한 멤버만 다시 갱신</button>' +
          '<button class="btn btn-secondary btn-sm" id="rfb-close">닫기</button>' +
        '</div>';
      document.getElementById('rfb-retry').addEventListener('click', function() {
        var data = getFailedRefresh();
        if (data && data.ids.length > 0) refreshMembersByIds(data.ids);
      });
      document.getElementById('rfb-close').addEventListener('click', function() {
        clearFailedRefresh();
        syncRefreshBanner();
        renderMembers();  // 실패 표시 제거
      });
    } else {
      var existingIdle = document.getElementById('refresh-fail-banner');
      if (existingIdle) existingIdle.remove();
    }
  }

  /** 페이지 로드/멤버 렌더링 시 sessionStorage 상태에 맞춰 배너 표시. */
  function syncRefreshBanner() {
    setBannerStatus('failure');
  }

  document.getElementById('btn-refresh-all').addEventListener('click', refreshAllMembers);

  // ===== 키보드 단축키 =====
  // Esc: 열려있는 모달/다이얼로그 닫기
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var overlays = ['modal-overlay', 'manage-dialog-overlay'];
    overlays.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.classList.contains('open')) el.classList.remove('open');
    });
  });

  // ===== 초기화 =====

  Utils.onTabActive('tab-manage', loadMembers);

  /** @global 연맹원 관리 Public API */
  window.Members = {
    openDialog: openDialog,
    reload: loadMembers,
    _getAllData: function() { return membersData; }
  };

})();
