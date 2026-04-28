/**
 * Stage → 크리스탈 보상 매핑 (클라이언트 측 mirror).
 *
 * **반드시** supabase/functions/economy/index.ts 의 rewardForStage() 와 동일하게 유지.
 * 서버가 항상 진실의 원천(authoritative) — 클라이언트는 즉시 표시용 사전 계산만 수행.
 *
 * 변경 시 양쪽 동시 수정:
 *   - 본 파일
 *   - supabase/functions/economy/index.ts (~line 51-66)
 *
 * 표:
 *   Stage 1     : 100 (튜토리얼 보너스)
 *   Stage 2~10  : 10, 15, 20, 25, 30, 35, 40, 45, 50 (5씩 점진)
 *   Stage 11~20 : 100, 120, 140, 160, 180, 200, 220, 250, 280, 300
 *   Stage 21~45 : 500 부터 +20씩 → stage 45 = 980
 *   Stage 46+   : 0 (난이도 cap, 의미 없음)
 */

const STAGE_11_20: readonly number[] = [100, 120, 140, 160, 180, 200, 220, 250, 280, 300];

export function rewardForStage(stage: number): number {
  if (stage === 1) return 100;
  if (stage >= 2 && stage <= 10) return (stage - 1) * 5 + 5;
  if (stage >= 11 && stage <= 20) return STAGE_11_20[stage - 11]!;
  if (stage >= 21 && stage <= 45) return 500 + (stage - 21) * 20;
  return 0;
}
