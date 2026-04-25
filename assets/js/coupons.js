/**
 * @fileoverview 쿠폰 받기 페이지 모듈
 * 연맹원(auto_coupon) + 추가 계정의 쿠폰 조회/수령을 처리합니다.
 * 5명 단위 병렬 배치 수령, URL 트리거(?auto-redeem=true) 지원.
 * @requires Utils - 공통 유틸리티 (utils.js)
 * @requires supabase - Supabase JS SDK
 */

(function() {
  'use strict';

  if (typeof SUPABASE_URL === 'undefined') return;

  // ===== 상수 =====

  var GIFT_API = SUPABASE_URL + '/functions/v1/gift-codes';
  var REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
  var CACHE_KEY = 'gift_codes_cache';
  var CACHE_REFRESH_MS = 60 * 60 * 1000;
  var BATCH_SIZE = 5;
  var DELAY_BETWEEN_BATCHES = 1000;
  var SUMMARY_DISPLAY_MS = 10000;

  // ===== 상태 =====

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var activeCoupons = [];
  var couponHistory = {};
  var allAccounts = [];
  var redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
  var totalRedeemTasks = 0;
  var completedRedeemTasks = 0;

  // 선택된 쿠폰 코드 (null이면 "전체 미수령" 모드 — 기존 동작)
  var selectedCouponCode = null;

  /** 현재 선택된 쿠폰 객체 또는 null */
  function getSelectedCoupon() {
    if (!selectedCouponCode) return null;
    for (var i = 0; i < activeCoupons.length; i++) {
      if (activeCoupons[i].code === selectedCouponCode) return activeCoupons[i];
    }
    return null;
  }

  /** 쿠폰 카드 클릭 시 선택 토글. */
  function selectCoupon(code) {
    selectedCouponCode = (selectedCouponCode === code) ? null : code;
    renderCoupons();
    renderAccounts();
    updateRedeemAllButton();
  }

  // ===== SVG 아이콘 =====

  var SVG = {
    gift: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12v10H4V12"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };

  // ===== 쿠폰 목록 (캐싱) =====

  /**
   * sessionStorage에서 쿠폰 캐시를 가져옵니다.
   * 만료된 쿠폰이 포함되어 있으면 null을 반환합니다.
   * @returns {Object|null} 캐시 데이터 {codes, fetchedAt, total}
   */
  function getCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      var now = new Date().toISOString();
      if (cached.codes.some(function(c) { return c.expiresAt && c.expiresAt < now; })) return null;
      return cached;
    } catch(e) { return null; }
  }

  /**
   * 쿠폰 목록을 sessionStorage에 캐싱합니다.
   * @param {Array} codes - 액티브 쿠폰 목록
   */
  function setCache(codes) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        codes: codes, fetchedAt: Date.now(), total: codes.length
      }));
    } catch(e) {}
  }

  /**
   * 액티브 쿠폰 목록을 조회합니다. 캐시 우선, 만료 시 API 호출.
   * @param {Function} [callback] - 완료 후 콜백
   */
  function loadCoupons(callback) {
    var cached = getCache();
    if (cached && (Date.now() - cached.fetchedAt < CACHE_REFRESH_MS)) {
      activeCoupons = cached.codes;
      pruneSelectedCoupon();
      renderCoupons();
      updateRedeemAllButton();
      if (callback) callback();
      return;
    }
    fetch(GIFT_API)
      .then(function(r) { return r.json(); })
      .then(function(json) {
        if (json.status === 'success' && json.data) {
          activeCoupons = json.data.giftCodes || [];
          setCache(activeCoupons);
        }
        pruneSelectedCoupon();
        renderCoupons();
        updateRedeemAllButton();
      })
      .catch(function() { renderCoupons(); updateRedeemAllButton(); })
      .finally(function() { if (callback) callback(); });
  }

  /** 활성 쿠폰 목록이 변경되어 선택된 코드가 사라졌으면 선택 해제. */
  function pruneSelectedCoupon() {
    if (!selectedCouponCode) return;
    var exists = activeCoupons.some(function(c) { return c.code === selectedCouponCode; });
    if (!exists) selectedCouponCode = null;
  }

  var SVG_CHECK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';

  /**
   * 해당 계정의 모든 쿠폰을 수령했으면 행의 버튼을 체크 아이콘으로 즉시 변경합니다.
   * @param {string} kingshotId
   */
  function updateAccountRowStatus(kingshotId) {
    if (getRedeemStatus(kingshotId) !== 'done') return;
    document.querySelectorAll('.coupon-account-row').forEach(function(row) {
      var btn = row.querySelector('.cp-btn-redeem[onclick*="' + kingshotId + '"]');
      if (btn) {
        btn.outerHTML = '<button class="cp-btn cp-btn-done cp-btn-just-done" disabled title="수령 완료">' + SVG_CHECK + '</button>';
      }
    });
  }

  /** 만료까지 남은 일수를 반환 (무기한이면 null) */
  function daysUntilExpire(isoStr) {
    if (!isoStr) return null;
    var diff = new Date(isoStr).getTime() - Date.now();
    return Math.floor(diff / (24 * 60 * 60 * 1000));
  }

  /** 액티브 쿠폰 카드를 렌더링합니다. 만료 3일 이내는 강조 표시.
   *  카드 클릭 시 해당 쿠폰만 대상으로 수령하도록 필터링합니다.
   */
  function renderCoupons() {
    var el = document.getElementById('coupon-list');
    if (!el) return;
    if (activeCoupons.length === 0) {
      el.innerHTML = '<div class="empty-cell">현재 사용 가능한 쿠폰이 없습니다</div>';
      return;
    }
    var cardsHtml = activeCoupons.map(function(c) {
      var days = daysUntilExpire(c.expiresAt);
      var expiring = days !== null && days <= 3;
      var badge = expiring ? '<span class="coupon-badge-expiring">' + (days <= 0 ? '곧 만료' : 'D-' + days) + '</span>' : '';
      var selected = selectedCouponCode === c.code;
      var classNames = 'coupon-card' + (expiring ? ' coupon-expiring' : '') + (selected ? ' coupon-selected' : '');
      return '<div class="' + classNames + '" data-code="' + Utils.esc(c.code) + '" role="button" tabindex="0">' +
        '<span class="coupon-badge-active">' + (selected ? '선택됨' : 'ACTIVE') + '</span>' +
        '<span class="coupon-code">' + Utils.esc(c.code) + '</span>' +
        '<span class="coupon-expires">만료: ' + (c.expiresAt ? Utils.formatDate(c.expiresAt) : '무기한') + badge + '</span>' +
      '</div>';
    }).join('');
    el.innerHTML = cardsHtml +
      '<div class="coupon-select-hint">' +
        (selectedCouponCode
          ? '<strong>' + Utils.esc(selectedCouponCode) + '</strong> 만 수령합니다. 다시 클릭하면 전체 모드로 돌아갑니다.'
          : '쿠폰 카드를 클릭하면 해당 쿠폰만 받게 됩니다 (자격 미달 쿠폰 분리 수령용).') +
      '</div>';

    // 카드 클릭 핸들러 (이벤트 위임)
    el.querySelectorAll('.coupon-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var code = card.getAttribute('data-code');
        if (code) selectCoupon(code);
      });
      card.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          var code = card.getAttribute('data-code');
          if (code) selectCoupon(code);
        }
      });
    });
  }

  // ===== 대상 계정 =====

  var ACCOUNTS_CACHE_KEY = 'coupon_accounts_cache';

  /** sessionStorage에서 계정 목록 캐시 조회 */
  function getAccountsCache() {
    try {
      var raw = sessionStorage.getItem(ACCOUNTS_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }

  /** 계정 목록을 sessionStorage에 캐시 */
  function setAccountsCache(accounts) {
    try { sessionStorage.setItem(ACCOUNTS_CACHE_KEY, JSON.stringify(accounts)); } catch(e) {}
  }

  /** 계정 캐시 무효화 (등록/삭제/연맹원 변경 시 호출) */
  function invalidateAccountsCache() {
    try { sessionStorage.removeItem(ACCOUNTS_CACHE_KEY); } catch(e) {}
  }

  /**
   * 쿠폰 수령 대상 계정을 로드합니다.
   * auto_coupon=true인 연맹원 + coupon_accounts 외부 계정을 통합하여 가나다순 정렬.
   * sessionStorage 캐시 우선 사용.
   * @param {Function} [callback] - 완료 후 콜백
   */
  function loadAccounts(callback) {
    var cached = getAccountsCache();
    if (cached) {
      allAccounts = cached;
      if (callback) callback();
      return;
    }

    Promise.all([
      sb.from('members').select('kingshot_id,nickname,level,kingdom,profile_photo').eq('auto_coupon', true),
      sb.from('coupon_accounts').select('*')
    ]).then(function(results) {
      allAccounts = [];
      if (results[0].data) {
        results[0].data.forEach(function(m) {
          allAccounts.push({
            kingshot_id: m.kingshot_id, nickname: m.nickname, level: m.level,
            kingdom: m.kingdom, profile_photo: m.profile_photo, source: 'member'
          });
        });
      }
      if (results[1].data) {
        results[1].data.forEach(function(a) {
          allAccounts.push({
            id: a.id, kingshot_id: a.kingshot_id, nickname: a.nickname, level: a.level,
            kingdom: a.kingdom, profile_photo: a.profile_photo, source: 'extra'
          });
        });
      }
      allAccounts.sort(function(a, b) {
        return (a.nickname || '').localeCompare(b.nickname || '', 'ko');
      });
      setAccountsCache(allAccounts);
      if (callback) callback();
    });
  }

  // ===== 수령 이력 =====

  /**
   * Supabase에서 현재 액티브 쿠폰에 대한 수령 이력을 조회합니다.
   * @param {Function} [callback] - 완료 후 콜백
   */
  function loadHistory(callback) {
    var codes = activeCoupons.map(function(c) { return c.code; });
    if (codes.length === 0) { if (callback) callback(); return; }
    sb.from('coupon_history').select('kingshot_id,coupon_code,status')
      .in('coupon_code', codes)
      .then(function(res) {
        couponHistory = {};
        if (res.data) {
          res.data.forEach(function(r) {
            couponHistory[r.kingshot_id + ':' + r.coupon_code] = r.status;
          });
        }
        if (callback) callback();
      });
  }

  /**
   * 해당 계정의 전체 쿠폰 수령 상태를 반환합니다.
   * @param {string} kingshotId - 킹샷 플레이어 ID
   * @returns {string} 'done' | 'pending' | 'none'
   */
  function getRedeemStatus(kingshotId) {
    if (activeCoupons.length === 0) return 'none';
    for (var i = 0; i < activeCoupons.length; i++) {
      var s = couponHistory[kingshotId + ':' + activeCoupons[i].code];
      if (s !== Utils.REDEEM_STATUS.SUCCESS && s !== Utils.REDEEM_STATUS.ALREADY) return 'pending';
    }
    return 'done';
  }

  /**
   * 해당 계정의 미수령 쿠폰 코드 목록을 반환합니다.
   * @param {string} kingshotId - 킹샷 플레이어 ID
   * @returns {string[]} 미수령 쿠폰 코드 배열
   */
  /**
   * 선택 모드 인지하여 해당 계정에 보낼 쿠폰 코드 배열을 반환합니다.
   * 선택된 쿠폰이 있으면 그 하나만 (이미 수령했으면 빈 배열).
   * @param {string} kingshotId
   * @returns {string[]}
   */
  function getCodesToRedeem(kingshotId) {
    var sel = getSelectedCoupon();
    if (sel) {
      var s = couponHistory[kingshotId + ':' + sel.code];
      if (s === Utils.REDEEM_STATUS.SUCCESS || s === Utils.REDEEM_STATUS.ALREADY) return [];
      return [sel.code];
    }
    return getUnredeemedCodes(kingshotId);
  }

  /**
   * 선택 모드 인지하여 해당 계정의 수령 상태를 반환합니다.
   * @param {string} kingshotId
   * @returns {string} 'done' | 'pending' | 'none'
   */
  function getEffectiveStatus(kingshotId) {
    var sel = getSelectedCoupon();
    if (sel) {
      var s = couponHistory[kingshotId + ':' + sel.code];
      return (s === Utils.REDEEM_STATUS.SUCCESS || s === Utils.REDEEM_STATUS.ALREADY) ? 'done' : 'pending';
    }
    return getRedeemStatus(kingshotId);
  }

  function getUnredeemedCodes(kingshotId) {
    return activeCoupons.filter(function(c) {
      var s = couponHistory[kingshotId + ':' + c.code];
      return s !== Utils.REDEEM_STATUS.SUCCESS && s !== Utils.REDEEM_STATUS.ALREADY;
    }).map(function(c) { return c.code; });
  }

  /**
   * 쿠폰 수령 결과를 DB에 저장합니다.
   * @param {string} kingshotId - 킹샷 플레이어 ID
   * @param {string} code - 쿠폰 코드
   * @param {string} status - 'success' | 'already_redeemed'
   * @param {string} message - 서버 응답 메시지
   */
  function saveHistory(kingshotId, code, status, message) {
    couponHistory[kingshotId + ':' + code] = status;
    sb.from('coupon_history').upsert(
      { kingshot_id: kingshotId, coupon_code: code, status: status, message: message },
      { onConflict: 'kingshot_id,coupon_code' }
    ).then(function() {});
  }

  // ===== 계정 목록 렌더링 =====

  var searchKeyword = '';

  /** 쿠폰 수령 대상 목록을 렌더링합니다 (연맹원 + 추가 계정 그룹). 검색 필터 적용. */
  function renderAccounts() {
    var listEl = document.getElementById('coupon-members-list');
    if (!listEl) return;

    var kw = searchKeyword.trim().toLowerCase();
    var filterFn = function(a) {
      if (!kw) return true;
      return (a.nickname || '').toLowerCase().indexOf(kw) !== -1;
    };

    var members = allAccounts.filter(function(a) { return a.source === 'member'; }).filter(filterFn);
    var extras = allAccounts.filter(function(a) { return a.source === 'extra'; }).filter(filterFn);
    var total = members.length + extras.length;
    var totalAll = allAccounts.length;

    var countText = kw
      ? '검색 ' + total + ' / 전체 ' + totalAll + '명'
      : '전체 ' + totalAll + '명';
    document.getElementById('coupon-member-count').textContent = countText;

    if (totalAll === 0) {
      listEl.innerHTML = '<div class="empty-cell">쿠폰 수령 대상이 없습니다</div>';
      return;
    }
    if (total === 0) {
      listEl.innerHTML = '<div class="empty-cell">검색 결과가 없습니다</div>';
      return;
    }

    var html = '';
    if (members.length > 0) {
      html += '<div class="coupon-group-label">연맹원</div>';
      html += members.map(function(a) { return renderAccountRow(a, false); }).join('');
    }
    if (extras.length > 0) {
      html += '<div class="coupon-group-label">추가 계정</div>';
      html += extras.map(function(a) { return renderAccountRow(a, true); }).join('');
    }
    listEl.innerHTML = html;
  }

  // 검색 input 이벤트
  var searchInput = document.getElementById('coupon-search');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      searchKeyword = this.value;
      renderAccounts();
    });
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { this.value = ''; searchKeyword = ''; renderAccounts(); }
    });
  }

  /**
   * 계정 행 HTML을 생성합니다.
   * @param {Object} a - 계정 정보
   * @param {boolean} canDelete - 삭제 버튼 표시 여부
   * @returns {string} HTML 문자열
   */
  function renderAccountRow(a, canDelete) {
    var status = getEffectiveStatus(a.kingshot_id);
    var avatar = a.profile_photo
      ? '<img src="' + Utils.esc(a.profile_photo) + '" class="mc-photo">'
      : '<div class="mc-photo-empty">' + Utils.esc(a.nickname).charAt(0) + '</div>';

    var redeemBtn = status === 'done'
      ? '<button class="cp-btn cp-btn-done" disabled title="수령 완료">' + SVG.check + '</button>'
      : '<button class="cp-btn cp-btn-redeem" onclick="Coupons.redeemOne(\'' + Utils.esc(a.kingshot_id) + '\',\'' + Utils.esc(a.nickname) + '\')" title="쿠폰 수령">' + SVG.gift + '</button>';

    var deleteBtn = canDelete
      ? '<button class="cp-btn cp-btn-delete" onclick="Coupons.removeAccount(\'' + a.id + '\')" title="삭제">' + SVG.trash + '</button>'
      : '';

    return '<div class="coupon-account-row">' +
      '<div class="mc-photo-wrap">' + avatar + '</div>' +
      '<div class="mc-row-body">' +
        '<div class="mc-name">' + Utils.esc(a.nickname) + '</div>' +
        '<div class="mc-sub">Lv.' + (a.level || '?') + ' · ' + (a.kingdom || '?') + '</div>' +
      '</div>' +
      '<div class="coupon-row-actions">' + redeemBtn + deleteBtn + '</div>' +
    '</div>';
  }

  // ===== 추가 계정 등록 모달 =====

  var couponSearchData = null;

  /** 추가 계정 등록 모달을 엽니다. */
  document.getElementById('btn-add-coupon-account').addEventListener('click', function() {
    document.getElementById('coupon-input-id').value = '';
    document.getElementById('coupon-search-result').style.display = 'none';
    document.getElementById('coupon-modal-save').disabled = true;
    Utils.toggleOverlay('coupon-modal-overlay', true);
  });

  document.getElementById('coupon-modal-close').addEventListener('click', closeCouponModal);
  document.getElementById('coupon-modal-cancel').addEventListener('click', closeCouponModal);
  document.getElementById('coupon-modal-overlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('coupon-modal-overlay')) closeCouponModal();
  });

  function closeCouponModal() { Utils.toggleOverlay('coupon-modal-overlay', false); }

  /** 킹샷 ID로 플레이어를 조회합니다. */
  document.getElementById('coupon-btn-search').addEventListener('click', function() {
    var id = document.getElementById('coupon-input-id').value.trim();
    if (!id) return;
    var btn = document.getElementById('coupon-btn-search');
    btn.textContent = '조회 중...';
    btn.disabled = true;

    fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'player', fid: id })
    })
    .then(function(r) { return r.json(); })
    .then(function(json) {
      if (json.code !== 0 || !json.data) throw new Error(json.msg || '조회 실패');
      couponSearchData = {
        kingshot_id: String(json.data.fid),
        nickname: json.data.nickname,
        level: json.data.stove_lv || 0,
        kingdom: json.data.kid || null,
        profile_photo: json.data.avatar_image || null
      };
      document.getElementById('coupon-res-nickname').textContent = couponSearchData.nickname;
      document.getElementById('coupon-res-level').textContent = couponSearchData.level;
      document.getElementById('coupon-res-kingdom').textContent = couponSearchData.kingdom || '-';
      var photo = document.getElementById('coupon-res-photo');
      if (couponSearchData.profile_photo) { photo.src = couponSearchData.profile_photo; photo.style.display = ''; }
      else { photo.style.display = 'none'; }
      document.getElementById('coupon-search-result').style.display = '';
      document.getElementById('coupon-modal-save').disabled = false;
    })
    .catch(function(err) { alert('조회 실패: ' + err.message); couponSearchData = null; })
    .finally(function() { btn.textContent = '조회'; btn.disabled = false; });
  });

  /** 조회된 플레이어를 추가 계정으로 등록합니다. (연맹원 중복 방지) */
  document.getElementById('coupon-modal-save').addEventListener('click', function() {
    if (!couponSearchData) return;

    // 연맹원 테이블에 이미 존재하는지 먼저 확인
    sb.from('members').select('kingshot_id').eq('kingshot_id', couponSearchData.kingshot_id)
      .then(function(res) {
        if (res.data && res.data.length > 0) {
          alert('이 계정은 이미 연맹원으로 등록되어 있습니다.\n연맹원 관리 페이지에서 "쿠폰 자동 받기"를 활성화하세요.');
          return;
        }
        // 추가 계정으로 저장
        sb.from('coupon_accounts').insert({
          kingshot_id: couponSearchData.kingshot_id,
          nickname: couponSearchData.nickname,
          level: couponSearchData.level,
          kingdom: couponSearchData.kingdom,
          profile_photo: couponSearchData.profile_photo
        }).then(function(res) {
          if (res.error) {
            if (res.error.message.indexOf('duplicate') !== -1 || res.error.message.indexOf('unique') !== -1) {
              alert('이미 등록된 계정입니다.');
            } else { alert('저장 실패: ' + res.error.message); }
            return;
          }
          couponSearchData = null;
          invalidateAccountsCache();
          closeCouponModal();
          initPage();
        });
      });
  });

  // ===== 계정 삭제 =====

  /**
   * 추가 계정을 삭제합니다.
   * @param {string} id - coupon_accounts DB ID (UUID)
   */
  function removeAccount(id) {
    if (!confirm('이 계정을 삭제하시겠습니까?')) return;
    sb.from('coupon_accounts').delete().eq('id', id).then(function(res) {
      if (res.error) { alert('삭제 실패: ' + res.error.message); return; }
      invalidateAccountsCache();
      initPage();
    });
  }

  // ===== 쿠폰 수령 =====

  /**
   * 단일 계정의 미수령 쿠폰을 순차 수령합니다.
   * @param {string} fid - 킹샷 플레이어 ID
   * @param {string} nickname - 닉네임 (진행 표시용)
   */
  function redeemOne(fid, nickname) {
    var codes = getCodesToRedeem(fid);
    if (codes.length === 0) {
      var sel = getSelectedCoupon();
      alert(nickname + ': ' + (sel ? sel.code + ' 쿠폰을 이미 수령했습니다.' : '모든 쿠폰이 이미 수령되었습니다.'));
      return;
    }
    redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
    totalRedeemTasks = codes.length;
    completedRedeemTasks = 0;
    showProgress(nickname + ' 수령 시작...');
    redeemForMember(fid, nickname).then(function() { showSummary(); renderAccounts(); });
  }

  /**
   * 한 계정의 미수령 쿠폰을 벌크 엔드포인트로 한번에 교환합니다.
   * player 1회 + redeem N회를 단일 HTTP 요청으로 처리하여 속도 최적화.
   * @param {string} fid - 킹샷 플레이어 ID
   * @param {string} nickname - 닉네임
   * @returns {Promise<void>}
   */
  function redeemForMember(fid, nickname) {
    var codes = getCodesToRedeem(fid);
    if (codes.length === 0) return Promise.resolve();

    return fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'redeem_batch', fid: fid, cdks: codes, captcha_code: 'none' })
    })
    .then(function(r) { return r.json(); })
    .then(function(json) {
      // 최상위 에러 (player 로그인 실패 등) — 전체 실패 처리
      if (json.code !== 0 || !Array.isArray(json.results)) {
        var topLabel = Utils.describeRedeemError(json);
        codes.forEach(function(code) {
          completedRedeemTasks++;
          redeemStats.failed++;
          redeemStats.errors.push(nickname + ' — ' + code + ': ' + topLabel);
        });
        showProgress('⚠️ ' + nickname + ' 오류: ' + topLabel);
        return;
      }
      // 쿠폰별 결과 처리
      json.results.forEach(function(r) {
        completedRedeemTasks++;
        var code = r.cdk;
        var fakeJson = { code: r.code, msg: r.msg, err_code: r.err_code };
        if (r.code === 0) {
          redeemStats.success++;
          saveHistory(fid, code, Utils.REDEEM_STATUS.SUCCESS, r.msg);
          showProgress('✅ ' + nickname + ' — ' + code + ' 수령 완료');
        } else if (Utils.isAlreadyRedeemed(fakeJson)) {
          redeemStats.already++;
          saveHistory(fid, code, Utils.REDEEM_STATUS.ALREADY, r.msg);
          showProgress('✅ ' + nickname + ' — ' + code + ' 이미 수령됨');
        } else {
          var label = Utils.describeRedeemError(fakeJson);
          redeemStats.failed++;
          redeemStats.errors.push(nickname + ' — ' + code + ': ' + label);
          showProgress('⚠️ ' + nickname + ' — ' + code + ': ' + label);
        }
      });
      updateAccountRowStatus(fid);
    })
    .catch(function(err) {
      codes.forEach(function(code) {
        completedRedeemTasks++;
        redeemStats.failed++;
        redeemStats.errors.push(nickname + ' — ' + code + ': ' + (err.message || '네트워크 오류'));
      });
      showProgress('⚠️ ' + nickname + ' 네트워크 오류');
    });
  }

  // ===== 전체 수령 =====

  /** 전체 수령 버튼 라벨을 선택 상태에 맞게 업데이트합니다. */
  function updateRedeemAllButton() {
    var btn = document.getElementById('btn-redeem-all');
    if (!btn) return;
    var sel = getSelectedCoupon();
    btn.textContent = sel ? '🎁 ' + sel.code + ' 수령' : '🎁 전체 수령';
  }

  document.getElementById('btn-redeem-all').addEventListener('click', function() {
    startBulkRedeem(false);
  });

  /**
   * 미수령 쿠폰이 있는 모든 계정에 대해 병렬 배치(5명씩) 수령을 실행합니다.
   * @param {boolean} skipConfirm - true면 확인 없이 즉시 시작 (URL 트리거용)
   */
  function startBulkRedeem(skipConfirm) {
    if (activeCoupons.length === 0) {
      if (!skipConfirm) alert('사용 가능한 쿠폰이 없습니다.');
      return;
    }
    var sel = getSelectedCoupon();
    var pending = allAccounts.filter(function(a) {
      return getCodesToRedeem(a.kingshot_id).length > 0;
    });
    if (pending.length === 0) {
      if (!skipConfirm) {
        alert(sel ? sel.code + ' 쿠폰을 모든 계정이 이미 수령했습니다.' : '모든 계정이 이미 쿠폰을 수령했습니다.');
      }
      return;
    }
    var confirmMsg = sel
      ? pending.length + '명에게 ' + sel.code + ' 쿠폰을 수령하시겠습니까?'
      : pending.length + '명에게 미수령 쿠폰을 수령하시겠습니까?';
    if (!skipConfirm && !confirm(confirmMsg)) return;

    redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
    totalRedeemTasks = pending.reduce(function(sum, a) {
      return sum + getCodesToRedeem(a.kingshot_id).length;
    }, 0);
    completedRedeemTasks = 0;
    var startMsg = sel
      ? sel.code + ' 수령 시작 (' + pending.length + '명)...'
      : '전체 수령 시작 (' + pending.length + '명, ' + totalRedeemTasks + '건)...';
    showProgress(startMsg);

    var batches = [];
    for (var i = 0; i < pending.length; i += BATCH_SIZE) {
      batches.push(pending.slice(i, i + BATCH_SIZE));
    }

    var chain = Promise.resolve();
    batches.forEach(function(batch, idx) {
      chain = chain.then(function() {
        showProgress('배치 ' + (idx + 1) + '/' + batches.length + ' 처리 중...');
        return Promise.all(batch.map(function(a) {
          return redeemForMember(a.kingshot_id, a.nickname);
        }));
      }).then(function() {
        if (idx < batches.length - 1) return Utils.delay(DELAY_BETWEEN_BATCHES);
      });
    });
    chain.then(function() { showSummary(); renderAccounts(); });
  }

  // ===== 진행 표시 =====

  /**
   * 진행 상태 바를 표시/업데이트합니다.
   * @param {string} text - 상태 텍스트
   */
  function showProgress(text) {
    var el = document.getElementById('redeem-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'redeem-progress';
      el.className = 'redeem-progress';
      var toolbar = document.querySelector('#page-coupons .members-toolbar');
      if (toolbar) toolbar.parentNode.insertBefore(el, toolbar.nextSibling);
    }
    var pct = totalRedeemTasks > 0 ? Math.round((completedRedeemTasks / totalRedeemTasks) * 100) : 0;
    el.innerHTML =
      '<div class="redeem-progress-text">' + Utils.esc(text) + '</div>' +
      '<div class="redeem-progress-bar"><div class="redeem-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="redeem-progress-count">' + completedRedeemTasks + ' / ' + totalRedeemTasks + '</div>';
    el.style.display = '';
  }

  /** 수령 완료 요약을 표시합니다. 실패 시 alert으로 상세 내역을 보여줍니다. */
  function showSummary() {
    var el = document.getElementById('redeem-progress');
    if (el) {
      var cls = redeemStats.failed > 0 ? 'summary-warn' : 'summary-ok';
      el.innerHTML = '<div class="redeem-summary ' + cls + '">' +
        '<span>✅ 성공 ' + redeemStats.success + '</span>' +
        (redeemStats.already > 0 ? '<span>📋 이미 수령 ' + redeemStats.already + '</span>' : '') +
        (redeemStats.failed > 0 ? '<span>⚠️ 실패 ' + redeemStats.failed + '</span>' : '') +
        '</div>';
      setTimeout(function() { el.style.display = 'none'; }, SUMMARY_DISPLAY_MS);
    }
    if (redeemStats.failed > 0) {
      alert('실패 상세:\n' + redeemStats.errors.join('\n'));
    }
  }

  // ===== 수령 이력 다이얼로그 =====

  var HISTORY_PAGE_SIZE = 5;
  var historyCurrentPage = 1;
  var historyTotalCount = 0;
  var nicknameMap = {};

  /**
   * kingshot_id → nickname 매핑을 구성합니다.
   * members + coupon_accounts에 없는 ID는 kingshot_id를 그대로 표시합니다.
   */
  function buildNicknameMap() {
    nicknameMap = {};
    allAccounts.forEach(function(a) { nicknameMap[a.kingshot_id] = a.nickname; });
  }

  /**
   * 수령 이력 다이얼로그를 엽니다.
   */
  function openHistoryDialog() {
    buildNicknameMap();
    historyCurrentPage = 1;
    Utils.toggleOverlay('history-dialog-overlay', true);
    loadHistoryPage();
  }

  /**
   * 현재 페이지의 수령 이력을 로드하여 렌더링합니다.
   */
  function loadHistoryPage() {
    var body = document.getElementById('history-body');
    body.innerHTML = '<div class="empty-cell">로딩 중...</div>';

    var from = (historyCurrentPage - 1) * HISTORY_PAGE_SIZE;
    var to = from + HISTORY_PAGE_SIZE - 1;

    sb.from('coupon_history')
      .select('kingshot_id,coupon_code,redeemed_at', { count: 'exact' })
      .eq('status', Utils.REDEEM_STATUS.SUCCESS)
      .order('redeemed_at', { ascending: false })
      .range(from, to)
      .then(function(res) {
        if (res.error) {
          body.innerHTML = '<div class="empty-cell">조회 실패: ' + res.error.message + '</div>';
          return;
        }
        historyTotalCount = res.count || 0;
        document.getElementById('history-total').textContent = '전체 ' + historyTotalCount + '건';
        renderHistoryTable(res.data || []);
        renderHistoryPagination();
      });
  }

  /**
   * 이력 테이블을 렌더링합니다.
   * @param {Array} rows - 이력 데이터
   */
  function renderHistoryTable(rows) {
    var body = document.getElementById('history-body');
    if (rows.length === 0) {
      body.innerHTML = '<div class="empty-cell">수령 이력이 없습니다</div>';
      return;
    }
    var html = '<table class="history-table">' +
      '<thead><tr><th>계정</th><th>쿠폰</th><th>수령일시</th></tr></thead><tbody>';
    html += rows.map(function(r) {
      var nick = nicknameMap[r.kingshot_id] || r.kingshot_id;
      return '<tr title="' + formatDateTime(r.redeemed_at) + '">' +
        '<td>' + Utils.esc(nick) + '</td>' +
        '<td class="col-code">' + Utils.esc(r.coupon_code) + '</td>' +
        '<td class="col-date">' + formatRelativeTime(r.redeemed_at) + '</td>' +
      '</tr>';
    }).join('');
    html += '</tbody></table>';
    body.innerHTML = html;
  }

  /**
   * ISO 날짜를 상대 시간 문자열로 변환합니다 (3분 전, 어제, 3일 전 등).
   * @param {string} iso
   * @returns {string}
   */
  function formatRelativeTime(iso) {
    if (!iso) return '-';
    var now = Date.now();
    var then = new Date(iso).getTime();
    var diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return '방금 전';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + '분 전';
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + '시간 전';

    // 어제/그제 구분을 위해 날짜 기준 계산
    var nowDate = new Date(now);
    var thenDate = new Date(then);
    var diffDays = Math.floor(
      (Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()) -
       Date.UTC(thenDate.getFullYear(), thenDate.getMonth(), thenDate.getDate())) / 86400000
    );
    if (diffDays === 1) return '어제';
    if (diffDays === 2) return '그제';
    if (diffDays < 7) return diffDays + '일 전';
    if (diffDays < 30) return Math.floor(diffDays / 7) + '주 전';
    if (diffDays < 365) return Math.floor(diffDays / 30) + '개월 전';
    return Math.floor(diffDays / 365) + '년 전';
  }

  /**
   * 페이지네이션 버튼을 렌더링합니다.
   */
  function renderHistoryPagination() {
    var el = document.getElementById('history-pagination');
    var totalPages = Math.max(1, Math.ceil(historyTotalCount / HISTORY_PAGE_SIZE));

    var html = '';
    // 이전
    html += '<button ' + (historyCurrentPage === 1 ? 'disabled' : '') + ' data-page="' + (historyCurrentPage - 1) + '">&lsaquo;</button>';

    // 페이지 번호 (최대 5개 표시)
    var start = Math.max(1, historyCurrentPage - 2);
    var end = Math.min(totalPages, start + 4);
    if (end - start < 4) start = Math.max(1, end - 4);
    for (var i = start; i <= end; i++) {
      html += '<button class="' + (i === historyCurrentPage ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>';
    }

    // 다음
    html += '<button ' + (historyCurrentPage >= totalPages ? 'disabled' : '') + ' data-page="' + (historyCurrentPage + 1) + '">&rsaquo;</button>';

    el.innerHTML = html;
    el.querySelectorAll('button[data-page]').forEach(function(btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', function() {
        historyCurrentPage = parseInt(btn.dataset.page, 10);
        loadHistoryPage();
      });
    });
  }

  /**
   * ISO 날짜를 'YYYY-MM-DD HH:MM' 형식으로 변환합니다.
   * @param {string} iso
   * @returns {string}
   */
  function formatDateTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  document.getElementById('btn-history').addEventListener('click', openHistoryDialog);
  document.getElementById('history-close').addEventListener('click', function() {
    Utils.toggleOverlay('history-dialog-overlay', false);
  });
  document.getElementById('history-dialog-overlay').addEventListener('click', function(e) {
    if (e.target === this) Utils.toggleOverlay('history-dialog-overlay', false);
  });

  // ===== 초기화 =====

  /**
   * 쿠폰 받기 페이지를 초기화합니다.
   * 쿠폰 목록 → 계정 목록 → 수령 이력 순으로 로드 후 렌더링합니다.
   */
  function initPage() {
    loadCoupons(function() {
      loadAccounts(function() {
        loadHistory(function() {
          renderAccounts();
          checkAutoRedeem();
        });
      });
    });
  }

  /**
   * URL에 ?auto-redeem=true 파라미터가 있으면 자동으로 전체 수령을 시작합니다.
   * 실행 후 파라미터를 제거하여 새로고침 시 중복 실행을 방지합니다.
   */
  function checkAutoRedeem() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('auto-redeem') === 'true') {
      var url = new URL(window.location);
      url.searchParams.delete('auto-redeem');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      setTimeout(function() { startBulkRedeem(true); }, 500);
    }
  }

  // manage 탭의 쿠폰 페이지가 보일 때 초기화
  Utils.onTabActive('tab-manage', function() {
    var couponPage = document.getElementById('page-coupons');
    if (couponPage && couponPage.style.display !== 'none') initPage();
  });

  // ===== 키보드 단축키 =====
  // Esc: 열려있는 모달/다이얼로그 닫기
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var overlays = ['coupon-modal-overlay', 'history-dialog-overlay'];
    overlays.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.classList.contains('open')) el.classList.remove('open');
    });
  });

  /** @global 쿠폰 받기 Public API */
  window.Coupons = {
    redeemOne: redeemOne,
    removeAccount: removeAccount,
    initPage: initPage,
    invalidateAccountsCache: invalidateAccountsCache
  };

})();
