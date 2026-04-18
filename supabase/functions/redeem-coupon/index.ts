import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { crypto as stdCrypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const BASE = "https://kingshot-giftcode.centurygame.com/api";
const SECRET = "mN4!pQs6JrYwV9";

const corsHeaders = {
  // TODO: 테스트 완료 후 "https://kingshot.wooju-home.org" 로 복원
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

async function md5(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await stdCrypto.subtle.digest("MD5", data);
  return new TextDecoder().decode(hexEncode(new Uint8Array(hash)));
}

async function makeSign(params: Record<string, string | number>): Promise<string> {
  const sorted = Object.keys(params)
    .filter((k) => k !== "sign")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return await md5(sorted + SECRET);
}

async function postAPI(endpoint: string, params: Record<string, string | number>) {
  const sign = await makeSign(params);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.set(k, String(v));
  }
  body.set("sign", sign);

  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: -1, msg: "Invalid response from server", raw: text.substring(0, 200) };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, fid, cdk, captcha_code } = await req.json();
    const time = Date.now();
    let result;

    switch (action) {
      case "player":
        result = await postAPI("/player", { fid, time });
        break;
      case "captcha":
        result = await postAPI("/captcha", { fid, time });
        break;
      case "redeem":
        if (!captcha_code || !cdk) {
          return new Response(
            JSON.stringify({ code: -1, msg: "captcha_code and cdk are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        result = await postAPI("/gift_code", { captcha_code, cdk, fid, time });
        break;
      default:
        return new Response(
          JSON.stringify({ code: -1, msg: "Invalid action. Use: player, captcha, redeem" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ code: -1, msg: err.message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
