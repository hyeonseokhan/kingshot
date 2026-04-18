import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const KINGSHOT_API = "https://kingshot.net/api/gift-codes";

const corsHeaders = {
  // TODO: 테스트 완료 후 "https://kingshot.wooju-home.org" 로 복원
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const res = await fetch(KINGSHOT_API);
    const data = await res.text();

    return new Response(data, {
      status: res.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ status: "error", message: err.message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
