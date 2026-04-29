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
  is_ranked: boolean;
  /** 직전 턴 attacker 카드 — cooldown 판정용 */
  last_attacker_card: 'attack' | 'enhance' | 'defend' | null;
}

let currentOpponents: Opponent[] = [];
let currentBattle: BattleState | null = null;
let busy = false;
/** 5회 다 쓰면 attacks_remaining = 0 → 검색 섹션 활성. -1 = 미확인. */
let attacksRemaining = -1;
/** 검색 모드 — 멤버 캐시 */
let allMembersCache: { kingshot_id: string; nickname: string; profile_photo: string | null }[] | null = null;

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
    attacksRemaining = remaining;
    const el = $('pvp-daily-remaining');
    if (el) patchText(el, remaining);
    // 5회 소진 시 연습 모드 배지 + "대상 검색" 트리거 버튼 표시
    const banner = $('pvp-practice-banner');
    const trigger = $('pvp-search-trigger');
    const isPractice = remaining <= 0;
    if (banner) banner.style.display = isPractice ? '' : 'none';
    if (trigger) trigger.style.display = isPractice ? '' : 'none';
    // 연습 모드 진입 시 멤버 목록 prefetch (캐시 없으면)
    if (isPractice && !allMembersCache) {
      fetchAllMembers(playerId);
    }
  });
}

function openSearchDialog(): void {
  const dlg = $('pvp-search-dialog') as HTMLDialogElement | null;
  if (!dlg) return;
  // 캐시 없으면 fetch
  const session = window.TileMatchAuth?.getSession();
  if (session?.player_id && !allMembersCache) {
    fetchAllMembers(session.player_id);
  } else if (allMembersCache) {
    renderSearchList('');
  }
  // 검색 input 초기화
  const inp = $('pvp-search-input') as HTMLInputElement | null;
  if (inp) inp.value = '';
  if (typeof dlg.showModal === 'function') dlg.showModal();
  // input focus
  setTimeout(() => inp?.focus(), 50);
}

function closeSearchDialog(): void {
  const dlg = $('pvp-search-dialog') as HTMLDialogElement | null;
  if (dlg && typeof dlg.close === 'function' && dlg.open) dlg.close();
}

// ===== 검색 모드 — 5회 후 자유 매칭 =====

function fetchAllMembers(myId: string): Promise<void> {
  const url =
    `${REST_URL}/members?select=kingshot_id,nickname,profile_photo&kingshot_id=neq.${encodeURIComponent(myId)}&order=nickname.asc&limit=300`;
  return fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
  })
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: typeof allMembersCache) => {
      allMembersCache = rows ?? [];
      renderSearchList('');
    })
    .catch(() => {
      allMembersCache = [];
    });
}

function renderSearchList(query: string): void {
  const list = $('pvp-search-list');
  if (!list || !allMembersCache) return;
  const q = query.trim().toLowerCase();
  const filtered = q === ''
    ? allMembersCache
    : allMembersCache.filter(
        (m) => m.nickname.toLowerCase().includes(q) || m.kingshot_id.includes(q),
      );
  if (filtered.length === 0) {
    list.innerHTML = '<div class="pvp-search-empty">검색 결과 없음</div>';
    return;
  }
  list.innerHTML = filtered
    .slice(0, 50)
    .map((m) => {
      const avatar = m.profile_photo
        ? `<img class="pvp-search-avatar" src="${m.profile_photo}" alt="" />`
        : `<div class="pvp-search-avatar pvp-search-avatar-placeholder">${m.nickname.charAt(0)}</div>`;
      return (
        `<button class="pvp-search-item" type="button" data-target-id="${m.kingshot_id}">` +
        avatar +
        `<span class="pvp-search-item-name">${m.nickname}</span>` +
        `<span class="pvp-search-item-arrow">⚔️</span>` +
        `</button>`
      );
    })
    .join('');
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
  is_ranked?: boolean;
  error?: string;
}

