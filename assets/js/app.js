// ===== 킹샷 가이드 앱 로직 =====

(function() {
  'use strict';

  let activeTab = null;
  const sectionState = {}; // 탭별 현재 섹션 인덱스

  // ===== 초기화 =====
  document.addEventListener('DOMContentLoaded', function() {
    initTabs();
    initNavItems();
    processHeadings();
    restoreFromHash();
  });

  // ===== 탭 전환 =====
  function initTabs() {
    document.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        switchTab(btn.dataset.tab);
      });
    });
  }

  function switchTab(tabId) {
    // 탭 버튼 활성화
    document.querySelectorAll('.tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });
    // 탭 콘텐츠 활성화
    document.querySelectorAll('.tab-content').forEach(function(tc) {
      tc.classList.toggle('active', tc.id === 'tab-' + tabId);
    });
    activeTab = tabId;

    // 첫 진입 시 0번 섹션으로 초기화
    if (sectionState[tabId] === undefined) {
      sectionState[tabId] = 0;
    }
    updateRightToc();
    updateHash();
  }

  // ===== 좌측 네비 섹션 전환 =====
  function initNavItems() {
    document.querySelectorAll('.left-nav-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var tab = item.dataset.tab;
        var idx = parseInt(item.dataset.section, 10);
        switchSection(tab, idx);
      });
    });
  }

  function switchSection(tabId, idx) {
    // 좌측 nav 활성화
    document.querySelectorAll('.left-nav-item[data-tab="' + tabId + '"]').forEach(function(el, i) {
      el.classList.toggle('active', i === idx);
    });
    // 섹션 전환
    document.querySelectorAll('.section-content[data-tab="' + tabId + '"]').forEach(function(el, i) {
      el.style.display = i === idx ? '' : 'none';
    });
    // 스크롤 초기화
    var center = document.querySelector('#tab-' + tabId + ' .center-content');
    if (center) center.scrollTop = 0;

    sectionState[tabId] = idx;
    updateRightToc();
    updateHash();
  }

  // ===== 헤딩에 앵커 부여 (kramdown이 이미 id를 생성) =====
  function processHeadings() {
    document.querySelectorAll('.section-content').forEach(function(section) {
      section.querySelectorAll('h2[id], h3[id], h4[id]').forEach(function(h) {
        var slug = h.id;
        var anchor = document.createElement('a');
        anchor.className = 'heading-anchor';
        anchor.href = '#' + slug;
        anchor.textContent = '#';
        anchor.addEventListener('click', function(e) {
          e.preventDefault();
          history.replaceState(null, '', '#' + slug);
          var center = h.closest('.center-content');
          if (center) center.scrollTo({ top: h.offsetTop - 60, behavior: 'smooth' });
        });
        h.insertBefore(anchor, h.firstChild);
      });
    });
  }

  // ===== 우측 TOC =====
  function updateRightToc() {
    if (!activeTab) return;
    var idx = sectionState[activeTab] || 0;
    var container = document.querySelector('#tab-' + activeTab + ' .right-toc-items');
    if (!container) return;

    var section = document.querySelector('.section-content[data-tab="' + activeTab + '"][data-section="' + idx + '"]');
    if (!section) { container.innerHTML = ''; return; }

    var headings = section.querySelectorAll('h2, h3, h4');
    var html = '';
    headings.forEach(function(h) {
      var level = parseInt(h.tagName.charAt(1), 10);
      var text = h.textContent.replace(/^#\s*/, '');
      html += '<div class="right-toc-item level-' + level + '" data-slug="' + h.id + '">' + text + '</div>';
    });
    container.innerHTML = html;

    // TOC 클릭 이벤트
    container.querySelectorAll('.right-toc-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var el = document.getElementById(item.dataset.slug);
        if (el) {
          var center = document.querySelector('#tab-' + activeTab + ' .center-content');
          center.scrollTo({ top: el.offsetTop - 60, behavior: 'smooth' });
        }
      });
    });

    setupScrollSpy();
  }

  // ===== 스크롤 스파이 =====
  function setupScrollSpy() {
    if (!activeTab) return;
    var center = document.querySelector('#tab-' + activeTab + ' .center-content');
    var tocItems = document.querySelectorAll('#tab-' + activeTab + ' .right-toc-items .right-toc-item');
    if (!center || tocItems.length === 0) return;

    var headingEls = [];
    tocItems.forEach(function(ti) {
      var el = document.getElementById(ti.dataset.slug);
      if (el) headingEls.push({ el: el, tocItem: ti });
    });

    // 기존 핸들러 제거
    if (center._scrollSpy) center.removeEventListener('scroll', center._scrollSpy);

    var ticking = false;
    center._scrollSpy = function() {
      if (!ticking) {
        requestAnimationFrame(function() {
          var scrollTop = center.scrollTop + 80;
          var active = null;
          for (var i = 0; i < headingEls.length; i++) {
            if (headingEls[i].el.offsetTop <= scrollTop) active = headingEls[i];
          }
          tocItems.forEach(function(t) { t.classList.remove('active'); });
          if (active) active.tocItem.classList.add('active');
          ticking = false;
        });
        ticking = true;
      }
    };
    center.addEventListener('scroll', center._scrollSpy);
  }

  // ===== URL 해시 =====
  function updateHash() {
    if (!activeTab) return;
    var idx = sectionState[activeTab] || 0;
    var hash = activeTab + '-' + idx;
    history.replaceState(null, '', '#' + hash);
  }

  function restoreFromHash() {
    var hash = location.hash.slice(1);
    if (!hash) {
      // 기본: 첫 번째 탭
      var firstTab = document.querySelector('.tab');
      if (firstTab) switchTab(firstTab.dataset.tab);
      return;
    }

    var parts = hash.split('-');
    var tabId = parts[0];
    var sectionIdx = parts.length > 1 ? parseInt(parts[1], 10) : 0;

    // 탭이 존재하는지 확인
    var tabEl = document.getElementById('tab-' + tabId);
    if (!tabEl) {
      var firstTab = document.querySelector('.tab');
      if (firstTab) switchTab(firstTab.dataset.tab);
      return;
    }

    switchTab(tabId);
    if (sectionIdx > 0) switchSection(tabId, sectionIdx);
  }

})();
