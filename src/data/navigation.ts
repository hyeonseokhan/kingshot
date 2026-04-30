export type SubMenu = {
  id: string;
  title: string;
  path: string;
};

export type NavTab = {
  id: string;
  title: string;
  /** 헤더 탭 클릭 시 이동할 진입 경로. 가이드 탭은 첫 항목, 앱 탭은 첫 서브메뉴. */
  path: string;
  /** path 활성 판정용 prefix (이 prefix 로 시작하면 해당 탭이 active). */
  pathPrefix: string;
  submenus?: SubMenu[];
};

export const tabs: NavTab[] = [
  {
    id: 'beginner',
    title: '입문 가이드',
    path: '/',
    pathPrefix: '/beginner/',
  },
  {
    id: 'events',
    title: '이벤트',
    path: '/events/',
    pathPrefix: '/events/',
  },
  {
    id: 'manage',
    title: '연맹관리',
    path: '/manage/members/',
    pathPrefix: '/manage/',
    submenus: [
      { id: 'members', title: '연맹원', path: '/manage/members/' },
      { id: 'coupons', title: '쿠폰 받기', path: '/manage/coupons/' },
    ],
  },
  {
    id: 'minigame',
    title: '미니게임',
    path: '/minigame/equipment/',
    pathPrefix: '/minigame/',
    submenus: [
      { id: 'equipment', title: '장비 강화', path: '/minigame/equipment/' },
      { id: 'pvp', title: '매칭 대결', path: '/minigame/pvp/' },
      { id: 'tile-match', title: '타일 매치', path: '/minigame/tile-match/' },
      { id: 'partner-draw', title: '운명의 파트너', path: '/minigame/partner-draw/' },
    ],
  },
  {
    id: 'tools',
    title: '게임도구',
    path: '/tools/build-optimizer/',
    pathPrefix: '/tools/',
    submenus: [
      { id: 'build-optimizer', title: '건설 최적화', path: '/tools/build-optimizer/' },
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
