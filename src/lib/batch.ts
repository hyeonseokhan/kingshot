/**
 * 배치 단위로 순차 실행하는 헬퍼.
 *
 * 외부 API rate limit 을 피하면서 다수 항목을 처리할 때 사용:
 *   - 한 batch 안의 아이템은 Promise.all 로 동시에 처리
 *   - batch 사이에 delay 삽입
 *   - 진행률 UI 업데이트는 onBatchStart / onBatchComplete 콜백으로
 *
 * 호출처: members 전체 갱신, coupons 추가 계정 갱신 / 전체 쿠폰 수령,
 *         blacklist 전체 프로필 갱신.
 *
 * 예:
 *   await runBatched({
 *     items: targets,
 *     batchSize: 5,
 *     delayMs: 1000,
 *     handler: (m) => refreshSingleMember(m, stats),
 *     onBatchComplete: (done, total) => updateProgress(done, total),
 *   });
 */

import { delay } from './utils';

export interface RunBatchedOptions<T> {
  items: T[];
  batchSize: number;
  /** 배치 사이 ms 대기. 마지막 배치 뒤에는 적용 안 됨. */
  delayMs: number;
  handler: (item: T) => Promise<unknown>;
  /** 각 배치 Promise.all 직전 호출 (batchIdx: 0..batchCount-1). */
  onBatchStart?: (batchIdx: number, batchCount: number) => void;
  /** 각 배치 Promise.all 완료 후 호출 (delay 전). done = 누적 처리 아이템 수. */
  onBatchComplete?: (done: number, total: number) => void;
}

export async function runBatched<T>(opts: RunBatchedOptions<T>): Promise<void> {
  const { items, batchSize, delayMs, handler, onBatchStart, onBatchComplete } = opts;
  const total = items.length;
  if (total === 0) return;
  const batchCount = Math.ceil(total / batchSize);
  let done = 0;
  for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
    const start = batchIdx * batchSize;
    const batch = items.slice(start, start + batchSize);
    onBatchStart?.(batchIdx, batchCount);
    await Promise.all(batch.map((item) => handler(item)));
    done += batch.length;
    onBatchComplete?.(done, total);
    if (batchIdx < batchCount - 1) await delay(delayMs);
  }
}
