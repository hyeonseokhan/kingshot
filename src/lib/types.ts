/**
 * Supabase DB row 타입 — 이식 단계에선 핵심 필드만 명시.
 * Phase 7 에서 supabase gen types 스크립트 도입 검토.
 */

export type AllianceRank = 'R5' | 'R4' | 'R3' | 'R2' | 'R1';

export interface Member {
  id: string;
  kingshot_id: string;
  nickname: string;
  level: number | null;
  kingdom: string | null;
  profile_photo: string | null;
  alliance_rank: AllianceRank | null;
  auto_coupon: boolean | null;
  power: number | null;
  /** 클라이언트 계산 필드 — power-desc 기준 1..N 순위 */
  alliance_rank_pos?: number;
}

export interface CouponAccount {
  id: string;
  kingshot_id: string;
  nickname: string;
  level: number | null;
  kingdom: string | null;
  profile_photo: string | null;
}

export interface CouponHistoryRow {
  kingshot_id: string;
  coupon_code: string;
  status: string;
  message?: string | null;
  redeemed_at?: string | null;
}

export interface ActiveCoupon {
  code: string;
  expiresAt?: string | null;
}

/** centurygame redeem-coupon 응답 (player action) */
export interface PlayerInfoResponse {
  code: number;
  msg?: string;
  data?: {
    fid: string | number;
    nickname: string;
    stove_lv?: number | null;
    stove_lv_content?: number | null;
    kid?: string | null;
    avatar_image?: string | null;
  };
}

/** centurygame redeem_batch 응답 */
export interface RedeemBatchResponse {
  code: number;
  msg?: string;
  err_code?: number | null;
  results?: Array<{
    cdk: string;
    code: number;
    msg?: string;
    err_code?: number | null;
  }>;
}

/** 쿠폰 수령 대상 통합 계정 — members(auto_coupon) + coupon_accounts */
export interface RedeemAccount {
  /** coupon_accounts 의 UUID. members 출처면 undefined. */
  id?: string;
  kingshot_id: string;
  nickname: string;
  level: number | null;
  kingdom: string | null;
  profile_photo: string | null;
  source: 'member' | 'extra';
}
