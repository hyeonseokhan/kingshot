// ===== 쿠폰 관리 (조회 + 캐싱 + 병렬 수령 + URL 트리거) =====

(function() {
  'use strict';

  if (typeof SUPABASE_URL === 'undefined') return;

  var GIFT_API = SUPABASE_URL + '/functions/v1/gift-codes';
  var REDEEM_API = SUPABASE_URL + '/functions/v1/redeem-coupon';
  var CACHE_KEY = 'gift_codes_cache';
  var CACHE_REFRESH_MS = 60 * 60 * 1000;
  var BATCH_SIZE = 5;
  var DELAY_BETWEEN_CODES = 300;
  var DELAY_BETWEEN_BATCHES = 1000;

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var activeCoupons = [];
  var couponHistory = {};
  var redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
  var totalRedeemTasks = 0;
  var completedRedeemTasks = 0;

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
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        codes: codes, fetchedAt: Date.now(), total: codes.length
      }));
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
    if (cached) { activeCoupons = cached.codes; renderCoupons(); }

    fetch(GIFT_API)
      .then(function(r) { return r.json(); })
      .then(function(json) {
        if (json.status !== 'success' || !json.data) return;
        activeCoupons = json.data.giftCodes || [];
        setCache(activeCoupons);
        renderCoupons();
      })
      .catch(function(err) {
        console.error('쿠폰 조회 실패:', err);
        if (activeCoupons.length === 0) {
          var el = document.getElementById('coupon-list');
          if (el) el.innerHTML = '<div class="empty-cell">쿠폰 정보를 불러올 수 없습니다</div>';
        }
      })
      .finally(function() { if (callback) callback(); });
  }

  function renderCoupons() {
    var listEl = document.getElementById('coupon-list');
    if (!listEl) return;
    if (activeCoupons.length === 0) {
      listEl.innerHTML = '<div class="empty-cell">현재 사용 가능한 쿠폰이 없습니다</div>';
      return;
    }
    listEl.innerHTML = activeCoupons.map(function(c) {
      var expires = c.expiresAt ? formatDate(c.expiresAt) : '무기한';
      return '<div class="coupon-card">' +
        '<span class="coupon-badge-active">ACTIVE</span>' +
        '<span class="coupon-code">' + esc(c.code) + '</span>' +
        '<span class="coupon-expires">만료: ' + expires + '</span>' +
      '</div>';
    }).join('');
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
          res.data.forEach(function(r) {
            couponHistory[r.kingshot_id + ':' + r.coupon_code] = r.status;
          });
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
    sb.from('coupon_history').upsert({
      kingshot_id: kingshotId, coupon_code: code,
      status: status, message: message
    }, { onConflict: 'kingshot_id,coupon_code' }).then(function() {});
  }

  // ===== 선물 버튼 HTML =====
  function getGiftButtonHtml(kingshotId, nickname) {
    if (getRedeemStatus(kingshotId) === 'done') {
      return '<button class="mc-gift-btn mc-gift-done" disabled title="모두 수령 완료">✅</button>';
    }
    return '<button class="mc-gift-btn" onclick="Coupons.redeemOne(\'' + esc(kingshotId) + '\',\'' + esc(nickname) + '\')" title="쿠폰 수령">🎁</button>';
  }

  // ===== 1명의 모든 쿠폰을 순차 교환 =====
  function redeemForMember(fid, nickname) {
    var codes = getUnredeemedCodes(fid);
    if (codes.length === 0) return Promise.resolve();

    var chain = Promise.resolve();
    codes.forEach(function(code) {
      chain = chain.then(function() {
        return redeemSingleCode(fid, nickname, code);
      }).then(function() {
        return delay(DELAY_BETWEEN_CODES);
      });
    });
    return chain.then(function() {
      updateGiftButton(fid);
    });
  }

  function redeemSingleCode(fid, nickname, code) {
    return fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'redeem', fid: fid, cdk: code, captcha_code: 'none' })
    })
    .then(function(r) { return r.json(); })
    .then(function(json) {
      completedRedeemTasks++;

      if (json.code === 0) {
        redeemStats.success++;
        saveHistory(fid, code, 'success', json.msg || '수령 완료');
        showProgress('✅ ' + nickname + ' — ' + code + ' 수령 완료');
      } else if (json.code === 1 || (json.msg && json.msg.indexOf('RECEIVED') !== -1) ||
                 (json.msg && json.msg.indexOf('redeemed once') !== -1)) {
        redeemStats.already++;
        saveHistory(fid, code, 'already_redeemed', json.msg);
        showProgress('✅ ' + nickname + ' — ' + code + ' 이미 수령됨');
      } else {
        redeemStats.failed++;
        redeemStats.errors.push(nickname + ' — ' + code + ': ' + (json.msg || '실패'));
        console.warn('쿠폰 교환 실패:', fid, code, json);
        showProgress('⚠️ ' + nickname + ' — ' + code + ': ' + (json.msg || '실패'));
      }
    })
    .catch(function(err) {
      completedRedeemTasks++;
      redeemStats.failed++;
      redeemStats.errors.push(nickname + ' — ' + code + ': ' + err.message);
      console.error('교환 오류:', err);
      showProgress('⚠️ ' + nickname + ' — ' + code + ' 오류');
    });
  }

  // ===== 개별 수령 (1명) =====
  function redeemOne(fid, nickname) {
    var codes = getUnredeemedCodes(fid);
    if (codes.length === 0) {
      alert(nickname + ': 모든 쿠폰이 이미 수령되었습니다.');
      return;
    }
    redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
    totalRedeemTasks = codes.length;
    completedRedeemTasks = 0;
    showProgress(nickname + ' 쿠폰 수령 시작...');

    redeemForMember(fid, nickname).then(function() {
      showSummary();
    });
  }

  // ===== 전체 수령 (병렬 배치) =====
  function startBulkRedeem(skipConfirm) {
    if (activeCoupons.length === 0) {
      if (!skipConfirm) alert('사용 가능한 쿠폰이 없습니다.');
      return;
    }

    var allData = window.Members._getAllData ? window.Members._getAllData() : {};
    var pending = [];
    Object.keys(allData).forEach(function(id) {
      var m = allData[id];
      var codes = getUnredeemedCodes(m.kingshot_id);
      if (codes.length > 0) {
        pending.push({ fid: m.kingshot_id, nickname: m.nickname, codeCount: codes.length });
      }
    });

    if (pending.length === 0) {
      if (!skipConfirm) alert('모든 연맹원이 이미 쿠폰을 수령했습니다.');
      return;
    }

    if (!skipConfirm && !confirm(pending.length + '명에게 미수령 쿠폰을 수령하시겠습니까?')) return;

    redeemStats = { success: 0, already: 0, failed: 0, errors: [] };
    totalRedeemTasks = pending.reduce(function(sum, m) { return sum + m.codeCount; }, 0);
    completedRedeemTasks = 0;
    showProgress('전체 수령 시작 (' + pending.length + '명, ' + totalRedeemTasks + '건)...');

    // 5명씩 배치로 병렬 처리
    var batches = [];
    for (var i = 0; i < pending.length; i += BATCH_SIZE) {
      batches.push(pending.slice(i, i + BATCH_SIZE));
    }

    var batchChain = Promise.resolve();
    batches.forEach(function(batch, batchIdx) {
      batchChain = batchChain.then(function() {
        showProgress('배치 ' + (batchIdx + 1) + '/' + batches.length + ' 처리 중...');
        // 배치 내 병렬 실행
        var promises = batch.map(function(m) {
          return redeemForMember(m.fid, m.nickname);
        });
        return Promise.all(promises);
      }).then(function() {
        // 배치 간 딜레이
        if (batchIdx < batches.length - 1) return delay(DELAY_BETWEEN_BATCHES);
      });
    });

    batchChain.then(function() {
      showSummary();
      // 완료 후 목록 새로고침
      if (window.Members && window.Members.reload) window.Members.reload();
    });
  }

  // 전체 수령 버튼 이벤트
  document.getElementById('btn-redeem-all').addEventListener('click', function() {
    startBulkRedeem(false);
  });

  // ===== 진행 상태 표시 =====
  function showProgress(text) {
    var el = document.getElementById('redeem-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'redeem-progress';
      el.className = 'redeem-progress';
      var toolbar = document.querySelector('.members-toolbar');
      if (toolbar) toolbar.parentNode.insertBefore(el, toolbar.nextSibling);
    }
    var pct = totalRedeemTasks > 0 ? Math.round((completedRedeemTasks / totalRedeemTasks) * 100) : 0;
    el.innerHTML = '<div class="redeem-progress-text">' + esc(text) + '</div>' +
      '<div class="redeem-progress-bar"><div class="redeem-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="redeem-progress-count">' + completedRedeemTasks + ' / ' + totalRedeemTasks + '</div>';
    el.style.display = '';
  }

  // ===== 요약 표시 =====
  function showSummary() {
    var el = document.getElementById('redeem-progress');
    if (el) {
      var statusClass = redeemStats.failed > 0 ? 'summary-warn' : 'summary-ok';
      el.innerHTML = '<div class="redeem-summary ' + statusClass + '">' +
        '<span>✅ 성공 ' + redeemStats.success + '</span>' +
        (redeemStats.already > 0 ? '<span>📋 이미 수령 ' + redeemStats.already + '</span>' : '') +
        (redeemStats.failed > 0 ? '<span>⚠️ 실패 ' + redeemStats.failed + '</span>' : '') +
        '</div>';
      setTimeout(function() { el.style.display = 'none'; }, 10000);
    }
    if (redeemStats.failed > 0) {
      var msg = '실패 상세:\n' + redeemStats.errors.join('\n');
      alert(msg);
    }
  }

  // ===== 선물 버튼 업데이트 =====
  function updateGiftButton(kingshotId) {
    document.querySelectorAll('.member-row').forEach(function(row) {
      var btn = row.querySelector('.mc-gift-btn');
      if (!btn) return;
      var onclick = btn.getAttribute('onclick') || '';
      if (onclick.indexOf(kingshotId) !== -1) {
        if (getRedeemStatus(kingshotId) === 'done') {
          btn.textContent = '✅';
          btn.classList.add('mc-gift-done');
          btn.disabled = true;
          btn.removeAttribute('onclick');
        }
      }
    });
  }

  // ===== 유틸 =====
  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function formatDate(isoStr) {
    if (!isoStr) return '-';
    var d = new Date(isoStr);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  // ===== 초기화 =====
  var loaded = false;
  var observer = new MutationObserver(function() {
    var manageTab = document.getElementById('tab-manage');
    if (manageTab && manageTab.classList.contains('active') && !loaded) {
      loaded = true;
      initCoupons();
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

  function initCoupons() {
    loadCoupons(function() {
      loadHistory(function() {
        if (window.Members && window.Members.reload) window.Members.reload();
        // URL 트리거 확인: ?auto-redeem=true
        checkAutoRedeem();
      });
    });
  }

  // ===== URL 트리거: ?auto-redeem=true =====
  function checkAutoRedeem() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('auto-redeem') === 'true') {
      // URL에서 파라미터 제거 (중복 실행 방지)
      var url = new URL(window.location);
      url.searchParams.delete('auto-redeem');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      // 약간의 딜레이 후 자동 시작
      setTimeout(function() {
        startBulkRedeem(true);
      }, 500);
    }
  }

  window.Coupons = {
    redeemOne: redeemOne,
    reload: loadCoupons,
    getGiftButtonHtml: getGiftButtonHtml,
    loadHistory: loadHistory,
    getActiveCoupons: function() { return activeCoupons; }
  };

})();
