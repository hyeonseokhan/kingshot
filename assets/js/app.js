// ===== PNX 연맹 가이드 앱 로직 =====

(function() {
  'use strict';

  var activeTab = null;
  var sectionState = {};

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
    document.querySelectorAll('.tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-content').forEach(function(tc) {
      tc.classList.toggle('active', tc.id === 'tab-' + tabId);
    });
    activeTab = tabId;
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
        switchSection(item.dataset.tab, parseInt(item.dataset.section, 10));
      });
    });
  }

  function switchSection(tabId, idx) {
    document.querySelectorAll('.left-nav-item[data-tab="' + tabId + '"]').forEach(function(el, i) {
      el.classList.toggle('active', i === idx);
    });
    document.querySelectorAll('.section-content[data-tab="' + tabId + '"]').forEach(function(el, i) {
      el.style.display = i === idx ? '' : 'none';
    });
    var center = document.querySelector('#tab-' + tabId + ' .center-content');
    if (center) center.scrollTop = 0;
    sectionState[tabId] = idx;
    updateRightToc();
    updateHash();
  }

  // ===== 헤딩에 앵커 부여 =====
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
          var tab = section.dataset.tab;
          var sIdx = section.dataset.section;
          history.replaceState(null, '', '#' + tab + '-' + sIdx + ':' + slug);
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

    // TOC 클릭 → URL 해시에 slug 포함 + 스크롤
    container.querySelectorAll('.right-toc-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var el = document.getElementById(item.dataset.slug);
        if (el) {
          var center = document.querySelector('#tab-' + activeTab + ' .center-content');
          center.scrollTo({ top: el.offsetTop - 60, behavior: 'smooth' });
          var sIdx = sectionState[activeTab] || 0;
          history.replaceState(null, '', '#' + activeTab + '-' + sIdx + ':' + item.dataset.slug);
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
  // 형식: #탭-섹션인덱스 또는 #탭-섹션인덱스:heading-slug
  function updateHash() {
    if (!activeTab) return;
    var idx = sectionState[activeTab] || 0;
    history.replaceState(null, '', '#' + activeTab + '-' + idx);
  }

  function restoreFromHash() {
    var hash = location.hash.slice(1);
    if (!hash) {
      var firstTab = document.querySelector('.tab');
      if (firstTab) switchTab(firstTab.dataset.tab);
      return;
    }

    // #탭-섹션:slug 또는 #탭-섹션
    var slug = null;
    var colonIdx = hash.indexOf(':');
    if (colonIdx !== -1) {
      slug = decodeURIComponent(hash.slice(colonIdx + 1));
      hash = hash.slice(0, colonIdx);
    }

    var parts = hash.split('-');
    var tabId = parts[0];
    var sectionIdx = parts.length > 1 ? parseInt(parts[1], 10) : 0;

    var tabEl = document.getElementById('tab-' + tabId);
    if (!tabEl) {
      var firstTab = document.querySelector('.tab');
      if (firstTab) switchTab(firstTab.dataset.tab);
      return;
    }

    switchTab(tabId);
    if (sectionIdx > 0) switchSection(tabId, sectionIdx);

    // slug가 있으면 해당 heading으로 스크롤 (렌더링 완료 대기)
    if (slug) {
      function scrollToSlug() {
        var el = document.getElementById(slug);
        if (el) {
          var center = document.querySelector('#tab-' + tabId + ' .center-content');
          if (center) center.scrollTo({ top: el.offsetTop - 20, behavior: 'instant' });
        }
      }
      // 폰트/레이아웃 렌더링 완료 후 스크롤
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function() { setTimeout(scrollToSlug, 50); });
      } else {
        setTimeout(scrollToSlug, 300);
      }
    }
  }

  // ===== 모바일 메뉴 =====
  function initMobileMenu() {
    var btn = document.getElementById('mobile-menu-btn');
    var overlay = document.getElementById('mobile-nav-overlay');
    var panel = document.getElementById('mobile-nav-panel');
    var closeBtn = document.getElementById('mobile-nav-close');
    if (!btn || !panel) return;

    function openMenu() {
      overlay.classList.add('open');
      panel.classList.add('open');
    }
    function closeMenu() {
      overlay.classList.remove('open');
      panel.classList.remove('open');
    }

    btn.addEventListener('click', openMenu);
    overlay.addEventListener('click', closeMenu);
    closeBtn.addEventListener('click', closeMenu);

    // 탭 클릭
    panel.querySelectorAll('.mobile-nav-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        panel.querySelectorAll('.mobile-nav-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        switchTab(tab.dataset.tab);
        closeMenu();
      });
    });

    // 섹션 클릭
    panel.querySelectorAll('.mobile-nav-section').forEach(function(item) {
      item.addEventListener('click', function() {
        panel.querySelectorAll('.mobile-nav-section').forEach(function(s) { s.classList.remove('active'); });
        item.classList.add('active');
        switchTab(item.dataset.tab);
        switchSection(item.dataset.tab, parseInt(item.dataset.section, 10));
        closeMenu();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', initMobileMenu);

})();
