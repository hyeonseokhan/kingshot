/**
 * pvp Edge Function (Phase C)
 *
 * 비동기 PvP 카드 대결.
 *   - 방어자는 자동 응전 (서버측 random 카드 선택)
 *   - 데미지/카드효과/크리티컬/보상 모두 서버측 계산 — 클라이언트 조작 차단
 *
 * 액션:
 *   { action: "list-opponents",   player_id }
 *     → { ok, opponents: [{kingshot_id, nickname, profile_photo, power}] }
 *   { action: "start-battle",     attacker_id, defender_id }
 *     → { ok, battle_id, attacker_power, defender_power, attacker_hp, defender_hp, turn, attacks_remaining }
 *   { action: "play-card",        battle_id, player_id, card }
 *     → { ok, turn, attacker_hp, defender_hp, last_turn, status, winner_id?, reward? }
 *   { action: "get-result",       battle_id }
 *     → { ok, battle: {...전체} }
 *   { action: "get-daily-state",  player_id }
 *     → { ok, attacks_used, attacks_remaining, max }
 *
 * 게임 메커닉:
 *   - HP 1000 고정
 *   - 5턴, HP 0 즉시 종료
 *   - 일일 공격 5회 (KST 자정 리셋), 방어 무제한
 *   - 카드 효과:
 *     * attack:  데미지 1.2~1.5 배 (per use random)
 *     * enhance: 1.0 배 + 크리티컬 30% 확률 (×2)
 *     * defend:  데미지 0, 받는 데미지 50% 감소
 *   - 데미지 공식: max(0, floor(MyPower × CardEffect × Random(0.85~1.15) - EnemyPower × 0.1))
 *   - MyPower = 장비 강화 합산만 (members.power 는 PvP 와 분리 — 강화 동기 부여)
 *   - 보상: attacker 승리 +200 / 패배·무 +50
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

async function dbSelect<T = unknown>(path: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbSelectOne<T = unknown>(path: string): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...dbHeaders, Accept: "application/vnd.pgrst.object+json" },
  });
  if (res.status === 406) return null;
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbInsert<T = unknown>(table: string, body: Record<string, unknown>, returnRow = false): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...dbHeaders,
      Prefer: returnRow ? "return=representation" : "return=minimal",
      ...(returnRow ? { Accept: "application/vnd.pgrst.object+json" } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db insert ${res.status}: ${await res.text()}`);
  return returnRow ? res.json() : null;
}

async function dbPatch(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db patch ${res.status}: ${await res.text()}`);
}

async function dbUpsert(table: string, body: Record<string, unknown>, onConflict: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db upsert ${res.status}: ${await res.text()}`);
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
// 게임 상수
// ============================================================
const HP_INITIAL = 1000;
const MAX_TURNS = 5;
const DAILY_ATTACK_LIMIT = 5;
const REWARD_WIN = 200;
const REWARD_LOSE = 50;
const DEFENSE_FACTOR = 0.1; // EnemyPower × 0.1 = 데미지 감산
const DEFEND_REDUCTION = 0.5; // 방어 카드 시 받는 데미지 50% 감소
const ENHANCE_CRIT_RATE = 0.30;
const ENHANCE_CRIT_MULT = 2.0;
const OPPONENT_CANDIDATES = 3;
const OPPONENT_POWER_RANGE = 0.5; // 자기 power 의 ±50% 안 매칭 우선

type CardKind = "attack" | "enhance" | "defend";
const VALID_CARDS: ReadonlyArray<CardKind> = ["attack", "enhance", "defend"];

function isValidCard(c: unknown): c is CardKind {
  return typeof c === "string" && (VALID_CARDS as readonly string[]).includes(c);
}

// ============================================================
// 헬퍼 — KST 날짜 / power 계산 / 카드 효과 / 데미지 / 매칭
// ============================================================
function todayKst(): string {
  // UTC + 9 시간 → KST. ISO 의 date 부분만.
  const kstMs = Date.now() + 9 * 3600 * 1000;
  return new Date(kstMs).toISOString().slice(0, 10);
}

/**
 * PvP 용 player power.
 * **장비 강화 합산만** 사용 — members.power(게임 본체) 는 의도적으로 제외.
 *   - 디자인 의도: PvP 가 장비 강화 컨텐츠와 직결되도록 (강화 동기 부여)
 *   - 향후 변경 시 이 함수 한 곳만 수정.
 */
async function totalPowerFor(playerId: string): Promise<number> {
  const rows = await dbSelect<{ power: number }>(
    `equipment_levels?player_id=eq.${encodeURIComponent(playerId)}&select=power`,
  );
  return rows.reduce((s, r) => s + (r.power || 0), 0);
}

