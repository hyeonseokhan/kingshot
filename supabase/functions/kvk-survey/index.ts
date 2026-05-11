/**
 * kvk-survey Edge Function
 *
 * KVK 가속권 보유량 설문 (survey.kingshot.wooju-home.org/kvk) 의 백엔드.
 * kvk_speedup_survey 테이블은 anon 차단 → 본 함수 (service_role) 만 접근.
 *
 * 액션:
 *   { action: "lookup",   kingshot_id }                                  → { ok, player: {...}, registered }
 *   { action: "register", kingshot_id, pin, training, construction, general } → { ok }
 *   { action: "verify",   kingshot_id, pin }                              → { ok }
 *   { action: "update",   kingshot_id, pin, training, construction, general } → { ok }
 *   { action: "list" }                                                    → { ok, items: [...] }  (pin_hash/salt 제외)
 *
 * pin: 정확히 4자리 숫자. SHA-256(pin + 16바이트 hex salt) 로 저장.
 * nickname/avatar 는 lookup 시점에 게임 공식 API 로 직접 조회 → 위변조 차단.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// 공식 redemption 사이트의 player 조회 API — kingshot 의 모든 player 조회 가능.
// redeem-coupon Edge Function 이 같은 endpoint 를 proxy 하지만, 본 함수는 서버 측에서
// 직접 호출해야 정합성 검증 (클라이언트 위조 차단) 가능. URL/secret 은 redeem-coupon
// 과 동일한 환경 변수를 공유한다.
const REDEEM_API_URL = Deno.env.get("KS_REDEEM_API_URL")
  ?? "https://kingshot-giftcode.centurygame.com/api/player";
const REDEEM_SALT = Deno.env.get("KS_REDEEM_SALT") ?? "";

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

async function dbSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbInsert(table: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db insert ${res.status}: ${await res.text()}`);
}

async function dbPatch(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db patch ${res.status}: ${await res.text()}`);
}

async function dbDelete(path: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
  });
  if (!res.ok) throw new Error(`db delete ${res.status}: ${await res.text()}`);
}

async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSaltHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

function isValidKingshotId(id: unknown): id is string {
  return typeof id === "string" && /^\d{4,15}$/.test(id);
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 9_999_999;
}

/**
 * 요청 헤더에서 클라이언트 IP / 국가 추출.
 *   - 클라이언트는 어떤 값도 송수신하지 않음 (DevTools 노출 X)
 *   - Cloudflare/Supabase 인프라가 자동으로 부착하는 헤더만 신뢰
 *   - country 는 ISO 3166-1 alpha-2 (예: 'KR'), 미상이면 null
 */
function extractRequestMeta(req: Request): { ip: string | null; country: string | null } {
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;
  const country = req.headers.get("cf-ipcountry") ?? null;
  return { ip, country };
}

interface PlayerInfo {
  fid: string;
  nickname: string;
  avatar_image: string | null;
}

/**
 * 게임 공식 사이트의 player 조회.
 * redeem-coupon Edge Function 과 동일한 sign 패턴 사용.
 * sign = md5(query-string + SALT) — 단, redeem-coupon 이 이미 동일 패턴을 구현 중이라
 * 운영 단순화를 위해 우리는 그냥 redeem-coupon 을 호출하는 wrapper 로 가도 무방.
 */
async function fetchPlayerInfo(kingshotId: string): Promise<PlayerInfo | null> {
  // 같은 Supabase 프로젝트의 redeem-coupon Edge Function 호출.
  // anon key 로 호출 가능 (이미 검증된 경로).
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/redeem-coupon`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ action: "player", fid: kingshotId }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || !json.data) return null;
    return {
      fid: String(json.data.fid),
      nickname: json.data.nickname,
      avatar_image: json.data.avatar_image ?? null,
    };
  } catch {
    return null;
  }
}

async function lookup(kingshotId: string) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  const player = await fetchPlayerInfo(kingshotId);
  if (!player) return { ok: false, error: "player_not_found" };
  const existing = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=kingshot_id`
  );
  return {
    ok: true,
    player: {
      kingshot_id: player.fid,
      nickname: player.nickname,
      avatar_url: player.avatar_image,
    },
    registered: !!existing,
  };
}

