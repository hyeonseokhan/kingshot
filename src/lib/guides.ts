import { getCollection, type CollectionEntry } from 'astro:content';

export type GuideCategory = 'beginner' | 'events';
export type GuideEntry = CollectionEntry<'guides'>;

/** 카테고리의 가이드를 order 오름차순으로 반환. */
export async function getGuidesByCategory(category: GuideCategory): Promise<GuideEntry[]> {
  const all = await getCollection('guides', (e) => e.data.category === category);
  return all.sort((a, b) => a.data.order - b.data.order);
}

/** entry.id ('beginner/01-overview') → URL slug ('01-overview'). */
export function entryToSlug(entry: GuideEntry): string {
  const tail = entry.id.includes('/') ? entry.id.split('/').slice(1).join('/') : entry.id;
  return tail.replace(/\.md$/, '');
}

/** 좌측 네비 항목을 만든다. activeSlug 와 일치하면 active=true. */
export function buildNavItems(
  guides: GuideEntry[],
  category: GuideCategory,
  activeSlug?: string,
): Array<{ title: string; path: string; active: boolean }> {
  return guides.map((g) => {
    const slug = entryToSlug(g);
    return {
      title: g.data.title,
      path: `/${category}/${slug}/`,
      active: slug === activeSlug,
    };
  });
}