interface CardOutcome {
  damage: number;
  isCrit: boolean;
}

/**
 * 한 카드의 raw 데미지 계산 (defender 의 defend 효과는 호출 측에서 후처리).
 * 입력: attackerPower, attackerCard
 * 출력: damage (defender 의 defense 차감 후 0 이상), isCrit (강화 카드 크리티컬)
 *
 * 데미지 공식:
 *   raw = attackerPower × cardEffect × Random(0.85~1.15) × critMult
 *   damage = max(0, floor(raw - defenderPower × DEFENSE_FACTOR))
 */
function rollCardDamage(
  attackerPower: number,
  attackerCard: CardKind,
  defenderPower: number,
): CardOutcome {
  if (attackerCard === "defend") return { damage: 0, isCrit: false };
  let cardEffect = 1.0;
  let critMult = 1.0;
  let isCrit = false;
  if (attackerCard === "attack") {
    cardEffect = 1.2 + Math.random() * 0.3; // 1.2 ~ 1.5
  } else {
    // enhance — 1.0 + 크리티컬 30%
    cardEffect = 1.0;
    if (Math.random() < ENHANCE_CRIT_RATE) {
      critMult = ENHANCE_CRIT_MULT;
      isCrit = true;
    }
  }
  const luck = 0.85 + Math.random() * 0.30;
  const raw = attackerPower * cardEffect * luck * critMult;
  const damage = Math.max(0, Math.floor(raw - defenderPower * DEFENSE_FACTOR));
  return { damage, isCrit };
}

/** 방어자 자동 카드 선택 — 단순 random (추후 AI 강화 가능). */
function pickDefenderCard(): CardKind {
  return VALID_CARDS[Math.floor(Math.random() * VALID_CARDS.length)]!;
}

// ============================================================
// 액션: list-opponents
// ============================================================
interface MemberRow {
  kingshot_id: string;
  nickname: string;
  profile_photo: string | null;
}

