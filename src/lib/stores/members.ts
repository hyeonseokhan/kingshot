/**
 * 전체 연맹원 로스터 — 페이지 간 공유 store.
 *
 * 4 페이지(`members`, `coupons`, `pvp`, `tile-match`)가 각자 fetch 하던 패턴을 통합.
 * 22명 규모라 SELECT * 라도 페이로드가 작아서 페이지별 컬럼 분기보다 단일 fetch 가 효율적.
 *
 * 사용:
 *   import { membersStore, fetchMembers } from '@/lib/stores/members';
 *   const unsub = membersStore.subscribe((list) => render(list));
 *   membersStore.refresh(fetchMembers);
 */

import { supabase } from '@/lib/supabase';
import { createStore } from '@/lib/store';
import type { Member } from '@/lib/types';

const TTL_MS = 60_000; // 1분 — 너무 stale 하지 않으면서 페이지 이동 시 재 fetch 회피

export const membersStore = createStore<Member[]>({
  storageKey: 'members_roster_v1',
  ttlMs: TTL_MS,
  validate: (raw): boolean => Array.isArray(raw),
});

/** members 테이블 전량 SELECT *. order 는 사용 시점에 정렬. */
export async function fetchMembers(): Promise<Member[]> {
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .order('nickname', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Member[];
}
