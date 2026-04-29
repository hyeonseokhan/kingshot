/**
 * equipment Edge Function (Phase B)
 *
 * 장비 강화의 단일 변경 진입점.
 * equipment_levels 테이블은 anon write 차단 → 이 함수만 (service_role) 변경 가능.
 *
 * 액션:
 *   { action: "get-equipment", player_id }                 → { ok, levels: [{slot,level,power,last_attempt_at}] }
 *   { action: "enhance",       player_id, slot }           → { ok, success, new_level, new_power, cost, balance } | { ok:false, error }
 *
 * 디자인:
 *   - 강화 표(ENHANCE_TABLE)는 서버측 SSOT. 클라이언트의 src/lib/balance.ts 와 동일 유지 필수.
 *   - cost/power/rate 는 서버가 계산해서 RPC 에 전달. 클라이언트 입력 신뢰 안 함.
 *   - 확률 굴림 + 잔액 차감 + 레벨 갱신은 RPC enhance_equipment() 안에서 atomic.
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

async function dbSelect(path: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbSelectOne(path: string): Promise<unknown | null> {
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
// 장비 강화 — 등급별 range + 선형 보간 (SSOT, 클라이언트 src/lib/balance.ts 와 일치 유지)
// ============================================================
//   - 튜토리얼 (+1, +2): 100% 성공
//   - 등급별 range 안에서 cost/power/rate 선형 보간
//   - 100단계 cap (그 이후는 후속 트랙 — 신소재 시스템)
const ENHANCE_MAX_LEVEL = 100;

const ENHANCE_RANGES: ReadonlyArray<{
  from: number; to: number;
  costFrom: number; costTo: number;
  powerFrom: number; powerTo: number;
  rateFrom: number; rateTo: number;
}> = [
  { from: 3,  to: 10,  costFrom: 300,    costTo: 1000,   powerFrom: 80,    powerTo: 200,    rateFrom: 0.95, rateTo: 0.80 },
  { from: 11, to: 25,  costFrom: 1500,   costTo: 4000,   powerFrom: 250,   powerTo: 600,    rateFrom: 0.75, rateTo: 0.55 },
  { from: 26, to: 45,  costFrom: 5000,   costTo: 15000,  powerFrom: 700,   powerTo: 2000,   rateFrom: 0.50, rateTo: 0.30 },
  { from: 46, to: 70,  costFrom: 18000,  costTo: 60000,  powerFrom: 2500,  powerTo: 8000,   rateFrom: 0.25, rateTo: 0.10 },
  { from: 71, to: 100, costFrom: 70000,  costTo: 400000, powerFrom: 10000, powerTo: 50000,  rateFrom: 0.08, rateTo: 0.02 },
];

interface EnhanceStep {
  level: number;
  cost: number;
  power: number;
  rate: number;
}

function enhanceStepFor(targetLevel: number): EnhanceStep | null {
  if (targetLevel < 1 || targetLevel > ENHANCE_MAX_LEVEL) return null;
  if (targetLevel === 1) return { level: 1, cost: 100, power: 50, rate: 1.0 };
  if (targetLevel === 2) return { level: 2, cost: 200, power: 60, rate: 1.0 };
  const range = ENHANCE_RANGES.find((r) => targetLevel >= r.from && targetLevel <= r.to);
  if (!range) return null;
  const span = Math.max(1, range.to - range.from);
  const t = (targetLevel - range.from) / span;
  return {
    level: targetLevel,
    cost: Math.round(range.costFrom + (range.costTo - range.costFrom) * t),
    power: Math.round(range.powerFrom + (range.powerTo - range.powerFrom) * t),
    rate: range.rateFrom + (range.rateTo - range.rateFrom) * t,
  };
}

const VALID_SLOTS = ["crown", "necklace", "top", "bottom", "ring", "staff"] as const;
type Slot = typeof VALID_SLOTS[number];

function isValidSlot(s: unknown): s is Slot {
  return typeof s === "string" && (VALID_SLOTS as readonly string[]).includes(s);
}

// ============================================================
// 액션 핸들러
// ============================================================

async function getEquipment(playerId: string) {
  const rows = (await dbSelect(
    `equipment_levels?player_id=eq.${encodeURIComponent(playerId)}&select=slot,level,power,last_attempt_at`
  )) as Array<{ slot: string; level: number; power: number; last_attempt_at: string | null }>;
  // 6슬롯 모두 응답 — 강화 안 된 슬롯도 level=0 으로 채워서 반환
  const map = new Map(rows.map((r) => [r.slot, r]));
  const levels = VALID_SLOTS.map((slot) => {
    const r = map.get(slot);
    return {
      slot,
      level: r?.level ?? 0,
      power: r?.power ?? 0,
      last_attempt_at: r?.last_attempt_at ?? null,
    };
  });
  const total_power = levels.reduce((s, l) => s + l.power, 0);
  return { ok: true, levels, total_power };
}

async function enhance(playerId: string, slot: unknown) {
  if (!isValidSlot(slot)) return { ok: false, error: "invalid_slot" };

  // member 존재 확인
  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id`
  );
  if (!member) return { ok: false, error: "member_not_found" };

  // 현재 강화 레벨 조회 → 다음 단계 표 lookup
  const current = (await dbSelectOne(
    `equipment_levels?player_id=eq.${encodeURIComponent(playerId)}&slot=eq.${slot}&select=level`
  )) as { level: number } | null;
  const currentLevel = current?.level ?? 0;
  const targetLevel = currentLevel + 1;

  if (targetLevel > ENHANCE_MAX_LEVEL) {
    return { ok: false, error: "level_capped", current_level: currentLevel };
  }

  const step = enhanceStepFor(targetLevel);
  if (!step) return { ok: false, error: "invalid_level", current_level: currentLevel };

  // RPC: atomic 잔액 차감 + 확률 굴림 + level 갱신
  const result = await dbRpc<{
    ok: boolean;
    error?: string;
    success?: boolean;
    new_level?: number;
    new_power?: number;
    cost?: number;
    balance?: number;
    current_level?: number;
  }>("enhance_equipment", {
    p_player_id: playerId,
    p_slot: slot,
    p_cost: step.cost,
    p_power_delta: step.power,
    p_rate: step.rate,
    p_target_level: targetLevel,
  });

  return result;
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
      case "get-equipment": result = await getEquipment(player_id); break;
      case "enhance":       result = await enhance(player_id, body.slot); break;
      default:              result = { ok: false, error: "unknown_action" };
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