function onSelectOpponent(oppId: string, fallbackInfo?: { nickname: string; profile_photo: string | null }): void {
  if (busy) return;
  const session = window.TileMatchAuth?.getSession();
  if (!session?.player_id) return;
  // 자동 매칭 후보 또는 검색 결과에서 정보 가져오기
  const opp = currentOpponents.find((o) => o.kingshot_id === oppId)
    ?? (allMembersCache?.find((m) => m.kingshot_id === oppId) && {
      kingshot_id: oppId,
      nickname: allMembersCache.find((m) => m.kingshot_id === oppId)!.nickname,
      profile_photo: allMembersCache.find((m) => m.kingshot_id === oppId)!.profile_photo,
      power: 0,
    });
  if (!opp && !fallbackInfo) return;
  const oppInfo = opp ?? {
    kingshot_id: oppId,
    nickname: fallbackInfo!.nickname,
    profile_photo: fallbackInfo!.profile_photo,
    power: 0,
  };

  busy = true;
  postJson<StartResp>(FN_PVP_URL, {
    action: 'start-battle',
    player_id: session.player_id,
    defender_id: oppId,
  })
    .then((res) => {
      if (!res.ok || !res.battle_id) {
        alert('배틀 시작 실패: ' + (res.error ?? 'unknown'));
        return;
      }
      currentBattle = {
        battle_id: res.battle_id,
        attacker_id: session.player_id,
        defender_id: oppId,
        defender_nickname: oppInfo.nickname,
        defender_avatar: oppInfo.profile_photo,
        attacker_power: res.attacker_power ?? 0,
        defender_power: res.defender_power ?? 0,
        attacker_hp: res.attacker_hp ?? 1000,
        defender_hp: res.defender_hp ?? 1000,
        turn: res.turn ?? 1,
        is_ranked: res.is_ranked !== false,
        last_attacker_card: null,
      };
      renderBattle(session.nickname, oppInfo);
      showView('battle');
      // 일일 횟수 갱신
      attacksRemaining = res.attacks_remaining ?? attacksRemaining;
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
  // 모든 카드 비활성/활성 + cooldown 표시 클래스 갱신
  const lastCard = currentBattle?.last_attacker_card;
  document.querySelectorAll<HTMLButtonElement>('.pvp-card').forEach((b) => {
    const card = b.dataset.card as 'attack' | 'enhance' | 'defend' | undefined;
    if (!enabled || !card) {
      b.disabled = true;
      b.classList.remove('pvp-card-cooldown');
      return;
    }
    // cooldown: 직전 턴 enhance/defend 사용했으면 attack 만 가능
    const cooldownActive = lastCard === 'enhance' || lastCard === 'defend';
    const isAvailable = !cooldownActive || card === 'attack';
    b.disabled = !isAvailable;
    b.classList.toggle('pvp-card-cooldown', cooldownActive && card !== 'attack');
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
  collision?: boolean;
  is_ranked?: boolean;
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
      // HP / 턴 / cooldown 갱신
      currentBattle!.attacker_hp = res.attacker_hp ?? currentBattle!.attacker_hp;
      currentBattle!.defender_hp = res.defender_hp ?? currentBattle!.defender_hp;
      currentBattle!.turn = (res.turn ?? currentBattle!.turn) + 1;
      currentBattle!.last_attacker_card = (res.a_card ?? null) as
        | 'attack' | 'enhance' | 'defend' | null;
      updateHpBars();
      updateTurnInfo();
      renderLastTurn(res);

      if (res.last_turn || res.status === 'done') {
        // 결과 화면 — 1.2초 딜레이 (마지막 턴 결과 보여주고 전환)
        window.setTimeout(() => {
          showResult(res);
        }, 1200);
      } else {
        setCardsEnabled(true); // cooldown 자동 반영
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
  const collisionBanner = res.collision
    ? `<div class="pvp-last-turn-collision">💥 격돌! 양쪽 ${res.a_dmg_to_d ?? 0} 데미지</div>`
    : '';
  el.innerHTML =
    collisionBanner +
    `<div class="pvp-last-turn-row"><span>나</span><strong>${aName}${aCrit}</strong><span>→ ${res.a_dmg_to_d ?? 0} 데미지</span></div>` +
    `<div class="pvp-last-turn-row"><span>상대</span><strong>${dName}${dCrit}</strong><span>→ ${res.d_dmg_to_a ?? 0} 데미지</span></div>`;
  el.style.display = '';
  el.classList.toggle('pvp-last-turn-collision-active', !!res.collision);
}

// ===== 결과 화면 =====

function showResult(res: PlayCardResp): void {
  const win = res.winner_id === currentBattle?.attacker_id;
  const isPractice = currentBattle?.is_ranked === false;
  const icon = $('pvp-result-icon');
  if (icon) icon.textContent = isPractice ? (win ? '😆' : '😭') : (win ? '🎉' : '💔');
  const title = $('pvp-result-title');
  if (title) {
    title.textContent = isPractice
      ? (win ? '연습 승리' : '연습 패배')
      : (win ? '승리!' : '패배');
  }
  const reward = $('pvp-result-reward');
  if (reward) {
    if (isPractice) {
      reward.textContent = '연습 매칭 — 보상 / 승수 X';
      reward.classList.add('pvp-result-reward-practice');
    } else {
      reward.textContent = '+' + (res.reward_crystals ?? 0).toLocaleString('ko-KR');
      reward.classList.remove('pvp-result-reward-practice');
    }
  }
  showView('result');
  // 잔액 broadcast — 헤더 위젯이 갱신됨
  if (typeof res.reward_crystals === 'number' && res.reward_crystals > 0) {
    // 정확한 새 잔액은 모르니 fetch 트리거 (헤더가 받아 처리)
    window.dispatchEvent(new CustomEvent('crystal-balance-refresh-request'));
  }
  // 랭킹도 새로 fetch (PvP 승수 탭이 변경됐을 수 있음)
  loadRanking();
}

// ===== 랭킹 =====

let currentRankMode: 'power' | 'pvp_wins' = 'power';
let cachedRankings: RankingRow[] = [];

interface RankingRow {
  kingshot_id: string;
  nickname: string;
  profile_photo: string | null;
  power: number;
  pvp_wins: number;
}

/** 멤버 + 장비 power + PvP 승수 fetch → cache 후 현재 mode 로 렌더. */
function loadRanking(): void {
  const refreshBtn = $('pvp-rank-refresh');
  if (refreshBtn) refreshBtn.classList.add('is-loading');
  const url =
    `${REST_URL}/members?select=kingshot_id,nickname,profile_photo,equipment_levels(power)&order=nickname.asc&limit=200`;
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
    }>) => {
      const enriched: RankingRow[] = rows.map((m) => ({
        kingshot_id: m.kingshot_id,
        nickname: m.nickname,
        profile_photo: m.profile_photo,
        power: (m.equipment_levels ?? []).reduce((s, e) => s + (e.power || 0), 0),
        pvp_wins: 0,
      }));
      return fetchPvpWins().then((winsMap) => {
        enriched.forEach((r) => {
          r.pvp_wins = winsMap[r.kingshot_id] ?? 0;
        });
        return enriched;
      });
    })
    .then((rows) => {
      cachedRankings = rows;
      renderRanking();
    })
    .catch(() => {
      cachedRankings = [];
      renderRanking();
    })
    .finally(() => {
      // spinning 최소 400ms 유지 — 빠르게 응답 와도 사용자가 클릭 인지 가능
      window.setTimeout(() => refreshBtn?.classList.remove('is-loading'), 400);
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

/** cachedRankings 를 currentRankMode 기준 내림차순으로 정렬해 렌더. */
function renderRanking(): void {
  const body = $('pvp-ranking-body');
  if (!body) return;
  if (cachedRankings.length === 0) {
    body.innerHTML = '<div class="pvp-ranking-empty">데이터 없음</div>';
  } else {
    const sorted = [...cachedRankings]
      .sort((a, b) => (b[currentRankMode] || 0) - (a[currentRankMode] || 0))
      .slice(0, 20);
    body.innerHTML = sorted
      .map((r, i) => {
        const avatar = r.profile_photo
          ? `<img class="pvp-rank-avatar" src="${r.profile_photo}" alt="" />`
          : `<div class="pvp-rank-avatar pvp-rank-avatar-placeholder">${r.nickname.charAt(0)}</div>`;
        return (
          `<div class="pvp-rank-row">` +
          `<span class="pvp-rank-pos">${i + 1}</span>` +
          avatar +
          `<span class="pvp-rank-name">${r.nickname}</span>` +
          `<span class="pvp-rank-cell-power">${r.power.toLocaleString('ko-KR')}</span>` +
          `<span class="pvp-rank-cell-wins">${r.pvp_wins.toLocaleString('ko-KR')}</span>` +
          `</div>`
        );
      })
      .join('');
  }
  // 헤더 active 표시 (정렬 ▼ 화살표는 CSS ::after 로)
  document.querySelectorAll<HTMLButtonElement>('.pvp-rank-h-sort').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === currentRankMode);
  });
}

// ===== 인증 흐름 =====

function onSessionReady(session: { player_id: string; nickname: string } | null): void {
  if (session?.player_id) {
    hideAuthPrompt();
    showView('matching');
    fetchOpponents(session.player_id);
    fetchDaily(session.player_id);
    loadRanking();
  } else {
    showAuthPrompt();
    // 비인증 사용자도 랭킹은 보여줌
    loadRanking();
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

  // 대상 검색 트리거 — dialog 열기
  $('pvp-search-trigger')?.addEventListener('click', openSearchDialog);

  // dialog 닫기 (× 버튼 + backdrop 클릭)
  $('pvp-search-dialog-close')?.addEventListener('click', closeSearchDialog);
  ($('pvp-search-dialog') as HTMLDialogElement | null)?.addEventListener('click', (e) => {
    // backdrop 클릭 (dialog 자체) 시 닫기 — 카드 영역 클릭은 상관 X
    if ((e.target as HTMLElement).id === 'pvp-search-dialog') closeSearchDialog();
  });

  // 검색 input
  ($('pvp-search-input') as HTMLInputElement | null)?.addEventListener('input', (e) => {
    renderSearchList((e.target as HTMLInputElement).value);
  });

  // 검색 결과 클릭 — defender 직접 선택 (is_ranked=false 자동) + dialog 닫음
  $('pvp-search-list')?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.pvp-search-item');
    if (!target) return;
    const id = target.dataset.targetId;
    if (id) {
      closeSearchDialog();
      onSelectOpponent(id);
    }
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

  // 랭킹 컬럼 헤더 클릭 → 그 컬럼 기준 내림차순 재정렬 (fetch 안 함, cachedRankings 재렌더만)
  document.querySelectorAll<HTMLButtonElement>('.pvp-rank-h-sort').forEach((b) => {
    b.addEventListener('click', () => {
      const mode = b.dataset.sort as 'power' | 'pvp_wins' | undefined;
      if (!mode || mode === currentRankMode) return;
      currentRankMode = mode;
      renderRanking();
    });
  });

  // 랭킹 새로고침 — fetch 다시 (PvP 결과 직후 or 사용자 명시 갱신)
  $('pvp-rank-refresh')?.addEventListener('click', loadRanking);

  // 인증 세션
  if (window.TileMatchAuth) {
    window.TileMatchAuth.initPage();
    window.TileMatchAuth.onSessionChange(onSessionReady);
    window.TileMatchAuth.ensureAuth().then(onSessionReady);
  } else {
    showAuthPrompt();
  }
}
