/**
 * PvP 카드 대결 페이지 (Phase C).
 *
 * 흐름:
 *   1. 진입 — 인증 확인 → list-opponents + get-daily-state
 *   2. 매칭 화면 — 후보 3명 카드. 클릭 시 start-battle → 배틀 화면
 *   3. 배틀 화면 — 카드 3장. 선택 시 play-card → HP/턴 갱신, 마지막 턴이면 결과 화면
 *   4. 결과 화면 — 승/패 + 보상. "다시 도전" 시 매칭으로
 *   5. 랭킹 — 페이지 하단, 전투력 / 스테이지 / PvP 승수 탭 전환
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import { patchText } from '@/lib/dom-diff';

const FN_PVP_URL = SUPABASE_URL + '/functions/v1/pvp';
const REST_URL = SUPABASE_URL + '/rest/v1';

let initialized = false;

interface Opponent {
  kingshot_id: string;
  nickname: string;
  profile_photo: string | null;
  power: number;
}

interface BattleState {
  battle_id: string;
  attacker_id: string;
  defender_id: string;
  defender_nickname: string;
  defender_avatar: string | null;
  attacker_power: number;
  defender_power: number;
  attacker_hp: number;
  defender_hp: number;
  turn: number;
}

let currentOpponents: Opponent[] = [];
let currentBattle: BattleState | null = null;
let busy = false;

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  })
    .then((r) => r.json() as Promise<T>)
    .catch((err: Error) => ({ ok: false, error: String(err.message || err) }) as T);
}

// ===== 뷰 전환 =====
function showView(view: 'matching' | 'battle' | 'result'): void {
  ['matching', 'battle', 'result'].forEach((v) => {
    const el = $('pvp-view-' + v);
    if (el) el.style.display = v === view ? '' : 'none';
  });
}

function showAuthPrompt(): void {
  const p = $('pvp-auth-prompt');
  if (p) p.style.display = '';
  ['matching', 'battle', 'result'].forEach((v) => {
    const el = $('pvp-view-' + v);
    if (el) el.style.display = 'none';
  });
}

function hideAuthPrompt(): void {
  const p = $('pvp-auth-prompt');
  if (p) p.style.display = 'none';
}

// ===== 매칭 화면 =====

interface OpponentsResp { ok: boolean; my_power?: number; opponents?: Opponent[]; error?: string }
interface DailyResp { ok: boolean; attacks_used?: number; attacks_remaining?: number; max?: number; error?: string }

function fetchOpponents(playerId: string): Promise<void> {
  return postJson<OpponentsResp>(FN_PVP_URL, {
    action: 'list-opponents',
    player_id: playerId,
  }).then((res) => {
    if (!res.ok || !res.opponents) {
      renderMatchingError(res.error ?? 'unknown');
      return;
    }
    currentOpponents = res.opponents;
    renderOpponents(res.opponents, res.my_power ?? 0);
  });
}

function fetchDaily(playerId: string): Promise<void> {
  return postJson<DailyResp>(FN_PVP_URL, {
    action: 'get-daily-state',
    player_id: playerId,
  }).then((res) => {
    const remaining = res.ok ? (res.attacks_remaining ?? 5) : 5;
    const el = $('pvp-daily-remaining');
    if (el) patchText(el, remaining);
  });
}

function renderOpponents(list: Opponent[], myPower: number): void {
  const host = $('pvp-opponents');
  if (!host) return;
  host.innerHTML = '';
  if (list.length === 0) {
    host.innerHTML =
      '<div class="pvp-opponent-empty">매칭 가능한 상대가 없습니다. 잠시 후 다시 시도하세요.</div>';
    return;
  }
  for (const opp of list) {
    const card = document.createElement('button');
    card.className = 'pvp-opponent';
    card.type = 'button';
    card.dataset.opponentId = opp.kingshot_id;
    const img = opp.profile_photo
      ? `<img class="pvp-opponent-avatar" src="${opp.profile_photo}" alt="" />`
      : `<div class="pvp-opponent-avatar pvp-opponent-avatar-placeholder">${opp.nickname.charAt(0)}</div>`;
    card.innerHTML =
      img +
      `<strong class="pvp-opponent-name">${opp.nickname}</strong>` +
      `<span class="pvp-opponent-power">⚔️ ${opp.power.toLocaleString('ko-KR')}</span>`;
    host.appendChild(card);
  }
  const note = $('pvp-matching-note');
  if (note) {
    note.textContent = myPower === 0
      ? '⚠️ 장비 강화 power 가 0 입니다. 강화 후 도전하세요.'
      : '내 전투력 ⚔️ ' + myPower.toLocaleString('ko-KR');
  }
}

function renderMatchingError(err: string): void {
  const host = $('pvp-opponents');
  if (host) host.innerHTML = `<div class="pvp-opponent-empty">상대를 불러오지 못했어요 (${err}).</div>`;
}

// ===== 배틀 시작 =====

interface StartResp {
  ok: boolean;
  battle_id?: string;
  attacker_power?: number;
  defender_power?: number;
  attacker_hp?: number;
  defender_hp?: number;
  turn?: number;
  attacks_remaining?: number;
  error?: string;
}

function onSelectOpponent(oppId: string): void {
  if (busy) return;
  const session = window.TileMatchAuth?.getSession();
  if (!session?.player_id) return;
  const opp = currentOpponents.find((o) => o.kingshot_id === oppId);
  if (!opp) return;

  busy = true;
  postJson<StartResp>(FN_PVP_URL, {
    action: 'start-battle',
    player_id: session.player_id,
    defender_id: oppId,
  })
    .then((res) => {
      if (!res.ok || !res.battle_id) {
        if (res.error === 'daily_limit_reached') {
          alert('오늘 공격 횟수를 모두 소진했어요. 내일 다시 도전하세요.');
        } else {
          alert('배틀 시작 실패: ' + (res.error ?? 'unknown'));
        }
        return;
      }
      currentBattle = {
        battle_id: res.battle_id,
        attacker_id: session.player_id,
        defender_id: oppId,
        defender_nickname: opp.nickname,
        defender_avatar: opp.profile_photo,
        attacker_power: res.attacker_power ?? 0,
        defender_power: res.defender_power ?? 0,
        attacker_hp: res.attacker_hp ?? 1000,
        defender_hp: res.defender_hp ?? 1000,
        turn: res.turn ?? 1,
      };
      renderBattle(session.nickname, opp);
      showView('battle');
      // 일일 횟수 갱신
      const el = $('pvp-daily-remaining');
      if (el && typeof res.attacks_remaining === 'number') patchText(el, res.attacks_remaining);
    })
    .finally(() => {
      busy = false;
    });
}

// ===== 배틀 진행 =====

function renderBattle(myNickname: string, opp: Opponent): void {
  if (!currentBattle) return;
  const session = window.TileMatchAuth?.getSession();
  // attacker 정보
  const aName = $('pvp-attacker-name');
  if (aName) aName.textContent = session?.nickname || myNickname || '나';
  const aPow = $('pvp-attacker-power');
  if (aPow) patchText(aPow, currentBattle.attacker_power.toLocaleString('ko-KR'));
  const aImg = $('pvp-attacker-avatar') as HTMLImageElement | null;
  if (aImg) {
    fetchAvatarFor(currentBattle.attacker_id).then((url) => {
      if (url) aImg.src = url;
    });
  }
  // defender 정보
  const dName = $('pvp-defender-name');
  if (dName) dName.textContent = opp.nickname;
  const dPow = $('pvp-defender-power');
  if (dPow) patchText(dPow, currentBattle.defender_power.toLocaleString('ko-KR'));
  const dImg = $('pvp-defender-avatar') as HTMLImageElement | null;
  if (dImg && opp.profile_photo) dImg.src = opp.profile_photo;

  updateHpBars();
  updateTurnInfo();
  // 직전 턴 결과 초기화
  const lt = $('pvp-last-turn');
  if (lt) {
    lt.style.display = 'none';
    lt.textContent = '';
  }
  setCardsEnabled(true);
}

function fetchAvatarFor(playerId: string): Promise<string | null> {
  return fetch(
    `${REST_URL}/members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=profile_photo`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        Accept: 'application/vnd.pgrst.object+json',
      },
    },
  )
    .then((r) => (r.ok ? r.json() as Promise<{ profile_photo: string | null }> : null))
    .then((row) => row?.profile_photo ?? null)
    .catch(() => null);
}

function updateHpBars(): void {
  if (!currentBattle) return;
  const aHp = currentBattle.attacker_hp;
  const dHp = currentBattle.defender_hp;
  const aFill = $('pvp-attacker-hp-fill');
  if (aFill) aFill.style.width = Math.max(0, (aHp / 1000) * 100) + '%';
  const dFill = $('pvp-defender-hp-fill');
  if (dFill) dFill.style.width = Math.max(0, (dHp / 1000) * 100) + '%';
  const aText = $('pvp-attacker-hp');
  if (aText) patchText(aText, aHp);
  const dText = $('pvp-defender-hp');
  if (dText) patchText(dText, dHp);
}

function updateTurnInfo(): void {
  if (!currentBattle) return;
  const t = $('pvp-turn');
  if (t) patchText(t, currentBattle.turn);
}

function setCardsEnabled(enabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement>('.pvp-card').forEach((b) => {
    b.disabled = !enabled;
  });
}

// ===== 카드 사용 =====

interface PlayCardResp {
  ok: boolean;
  turn?: number;
  last_turn?: boolean;
  status?: 'in_progress' | 'done';
  a_card?: string;
  d_card?: string;
  a_dmg_to_d?: number;
  d_dmg_to_a?: number;
  a_crit?: boolean;
  d_crit?: boolean;
  attacker_hp?: number;
  defender_hp?: number;
  winner_id?: string | null;
  reward_crystals?: number;
  error?: string;
}

const CARD_NAME: Record<string, string> = {
  attack: '공격',
  enhance: '강화',
  defend: '방어',
};

function onSelectCard(card: 'attack' | 'enhance' | 'defend'): void {
  if (busy || !currentBattle) return;
  const session = window.TileMatchAuth?.getSession();
  if (!session?.player_id) return;

  busy = true;
  setCardsEnabled(false);

  postJson<PlayCardResp>(FN_PVP_URL, {
    action: 'play-card',
    player_id: session.player_id,
    battle_id: currentBattle.battle_id,
    card,
  })
    .then((res) => {
      if (!res.ok) {
        alert('카드 사용 실패: ' + (res.error ?? 'unknown'));
        setCardsEnabled(true);
        return;
      }
      // HP / 턴 갱신
      currentBattle!.attacker_hp = res.attacker_hp ?? currentBattle!.attacker_hp;
      currentBattle!.defender_hp = res.defender_hp ?? currentBattle!.defender_hp;
      currentBattle!.turn = (res.turn ?? currentBattle!.turn) + 1;
      updateHpBars();
      updateTurnInfo();
      renderLastTurn(res);

      if (res.last_turn || res.status === 'done') {
        // 결과 화면 — 1초 딜레이 (마지막 턴 결과 보여주고 전환)
        window.setTimeout(() => {
          showResult(res);
        }, 1000);
      } else {
        setCardsEnabled(true);
      }
    })
    .finally(() => {
      busy = false;
    });
}

function renderLastTurn(res: PlayCardResp): void {
  const el = $('pvp-last-turn');
  if (!el) return;
  const aName = CARD_NAME[res.a_card ?? ''] ?? '?';
  const dName = CARD_NAME[res.d_card ?? ''] ?? '?';
  const aCrit = res.a_crit ? ' 💥CRIT' : '';
  const dCrit = res.d_crit ? ' 💥CRIT' : '';
  el.innerHTML =
    `<div class="pvp-last-turn-row"><span>나</span><strong>${aName}${aCrit}</strong><span>→ ${res.a_dmg_to_d ?? 0} 데미지</span></div>` +
    `<div class="pvp-last-turn-row"><span>상대</span><strong>${dName}${dCrit}</strong><span>→ ${res.d_dmg_to_a ?? 0} 데미지</span></div>`;
  el.style.display = '';
}

// ===== 결과 화면 =====

function showResult(res: PlayCardResp): void {
  const win = res.winner_id === currentBattle?.attacker_id;
  const icon = $('pvp-result-icon');
  if (icon) icon.textContent = win ? '🎉' : '💔';
  const title = $('pvp-result-title');
  if (title) title.textContent = win ? '승리!' : '패배';
  const reward = $('pvp-result-reward');
  if (reward) reward.textContent = '+' + (res.reward_crystals ?? 0).toLocaleString('ko-KR');
  showView('result');
  // 잔액 broadcast — 헤더 위젯이 갱신됨
  if (typeof res.reward_crystals === 'number' && res.reward_crystals > 0) {
    // 정확한 새 잔액은 모르니 fetch 트리거 (헤더가 받아 처리)
    window.dispatchEvent(new CustomEvent('crystal-balance-refresh-request'));
  }
  // 랭킹도 새로 fetch (PvP 승수 탭이 변경됐을 수 있음)
  loadRanking(currentRankMode);
}

// ===== 랭킹 =====

let currentRankMode: 'power' | 'best_stage' | 'pvp_wins' = 'power';

interface RankingRow {
  kingshot_id: string;
  nickname: string;
  profile_photo: string | null;
  power: number;
  best_stage: number;
  pvp_wins: number;
}

function loadRanking(mode: 'power' | 'best_stage' | 'pvp_wins'): void {
  currentRankMode = mode;
  // 현재 모든 멤버 + equipment_levels(power) + tile_match_records(best_stage) + pvp_battles count
  // PostgREST nested select 활용
  const url =
    `${REST_URL}/members?select=kingshot_id,nickname,profile_photo,equipment_levels(power),tile_match_records(best_stage)&order=nickname.asc&limit=200`;
  fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
  })
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: Array<{
      kingshot_id: string;
      nickname: string;
      profile_photo: string | null;
      equipment_levels?: { power: number }[];
      tile_match_records?: { best_stage: number }[];
    }>) => {
      // 멤버별 power, best_stage 합산
      const enriched: RankingRow[] = rows.map((m) => ({
        kingshot_id: m.kingshot_id,
        nickname: m.nickname,
        profile_photo: m.profile_photo,
        power: (m.equipment_levels ?? []).reduce((s, e) => s + (e.power || 0), 0),
        best_stage: m.tile_match_records?.[0]?.best_stage ?? 0,
        pvp_wins: 0,
      }));

      // PvP 승수 — pvp_battles 에서 fetch (별도 쿼리)
      return fetchPvpWins().then((winsMap) => {
        enriched.forEach((r) => {
          r.pvp_wins = winsMap[r.kingshot_id] ?? 0;
        });
        return enriched;
      });
    })
    .then((rows) => {
      renderRanking(rows, currentRankMode);
    })
    .catch(() => {
      renderRanking([], currentRankMode);
    });
}

function fetchPvpWins(): Promise<Record<string, number>> {
  return fetch(
    `${REST_URL}/pvp_battles?select=winner_id&status=eq.done&limit=10000`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      },
    },
  )
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: Array<{ winner_id: string | null }>) => {
      const map: Record<string, number> = {};
      for (const r of rows) {
        if (r.winner_id) map[r.winner_id] = (map[r.winner_id] ?? 0) + 1;
      }
      return map;
    })
    .catch(() => ({}));
}

function renderRanking(rows: RankingRow[], mode: 'power' | 'best_stage' | 'pvp_wins'): void {
  const host = $('pvp-ranking-list');
  if (!host) return;
  if (rows.length === 0) {
    host.innerHTML = '<div class="pvp-ranking-empty">데이터 없음</div>';
    return;
  }
  // 정렬
  const sorted = [...rows].sort((a, b) => (b[mode] || 0) - (a[mode] || 0)).slice(0, 20);
  const valueLabel = mode === 'power' ? '⚔️' : mode === 'best_stage' ? '🏁' : '🏆';
  host.innerHTML = sorted
    .map((r, i) => {
      const v = r[mode] || 0;
      const avatar = r.profile_photo
        ? `<img class="pvp-rank-avatar" src="${r.profile_photo}" alt="" />`
        : `<div class="pvp-rank-avatar pvp-rank-avatar-placeholder">${r.nickname.charAt(0)}</div>`;
      return (
        `<div class="pvp-rank-row">` +
        `<span class="pvp-rank-pos">${i + 1}</span>` +
        avatar +
        `<span class="pvp-rank-name">${r.nickname}</span>` +
        `<span class="pvp-rank-value">${valueLabel} ${v.toLocaleString('ko-KR')}</span>` +
        `</div>`
      );
    })
    .join('');
}

// ===== 인증 흐름 =====

function onSessionReady(session: { player_id: string; nickname: string } | null): void {
  if (session?.player_id) {
    hideAuthPrompt();
    showView('matching');
    fetchOpponents(session.player_id);
    fetchDaily(session.player_id);
    loadRanking(currentRankMode);
  } else {
    showAuthPrompt();
    // 비인증 사용자도 랭킹은 보여줌
    loadRanking(currentRankMode);
  }
}

// ===== 진입 =====

export function initPvP(): void {
  if (initialized) return;
  initialized = true;

  // 매칭 — 후보 클릭
  $('pvp-opponents')?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.pvp-opponent');
    if (!target) return;
    const oppId = target.dataset.opponentId;
    if (oppId) onSelectOpponent(oppId);
  });

  // 매칭 — 새로고침
  $('pvp-refresh-btn')?.addEventListener('click', () => {
    const session = window.TileMatchAuth?.getSession();
    if (session?.player_id) fetchOpponents(session.player_id);
  });

  // 카드 클릭
  document.querySelectorAll<HTMLButtonElement>('.pvp-card').forEach((b) => {
    b.addEventListener('click', () => {
      const card = b.dataset.card as 'attack' | 'enhance' | 'defend' | undefined;
      if (card) onSelectCard(card);
    });
  });

  // 결과 — 다시 도전 / 매칭으로
  $('pvp-result-again')?.addEventListener('click', () => {
    const session = window.TileMatchAuth?.getSession();
    if (session?.player_id) {
      currentBattle = null;
      fetchOpponents(session.player_id);
      fetchDaily(session.player_id);
      showView('matching');
    }
  });
  $('pvp-result-close')?.addEventListener('click', () => {
    currentBattle = null;
    showView('matching');
    const session = window.TileMatchAuth?.getSession();
    if (session?.player_id) {
      fetchOpponents(session.player_id);
      fetchDaily(session.player_id);
    }
  });

  // 랭킹 탭
  document.querySelectorAll<HTMLButtonElement>('.pvp-ranking-tab').forEach((b) => {
    b.addEventListener('click', () => {
      const mode = b.dataset.rank as 'power' | 'best_stage' | 'pvp_wins' | undefined;
      if (!mode) return;
      document.querySelectorAll<HTMLButtonElement>('.pvp-ranking-tab').forEach((x) =>
        x.classList.toggle('active', x === b),
      );
      loadRanking(mode);
    });
  });

  // 인증 세션
  if (window.TileMatchAuth) {
    window.TileMatchAuth.initPage();
    window.TileMatchAuth.onSessionChange(onSessionReady);
    window.TileMatchAuth.ensureAuth().then(onSessionReady);
  } else {
    showAuthPrompt();
  }
}
