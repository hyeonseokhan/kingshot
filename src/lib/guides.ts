import { getCollection, type CollectionEntry } from 'astro:content';

export type GuideCategory = 'beginner' | 'events';
export type GuideEntry = CollectionEntry<'guides'>;
export type GuideLang = 'ko' | 'en';

/** entry.id 의 .en suffix 로 언어 판단. Astro 버전마다 id 가 .md 포함/미포함 둘 다 가능 → 양쪽 모두 매칭. */
export function langOf(entry: GuideEntry): GuideLang {
  return /\.en(\.md)?$/.test(entry.id) ? 'en' : 'ko';
}

/** 언어 suffix 제거한 베이스 slug — '01-overview' (ko/en 페어가 같은 값). */
export function baseSlugOf(entry: GuideEntry): string {
  const tail = entry.id.includes('/') ? entry.id.split('/').slice(1).join('/') : entry.id;
  return tail.replace(/\.md$/, '').replace(/\.en$/, '');
}

/** 카테고리의 ko 가이드만 order 오름차순으로 반환 (URL 페이지 빌드 기준). */
export async function getGuidesByCategory(category: GuideCategory): Promise<GuideEntry[]> {
  const all = await getCollection(
    'guides',
    (e) => e.data.category === category && langOf(e) === 'ko',
  );
  return all.sort((a, b) => a.data.order - b.data.order);
}

/** ko entry 와 같은 카테고리·base slug 의 en entry 를 반환. 없으면 null. */
export async function getGuideEn(koEntry: GuideEntry): Promise<GuideEntry | null> {
  const base = baseSlugOf(koEntry);
  const all = await getCollection(
    'guides',
    (e) =>
      e.data.category === koEntry.data.category &&
      langOf(e) === 'en' &&
      baseSlugOf(e) === base,
  );
  return all[0] ?? null;
}

/** 카테고리의 en 가이드 → base slug 로 인덱스. buildNavItems 가 페어 매칭에 활용. */
export async function getEnIndexByCategory(
  category: GuideCategory,
): Promise<Record<string, GuideEntry>> {
  const all = await getCollection(
    'guides',
    (e) => e.data.category === category && langOf(e) === 'en',
  );
  const map: Record<string, GuideEntry> = {};
  for (const e of all) map[baseSlugOf(e)] = e;
  return map;
}

/** entry.id ('beginner/01-overview') → URL slug ('01-overview'). */
export function entryToSlug(entry: GuideEntry): string {
  return baseSlugOf(entry);
}

/** 좌측 네비 항목 — ko title 기본, en pair 있으면 titleEn 도 함께 전달. */
export function buildNavItems(
  guides: GuideEntry[],
  category: GuideCategory,
  activeSlug?: string,
  enIndex?: Record<string, GuideEntry>,
): Array<{ title: string; titleEn?: string; path: string; active: boolean }> {
  return guides.map((g) => {
    const slug = entryToSlug(g);
    return {
      title: g.data.title,
      titleEn: enIndex?.[slug]?.data.title,
      path: `/${category}/${slug}/`,
      active: slug === activeSlug,
    };
  });
}
