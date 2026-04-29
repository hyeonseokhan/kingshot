/**
 * economy Edge Function
 *
 * 미니게임 크리스탈 경제의 단일 변경 진입점.
 * crystal_balances / crystal_transactions 테이블은 anon write 차단 → 이 함수만 (service_role) 변경 가능.
 *
 * 액션:
 *   { action: "get-balance",         player_id }              → { ok, balance }
 *   { action: "claim-stage-reward",  player_id, stage }       → { ok, amount, balance, duplicate, stage }
 *
 * 보안 모델 (Phase A):
 *   * 호출자가 본인이라는 검증은 클라이언트 sessionStorage 신뢰 + DB FK 제약 (members) 으로 한정.
 *     기존 tile-match-auth 의 record-clear 와 동일 수준. 추후 토큰 검증으로 강화 예정.
 *   * 보상 중복 청구는 crystal_transactions 의 (player_id, ref_key) UNIQUE 인덱스로 강제.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const dbHeaders: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function dbSelectOne(path: string): Promise<any | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...dbHeaders, Accept: "application/vnd.pgrst.object+json" },
  });
  if (res.status === 406) return null;
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbRpc<T = unknown>(fnName: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: dbHeaders,
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fnName} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ============================================================
// stage → reward 매핑 (서버 권위: 클라이언트가 amount 를 결정하지 못하게 함)
// ============================================================
//   Stage 1       : 100  (튜토리얼 보너스, 1회)
//   Stage 2~10    : 10, 15, 20, 25, 30, 35, 40, 45, 50 (5씩 점진, 각 1회)
//   Stage 11~20   : 100, 120, 140, 160, 180, 200, 220, 250, 280, 300 (각 1회)
//   Stage 21~45   : 500 부터 +20씩 → stage 45 = 980 (각 1회)
//   Stage 46+     : 100 (고정, 매 클리어 반복 파밍 — 연맹원 일상 활동 재화)
const STAGE_11_20: readonly number[] = [100, 120, 140, 160, 180, 200, 220, 250, 280, 300];

function rewardForStage(stage: number): number {
  if (stage === 1) return 100;
  if (stage >= 2 && stage <= 10) return (stage - 1) * 5 + 5;
  if (stage >= 11 && stage <= 20) return STAGE_11_20[stage - 11]!;
  if (stage >= 21 && stage <= 45) return 500 + (stage - 21) * 20;
  if (stage >= 46) return 100;
  return 0;
}

function isRepeatableRewardStage(stage: number): boolean {
  return stage >= 46;
}

// ============================================================
// 액션 핸들러
// ============================================================

async function getBalance(playerId: string) {
  const row = await dbSelectOne(
    `crystal_balances?player_id=eq.${encodeURIComponent(playerId)}&select=balance,total_earned,total_spent`
  );
  return {
    ok: true,
    balance: row?.balance ?? 0,
    total_earned: row?.total_earned ?? 0,
    total_spent: row?.total_spent ?? 0,
  };
}

async function claimStageReward(playerId: string, stage: unknown) {
  if (!Number.isInteger(stage) || (stage as number) < 1 || (stage as number) > 200) {
    return { ok: false, error: "invalid_stage" };
  }
  const stageNum = stage as number;

  // member 존재 확인 (FK 가 막아주지만 명확한 에러 메시지)
  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id`
  );
  if (!member) return { ok: false, error: "member_not_found" };

  const amount = rewardForStage(stageNum);
  if (amount <= 0) {
    // 보상 없는 stage (46+) — 잔액만 반환하고 정상 응답
    const cur = await getBalance(playerId);
    return { ok: true, amount: 0, balance: cur.balance, duplicate: false, stage: stageNum };
  }

  // RPC 호출: 거래 INSERT + 잔액 갱신 트랜잭션 + 멱등성
  //   Stage 1~45: first_clear ref_key 로 멱등 (재클리어 시 0 적립)
  //   Stage 46+: ref_key NULL — 매 클리어마다 새 거래 INSERT, 반복 파밍 가능
  const refKey = isRepeatableRewardStage(stageNum)
    ? null
    : `tile_match:stage_${stageNum}:first_clear`;
  const result = await dbRpc<{
    duplicate: boolean;
    amount_applied: number;
    balance: number;
    transaction_id?: string;
  }>("apply_crystal_transaction", {
    p_player_id: playerId,
    p_amount: amount,
    p_source: "tile_match_clear",
    p_ref_key: refKey,
    p_ref_data: { stage: stageNum },
  });

  return {
    ok: true,
    amount: result.amount_applied,
    balance: result.balance,
    duplicate: result.duplicate,
    stage: stageNum,
  };
}

// ============================================================
// 엔트리
// ============================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action, player_id } = body ?? {};
    if (!player_id || typeof player_id !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "missing_player_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let result;
    switch (action) {
      case "get-balance":        result = await getBalance(player_id); break;
      case "claim-stage-reward": result = await claimStageReward(player_id, body.stage); break;
      default:                   result = { ok: false, error: "unknown_action" };
    }
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
