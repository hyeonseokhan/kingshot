/**
 * kvk-buff Edge Function — KvK 버프 예약 페이지의 백엔드.
 *
 * 액션:
 *   { action: 'get-state', token?, test_mode? }                                    → { ok, state, participants[], me? }
 *     bootstrap 안 됐고 마감 지났으면 자동 init.
 *     token 주면 me (현재 사용자 정보 + is_admin) 도 함께 응답.
 *   { action: 'pick-slot', token, slot_idx, expected_turn_idx, test_mode? }        → { ok }
 *   { action: 'admin-skip', token, expected_turn_idx, test_mode? }                 → { ok }
 *   { action: 'admin-swap', token, slot_a_idx, slot_b_idx, test_mode? }            → { ok }
 *
 * 권한: token 으로 kingshot_id 추출. admin 액션은 is_admin=TRUE 검증.
 *
 * 5초 polling: 모든 클라가 5초마다 get-state 호출. 응답으로 local 상태 갱신.
 *
 * 동시성: 모든 변경은 plpgsql RPC 안에서 SELECT ... FOR UPDATE + 단일 UPDATE statement 로 atomic.
 *         RPC 가 stale 감지 시 'turn_changed' 에러 → 클라가 즉시 새 state fetch + 새로고침.
 *
 * !!! TEST_MODE — 관리자 필드 테스트 종료 후 제거 대상 !!!
 *   body.test_mode === true → kvk_buff_*_test 테이블 + _test RPC 사용.
 *   격리 범위: buff 테이블만. 인증/회원 (kvk_speedup_survey) 은 운영 그대로 공유.
 *   bootstrap_test 는 deadline 검증 skip (테스트는 즉시 시작 가능).
 *   제거: `TEST_MODE` 키워드 grep + isTest 분기 코드 일괄 제거 + 마이그레이션 ROLLBACK 적용.
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

async function dbSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

/** RPC 호출 — error 메시지의 EXCEPTION 메시지를 그대로 throw 해서 클라이언트가 에러 코드로 활용. */
async function dbRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: dbHeaders,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // PostgREST RPC 에러 형식: { code, details, hint, message }
    try {
      const json = JSON.parse(text);
      throw new Error(json.message ?? text);
    } catch {
      throw new Error(text || `rpc ${name} ${res.status}`);
    }
  }
  return text ? JSON.parse(text) : null;
}

function isValidToken(t: unknown): t is string {
  return typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t);
}

function isValidSlotIdx(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 48;
}

function isValidTurnIdx(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 48;
}

interface Me {
  kingshot_id: string;
  nickname: string;
  is_admin: boolean;
}

/** token → kvk_speedup_survey 의 사용자 정보 + is_admin. 만료 검증.
 *  TEST_MODE 와 무관 — 인증/회원은 운영 테이블 그대로 사용. */
async function authenticate(
  token: unknown,
): Promise<{ ok: true; me: Me } | { ok: false; error: string }> {
  if (!isValidToken(token)) return { ok: false, error: "invalid_token" };
  const row = await dbSelectOne(
    `kvk_speedup_survey?session_token=eq.${encodeURIComponent(token)}` +
      `&select=kingshot_id,nickname,is_admin,session_expires_at`,
  );
  if (!row) return { ok: false, error: "invalid_token" };
  if (!row.session_expires_at || new Date(row.session_expires_at) <= new Date()) {
    return { ok: false, error: "token_expired" };
  }
  return {
    ok: true,
    me: {
      kingshot_id: row.kingshot_id,
      nickname: row.nickname,
      is_admin: row.is_admin === true,
    },
  };
}

/** 마감 시각 — 마이그레이션의 RPC 와 일치 유지. */
const DEADLINE_ISO = "2026-05-16T01:00:00Z";

// !!! TEST_MODE 분기 helper — 테스트 종료 후 제거 대상 !!!
//   isTest=true 면 _test 테이블/RPC 이름 반환.
const t = (name: string, isTest: boolean) => `${name}${isTest ? "_test" : ""}`;

