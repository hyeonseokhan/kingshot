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
    // 서브메뉴를 가진 탭은 활성 서브메뉴의 init 훅도 발동 (탭 버튼 클릭 경로 보강)
    var activeSub = document.querySelector(
      '#tab-' + tabId + ' .left-nav-item.active[data-submenu]'
    );
    if (activeSub) fireSubmenuInit(activeSub.dataset.submenu);
  }

  function fireSubmenuInit(submenuId) {
    if (submenuId === 'coupons' && window.Coupons && window.Coupons.initPage) {
      window.Coupons.initPage();
    } else if (submenuId === 'tile-match' && window.TileMatch && window.TileMatch.initPage) {
      window.TileMatch.initPage();
    } else if (submenuId === 'partner-draw' && window.PartnerDraw && window.PartnerDraw.initPage) {
      window.PartnerDraw.initPage();
    }
  }

  // ===== 좌측 네비 섹션 전환 =====
  function initNavItems() {
    document.querySelectorAll('.left-nav-item').forEach(function(item) {
      item.addEventListener('click', function() {
        // 서브메뉴 전환 (연맹관리 탭)
        if (item.dataset.submenu) {
          switchSubmenu(item.dataset.tab, item.dataset.submenu);
          return;
        }
        switchSection(item.dataset.tab, parseInt(item.dataset.section, 10));
      });
    });
  }

  function switchSubmenu(tabId, submenuId) {
    // 좌측 nav 활성화
    document.querySelectorAll('.left-nav-item[data-tab="' + tabId + '"]').forEach(function(el) {
      el.classList.toggle('active', el.dataset.submenu === submenuId);
    });
    // 페이지 전환
    document.querySelectorAll('#tab-' + tabId + ' .manage-page').forEach(function(el) {
      el.style.display = el.id === 'page-' + submenuId ? '' : 'none';
    });
    // URL 해시 업데이트
    history.replaceState(null, '', '#' + tabId + '-' + submenuId);
    fireSubmenuInit(submenuId);
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
    // ?auto-redeem=true 파라미터가 있으면 쿠폰 받기 페이지로 자동 전환
    var params = new URLSearchParams(window.location.search);
    if (params.get('auto-redeem') === 'true') {
      switchTab('manage');
      switchSubmenu('manage', 'coupons');
      return;
    }

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

    // 첫 번째 dash 만 split — submenu id 가 dash 를 포함하는 경우(partner-draw 등) 처리
    var dashIdx = hash.indexOf('-');
    var tabId = dashIdx === -1 ? hash : hash.slice(0, dashIdx);
    var secondPart = dashIdx === -1 ? null : hash.slice(dashIdx + 1);

    var tabEl = document.getElementById('tab-' + tabId);
    if (!tabEl) {
      var firstTab = document.querySelector('.tab');
      if (firstTab) switchTab(firstTab.dataset.tab);
      return;
    }

    switchTab(tabId);

    // 서브메뉴 (manage-coupons, manage-members)
    if (secondPart && document.getElementById('page-' + secondPart)) {
      switchSubmenu(tabId, secondPart);
    } else if (secondPart) {
      var sectionIdx = parseInt(secondPart, 10) || 0;
      if (sectionIdx > 0) switchSection(tabId, sectionIdx);
    }

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
      syncActiveState();
      overlay.classList.add('open');
      panel.classList.add('open');
    }

    // 현재 활성 탭/서브메뉴를 모바일 메뉴에 반영
    function syncActiveState() {
      if (!activeTab) return;
      // 탭 펼침 상태 초기화
      panel.querySelectorAll('.mobile-nav-children').forEach(function(c) { c.classList.remove('open'); });
      panel.querySelectorAll('.mobile-nav-tab').forEach(function(t) { t.classList.remove('expanded'); });
      panel.querySelectorAll('.mobile-nav-section').forEach(function(s) { s.classList.remove('active'); });

      // 현재 탭 펼침
      var currentTab = panel.querySelector('.mobile-nav-tab[data-tab="' + activeTab + '"]');
      var currentChildren = panel.querySelector('.mobile-nav-children[data-parent="' + activeTab + '"]');
      if (currentTab && currentChildren) {
        currentTab.classList.add('expanded');
        currentChildren.classList.add('open');
      }

      // 서브메뉴 활성 표시 (연맹관리 탭)
      if (activeTab === 'manage') {
        var activeSubmenuId = null;
        document.querySelectorAll('#tab-manage .manage-page').forEach(function(p) {
          if (p.style.display !== 'none') {
            activeSubmenuId = p.id.replace('page-', '');
          }
        });
        if (activeSubmenuId) {
          var activeSection = panel.querySelector('.mobile-nav-section[data-tab="manage"][data-submenu="' + activeSubmenuId + '"]');
          if (activeSection) activeSection.classList.add('active');
        }
      } else {
        // 가이드 탭: 현재 섹션 인덱스 기반
        var secIdx = sectionState[activeTab] || 0;
        var activeSection = panel.querySelector('.mobile-nav-section[data-tab="' + activeTab + '"][data-section="' + secIdx + '"]');
        if (activeSection) activeSection.classList.add('active');
      }
    }

    function closeMenu() {
      overlay.classList.remove('open');
      panel.classList.remove('open');
    }

    btn.addEventListener('click', openMenu);
    overlay.addEventListener('click', closeMenu);
    closeBtn.addEventListener('click', closeMenu);

    // 탭 클릭 → 토글 펼치기/접기
    panel.querySelectorAll('.mobile-nav-tab').forEach(function(tab) {
      tab.addEventListener('click', function(e) {
        var children = panel.querySelector('.mobile-nav-children[data-parent="' + tab.dataset.tab + '"]');
        if (!children) return;

        var isOpen = children.classList.contains('open');

        // 다른 탭 모두 닫기
        panel.querySelectorAll('.mobile-nav-children').forEach(function(c) { c.classList.remove('open'); });
        panel.querySelectorAll('.mobile-nav-tab').forEach(function(t) { t.classList.remove('expanded'); });

        // 토글
        if (!isOpen) {
          children.classList.add('open');
          tab.classList.add('expanded');
        }
      });
    });

    // 섹션 클릭
    panel.querySelectorAll('.mobile-nav-section').forEach(function(item) {
      item.addEventListener('click', function() {
        var tabId = item.dataset.tab;
        switchTab(tabId);
        if (item.dataset.submenu) {
          switchSubmenu(tabId, item.dataset.submenu);
        } else if (item.dataset.section !== undefined) {
          switchSection(tabId, parseInt(item.dataset.section, 10));
        }
        closeMenu();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', initMobileMenu);

})();
