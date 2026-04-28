/**
 * 레거시 hash URL → Astro 페이지 path 로 변환.
 * 외부에 공유된 옛 링크(예: 단톡방 #manage-coupons)가 깨지지 않도록 보호한다.
 *
 * 가이드형 hash(#beginner-3:slug) 매핑은 Phase 3 에서 가이드 슬러그가 확정된 뒤
 * GUIDE_INDEX 를 채워 활성화한다. Phase 2 시점에선 앱형 경로만 처리.
 */

type Pathname = `/${string}/`;

const APP_HASH_MAP: Record<string, Pathname> = {
  'manage-members': '/manage/members/',
  'manage-coupons': '/manage/coupons/',
  'minigame-tile-match': '/minigame/tile-match/',
  'minigame-partner-draw': '/minigame/partner-draw/',
};

/**
 * 가이드 슬러그 인덱스 — order 오름차순으로 정렬된 슬러그 배열.
 * 옛 hash URL `#beginner-3` 의 숫자는 0-based 섹션 인덱스 (forloop.index0).
 * 가이드를 추가/삭제/순서 변경 시 동기화 필요.
 */
type GuideIndex = Record<string, string[]>;
const GUIDE_INDEX: GuideIndex = {
  beginner: [
    '01-overview',
    '02-alliance',
    '03-vip-arena',
    '04-hammer-tier',
    '05-events-shop',
    '06-heroes',
    '07-faq',
  ],
  events: ['01-viking-raid', '02-castle-war', '03-bear-hunt'],
};

function resolveLegacyHash(hash: string): { pathname: string; hash?: string } | null {
  if (!hash || hash === '#') return null;

  let body = hash.startsWith('#') ? hash.slice(1) : hash;
  let trailingSlug: string | undefined;
  const colonIdx = body.indexOf(':');
  if (colonIdx !== -1) {
    trailingSlug = body.slice(colonIdx + 1);
    body = body.slice(0, colonIdx);
  }

  if (body in APP_HASH_MAP) {
    return { pathname: APP_HASH_MAP[body]! };
  }

  // 가이드형: "{tab}-{index}" (예: beginner-3, events-1)
  const dashIdx = body.indexOf('-');
  if (dashIdx !== -1) {
    const tab = body.slice(0, dashIdx);
    const idxStr = body.slice(dashIdx + 1);
    const index = parseInt(idxStr, 10);
    const slugs = GUIDE_INDEX[tab];
    if (slugs && Number.isFinite(index) && index >= 0 && index < slugs.length) {
      const slug = slugs[index];
      const pathname = `/${tab}/${slug}/`;
      return trailingSlug ? { pathname, hash: trailingSlug } : { pathname };
    }
  }

  // 단순 탭 hash (#beginner, #events)
  if (body === 'beginner') return { pathname: '/' };
  if (body === 'events') return { pathname: '/events/' };

  return null;
}

if (typeof window !== 'undefined' && window.location.hash) {
  const resolved = resolveLegacyHash(window.location.hash);
  if (resolved) {
    const search = window.location.search;
    const newUrl = resolved.pathname + search + (resolved.hash ? `#${resolved.hash}` : '');
    window.location.replace(newUrl);
  }
}

export {};
