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

interface APIResult {
  json: any;
  cookie: string;
}

/** centurygame API 호출. Set-Cookie 헤더를 추출하여 반환. */
async function postAPI(
  endpoint: string,
  params: Record<string, string | number>,
  cookie?: string
): Promise<APIResult> {
  const sign = await makeSign(params);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.set(k, String(v));
  }
  body.set("sign", sign);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cookie) headers["Cookie"] = cookie;

  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  // Set-Cookie 헤더에서 세션 쿠키 추출
  const setCookie = res.headers.get("set-cookie") || "";
  const newCookie = setCookie.split(",")
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.length > 0)
    .join("; ");

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { code: -1, msg: "Invalid response from server", raw: text.substring(0, 200) };
  }
  return { json, cookie: newCookie };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, fid, cdk, captcha_code, cdks } = await req.json();
    const time = Date.now();
    let result;

    switch (action) {
      case "player": {
        const r = await postAPI("/player", { fid, time });
        result = r.json;
        break;
      }
      case "captcha": {
        const r = await postAPI("/captcha", { fid, time });
        result = r.json;
        break;
      }
      case "redeem": {
        if (!captcha_code || !cdk) {
          return new Response(
            JSON.stringify({ code: -1, msg: "captcha_code and cdk are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        // 1단계: player 호출로 세션 쿠키 획득
        const playerRes = await postAPI("/player", { fid, time });
        if (playerRes.json.code !== 0) {
          result = playerRes.json;
          break;
        }
        // 2단계: 세션 쿠키로 redeem 호출
        const timeRedeem = Date.now();
        const redeemRes = await postAPI(
          "/gift_code",
          { captcha_code, cdk, fid, time: timeRedeem },
          playerRes.cookie
        );
        result = redeemRes.json;
        break;
      }
      case "redeem_batch": {
        // 벌크 수령: player 1회 호출 후 쿠키 재사용하여 여러 쿠폰 순차 교환
        if (!Array.isArray(cdks) || cdks.length === 0) {
          return new Response(
            JSON.stringify({ code: -1, msg: "cdks array is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const playerRes = await postAPI("/player", { fid, time });
        if (playerRes.json.code !== 0) {
          result = { code: -1, msg: playerRes.json.msg || "player login failed", results: [] };
          break;
        }
        const cookie = playerRes.cookie;
        const results: Array<{ cdk: string; code: number; msg: string; err_code?: string | number }> = [];
        for (const code of cdks) {
          const t = Date.now();
          const r = await postAPI(
            "/gift_code",
            { captcha_code: captcha_code || "none", cdk: code, fid, time: t },
            cookie
          );
          results.push({
            cdk: code,
            code: r.json.code,
            msg: r.json.msg,
            err_code: r.json.err_code,
          });
        }
        result = { code: 0, results };
        break;
      }
      default:
        return new Response(
          JSON.stringify({ code: -1, msg: "Invalid action. Use: player, captcha, redeem, redeem_batch" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ code: -1, msg: (err as Error).message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
