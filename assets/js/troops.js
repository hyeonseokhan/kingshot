/**
 * 연맹원 병과 분석 페이지.
 *
 * Flow:
 *  1) 연맹원 선택 (검색 + 리스트)
 *  2) 병과/티어/수량 입력 (수동) 또는 사진 업로드 (OCR 추후)
 *  3) 등록된 병과 목록 표시 + 편집/삭제
 *
 * DB: member_troops (kingshot_id, tier, troop_type, quantity) UNIQUE(kingshot_id, tier, troop_type)
 */
(function() {
  'use strict';

  var sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  // ===== 병과 / 티어 정의 =====

  var TROOP_TYPE_LABEL = {
    infantry: '보병',
    cavalry: '기병',
    archer: '궁병'
  };

  var TIER_NAME_INFANTRY = [
    null, '견습 보병', '노련한 보병', '베테랑 보병', '백전의 보병', '강직한 보병',
    '용감한 보병', '두려움 없는 보병', '정예 보병', '영광의 보병', '에이스 보병'
  ];
  var TIER_NAME_CAVALRY = [
    null, '견습 기병', '노련한 기병', '베테랑 기병', '백전의 기병', '강직한 기병',
    '용감한 기병', '두려움 없는 기병', '정예 기병', '영광의 기병', '에이스 기병'
  ];
  var TIER_NAME_ARCHER = [
    null, '견습 궁병', '노련한 궁병', '베테랑 궁병', '백전의 궁병', '강직한 궁병',
    '용감한 궁병', '두려움 없는 궁병', '정예 궁병', '영광의 궁병', '에이스 궁병'
  ];

  function troopName(type, tier) {
    var arr = type === 'cavalry' ? TIER_NAME_CAVALRY
            : type === 'archer'  ? TIER_NAME_ARCHER
            : TIER_NAME_INFANTRY;
    return arr[tier] || (TROOP_TYPE_LABEL[type] + ' T' + tier);
  }

  function formatQty(n) {
    n = Number(n) || 0;
    return n.toLocaleString('ko-KR');
  }

  // ===== 상태 =====

  var allMembers = [];
  var selectedMember = null;
  var entries = [];          // 현재 선택된 멤버의 member_troops 레코드 배열
  var initialized = false;
  var chart = null;          // Chart.js 인스턴스 (lazy)
  var chartJsPromise = null; // Chart.js CDN 로드 Promise (lazy, 1회만)

  // Chart.js — 병과 분석 페이지 진입 시 1회만 CDN 에서 로드
  function loadChartJs() {
    if (window.Chart) return Promise.resolve();
    if (chartJsPromise) return chartJsPromise;
    chartJsPromise = new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      s.onload = function() { resolve(); };
      s.onerror = function() { chartJsPromise = null; reject(new Error('Chart.js load failed')); };
      document.head.appendChild(s);
    });
    return chartJsPromise;
  }

  // ===== DOM refs (lazy) =====

  function $(id) { return document.getElementById(id); }

  // ===== 페이지 초기화 (첫 진입 시 1회) =====

  function initPage() {
    if (initialized) {
      // 데이터만 다시 가져옴
      loadMembers();
      return;
    }
    initialized = true;

    // 티어 select 옵션 채우기
    var tierSel = $('troops-input-tier');
    for (var t = 1; t <= 10; t++) {
      var opt = document.createElement('option');
      opt.value = t;
      opt.textContent = 'T' + t + ' · ' + troopName('infantry', t).split(' ').slice(0, -1).join(' ');
      tierSel.appendChild(opt);
    }

    // 병과 select 변경 시 티어 이름 업데이트
    $('troops-input-type').addEventListener('change', refreshTierLabels);

    $('troops-member-search').addEventListener('input', renderMemberList);
    $('troops-change-member').addEventListener('click', resetSelection);
    $('troops-add-entry').addEventListener('click', addEntry);

    $('troops-photo-input').addEventListener('change', onPhotoSelected);

    loadMembers();
  }

  function refreshTierLabels() {
    var type = $('troops-input-type').value;
    var tierSel = $('troops-input-tier');
    // 첫 번째 옵션(placeholder) 제외
    for (var i = 1; i < tierSel.options.length; i++) {
      var t = parseInt(tierSel.options[i].value, 10);
      var name = troopName(type, t);
      tierSel.options[i].textContent = 'T' + t + ' · ' + name.split(' ').slice(0, -1).join(' ');
    }
  }

  // ===== 멤버 목록 로드 & 검색 =====

  function loadMembers() {
    var listEl = $('troops-member-list');
    listEl.innerHTML = '<div class="empty-cell">로딩 중...</div>';
    sb.from('members').select('id, kingshot_id, nickname, level, kingdom, profile_photo, alliance_rank, power')
      .order('power', { ascending: false })
      .then(function(res) {
        if (res.error) {
          listEl.innerHTML = '<div class="empty-cell">오류: ' + res.error.message + '</div>';
          return;
        }
        allMembers = res.data || [];
        renderMemberList();
        renderAllianceChart();  // 초기 차트 로드 (멤버 목록 확보 후)
      });
  }

  function renderMemberList() {
    var q = ($('troops-member-search').value || '').trim().toLowerCase();
    var listEl = $('troops-member-list');
    var filtered = allMembers.filter(function(m) {
      if (!q) return true;
      return (m.nickname || '').toLowerCase().indexOf(q) !== -1
          || String(m.kingshot_id || '').indexOf(q) !== -1;
    });
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-cell">조건에 맞는 연맹원이 없습니다</div>';
      return;
    }
    listEl.innerHTML = filtered.map(function(m) {
      var avatarInner = m.profile_photo
        ? '<img src="' + Utils.esc(m.profile_photo) + '" class="tm-photo">'
        : '<div class="tm-photo-empty">' + Utils.esc(m.nickname || '').charAt(0) + '</div>';
      return '<div class="troops-member-item" data-id="' + m.id + '">' +
        avatarInner +
        '<div class="tm-info">' +
          '<div class="tm-name">' + Utils.esc(m.nickname || '') + '</div>' +
          '<div class="tm-meta">' + (m.alliance_rank || 'R1') + ' · Lv.' + (m.level || '?') +
            (m.kingdom ? ' · ' + m.kingdom : '') + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    listEl.querySelectorAll('.troops-member-item').forEach(function(el) {
      el.addEventListener('click', function() {
        var id = el.dataset.id;
        var m = allMembers.find(function(x) { return x.id === id; });
        if (m) selectMember(m);
      });
    });
  }

  // ===== 멤버 선택 / 해제 =====

  function selectMember(m) {
    selectedMember = m;

    $('troops-member-picker').style.display = 'none';
    var sel = $('troops-selected');
    sel.style.display = '';
    var avatarEl = $('troops-selected-avatar');
    avatarEl.innerHTML = m.profile_photo
      ? '<img src="' + Utils.esc(m.profile_photo) + '">'
      : '<div class="tm-photo-empty">' + Utils.esc(m.nickname || '').charAt(0) + '</div>';
    $('troops-selected-name').textContent = m.nickname || '';
    $('troops-selected-meta').textContent = (m.alliance_rank || 'R1') + ' · Lv.' + (m.level || '?') +
      (m.kingdom ? ' · ' + m.kingdom : '') + ' · ID ' + m.kingshot_id;

    $('troops-input-section').style.display = '';
    $('troops-data-section').style.display = '';

    loadEntries();
  }

  function resetSelection() {
    selectedMember = null;
    entries = [];
    $('troops-selected').style.display = 'none';
    $('troops-member-picker').style.display = '';
    $('troops-input-section').style.display = 'none';
    $('troops-data-section').style.display = 'none';
    $('troops-photo-preview').style.display = 'none';
  }

  // ===== 해당 멤버의 병과 엔트리 CRUD =====

  function loadEntries() {
    if (!selectedMember) return;
    var wrap = $('troops-entries');
    wrap.innerHTML = '<div class="empty-cell">로딩 중...</div>';
    sb.from('member_troops')
      .select('id, tier, troop_type, quantity, updated_at')
      .eq('kingshot_id', selectedMember.kingshot_id)
      .order('troop_type', { ascending: true })
      .order('tier', { ascending: false })
      .then(function(res) {
        if (res.error) {
          wrap.innerHTML = '<div class="empty-cell">오류: ' + res.error.message + '</div>';
          return;
        }
        entries = res.data || [];
        renderEntries();
        renderSummary();
      });
  }

  function renderEntries() {
    var wrap = $('troops-entries');
    if (entries.length === 0) {
      wrap.innerHTML = '<div class="empty-cell">등록된 병과가 없습니다. 위에서 추가해 주세요.</div>';
      return;
    }
    wrap.innerHTML = entries.map(function(e) {
      return '<div class="troops-entry" data-id="' + e.id + '">' +
        '<div class="te-name">' +
          '<span class="te-type te-type-' + e.troop_type + '">' + TROOP_TYPE_LABEL[e.troop_type] + '</span>' +
          '<span class="te-tier">T' + e.tier + '</span>' +
          '<span class="te-full">' + troopName(e.troop_type, e.tier) + '</span>' +
        '</div>' +
        '<div class="te-qty">' + formatQty(e.quantity) + '</div>' +
        '<div class="te-actions">' +
          '<button class="btn-icon te-edit" title="수정">✎</button>' +
          '<button class="btn-icon te-del" title="삭제">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');

    wrap.querySelectorAll('.te-edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var entryId = btn.closest('.troops-entry').dataset.id;
        editEntry(entryId);
      });
    });
    wrap.querySelectorAll('.te-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var entryId = btn.closest('.troops-entry').dataset.id;
        deleteEntry(entryId);
      });
    });
  }

  function renderSummary() {
    var wrap = $('troops-summary');
    var totals = { infantry: 0, cavalry: 0, archer: 0 };
    var grandTotal = 0;
    entries.forEach(function(e) {
      var q = Number(e.quantity) || 0;
      totals[e.troop_type] = (totals[e.troop_type] || 0) + q;
      grandTotal += q;
    });
    if (grandTotal === 0) { wrap.innerHTML = ''; return; }
    wrap.innerHTML =
      '<div class="ts-cell ts-infantry"><div class="ts-label">보병</div><div class="ts-value">' + formatQty(totals.infantry) + '</div></div>' +
      '<div class="ts-cell ts-cavalry"><div class="ts-label">기병</div><div class="ts-value">' + formatQty(totals.cavalry) + '</div></div>' +
      '<div class="ts-cell ts-archer"><div class="ts-label">궁병</div><div class="ts-value">' + formatQty(totals.archer) + '</div></div>' +
      '<div class="ts-cell ts-total"><div class="ts-label">합계</div><div class="ts-value">' + formatQty(grandTotal) + '</div></div>';
  }

  function addEntry() {
    if (!selectedMember) return;
    var type = $('troops-input-type').value;
    var tier = parseInt($('troops-input-tier').value, 10);
    var qty = parseInt($('troops-input-qty').value, 10);
    if (!type || !tier || isNaN(qty) || qty < 0) {
      alert('병과·티어·수량을 모두 입력하세요.');
      return;
    }
    var row = {
      kingshot_id: selectedMember.kingshot_id,
      tier: tier,
      troop_type: type,
      quantity: qty
    };
    // UNIQUE 제약: 동일 type+tier가 있으면 덮어쓰기 (upsert)
    sb.from('member_troops').upsert(row, { onConflict: 'kingshot_id,tier,troop_type' })
      .then(function(res) {
        if (res.error) { alert('저장 실패: ' + res.error.message); return; }
        $('troops-input-qty').value = '';
        $('troops-input-tier').selectedIndex = 0;
        loadEntries();
        renderAllianceChart();
      });
  }

  function editEntry(id) {
    var e = entries.find(function(x) { return String(x.id) === String(id); });
    if (!e) return;
    var input = prompt(
      troopName(e.troop_type, e.tier) + ' 수량:',
      e.quantity
    );
    if (input === null) return;
    var qty = parseInt(input, 10);
    if (isNaN(qty) || qty < 0) {
      alert('0 이상의 숫자를 입력하세요.');
      return;
    }
    sb.from('member_troops').update({ quantity: qty }).eq('id', e.id)
      .then(function(res) {
        if (res.error) { alert('수정 실패: ' + res.error.message); return; }
        loadEntries();
        renderAllianceChart();
      });
  }

  function deleteEntry(id) {
    var e = entries.find(function(x) { return String(x.id) === String(id); });
    if (!e) return;
    if (!confirm(troopName(e.troop_type, e.tier) + ' 항목을 삭제할까요?')) return;
    sb.from('member_troops').delete().eq('id', e.id)
      .then(function(res) {
        if (res.error) { alert('삭제 실패: ' + res.error.message); return; }
        loadEntries();
        renderAllianceChart();
      });
  }

  // ===== 연맹 전체 병과 분포 차트 =====

  function renderAllianceChart() {
    var statsEl = $('troops-chart-stats');
    var canvasEl = $('troops-chart');
    if (!statsEl || !canvasEl) return;

    loadChartJs().then(function() {
      return sb.from('member_troops').select('kingshot_id, tier, troop_type, quantity');
    }).then(function(res) {
      if (!res || res.error) {
        statsEl.innerHTML = '<span class="troops-chart-empty">차트 데이터 로드 실패</span>';
        return;
      }
      var rows = res.data || [];
      var tiers = [];
      for (var t = 1; t <= 10; t++) tiers.push(t);
      var matrix = { infantry: tiers.map(function() { return 0; }),
                     cavalry:  tiers.map(function() { return 0; }),
                     archer:   tiers.map(function() { return 0; }) };
      var totals = { infantry: 0, cavalry: 0, archer: 0 };
      var recorders = {};
      rows.forEach(function(r) {
        recorders[r.kingshot_id] = true;
        var idx = (Number(r.tier) || 1) - 1;
        var q = Number(r.quantity) || 0;
        if (matrix[r.troop_type]) {
          matrix[r.troop_type][idx] += q;
          totals[r.troop_type] += q;
        }
      });
      var recordersCount = Object.keys(recorders).length;
      var grandTotal = totals.infantry + totals.cavalry + totals.archer;

      // Stats row
      if (grandTotal === 0) {
        statsEl.innerHTML = '<span class="troops-chart-empty">아직 등록된 병과 데이터가 없습니다</span>';
      } else {
        statsEl.innerHTML =
          '<span class="ts-chip ts-chip-infantry">보병 ' + formatQty(totals.infantry) + '</span>' +
          '<span class="ts-chip ts-chip-cavalry">기병 ' + formatQty(totals.cavalry) + '</span>' +
          '<span class="ts-chip ts-chip-archer">궁병 ' + formatQty(totals.archer) + '</span>' +
          '<span class="ts-chip ts-chip-total">합계 ' + formatQty(grandTotal) + '</span>' +
          '<span class="ts-recorders">기록자 ' + recordersCount + '/' + allMembers.length + '</span>';
      }

      // Chart (re-render)
      if (chart) chart.destroy();
      if (!window.Chart) return;
      var ctx = canvasEl.getContext('2d');
      chart = new window.Chart(ctx, {
        type: 'bar',
        data: {
          labels: tiers.map(function(n) { return 'T' + n; }),
          datasets: [
            { label: '보병', data: matrix.infantry, backgroundColor: '#6b7d5e', borderWidth: 0 },
            { label: '기병', data: matrix.cavalry,  backgroundColor: '#7d6b5e', borderWidth: 0 },
            { label: '궁병', data: matrix.archer,   backgroundColor: '#5e6b7d', borderWidth: 0 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { stacked: true, ticks: { font: { size: 11 } }, grid: { display: false } },
            y: {
              stacked: true, beginAtZero: true,
              ticks: {
                font: { size: 11 },
                callback: function(v) {
                  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
                  if (v >= 1000) return Math.round(v / 1000) + 'K';
                  return v;
                }
              }
            }
          },
          plugins: {
            legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } },
            tooltip: {
              callbacks: {
                label: function(c) {
                  return c.dataset.label + ': ' + (c.parsed.y || 0).toLocaleString('ko-KR');
                },
                footer: function(items) {
                  var sum = items.reduce(function(a, b) { return a + (b.parsed.y || 0); }, 0);
                  return '합계: ' + sum.toLocaleString('ko-KR');
                }
              }
            }
          }
        }
      });
    }).catch(function(err) {
      statsEl.innerHTML = '<span class="troops-chart-empty">차트 초기화 실패</span>';
      // eslint-disable-next-line no-console
      console.error('[troops] chart error:', err);
    });
  }

  // ===== 사진 업로드 (OCR은 추후) =====

  function onPhotoSelected(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var preview = $('troops-photo-preview');
    preview.style.display = '';
    preview.innerHTML = '';
    var img = new Image();
    img.onload = function() { URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(file);
    preview.appendChild(img);
    var notice = document.createElement('div');
    notice.className = 'troops-photo-notice';
    notice.innerHTML = '사진이 준비되었습니다. <strong>자동 인식 기능은 추후 제공될 예정</strong>이며, 지금은 수동으로 입력해 주세요.';
    preview.appendChild(notice);
  }

  // ===== Public API =====

  window.Troops = { initPage: initPage };

})();
