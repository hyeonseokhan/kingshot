/**
 * 공통 유틸리티 — utils.js 의 TypeScript 이식.
 * Phase 7 에서 도메인별로 분할 검토.
 */

/** 쿠폰 교환 상태 코드 */
export const REDEEM_STATUS = {
  SUCCESS: 'success',
  ALREADY: 'already_redeemed',
} as const;
export type RedeemStatus = (typeof REDEEM_STATUS)[keyof typeof REDEEM_STATUS];

/** centurygame "이미 수령됨" 응답에 등장하는 키워드 */
const ALREADY_REDEEMED_KEYWORDS = ['RECEIVED', 'redeemed once'];

/** centurygame err_code → 사용자용 한글 라벨 */
const REDEEM_ERR_CODES: Record<number, string> = {
  40004: '인증코드 불일치',
  40005: '존재하지 않는 쿠폰 코드',
  40007: '만료된 쿠폰 코드',
  40008: '이미 수령된 쿠폰',
  40014: '서버 시간 오류',
  40017: '영주 상담원 전속 코드 (카카오톡 채널 자격 필요)',
};

/** 레벨별 프로필 테두리 CSS 클래스 매핑 (임계값 내림차순) */
const LEVEL_CLASSES: Array<{ min: number; cls: string }> = [
  { min: 30, cls: ' lv-30' },
  { min: 29, cls: ' lv-29' },
  { min: 28, cls: ' lv-28' },
];

/** HTML 특수문자 이스케이프 */
export function esc(s: unknown): string {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ISO → YYYY-MM-DD */
export function formatDate(isoStr: string | null | undefined): string {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

/** Promise 기반 sleep */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 숫자에 천 단위 쉼표 */
export function formatNum(n: number | null | undefined): string {
  if (!n) return '-';
  return Number(n).toLocaleString();
}

/** 레벨에 해당하는 프로필 테두리 CSS 클래스 ('', ' lv-28', ' lv-29', ' lv-30') */
export function getLevelClass(level: number | null | undefined): string {
  const lv = Number(level) || 0;
  for (const { min, cls } of LEVEL_CLASSES) {
    if (lv >= min) return cls;
  }
  return '';
}

/** 메모/이름 말줄임 */
export function truncate(text: string | null | undefined, limit: number): string {
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

/** centurygame 응답이 "이미 수령됨" 인지 판별 */
export function isAlreadyRedeemed(json: { msg?: string }): boolean {
  if (!json.msg) return false;
  return ALREADY_REDEEMED_KEYWORDS.some((kw) => json.msg!.indexOf(kw) !== -1);
}

/** 쿠폰 교환 응답을 사람이 이해할 수 있는 한글 라벨로 변환 */
export function describeRedeemError(resp: {
  code?: number;
  msg?: string;
  err_code?: number | null;
} | null | undefined): string {
  if (!resp) return '실패';
  if (resp.err_code != null && REDEEM_ERR_CODES[resp.err_code]) {
    return REDEEM_ERR_CODES[resp.err_code]!;
  }
  if (isAlreadyRedeemed(resp)) return '이미 수령됨';
  return resp.msg || '실패';
}

/** 모달/다이얼로그 오버레이 토글 */
export function toggleOverlay(overlayId: string, open: boolean): void {
  const el = document.getElementById(overlayId);
  if (el) el.classList.toggle('open', open);
}

/** 전투력 → 표시용 문자열 (1M 이상은 XX.XM) */
export function formatPower(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return (m >= 100 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, '') + 'M';
  }
  return v.toLocaleString('ko-KR');
}

/** ISO → 'YYYY-MM-DD HH:MM' (이력 다이얼로그 title 용) */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0') +
    ' ' +
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
}

/** ISO → 상대 시간 ("3분 전", "어제", "3일 전" 등) */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return '방금 전';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + '분 전';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + '시간 전';

  const nowDate = new Date(now);
  const thenDate = new Date(then);
  const diffDays = Math.floor(
    (Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()) -
      Date.UTC(thenDate.getFullYear(), thenDate.getMonth(), thenDate.getDate())) /
      86_400_000,
  );
  if (diffDays === 1) return '어제';
  if (diffDays === 2) return '그제';
  if (diffDays < 7) return diffDays + '일 전';
  if (diffDays < 30) return Math.floor(diffDays / 7) + '주 전';
  if (diffDays < 365) return Math.floor(diffDays / 30) + '개월 전';
  return Math.floor(diffDays / 365) + '년 전';
}
