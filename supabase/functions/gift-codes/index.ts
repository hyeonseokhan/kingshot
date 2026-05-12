import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const KINGSHOT_API = "https://kingshot.net/api/gift-codes";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  // TODO: 테스트 완료 후 "https://kingshot.wooju-home.org" 로 복원
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

/**
 * expired_coupon_codes 에서 차단된 code Set 조회.
 * - service_role 로 직접 SELECT (RLS 우회 — 일반 사용자는 anon 으로 본 테이블 접근 불가)
 * - 실패 시 빈 Set 반환 → 외부 API 응답 그대로 (안전 fallback)
 */
async function fetchExpiredCodes(): Promise<Set<string>> {
  if (!SUPABASE_URL || !SERVICE_KEY) return new Set();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/expired_coupon_codes?select=code`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      },
    );
    if (!res.ok) return new Set();
    const rows = (await res.json()) as Array<{ code: string }>;
    return new Set(rows.map((r) => r.code));
  } catch {
    return new Set();
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 외부 list + 차단 set 병렬 fetch
    const [externalRes, expiredSet] = await Promise.all([
      fetch(KINGSHOT_API),
      fetchExpiredCodes(),
    ]);

    const text = await externalRes.text();

    // 차단 set 비어있으면 응답 그대로 통과 — 옛 동작 유지
    if (expiredSet.size === 0) {
      return new Response(text, {
        status: externalRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // JSON 파싱 후 giftCodes 필터링. 파싱 실패 시 응답 그대로 통과.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return new Response(text, {
        status: externalRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = (json as { data?: { giftCodes?: Array<{ code: string }> } }).data;
    if (data?.giftCodes && Array.isArray(data.giftCodes)) {
      data.giftCodes = data.giftCodes.filter((c) => !expiredSet.has(c.code));
    }

    return new Response(JSON.stringify(json), {
      status: externalRes.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ status: "error", message: (err as Error).message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
