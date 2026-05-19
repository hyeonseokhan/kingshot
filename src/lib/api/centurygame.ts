/**
 * centurygame player API 호출 — supabase Edge Function `redeem-coupon` 의
 * `action: 'player'` 디스패치를 호출해 player 프로필을 조회한다.
 *
 * 4 호출처 (members 등록/갱신, coupons 등록/갱신, blacklist 등록/갱신) 의 인라인
 * fetch + JSON 매핑 + 에러 분기 패턴을 단일 함수로 통합. 응답 정규화 + 에러 분류
 * (not-found vs generic) 를 한 곳에서 처리.
 *
 * 사용:
 *   try {
 *     const p = await lookupPlayer(kingshotId);
 *     // p.kingshotId / p.nickname / p.level / p.kingdom / p.avatarUrl
 *   } catch (err) {
 *     if (err instanceof PlayerNotFoundError) { ... }
 *     else if (err instanceof PlayerLookupError) { ... }
 *   }
 *
 * import.meta.env 를 직접 사용 — `@/lib/supabase` 를 import 하지 않아 createClient
 * (~200 KB) 청크에 끌려 들어가지 않는다. caller (blacklist 등) 가 supabase 청크
 * 없이도 본 모듈만 import 가능.
 */

import type { PlayerInfoResponse } from '../types';

const REDEEM_API =
  (import.meta.env.PUBLIC_SUPABASE_URL as string) + '/functions/v1/redeem-coupon';

/** 정규화된 player 조회 결과. 외부 API 의 필드 이름 변화로부터 caller 보호. */
export interface PlayerLookup {
  kingshotId: string;
  nickname: string;
  /** stove_lv ?? stove_lv_content ?? 0. centurygame 응답에서 두 필드가 혼용. */
  level: number;
  kingdom: string | null;
  avatarUrl: string | null;
}

/** "Player Not Existed" 등 외부 API 가 not-found 를 알린 경우. */
export class PlayerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerNotFoundError';
  }
}

/** 그 외 lookup 실패 (네트워크 / HTTP / Sign Error 등). */
export class PlayerLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerLookupError';
  }
}

const NOT_FOUND_RE = /not.*exist|not.*found/i;

export async function lookupPlayer(kingshotId: string): Promise<PlayerLookup> {
  let res: Response;
  try {
    res = await fetch(REDEEM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'player', fid: kingshotId }),
    });
  } catch (err) {
    throw new PlayerLookupError((err as Error).message);
  }
  if (!res.ok) {
    throw new PlayerLookupError('HTTP ' + res.status);
  }
  const json = (await res.json()) as PlayerInfoResponse;
  if (json.code !== 0 || !json.data) {
    const msg = json.msg || 'lookup failed';
    if (NOT_FOUND_RE.test(msg)) throw new PlayerNotFoundError(msg);
    throw new PlayerLookupError(msg);
  }
  const d = json.data;
  return {
    kingshotId: String(d.fid),
    nickname: d.nickname,
    level: Number(d.stove_lv ?? d.stove_lv_content ?? 0) || 0,
    kingdom: d.kid ?? null,
    avatarUrl: d.avatar_image ?? null,
  };
}
