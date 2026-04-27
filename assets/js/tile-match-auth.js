/**
 * 미니게임 본인 인증 모듈
 *
 *  - 미니게임 탭 진입 시 sessionStorage 미확인이면 모달 다이얼로그
 *  - 단계 1) 연맹원 검색/선택 (닉네임 + ID 자동완성)
 *  - 단계 2) PIN 4자리 등록(미등록자) 또는 검증(등록자)
 *  - 키패드: 0-9 + ⌫(백스페이스) + 전체 지우기
 *  - 인증 성공 시 sessionStorage 에 { player_id, nickname } 저장
 */
(function() {
  'use strict';

  var SESSION_KEY = 'tileMatchAuth';
  var MEMBERS_URL = SUPABASE_URL + '/rest/v1/members?select=kingshot_id,nickname,level,profile_photo&order=nickname.asc';
  var FN_AUTH_URL = SUPABASE_URL + '/functions/v1/tile-match-auth';
  var FAIL_MSG = '비밀번호를 확인해 주세요. 또는 비밀번호 초기화 요청을 해주세요.';

  // ===== 상태 =====
  var initialized = false;
  var members = [];
  var selectedMember = null;
  var pinMode = null;     // 'set' | 'verify'
  var pinInput = '';      // 현재 4자리 입력 버퍼
  var firstPin = null;    // 등록 모드의 1차 입력값
  var pendingResolve = null;
  var changeListeners = [];

  // ===== util =====
  function $(id) { return document.getElementById(id); }

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function setSession(s) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    notifyChange();
  }
  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    notifyChange();
  }
  function onSessionChange(fn) {
    changeListeners.push(fn);
  }
  function notifyChange() {
    var s = getSession();
    changeListeners.forEach(function(fn) { try { fn(s); } catch (e) {} });
  }

  // ===== 다이얼로그 open/close =====
  function openAuth() {
    return new Promise(function(resolve) {
      pendingResolve = resolve;
      $('tm-auth-overlay').style.display = '';
      document.body.style.overflow = 'hidden';
      resetState();
      showStep('select');
      loadMembers();
      var s = $('tm-auth-search');
      if (s) { s.value = ''; setTimeout(function() { s.focus(); }, 200); }
    });
  }

  function closeAuth(success) {
    $('tm-auth-overlay').style.display = 'none';
    document.body.style.overflow = '';
    var resolve = pendingResolve;
    pendingResolve = null;
    if (resolve) resolve(success ? getSession() : null);
  }

  function resetState() {
    selectedMember = null;
    pinMode = null;
    pinInput = '';
    firstPin = null;
  }

  // 인증된 세션이 있으면 즉시 resolve, 없으면 다이얼로그
  function ensureAuth() {
    var s = getSession();
    if (s && s.player_id) return Promise.resolve(s);
    return openAuth();
  }

  // ===== 단계 전환 =====
  function showStep(step) {
    $('tm-auth-step-select').style.display = step === 'select' ? '' : 'none';
    $('tm-auth-step-pin').style.display = step === 'pin' ? '' : 'none';
    $('tm-auth-back').style.display = step === 'pin' ? '' : 'none';
  }

  // ===== 연맹원 목록 =====
  function loadMembers() {
    var box = $('tm-auth-list');
    box.innerHTML = '<div class="tm-auth-empty">불러오는 중...</div>';
    fetch(MEMBERS_URL, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        members = Array.isArray(data) ? data : [];
        renderList(members);
      })
      .catch(function(err) {
        box.innerHTML = '<div class="tm-auth-empty">조회 실패: ' + (err.message || err) + '</div>';
      });
  }

  function filterMembers(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return members;
    return members.filter(function(m) {
      var nick = (m.nickname || '').toLowerCase();
      var pid = String(m.kingshot_id || '').toLowerCase();
      return nick.indexOf(q) !== -1 || pid.indexOf(q) !== -1;
    });
  }

  function renderList(list) {
    var box = $('tm-auth-list');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="tm-auth-empty">검색 결과가 없습니다</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    list.slice(0, 50).forEach(function(m) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'tm-auth-item';
      var photoHtml = m.profile_photo
        ? '<img class="tm-auth-item-photo" src="' + escape(m.profile_photo) + '" alt="">'
        : '<span class="tm-auth-item-photo-empty">' + escape((m.nickname || '?').slice(0, 1).toUpperCase()) + '</span>';
      el.innerHTML =
        photoHtml +
        '<span class="tm-auth-item-text">' +
          '<span class="tm-auth-item-name">' + escape(m.nickname || '') + '</span>' +
          '<span class="tm-auth-item-id">ID ' + escape(m.kingshot_id || '') +
          (m.level ? ' · Lv.' + m.level : '') + '</span>' +
        '</span>';
      el.addEventListener('click', function() { onSelectMember(m); });
      frag.appendChild(el);
    });
    box.appendChild(frag);
  }

  function escape(s) {
    return String(s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ===== 연맹원 선택 → pin-status =====
  // iOS Safari 에서 자동 키보드가 뜨려면 input.focus() 가 사용자 제스처 (tap) 컨텍스트 내에서 호출되어야 함.
  // 따라서 fetch 결과를 기다리지 않고 즉시 PIN step 으로 전환 + focus, prompt 만 fetch 결과로 후속 갱신.
  function onSelectMember(m) {
    selectedMember = m;
    pinMode = null;
    firstPin = null;
    setMsg('');
    $('tm-auth-selected').textContent = m.nickname + ' (' + m.kingshot_id + ')';
    $('tm-auth-pin-prompt').textContent = '확인 중...';
    showStep('pin');
    setPinValue('');
    var inp = $('tm-pin-input');
    if (inp) inp.focus();   // 동기 호출 (제스처 컨텍스트 보존)

    callAuth('pin-status', { player_id: m.kingshot_id }).then(function(res) {
      if (!res.ok) {
        setMsg(res.error === 'member_not_found' ? '회원 정보가 없습니다' : '조회 실패: ' + res.error);
        $('tm-auth-pin-prompt').textContent = '';
        return;
      }
      pinMode = res.registered ? 'verify' : 'set';
      $('tm-auth-pin-prompt').textContent = pinMode === 'set'
        ? 'PIN 4자리를 새로 등록하세요'
        : 'PIN 4자리를 입력하세요';
      // pin-status 응답 도착 전에 사용자가 이미 4자리 입력했다면 즉시 처리
      if (pinInput.length === 4) submitPin();
    });
  }

  // ===== PIN 박스 (입력은 native keyboard 가 처리) =====
  function renderPinBoxes() {
    var boxes = document.querySelectorAll('#tm-pin-boxes .tm-pin-box');
    for (var i = 0; i < 4; i++) {
      if (!boxes[i]) continue;
      boxes[i].textContent = pinInput[i] ? '●' : '';
      boxes[i].classList.toggle('tm-pin-box-filled', !!pinInput[i]);
      boxes[i].classList.toggle('tm-pin-box-active', i === pinInput.length);
    }
  }

  function setPinValue(v) {
    pinInput = v;
    var inp = $('tm-pin-input');
    if (inp && inp.value !== v) inp.value = v;
    renderPinBoxes();
  }

  function focusPinInput() {
    setTimeout(function() {
      var inp = $('tm-pin-input');
      if (inp) inp.focus();
    }, 60);
  }

  function submitPin() {
    if (pinInput.length !== 4 || !selectedMember) return;
    if (!pinMode) return;  // pin-status 응답 대기 중 — 응답 도착 시 재호출됨
    if (pinMode === 'set') {
      if (firstPin === null) {
        // 1차 → 2차 확인
        firstPin = pinInput;
        $('tm-auth-pin-prompt').textContent = '확인을 위해 다시 한번 입력하세요';
        setMsg('');
        setPinValue('');
        focusPinInput();
      } else if (firstPin !== pinInput) {
        setMsg('PIN 이 일치하지 않습니다. 처음부터 다시 입력하세요.');
        firstPin = null;
        $('tm-auth-pin-prompt').textContent = 'PIN 4자리를 새로 등록하세요';
        setPinValue('');
        focusPinInput();
      } else {
        callAuth('set-pin', { player_id: selectedMember.kingshot_id, pin: pinInput })
          .then(function(res) {
            if (res.ok) {
              setSession({ player_id: selectedMember.kingshot_id, nickname: selectedMember.nickname });
              closeAuth(true);
            } else {
              setMsg('등록 실패: ' + (res.error || ''));
              firstPin = null;
              setPinValue('');
              focusPinInput();
            }
          });
      }
    } else {
      callAuth('verify-pin', { player_id: selectedMember.kingshot_id, pin: pinInput })
        .then(function(res) {
          if (res.ok) {
            setSession({ player_id: selectedMember.kingshot_id, nickname: selectedMember.nickname });
            closeAuth(true);
          } else {
            setMsg(FAIL_MSG);
            setPinValue('');
            focusPinInput();
          }
        });
    }
  }

  function setMsg(m) { $('tm-auth-msg').textContent = m || ''; }

  function callAuth(action, body) {
    return fetch(FN_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify(Object.assign({ action: action }, body))
    }).then(function(r) { return r.json(); }).catch(function(err) {
      return { ok: false, error: String(err.message || err) };
    });
  }

  // ===== init =====
  function initPage() {
    if (initialized) return;
    initialized = true;

    var search = $('tm-auth-search');
    if (search) {
      search.addEventListener('input', function() {
        renderList(filterMembers(search.value));
      });
    }

    // PIN input — 네이티브 키보드 사용. 숫자만 허용, 4자리 입력 시 자동 제출.
    var pinIn = $('tm-pin-input');
    if (pinIn) {
      pinIn.addEventListener('input', function(e) {
        var v = (e.target.value || '').replace(/\D/g, '').slice(0, 4);
        setPinValue(v);
        if (v.length === 4) setTimeout(submitPin, 120);
      });
      // PC: Enter 키로도 제출 (4자리 다 차면 input event 가 자동 제출)
      pinIn.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && pinInput.length === 4) {
          e.preventDefault();
          submitPin();
        }
      });
      // 박스 영역 클릭 시 input 으로 포커스 (4박스가 pointer-events:none 이라 wrap 클릭 처리)
      var wrap = $('tm-pin-wrap');
      if (wrap) wrap.addEventListener('click', focusPinInput);
    }
    var closeBtn = $('tm-auth-close');
    if (closeBtn) closeBtn.addEventListener('click', function() { closeAuth(false); });
    var backBtn = $('tm-auth-back');
    if (backBtn) backBtn.addEventListener('click', function() {
      resetState(); showStep('select'); setMsg('');
      var s = $('tm-auth-search'); if (s) s.value = '';
      renderList(members);
    });

    // 미니게임 탭 진입 시 항상 멤버 로드 — 인증된 사용자도 아바타 끼우기 등에 캐시 사용
    if (!members.length) loadMembers();
  }

  // ===== Public API =====
  window.TileMatchAuth = {
    initPage: initPage,
    ensureAuth: ensureAuth,
    getSession: getSession,
    clearSession: clearSession,
    onSessionChange: onSessionChange,
    // 다른 모듈(예: tile-match 의 아바타 끼워넣기)에서 멤버 캐시 재사용
    get _cachedMembers() { return members; }
  };
})();