async function listOpponents(playerId: string) {
  // member 존재 검증
  const me = await dbSelectOne<MemberRow>(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id,nickname,profile_photo`,
  );
  if (!me) return { ok: false, error: "member_not_found" };

  const myPower = await totalPowerFor(playerId);

  // 모든 멤버 + 장비 power 합산 — 자기 제외
  // PostgREST: members 와 equipment_levels 의 sum 은 RPC 가 더 효율적이지만,
  // 일회성 fetch 로 client side 합산.
  const allMembers = await dbSelect<MemberRow & { equipment_levels?: { power: number }[] }>(
    `members?select=kingshot_id,nickname,profile_photo,equipment_levels(power)&kingshot_id=neq.${encodeURIComponent(playerId)}`,
  );

  const enriched = allMembers.map((m) => ({
    kingshot_id: m.kingshot_id,
    nickname: m.nickname,
    profile_photo: m.profile_photo,
    power: (m.equipment_levels ?? []).reduce((s, e) => s + (e.power || 0), 0),
  }));

  // 1차: 자기 power ±50% 안 후보 (myPower=0 이면 전원 후보)
  const lowerBound = myPower * (1 - OPPONENT_POWER_RANGE);
  const upperBound = myPower * (1 + OPPONENT_POWER_RANGE);
  let candidates = myPower > 0
    ? enriched.filter((m) => m.power >= lowerBound && m.power <= upperBound)
    : enriched;

  // 부족하면 power 가까운 순으로 채움
  if (candidates.length < OPPONENT_CANDIDATES) {
    const sorted = [...enriched].sort(
      (a, b) => Math.abs(a.power - myPower) - Math.abs(b.power - myPower),
    );
    candidates = sorted.slice(0, Math.min(OPPONENT_CANDIDATES * 2, sorted.length));
  }

  // 후보 중 random 3명 (셔플 후 slice)
  const shuffled = candidates.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  return {
    ok: true,
    my_power: myPower,
    opponents: shuffled.slice(0, OPPONENT_CANDIDATES),
  };
}

// ============================================================
// 액션: get-daily-state
// ============================================================
async function getDailyState(playerId: string) {
  const today = todayKst();
  const row = await dbSelectOne<{ attacks_used: number }>(
    `pvp_daily_state?player_id=eq.${encodeURIComponent(playerId)}&date_kst=eq.${today}&select=attacks_used`,
  );
  const used = row?.attacks_used ?? 0;
  return {
    ok: true,
    attacks_used: used,
    attacks_remaining: Math.max(0, DAILY_ATTACK_LIMIT - used),
    max: DAILY_ATTACK_LIMIT,
  };
}

// ============================================================
// 액션: start-battle
// ============================================================
async function startBattle(attackerId: string, defenderId: unknown) {
  if (typeof defenderId !== "string" || !defenderId) return { ok: false, error: "missing_defender" };
  if (attackerId === defenderId) return { ok: false, error: "self_attack_forbidden" };

  const attacker = await dbSelectOne<MemberRow>(
    `members?kingshot_id=eq.${encodeURIComponent(attackerId)}&select=kingshot_id`,
  );
  if (!attacker) return { ok: false, error: "attacker_not_found" };
  const defender = await dbSelectOne<MemberRow>(
    `members?kingshot_id=eq.${encodeURIComponent(defenderId)}&select=kingshot_id`,
  );
  if (!defender) return { ok: false, error: "defender_not_found" };

  // 일일 공격 횟수 검증 + 증가
  const today = todayKst();
  const dailyRow = await dbSelectOne<{ attacks_used: number }>(
    `pvp_daily_state?player_id=eq.${encodeURIComponent(attackerId)}&date_kst=eq.${today}&select=attacks_used`,
  );
  const used = dailyRow?.attacks_used ?? 0;
  if (used >= DAILY_ATTACK_LIMIT) {
    return { ok: false, error: "daily_limit_reached", attacks_used: used, max: DAILY_ATTACK_LIMIT };
  }
  await dbUpsert(
    "pvp_daily_state",
    { player_id: attackerId, date_kst: today, attacks_used: used + 1 },
    "player_id,date_kst",
  );

  // power 스냅샷
  const [attackerPower, defenderPower] = await Promise.all([
    totalPowerFor(attackerId),
    totalPowerFor(defenderId),
  ]);

  // battle row INSERT
  const battle = await dbInsert<{ id: string }>(
    "pvp_battles",
    {
      attacker_id: attackerId,
      defender_id: defenderId,
      attacker_power: attackerPower,
      defender_power: defenderPower,
      turns_log: [],
      status: "in_progress",
    },
    true,
  );

  return {
    ok: true,
    battle_id: battle!.id,
    attacker_power: attackerPower,
    defender_power: defenderPower,
    attacker_hp: HP_INITIAL,
    defender_hp: HP_INITIAL,
    turn: 1,
    attacks_remaining: DAILY_ATTACK_LIMIT - used - 1,
  };
}

// ============================================================
// 액션: play-card
// ============================================================
interface BattleRow {
  id: string;
  attacker_id: string;
  defender_id: string;
  attacker_power: number;
  defender_power: number;
  winner_id: string | null;
  turns_log: TurnLogEntry[];
  status: "in_progress" | "done";
}

interface TurnLogEntry {
  turn: number;
  a_card: CardKind;
  d_card: CardKind;
  a_dmg_to_d: number;
  d_dmg_to_a: number;
  a_crit: boolean;
  d_crit: boolean;
  a_hp_after: number;
  d_hp_after: number;
}

async function playCard(playerId: string, battleId: unknown, card: unknown) {
  if (typeof battleId !== "string" || !battleId) return { ok: false, error: "missing_battle_id" };
  if (!isValidCard(card)) return { ok: false, error: "invalid_card" };

  const battle = await dbSelectOne<BattleRow>(
    `pvp_battles?id=eq.${encodeURIComponent(battleId)}&select=*`,
  );
  if (!battle) return { ok: false, error: "battle_not_found" };
  if (battle.status !== "in_progress") return { ok: false, error: "battle_done" };
  if (battle.attacker_id !== playerId) return { ok: false, error: "not_your_battle" };

  const turn = battle.turns_log.length + 1;
  if (turn > MAX_TURNS) return { ok: false, error: "max_turns_reached" };

  // 이전 턴까지의 HP 추적
  const lastEntry = battle.turns_log[battle.turns_log.length - 1];
  const prevAttackerHp = lastEntry?.a_hp_after ?? HP_INITIAL;
  const prevDefenderHp = lastEntry?.d_hp_after ?? HP_INITIAL;

  // defender 카드 자동 선택
  const defenderCard = pickDefenderCard();

  // 양쪽 데미지 계산 (서로 동시에 카드 사용)
  const aOutcome = rollCardDamage(battle.attacker_power, card, battle.defender_power);
  const dOutcome = rollCardDamage(battle.defender_power, defenderCard, battle.attacker_power);

  // defend 카드는 받는 데미지 50% 감소 (양쪽 동시 처리)
  const aDmgToD = defenderCard === "defend"
    ? Math.floor(aOutcome.damage * DEFEND_REDUCTION)
    : aOutcome.damage;
  const dDmgToA = card === "defend"
    ? Math.floor(dOutcome.damage * DEFEND_REDUCTION)
    : dOutcome.damage;

  const newAttackerHp = Math.max(0, prevAttackerHp - dDmgToA);
  const newDefenderHp = Math.max(0, prevDefenderHp - aDmgToD);

  const newEntry: TurnLogEntry = {
    turn,
    a_card: card,
    d_card: defenderCard,
    a_dmg_to_d: aDmgToD,
    d_dmg_to_a: dDmgToA,
    a_crit: aOutcome.isCrit,
    d_crit: dOutcome.isCrit,
    a_hp_after: newAttackerHp,
    d_hp_after: newDefenderHp,
  };

  // 종료 판정: HP 0 또는 마지막 턴
  let isLastTurn = false;
  let winnerId: string | null = null;
  if (newAttackerHp <= 0 || newDefenderHp <= 0 || turn >= MAX_TURNS) {
    isLastTurn = true;
    if (newAttackerHp > newDefenderHp) winnerId = battle.attacker_id;
    else if (newDefenderHp > newAttackerHp) winnerId = battle.defender_id;
    else winnerId = battle.defender_id; // 동률 → defender 승 (attacker 도전자 패널티)
  }

  // 보상 계산 + 적립
  let rewardCrystals = 0;
  if (isLastTurn) {
    rewardCrystals = winnerId === battle.attacker_id ? REWARD_WIN : REWARD_LOSE;
    // attacker 만 보상 (defender 는 자동 응전이라 무보상)
    try {
      await dbRpc("apply_crystal_transaction", {
        p_player_id: battle.attacker_id,
        p_amount: rewardCrystals,
        p_source: winnerId === battle.attacker_id ? "pvp_win" : "pvp_lose",
        p_ref_key: `pvp:${battle.id}:reward`, // 멱등성
        p_ref_data: {
          battle_id: battle.id,
          winner: winnerId,
          turns: turn,
        },
      });
    } catch (err) {
      // 멱등성 실패는 OK (이미 적립됨), 그 외는 로깅만 하고 진행
      console.error("reward apply failed:", err);
    }
  }

  // battle 갱신
  const newLog = [...battle.turns_log, newEntry];
  const updateFields: Record<string, unknown> = { turns_log: newLog };
  if (isLastTurn) {
    updateFields.status = "done";
    updateFields.winner_id = winnerId;
    updateFields.reward_crystals = rewardCrystals;
    updateFields.finished_at = new Date().toISOString();
  }
  await dbPatch(`pvp_battles?id=eq.${encodeURIComponent(battle.id)}`, updateFields);

  return {
    ok: true,
    turn,
    last_turn: isLastTurn,
    status: isLastTurn ? "done" : "in_progress",
    a_card: card,
    d_card: defenderCard,
    a_dmg_to_d: aDmgToD,
    d_dmg_to_a: dDmgToA,
    a_crit: aOutcome.isCrit,
    d_crit: dOutcome.isCrit,
    attacker_hp: newAttackerHp,
    defender_hp: newDefenderHp,
    winner_id: winnerId,
    reward_crystals: rewardCrystals,
  };
}

// ============================================================
// 액션: get-result
// ============================================================
async function getResult(battleId: unknown) {
  if (typeof battleId !== "string" || !battleId) return { ok: false, error: "missing_battle_id" };
  const battle = await dbSelectOne<BattleRow>(
    `pvp_battles?id=eq.${encodeURIComponent(battleId)}&select=*`,
  );
  if (!battle) return { ok: false, error: "battle_not_found" };
  return { ok: true, battle };
}

// ============================================================
// 엔트리
// ============================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action, player_id } = body ?? {};
    let result: { ok: boolean; [k: string]: unknown };
    switch (action) {
      case "list-opponents":
        if (!player_id) return jsonErr("missing_player_id");
        result = await listOpponents(player_id);
        break;
      case "start-battle":
        if (!player_id) return jsonErr("missing_player_id");
        result = await startBattle(player_id, body.defender_id);
        break;
      case "play-card":
        if (!player_id) return jsonErr("missing_player_id");
        result = await playCard(player_id, body.battle_id, body.card);
        break;
      case "get-result":
        result = await getResult(body.battle_id);
        break;
      case "get-daily-state":
        if (!player_id) return jsonErr("missing_player_id");
        result = await getDailyState(player_id);
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

function jsonErr(error: string) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
