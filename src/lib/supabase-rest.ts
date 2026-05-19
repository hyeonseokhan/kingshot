/**
 * Supabase REST / Edge Function / Storage 직접 호출용 공통 상수.
 *
 * import.meta.env 를 직접 사용 — `@/lib/supabase` (createClient ~200 KB) 와 분리.
 * supabase-js client 가 필요 없는 곳 (blacklist 등) 도 이 모듈만 import 하면
 * REST/Storage/Function 호출 가능.
 *
 * 사용:
 *   import { REST_BASE, restJsonHeaders } from '@/lib/supabase-rest';
 *   await fetch(REST_BASE + '/blacklist?id=eq.' + id, {
 *     method: 'PATCH',
 *     headers: { ...restJsonHeaders, Prefer: 'return=minimal' },
 *     body: JSON.stringify(patch),
 *   });
 */

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;

export const REST_BASE = SUPABASE_URL + '/rest/v1';
export const FN_BASE = SUPABASE_URL + '/functions/v1';
export const STORAGE_BASE = SUPABASE_URL + '/storage/v1';

/** 인증 헤더만 (Content-Type 없음 — Storage 업로드 시 별도 Content-Type 사용). */
export const restHeaders: Record<string, string> = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
};

/** 인증 + JSON Content-Type. REST INSERT/PATCH/DELETE 의 기본. */
export const restJsonHeaders: Record<string, string> = {
  ...restHeaders,
  'Content-Type': 'application/json',
};
