import { ko } from '@/i18n/ko';

export type SubMenu = {
  id: string;
  title: string;
  /** i18n 키 (앱 탭 서브메뉴만 — 가이드 탭은 마크다운에서 옴). 컴포넌트가 data-i18n 으로 swap. */
  titleKey?: string;
  path: string;
};

export type NavTab = {
  id: string;
  title: string;
  /** i18n 키. 컴포넌트가 data-i18n 으로 swap. */
  titleKey: string;
  /** 헤더 탭 클릭 시 이동할 진입 경로. 가이드 탭은 첫 항목, 앱 탭은 첫 서브메뉴. */
  path: string;
  /** path 활성 판정용 prefix (이 prefix 로 시작하면 해당 탭이 active). */
  pathPrefix: string;
  submenus?: SubMenu[];
  /** 이 탭/메뉴를 볼 수 있는 kingshot_id. 지정 시 SSR 은 hidden 으로 출력하고
   *  클라이언트가 세션 일치 시에만 unhide. 다른 사용자에겐 메뉴 자체가 보이지 않음. */
  requireKingshotId?: string;
};

// title 의 source 는 ko 사전 — 사전에서 키 누락되면 컴파일 에러로 검출. SSR 은 항상 한국어.
export const tabs: NavTab[] = [
  {
    id: 'beginner',
    title: ko.nav.beginner,
    titleKey: 'nav.beginner',
    path: '/',
    pathPrefix: '/beginner/',
  },
  {
    id: 'events',
    title: ko.nav.events,
    titleKey: 'nav.events',
    path: '/events/',
    pathPrefix: '/events/',
  },
  {
    id: 'manage',
    title: ko.nav.manage,
    titleKey: 'nav.manage',
    path: '/manage/members/',
    pathPrefix: '/manage/',
    submenus: [
      {
        id: 'members',
        title: ko.nav.submenu.members,
        titleKey: 'nav.submenu.members',
        path: '/manage/members/',
      },
      {
        id: 'coupons',
        title: ko.nav.submenu.coupons,
        titleKey: 'nav.submenu.coupons',
        path: '/manage/coupons/',
      },
    ],
  },
  {
    id: 'minigame',
    title: ko.nav.minigame,
    titleKey: 'nav.minigame',
    path: '/minigame/equipment/',
    pathPrefix: '/minigame/',
    submenus: [
      {
        id: 'equipment',
        title: ko.nav.submenu.equipment,
        titleKey: 'nav.submenu.equipment',
        path: '/minigame/equipment/',
      },
      {
        id: 'pvp',
        title: ko.nav.submenu.pvp,
        titleKey: 'nav.submenu.pvp',
        path: '/minigame/pvp/',
      },
      {
        id: 'tile-match',
        title: ko.nav.submenu.tileMatch,
        titleKey: 'nav.submenu.tileMatch',
        path: '/minigame/tile-match/',
      },
      {
        id: 'partner-draw',
        title: ko.nav.submenu.partnerDraw,
        titleKey: 'nav.submenu.partnerDraw',
        path: '/minigame/partner-draw/',
      },
    ],
  },
  {
    id: 'game-tools',
    title: ko.nav.gameTools,
    titleKey: 'nav.gameTools',
    path: '/game-tools/troops-calculator/',
    pathPrefix: '/game-tools/',
    // Toycode 전용 — SSR 에선 hidden, 클라이언트가 세션 일치 시에만 unhide.
    requireKingshotId: '270680423',
    submenus: [
      {
        id: 'troops-calculator',
        title: ko.nav.submenu.troopsCalculator,
        titleKey: 'nav.submenu.troopsCalculator',
        path: '/game-tools/troops-calculator/',
      },
    ],
  },
];

/** 현재 path 기준 활성 탭. 루트("/")는 첫 가이드 탭으로 간주. */
export function findActiveTab(pathname: string): NavTab | undefined {
  if (pathname === '/' || pathname === '') return tabs[0];
  return tabs.find((t) => pathname.startsWith(t.pathPrefix));
}

/** 앱 탭의 서브메뉴 활성 판정. */
export function findActiveSubmenu(tab: NavTab, pathname: string): SubMenu | undefined {
  if (!tab.submenus) return undefined;
  return tab.submenus.find((s) => pathname.startsWith(s.path));
}
