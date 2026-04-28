/**
 * sessionStorage 기반 클라이언트 캐시.
 * 페이지 라우팅 환경에서 modules 가 서로 다른 페이지에 로드되더라도
 * sessionStorage 키 자체는 공유되므로 모듈 간 조정점이 된다.
 */

import type { ActiveCoupon, RedeemAccount } from './types';

const KEY_GIFT_CODES = 'gift_codes_cache';
const KEY_ACCOUNTS = 'coupon_accounts_cache';
const KEY_FAILED_REFRESH = 'members_failed_refresh_v1';

interface GiftCodesCache {
  codes: ActiveCoupon[];
  fetchedAt: number;
  total: number;
}

interface FailedRefresh {
  ids: string[];
  names: string[];
  ts: number;
}

// ===== 활성 쿠폰 =====

export function getGiftCodesCache(): GiftCodesCache | null {
  try {
    const raw = sessionStorage.getItem(KEY_GIFT_CODES);
    if (!raw) return null;
    const cached = JSON.parse(raw) as GiftCodesCache;
    const nowIso = new Date().toISOString();
    // 만료된 코드가 끼어 있으면 캐시 무효화
    if (cached.codes.some((c) => c.expiresAt && c.expiresAt < nowIso)) return null;
    return cached;
  } catch {
    return null;
  }
}

export function setGiftCodesCache(codes: ActiveCoupon[]): void {
  try {
    sessionStorage.setItem(
      KEY_GIFT_CODES,
      JSON.stringify({ codes, fetchedAt: Date.now(), total: codes.length }),
    );
  } catch {
    /* quota / disabled storage */
  }
}

// ===== 쿠폰 대상 계정 =====

export function getAccountsCache(): RedeemAccount[] | null {
  try {
    const raw = sessionStorage.getItem(KEY_ACCOUNTS);
    return raw ? (JSON.parse(raw) as RedeemAccount[]) : null;
  } catch {
    return null;
  }
}

export function setAccountsCache(accounts: RedeemAccount[]): void {
  try {
    sessionStorage.setItem(KEY_ACCOUNTS, JSON.stringify(accounts));
  } catch {
    /* */
  }
}

/** 연맹원 변경 등 사이드이펙트로 캐시를 즉시 무효화. */
export function invalidateAccountsCache(): void {
  try {
    sessionStorage.removeItem(KEY_ACCOUNTS);
  } catch {
    /* */
  }
}

// ===== 갱신 실패 이력 =====

export function getFailedRefresh(): FailedRefresh | null {
  try {
    const raw = sessionStorage.getItem(KEY_FAILED_REFRESH);
    return raw ? (JSON.parse(raw) as FailedRefresh) : null;
  } catch {
    return null;
  }
}

export function saveFailedRefresh(ids: string[], names: string[]): void {
  try {
    sessionStorage.setItem(
      KEY_FAILED_REFRESH,
      JSON.stringify({ ids, names, ts: Date.now() }),
    );
  } catch {
    /* */
  }
}

export function clearFailedRefresh(): void {
  try {
    sessionStorage.removeItem(KEY_FAILED_REFRESH);
  } catch {
    /* */
  }
}
