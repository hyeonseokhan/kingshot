/**
 * troops-profiles Edge Function
 *
 * 부대 계산기 프로필(슬롯 1~5)의 조회/저장/삭제.
 * troops_profiles 테이블은 anon write 차단 → 이 함수만 (service_role) 쓰기 접근.
 *
 * 액션:
 *   { action: "list" }                          → { ok, profiles: Profile[] }
 *   { action: "save", slot, label, input, distribution } → { ok, profile }
 *   { action: "delete", slot }                  → { ok }
 *
 * slot: 1~5 정수. input: { cap, infantryT10, infantryT9, cavalryT10, cavalryT9,
 *   archersT10, archersT9, squadCount }. distribution: 'bear'|'bear-stack'|'even'.
 *
 * 이 도구는 관리자 전용이므로 player_id 구분 없이 전역 슬롯. (config.toml 에 verify_jwt 등록 불필요 —
 *  클라이언트가 anon key 를 항상 보냄.)
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

async function dbSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

/** upsert (slot PK 충돌 시 갱신) — Prefer: resolution=merge-duplicates. return=representation 로 결과 row 반환. */
async function dbUpsert(table: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...dbHeaders,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db upsert ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function dbDelete(path: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
  });
  if (!res.ok) throw new Error(`db delete ${res.status}: ${await res.text()}`);
}

/** DB row(snake_case) → 클라이언트 형태(camelCase input + meta). */
function rowToProfile(r: any) {
  return {
    slot: r.slot,
    label: r.label ?? "",
    input: {
      cap: Number(r.cap) || 0,
      infantryT10: Number(r.infantry_t10) || 0,
      infantryT9: Number(r.infantry_t9) || 0,
      cavalryT10: Number(r.cavalry_t10) || 0,
      cavalryT9: Number(r.cavalry_t9) || 0,
      archersT10: Number(r.archers_t10) || 0,
      archersT9: Number(r.archers_t9) || 0,
      squadCount: Number(r.squad_count) || 1,
    },
    distribution: r.distribution ?? "bear-stack",
    updated_at: r.updated_at ?? null,
  };
}

function isValidSlot(slot: unknown): slot is number {
  return Number.isInteger(slot) && (slot as number) >= 1 && (slot as number) <= 5;
}

/** 음수/NaN/Infinity 차단 후 정수화. 빈/이상값은 0. */
function toNonNegInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isValidDistribution(d: unknown): d is string {
  return d === "bear" || d === "bear-stack" || d === "even";
}

async function listProfiles() {
  const rows = await dbSelect("troops_profiles?select=*&order=slot.asc");
  return { ok: true, profiles: rows.map(rowToProfile) };
}

async function saveProfile(body: any) {
  const { slot, label, input, distribution } = body ?? {};
  if (!isValidSlot(slot)) return { ok: false, error: "invalid_slot" };
  if (!input || typeof input !== "object") return { ok: false, error: "invalid_input" };
  const squadCount = toNonNegInt(input.squadCount);
  const row = {
    slot,
    label: typeof label === "string" ? label.slice(0, 40) : "",
    cap: toNonNegInt(input.cap),
    infantry_t10: toNonNegInt(input.infantryT10),
    infantry_t9: toNonNegInt(input.infantryT9),
    cavalry_t10: toNonNegInt(input.cavalryT10),
    cavalry_t9: toNonNegInt(input.cavalryT9),
    archers_t10: toNonNegInt(input.archersT10),
    archers_t9: toNonNegInt(input.archersT9),
    squad_count: squadCount >= 1 ? Math.min(squadCount, 6) : 1,
    distribution: isValidDistribution(distribution) ? distribution : "bear-stack",
    updated_at: new Date().toISOString(),
  };
  const saved = await dbUpsert("troops_profiles", row);
  return { ok: true, profile: rowToProfile(saved) };
}

async function deleteProfile(body: any) {
  const { slot } = body ?? {};
  if (!isValidSlot(slot)) return { ok: false, error: "invalid_slot" };
  await dbDelete(`troops_profiles?slot=eq.${slot}`);
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const action = body?.action;
    let result;
    switch (action) {
      case "list":   result = await listProfiles(); break;
      case "save":   result = await saveProfile(body); break;
      case "delete": result = await deleteProfile(body); break;
      default:       result = { ok: false, error: "unknown_action" };
    }
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
