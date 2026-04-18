import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const KINGSHOT_API = "https://kingshot.net/api/player-info";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://kingshot.wooju-home.org",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const playerId = url.searchParams.get("playerId");

  if (!playerId) {
    return new Response(
      JSON.stringify({ status: "error", message: "playerId is required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const res = await fetch(`${KINGSHOT_API}?playerId=${encodeURIComponent(playerId)}`);
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
