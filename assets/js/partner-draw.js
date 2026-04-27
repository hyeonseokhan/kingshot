/**
 * 운명의 파트너 — 너 나랑 깐부할래?
 *
 * 흐름:
 *  1) 인증된 사용자만 사용 (tile-match-auth 재사용)
 *  2) 파티 인원 (본인 포함 2~4) 선택 → "오늘의 운명의 파트너" 클릭
 *  3) 파칭코식 가로 카드 띠 셔플 애니메이션
 *  4) 본인 제외 연맹원 풀에서 (인원-1) 명 무작위 추첨
 *  5) 결과 카드 표시 — "한 번 더" / "PNG 저장"
 */
(function() {
  'use strict';

  var PARTY_MIN = 2;
  var PARTY_MAX = 4;
  var DEFAULT_PARTY = 4;

  var initialized = false;
  var members = [];      // 멤버 풀 (본인 제외)
  var selfId = null;
  var partySize = DEFAULT_PARTY;
  var drawing = false;

  function $(id) { return document.getElementById(id); }

  function initPage() {
    if (!initialized) {
      initialized = true;
      $('pd-stepper-minus').addEventListener('click', function() { setPartySize(partySize - 1); });
      $('pd-stepper-plus').addEventListener('click', function() { setPartySize(partySize + 1); });
      $('pd-draw-btn').addEventListener('click', onDrawClick);

      var logoutBtn = $('pd-user-logout');
      if (logoutBtn) logoutBtn.addEventListener('click', function() {
        if (window.TileMatchAuth) window.TileMatchAuth.clearSession();
        renderUserBadge(null);
        if (window.TileMatchAuth) window.TileMatchAuth.ensureAuth().then(onSessionReady);
      });
    }

    setPartySize(partySize);
    if (window.TileMatchAuth) {
      window.TileMatchAuth.ensureAuth().then(onSessionReady);
    }
  }

  function onSessionReady(session) {
    renderUserBadge(session);
    if (!session || !session.player_id) {
      selfId = null;
      members = [];
      return;
    }
    selfId = String(session.player_id);
    refreshMemberPool();
  }

  // 멤버 풀 — TileMatchAuth 가 캐시한 _cachedMembers 우선 사용, 없으면 fetch.
  function refreshMemberPool() {
    var cached = (window.TileMatchAuth && window.TileMatchAuth._cachedMembers) || null;
    if (cached && cached.length) {
      members = cached.filter(function(m) { return m && String(m.kingshot_id) !== selfId; });
      return;
    }
    fetch(SUPABASE_URL + '/rest/v1/members?select=kingshot_id,nickname,level,profile_photo&limit=200', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }
    }).then(function(r) { return r.json(); })
      .then(function(list) {
        members = (list || []).filter(function(m) { return m && String(m.kingshot_id) !== selfId; });
      })
      .catch(function() { members = []; });
  }

  function renderUserBadge(session) {
    var box = $('pd-user');
    var name = $('pd-user-name');
    if (!box || !name) return;
    if (session && session.player_id) {
      box.style.display = '';
      name.textContent = session.nickname + ' (' + session.player_id + ')';
    } else {
      box.style.display = 'none';
    }
  }

  function setPartySize(n) {
    if (n < PARTY_MIN) n = PARTY_MIN;
    if (n > PARTY_MAX) n = PARTY_MAX;
    partySize = n;
    var v = $('pd-stepper-value');
    if (v) v.textContent = String(n);
    $('pd-stepper-minus').disabled = (n <= PARTY_MIN);
    $('pd-stepper-plus').disabled = (n >= PARTY_MAX);
  }

  // ===== 추첨 =====

  function onDrawClick() {
    if (drawing) return;
    if (!selfId) {
      if (window.TileMatchAuth) window.TileMatchAuth.ensureAuth().then(onSessionReady);
      return;
    }
    if (!members || members.length === 0) {
      // 풀 미준비 — 한번 더 시도
      refreshMemberPool();
      return;
    }
    var pickCount = partySize - 1;  // 본인 제외 N-1 명
    if (pickCount < 1 || members.length < pickCount) return;

    var winners = pickRandom(members, pickCount);
    runSlotAnimation(winners);
  }

  function pickRandom(arr, n) {
    var pool = arr.slice();
    var picked = [];
    for (var i = 0; i < n && pool.length > 0; i++) {
      var idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked;
  }

  // ===== 슬롯머신 애니메이션 =====
  // N개의 세로 슬롯이 동시에 위→아래로 카드들을 흘려보내고,
  // 왼쪽 슬롯부터 시간차(약 250ms) 로 winners[i] 카드에 정착.
  function runSlotAnimation(winners) {
    drawing = true;
    var result = $('pd-result');
    var slotsBox = $('pd-slots');
    var dateEl = $('pd-result-date');
    if (!result || !slotsBox) { drawing = false; return; }
    if (dateEl) dateEl.textContent = formatDate(new Date());

    // 슬롯 N 개 생성 — 각 슬롯에 random fillers + winner 가 마지막
    var FILLER = 22;          // 회전 카드 수 (각 슬롯)
    var BASE_DURATION = 1800; // 첫 슬롯 회전 시간
    var STAGGER = 350;        // 슬롯 간 정착 시간차
    var html = winners.map(function(_, i) {
      return '<div class="pd-slot" data-idx="' + i + '"><div class="pd-slot-strip"></div></div>';
    }).join('');
    slotsBox.innerHTML = html;
    result.style.display = '';

    // 각 슬롯 strip 채우기
    var slotEls = slotsBox.querySelectorAll('.pd-slot');
    slotEls.forEach(function(slot, i) {
      var strip = slot.querySelector('.pd-slot-strip');
      var seq = [];
      for (var j = 0; j < FILLER; j++) {
        seq.push(members[Math.floor(Math.random() * members.length)]);
      }
      seq.push(winners[i]);  // 마지막 카드가 정답
      strip.innerHTML = seq.map(renderSlotCard).join('');
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
    });
    // reflow
    void slotsBox.offsetWidth;

    // 각 슬롯 회전 시작 — duration 은 시간차 만큼 길어져서 왼→오 순서로 정착
    slotEls.forEach(function(slot, i) {
      var strip = slot.querySelector('.pd-slot-strip');
      var firstCard = strip.querySelector('.pd-slot-card');
      var cardH = firstCard ? firstCard.getBoundingClientRect().height : 140;
      var totalShift = FILLER * cardH;
      var duration = BASE_DURATION + i * STAGGER;
      strip.style.transition = 'transform ' + duration + 'ms cubic-bezier(0.18, 0.74, 0.12, 1)';
      strip.style.transform = 'translateY(-' + totalShift + 'px)';
      // 정착 시점에 lock 클래스 — glow 펄스
      setTimeout(function() {
        slot.classList.add('pd-slot-locked');
      }, duration);
    });

    // 모든 슬롯 정착 후 drawing 해제
    var totalTime = BASE_DURATION + (slotEls.length - 1) * STAGGER + 200;
    setTimeout(function() { drawing = false; }, totalTime);
  }

  function renderSlotCard(m) {
    // crossorigin 미지정 — 외부 아바타 도메인 ACAO 미제공이라 일반 img 로 표시
    var photo = m && m.profile_photo
      ? '<img src="' + escAttr(m.profile_photo) + '" alt="">'
      : '<div class="pd-slot-card-empty">' + escHtml((m && m.nickname || '?').slice(0, 1).toUpperCase()) + '</div>';
    var name = escHtml(m && m.nickname || '?');
    var meta = m && m.level ? '<div class="pd-slot-card-meta">Lv.' + m.level + '</div>' : '';
    return '<div class="pd-slot-card">' + photo +
      '<div class="pd-slot-card-name">' + name + '</div>' +
      meta +
      '</div>';
  }

  function formatDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '.' + m + '.' + dd;
  }

  // ===== util =====

  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function escAttr(s) { return escHtml(s); }

  // ===== Public API =====

  window.PartnerDraw = {
    initPage: initPage,
    // 검증/디버그 — 즉시 강제 추첨
    _draw: function(n) {
      if (n) setPartySize(n);
      onDrawClick();
    }
  };

})();
