import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { crypto as stdCrypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const BASE = "https://kingshot-giftcode.centurygame.com/api";
const SECRET = "mN4!pQs6JrYwV9";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  // TODO: 테스트 완료 후 "https://kingshot.wooju-home.org" 로 복원
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

/**
 * centurygame 가 영구 무효 err_code 응답한 코드를 expired_coupon_codes 에 영구 등록.
 * gift-codes Edge Function 이 다음 list 호출부터 자동 필터링.
 *
 * 영구 무효 코드:
 *   - 40005: 존재하지 않는 쿠폰 코드 (잘못 등록 / 오타 / 사용 불가)
 *   - 40007: 만료된 쿠폰 코드
 * (40008 이미 수령 / 40017 자격 필요 등은 사용자별이라 영구 등록 대상 아님)
 *
 * - service_role 로 직접 INSERT. RLS 우회.
 * - ON CONFLICT DO NOTHING (Prefer: resolution=ignore-duplicates) → 멱등.
 * - 실패해도 silently 무시 — 본 함수의 main path (쿠폰 redeem) 영향 없게 함.
 */

const PERMANENTLY_INVALID_ERR_CODES = new Set<number>([40005, 40007]);
function isPermanentlyInvalid(errCode: unknown): boolean {
  if (errCode == null) return false;
  const n = Number(errCode);
  return Number.isFinite(n) && PERMANENTLY_INVALID_ERR_CODES.has(n);
}
async function recordExpiredCoupon(
  code: string,
  errCode: number,
  msg: string | undefined,
  fid: string | undefined,
): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/expired_coupon_codes`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal,resolution=ignore-duplicates",
      },
      body: JSON.stringify({
        code,
        err_code: errCode,
        reason: msg ?? null,
        detected_by: fid ?? null,
      }),
    });
  } catch {
    // 만료 기록 실패는 next 호출에서 다시 시도 가능 — 본 redeem 흐름 막지 않음
  }
}

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
    const { action, fid, captcha_code, cdks } = await req.json();
    const time = Date.now();
    let result;

    switch (action) {
      case "player": {
        const r = await postAPI("/player", { fid, time });
        result = r.json;
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
          // 영구 무효 코드 (40005 존재하지 않음 / 40007 만료) 자동 등록 — 같은 batch 의
          // 나머지엔 영향 없음 (다음 list 호출부터 제외).
          const errCode = r.json?.err_code;
          if (isPermanentlyInvalid(errCode)) {
            await recordExpiredCoupon(String(code), Number(errCode), r.json?.msg, fid);
          }
        }
        result = { code: 0, results };
        break;
      }
      default:
        return new Response(
          JSON.stringify({ code: -1, msg: "Invalid action. Use: player, redeem_batch" }),
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
