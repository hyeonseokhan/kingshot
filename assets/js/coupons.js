// ===== 쿠폰 받기 페이지 (연맹원 auto_coupon + 추가 계정 + 병렬 수령) =====

(function() {
  'use strict';

  if (typeof SUPABASE_URL === 'undefined') return;

  var GIFT_API = SUPABASE_URL + '/functions/v1/gift-codes';
  var REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
  // player-info는 redeem-coupon의 player 액션으로 대체
  var CACHE_KEY = 'gift_codes_cache';
  var CACHE_REFRESH_MS = 60 * 60 * 1000;
  var BATCH_SIZE = 5;
  var DELAY_BETWEEN_CODES = 300;
  var DELAY_BETWEEN_BATCHES = 1000;

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var activeCoupons = [];
  var couponHistory = {};
  var allAccounts = []; // 연맹원(auto_coupon) + 추가 계정 통합
  var redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
  var totalRedeemTasks = 0;
  var completedRedeemTasks = 0;
  var pageInitialized = false;

  // ===== 쿠폰 캐싱 =====
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
  function setCache(codes) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ codes: codes, fetchedAt: Date.now(), total: codes.length }));
    } catch(e) {}
  }

  // ===== 쿠폰 목록 조회 =====
  function loadCoupons(callback) {
    var cached = getCache();
    if (cached && (Date.now() - cached.fetchedAt < CACHE_REFRESH_MS)) {
      activeCoupons = cached.codes;
      renderCoupons();
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
        renderCoupons();
      })
      .catch(function() { renderCoupons(); })
      .finally(function() { if (callback) callback(); });
  }

  function renderCoupons() {
    var el = document.getElementById('coupon-list');
    if (!el) return;
    if (activeCoupons.length === 0) {
      el.innerHTML = '<div class="empty-cell">현재 사용 가능한 쿠폰이 없습니다</div>';
      return;
    }
    el.innerHTML = activeCoupons.map(function(c) {
      return '<div class="coupon-card">' +
        '<span class="coupon-badge-active">ACTIVE</span>' +
        '<span class="coupon-code">' + esc(c.code) + '</span>' +
        '<span class="coupon-expires">만료: ' + (c.expiresAt ? formatDate(c.expiresAt) : '무기한') + '</span>' +
      '</div>';
    }).join('');
  }

  // ===== 대상 계정 로드 (연맹원 auto_coupon + coupon_accounts) =====
  function loadAccounts(callback) {
    Promise.all([
      sb.from('members').select('kingshot_id,nickname,level,kingdom,profile_photo').eq('auto_coupon', true),
      sb.from('coupon_accounts').select('*')
    ]).then(function(results) {
      allAccounts = [];
      if (results[0].data) {
        results[0].data.forEach(function(m) {
          allAccounts.push({ kingshot_id: m.kingshot_id, nickname: m.nickname, level: m.level, kingdom: m.kingdom, profile_photo: m.profile_photo, source: 'member' });
        });
      }
      if (results[1].data) {
        results[1].data.forEach(function(a) {
          allAccounts.push({ id: a.id, kingshot_id: a.kingshot_id, nickname: a.nickname, level: a.level, kingdom: a.kingdom, profile_photo: a.profile_photo, source: 'extra' });
        });
      }
      // 가나다순 정렬
      allAccounts.sort(function(a, b) { return (a.nickname || '').localeCompare(b.nickname || '', 'ko'); });
      if (callback) callback();
    });
  }

  // ===== 수령 이력 =====
  function loadHistory(callback) {
    var codes = activeCoupons.map(function(c) { return c.code; });
    if (codes.length === 0) { if (callback) callback(); return; }
    sb.from('coupon_history').select('kingshot_id,coupon_code,status')
      .in('coupon_code', codes)
      .then(function(res) {
        couponHistory = {};
        if (res.data) {
          res.data.forEach(function(r) { couponHistory[r.kingshot_id + ':' + r.coupon_code] = r.status; });
        }
        if (callback) callback();
      });
  }

  function getRedeemStatus(kingshotId) {
    if (activeCoupons.length === 0) return 'none';
    for (var i = 0; i < activeCoupons.length; i++) {
      var s = couponHistory[kingshotId + ':' + activeCoupons[i].code];
      if (s !== 'success' && s !== 'already_redeemed') return 'pending';
    }
    return 'done';
  }
  function getUnredeemedCodes(kingshotId) {
    return activeCoupons.filter(function(c) {
      var s = couponHistory[kingshotId + ':' + c.code];
      return s !== 'success' && s !== 'already_redeemed';
    }).map(function(c) { return c.code; });
  }
  function saveHistory(kingshotId, code, status, message) {
    couponHistory[kingshotId + ':' + code] = status;
    sb.from('coupon_history').upsert({ kingshot_id: kingshotId, coupon_code: code, status: status, message: message },
      { onConflict: 'kingshot_id,coupon_code' }).then(function() {});
  }

  // ===== 계정 목록 렌더링 =====
  function renderAccounts() {
    var listEl = document.getElementById('coupon-members-list');
    if (!listEl) return;

    var members = allAccounts.filter(function(a) { return a.source === 'member'; });
    var extras = allAccounts.filter(function(a) { return a.source === 'extra'; });
    var total = members.length + extras.length;
    document.getElementById('coupon-member-count').textContent = '전체 ' + total + '명';

    if (total === 0) {
      listEl.innerHTML = '<div class="empty-cell">쿠폰 수령 대상이 없습니다</div>';
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

  var SVG_GIFT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12v10H4V12"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>';
  var SVG_CHECK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
  var SVG_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  function renderAccountRow(a, canDelete) {
    var status = getRedeemStatus(a.kingshot_id);
    var avatar = a.profile_photo
      ? '<img src="' + esc(a.profile_photo) + '" class="mc-photo">'
      : '<div class="mc-photo-empty">' + esc(a.nickname).charAt(0) + '</div>';

    var redeemBtn = status === 'done'
      ? '<button class="cp-btn cp-btn-done" disabled title="수령 완료">' + SVG_CHECK + '</button>'
      : '<button class="cp-btn cp-btn-redeem" onclick="Coupons.redeemOne(\'' + esc(a.kingshot_id) + '\',\'' + esc(a.nickname) + '\')" title="쿠폰 수령">' + SVG_GIFT + '</button>';

    var deleteBtn = canDelete
      ? '<button class="cp-btn cp-btn-delete" onclick="Coupons.removeAccount(\'' + a.id + '\')" title="삭제">' + SVG_TRASH + '</button>'
      : '';

    return '<div class="coupon-account-row">' +
      '<div class="mc-photo-wrap">' + avatar + '</div>' +
      '<div class="mc-row-body">' +
        '<div class="mc-name">' + esc(a.nickname) + '</div>' +
        '<div class="mc-sub">Lv.' + (a.level || '?') + ' · ' + (a.kingdom || '?') + '</div>' +
      '</div>' +
      '<div class="coupon-row-actions">' + redeemBtn + deleteBtn + '</div>' +
    '</div>';
  }

  // ===== 추가 계정 등록 모달 =====
  var couponSearchData = null;

  document.getElementById('btn-add-coupon-account').addEventListener('click', function() {
    document.getElementById('coupon-input-id').value = '';
    document.getElementById('coupon-input-memo').value = '';
    document.getElementById('coupon-search-result').style.display = 'none';
    document.getElementById('coupon-modal-save').disabled = true;
    document.getElementById('coupon-modal-overlay').classList.add('open');
  });

  document.getElementById('coupon-modal-close').addEventListener('click', closeCouponModal);
  document.getElementById('coupon-modal-cancel').addEventListener('click', closeCouponModal);
  document.getElementById('coupon-modal-overlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('coupon-modal-overlay')) closeCouponModal();
  });
  function closeCouponModal() { document.getElementById('coupon-modal-overlay').classList.remove('open'); }

  document.getElementById('coupon-btn-search').addEventListener('click', function() {
    var id = document.getElementById('coupon-input-id').value.trim();
    if (!id) return;
    var btn = document.getElementById('coupon-btn-search');
    btn.textContent = '조회 중...'; btn.disabled = true;

    fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'player', fid: id })
    })
      .then(function(r) { return r.json(); })
      .then(function(json) {
        if (json.code !== 0 || !json.data) throw new Error(json.msg || '조회 실패');
        couponSearchData = {
          kingshot_id: String(json.data.fid), nickname: json.data.nickname,
          level: json.data.stove_lv || 0, kingdom: json.data.kid || null,
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

  document.getElementById('coupon-modal-save').addEventListener('click', function() {
    if (!couponSearchData) return;
    sb.from('coupon_accounts').insert({
      kingshot_id: couponSearchData.kingshot_id, nickname: couponSearchData.nickname,
      level: couponSearchData.level, kingdom: couponSearchData.kingdom,
      profile_photo: couponSearchData.profile_photo
    }).then(function(res) {
      if (res.error) {
        if (res.error.message.indexOf('duplicate') !== -1 || res.error.message.indexOf('unique') !== -1) alert('이미 등록된 계정입니다.');
        else alert('저장 실패: ' + res.error.message);
        return;
      }
      couponSearchData = null;
      closeCouponModal();
      initPage();
    });
  });

  // ===== 추가 계정 삭제 =====
  function removeAccount(id) {
    if (!confirm('이 계정을 삭제하시겠습니까?')) return;
    sb.from('coupon_accounts').delete().eq('id', id).then(function(res) {
      if (res.error) { alert('삭제 실패: ' + res.error.message); return; }
      initPage();
    });
  }

  // ===== 개별 수령 =====
  function redeemOne(fid, nickname) {
    var codes = getUnredeemedCodes(fid);
    if (codes.length === 0) { alert(nickname + ': 모든 쿠폰이 이미 수령되었습니다.'); return; }
    redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
    totalRedeemTasks = codes.length; completedRedeemTasks = 0;
    showProgress(nickname + ' 수령 시작...');
    redeemForMember(fid, nickname).then(function() { showSummary(); renderAccounts(); });
  }

  function redeemForMember(fid, nickname) {
    var codes = getUnredeemedCodes(fid);
    if (codes.length === 0) return Promise.resolve();
    var chain = Promise.resolve();
    codes.forEach(function(code) {
      chain = chain.then(function() { return redeemSingleCode(fid, nickname, code); })
        .then(function() { return delay(DELAY_BETWEEN_CODES); });
    });
    return chain;
  }

  function redeemSingleCode(fid, nickname, code) {
    return fetch(REDEEM_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'redeem', fid: fid, cdk: code, captcha_code: 'none' })
    })
    .then(function(r) { return r.json(); })
    .then(function(json) {
      completedRedeemTasks++;
      if (json.code === 0) {
        redeemStats.success++; saveHistory(fid, code, 'success', json.msg);
        showProgress('✅ ' + nickname + ' — ' + code + ' 수령 완료');
      } else if (json.code === 1 || (json.msg && (json.msg.indexOf('RECEIVED') !== -1 || json.msg.indexOf('redeemed once') !== -1))) {
        redeemStats.already++; saveHistory(fid, code, 'already_redeemed', json.msg);
        showProgress('✅ ' + nickname + ' — ' + code + ' 이미 수령됨');
      } else {
        redeemStats.failed++; redeemStats.errors.push(nickname + ' — ' + code + ': ' + (json.msg || '실패'));
        showProgress('⚠️ ' + nickname + ' — ' + code + ': ' + (json.msg || '실패'));
      }
    })
    .catch(function(err) {
      completedRedeemTasks++; redeemStats.failed++;
      redeemStats.errors.push(nickname + ' — ' + code + ': ' + err.message);
      showProgress('⚠️ ' + nickname + ' 오류');
    });
  }

  // ===== 전체 수령 (5명 병렬 배치) =====
  document.getElementById('btn-redeem-all').addEventListener('click', function() { startBulkRedeem(false); });

  function startBulkRedeem(skipConfirm) {
    if (activeCoupons.length === 0) { if (!skipConfirm) alert('사용 가능한 쿠폰이 없습니다.'); return; }
    var pending = allAccounts.filter(function(a) { return getUnredeemedCodes(a.kingshot_id).length > 0; });
    if (pending.length === 0) { if (!skipConfirm) alert('모든 계정이 이미 쿠폰을 수령했습니다.'); return; }
    if (!skipConfirm && !confirm(pending.length + '명에게 미수령 쿠폰을 수령하시겠습니까?')) return;

    redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
    totalRedeemTasks = pending.reduce(function(s, a) { return s + getUnredeemedCodes(a.kingshot_id).length; }, 0);
    completedRedeemTasks = 0;
    showProgress('전체 수령 시작 (' + pending.length + '명, ' + totalRedeemTasks + '건)...');

    var batches = [];
    for (var i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));

    var chain = Promise.resolve();
    batches.forEach(function(batch, idx) {
      chain = chain.then(function() {
        showProgress('배치 ' + (idx + 1) + '/' + batches.length + ' 처리 중...');
        return Promise.all(batch.map(function(a) { return redeemForMember(a.kingshot_id, a.nickname); }));
      }).then(function() { if (idx < batches.length - 1) return delay(DELAY_BETWEEN_BATCHES); });
    });
    chain.then(function() { showSummary(); renderAccounts(); });
  }

  // ===== 진행 & 요약 =====
  function showProgress(text) {
    var el = document.getElementById('redeem-progress');
    if (!el) {
      el = document.createElement('div'); el.id = 'redeem-progress'; el.className = 'redeem-progress';
      var toolbar = document.querySelector('#page-coupons .members-toolbar');
      if (toolbar) toolbar.parentNode.insertBefore(el, toolbar.nextSibling);
    }
    var pct = totalRedeemTasks > 0 ? Math.round((completedRedeemTasks / totalRedeemTasks) * 100) : 0;
    el.innerHTML = '<div class="redeem-progress-text">' + esc(text) + '</div>' +
      '<div class="redeem-progress-bar"><div class="redeem-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="redeem-progress-count">' + completedRedeemTasks + ' / ' + totalRedeemTasks + '</div>';
    el.style.display = '';
  }
  function showSummary() {
    var el = document.getElementById('redeem-progress');
    if (el) {
      var cls = redeemStats.failed > 0 ? 'summary-warn' : 'summary-ok';
      el.innerHTML = '<div class="redeem-summary ' + cls + '">' +
        '<span>✅ 성공 ' + redeemStats.success + '</span>' +
        (redeemStats.already > 0 ? '<span>📋 이미 수령 ' + redeemStats.already + '</span>' : '') +
        (redeemStats.failed > 0 ? '<span>⚠️ 실패 ' + redeemStats.failed + '</span>' : '') +
        '</div>';
      setTimeout(function() { el.style.display = 'none'; }, 10000);
    }
    if (redeemStats.failed > 0) alert('실패 상세:\n' + redeemStats.errors.join('\n'));
  }

  // ===== 유틸 =====
  function esc(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
  function formatDate(iso) { var d = new Date(iso); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // ===== 페이지 초기화 =====
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
  function checkAutoRedeem() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('auto-redeem') === 'true') {
      var url = new URL(window.location);
      url.searchParams.delete('auto-redeem');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      setTimeout(function() { startBulkRedeem(true); }, 500);
    }
  }

  // manage 탭 진입 시 초기화
  var loaded = false;
  var observer = new MutationObserver(function() {
    var manageTab = document.getElementById('tab-manage');
    if (manageTab && manageTab.classList.contains('active') && !loaded) {
      loaded = true;
      // 쿠폰 페이지가 보이면 초기화
      var couponPage = document.getElementById('page-coupons');
      if (couponPage && couponPage.style.display !== 'none') initPage();
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

  window.Coupons = {
    redeemOne: redeemOne,
    removeAccount: removeAccount,
    initPage: initPage
  };
})();