async function getState(token: unknown, isTest: boolean) {
  // 1. lazy bootstrap 시도 (마감 지났고 아직 init 안 됐으면)
  //    !!! TEST_MODE: deadline 검증 skip — 테스트는 항상 즉시 bootstrap 가능
  const stateProbe = await dbSelectOne(
    `${t("kvk_buff_state", isTest)}?id=eq.1&select=bootstrapped_at`,
  );
  const canBootstrap = isTest || new Date() >= new Date(DEADLINE_ISO);
  if (stateProbe && !stateProbe.bootstrapped_at && canBootstrap) {
    try {
      await dbRpc(t("kvk_buff_bootstrap", isTest), {});
    } catch (e) {
      // 두 클라 동시 호출 시 한 쪽은 NOOP 또는 race. 무시하고 진행.
      console.error("bootstrap (race ok):", (e as Error).message);
    }
  }

  // 2. state + participants 조회 (참가자엔 닉네임/avatar 도 join 필요)
  const state = await dbSelectOne(
    `${t("kvk_buff_state", isTest)}?id=eq.1&select=bootstrapped_at,current_turn_idx,turn_started_at,updated_at`,
  );
  // PostgREST embedded resource — kvk_speedup_survey 와 join (FK 자동 활용)
  // _test 의 FK 도 운영 kvk_speedup_survey 참조 → 같은 embedded 패턴 동작.
  const participants = await dbSelect(
    `${t("kvk_buff_participants", isTest)}?select=kingshot_id,turn_idx,score_rank,was_verified,slot_idx,picked_at,survey:kvk_speedup_survey(nickname,avatar_url,city_level)` +
      `&order=turn_idx.asc`,
  );

  // 3. me (token 있으면)
  let me: (Me & { turn_idx?: number; slot_idx?: number | null }) | null = null;
  if (token !== undefined && token !== null) {
    const auth = await authenticate(token);
    if (auth.ok) {
      const myRow = participants.find((p: any) => p.kingshot_id === auth.me.kingshot_id);
      me = {
        ...auth.me,
        turn_idx: myRow?.turn_idx,
        slot_idx: myRow?.slot_idx ?? null,
      };
    }
  }

  return {
    ok: true,
    deadline: DEADLINE_ISO,
    state,
    participants,
    me,
  };
}

async function pickSlot(token: unknown, slotIdx: unknown, expectedTurnIdx: unknown, isTest: boolean) {
  if (!isValidSlotIdx(slotIdx)) return { ok: false, error: "invalid_slot_idx" };
  if (!isValidTurnIdx(expectedTurnIdx)) return { ok: false, error: "invalid_turn_idx" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  try {
    await dbRpc(t("kvk_buff_pick_slot", isTest), {
      p_kingshot_id: auth.me.kingshot_id,
      p_slot_idx: slotIdx,
      p_expected_turn_idx: expectedTurnIdx,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function adminSkip(token: unknown, expectedTurnIdx: unknown, isTest: boolean) {
  if (!isValidTurnIdx(expectedTurnIdx)) return { ok: false, error: "invalid_turn_idx" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc(t("kvk_buff_admin_skip", isTest), { p_expected_turn_idx: expectedTurnIdx });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function adminSwap(token: unknown, slotA: unknown, slotB: unknown, isTest: boolean) {
  if (!isValidSlotIdx(slotA) || !isValidSlotIdx(slotB)) {
    return { ok: false, error: "invalid_slot_idx" };
  }
  if (slotA === slotB) return { ok: false, error: "same_slot" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc(t("kvk_buff_admin_swap", isTest), {
      p_slot_a_idx: slotA,
      p_slot_b_idx: slotB,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action, token, slot_idx, expected_turn_idx, slot_a_idx, slot_b_idx } = body ?? {};
    // !!! TEST_MODE — 클라가 ?test=1 일 때만 true. default false (운영). !!!
    const isTest = body?.test_mode === true;
    let result;
    switch (action) {
      case "get-state":
        result = await getState(token, isTest);
        break;
      case "pick-slot":
        result = await pickSlot(token, slot_idx, expected_turn_idx, isTest);
        break;
      case "admin-skip":
        result = await adminSkip(token, expected_turn_idx, isTest);
        break;
      case "admin-swap":
        result = await adminSwap(token, slot_a_idx, slot_b_idx, isTest);
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