async function register(
  kingshotId: string,
  pin: unknown,
  training: unknown,
  construction: unknown,
  general: unknown,
  meta: { ip: string | null; country: string | null },
) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  if (!isNonNegInt(training) || !isNonNegInt(construction) || !isNonNegInt(general)) {
    return { ok: false, error: "invalid_amount" };
  }
  const existing = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=kingshot_id`
  );
  if (existing) return { ok: false, error: "already_registered" };
  const player = await fetchPlayerInfo(kingshotId);
  if (!player) return { ok: false, error: "player_not_found" };
  const salt = randomSaltHex();
  const hash = await sha256Hex((pin as string) + salt);
  await dbInsert("kvk_speedup_survey", {
    kingshot_id: kingshotId,
    nickname: player.nickname,
    avatar_url: player.avatar_image,
    pin_hash: hash,
    pin_salt: salt,
    training: training as number,
    construction: construction as number,
    general: general as number,
    ip: meta.ip,
    country: meta.country,
  });
  return { ok: true };
}

async function verifyPin(kingshotId: string, pin: unknown) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  const row = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=pin_hash,pin_salt,training,construction,general,nickname,avatar_url`
  );
  if (!row) return { ok: false, error: "not_registered" };
  const computed = await sha256Hex((pin as string) + row.pin_salt);
  if (computed !== row.pin_hash) return { ok: false, error: "invalid_pin" };
  return {
    ok: true,
    record: {
      kingshot_id: kingshotId,
      nickname: row.nickname,
      avatar_url: row.avatar_url,
      training: row.training,
      construction: row.construction,
      general: row.general,
    },
  };
}

async function updateRow(
  kingshotId: string,
  pin: unknown,
  training: unknown,
  construction: unknown,
  general: unknown,
  meta: { ip: string | null; country: string | null },
) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  if (!isNonNegInt(training) || !isNonNegInt(construction) || !isNonNegInt(general)) {
    return { ok: false, error: "invalid_amount" };
  }
  const row = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=pin_hash,pin_salt`
  );
  if (!row) return { ok: false, error: "not_registered" };
  const computed = await sha256Hex((pin as string) + row.pin_salt);
  if (computed !== row.pin_hash) return { ok: false, error: "invalid_pin" };
  // 닉네임/아바타도 동기 — 게임 내 변경 시 자동 반영
  const player = await fetchPlayerInfo(kingshotId);
  const patch: Record<string, unknown> = {
    training: training as number,
    construction: construction as number,
    general: general as number,
    ip: meta.ip,
    country: meta.country,
    updated_at: new Date().toISOString(),
  };
  if (player) {
    patch.nickname = player.nickname;
    patch.avatar_url = player.avatar_image;
  }
  await dbPatch(`kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}`, patch);
  return { ok: true };
}

async function deleteRow(kingshotId: string, pin: unknown) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  const row = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=pin_hash,pin_salt`
  );
  if (!row) return { ok: false, error: "not_registered" };
  const computed = await sha256Hex((pin as string) + row.pin_salt);
  if (computed !== row.pin_hash) return { ok: false, error: "invalid_pin" };
  await dbDelete(`kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}`);
  return { ok: true };
}

async function list() {
  const rows = await dbSelect(
    `kvk_speedup_survey?select=kingshot_id,nickname,avatar_url,training,construction,general,updated_at&order=updated_at.desc`
  );
  return { ok: true, items: rows };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action, kingshot_id, pin, training, construction, general } = body ?? {};
    // IP / country 는 헤더에서만 추출 — 클라이언트 페이로드는 신뢰하지 않음
    const meta = extractRequestMeta(req);
    let result;
    switch (action) {
      case "lookup":
        result = await lookup(kingshot_id);
        break;
      case "register":
        result = await register(kingshot_id, pin, training, construction, general, meta);
        break;
      case "verify":
        result = await verifyPin(kingshot_id, pin);
        break;
      case "update":
        result = await updateRow(kingshot_id, pin, training, construction, general, meta);
        break;
      case "delete":
        result = await deleteRow(kingshot_id, pin);
        break;
      case "list":
        result = await list();
        break;
      default:
        result = { ok: false, error: "unknown_action" };
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
