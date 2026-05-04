/**
 * 주간 랭킹 패널 — 컴팩트 단일 라인 레이아웃 (Track 7).
 *
 * 데이터 출처: weekly_rankings 테이블 (anon SELECT 허용).
 *   1. game 별 최근 (year, week_no) 자동 추출 (order DESC + 첫 row 와 같은 주차 + rank ≤ 3)
 *   2. 회원 닉네임은 membersStore 에서 lookup (사진은 더이상 노출 X — 컴팩트화)
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';
import { membersStore, fetchMembers } from '@/lib/stores/members';
import { t, onLangChange } from '@/i18n';
import { patchText } from '@/lib/dom-diff';

interface RankingRow {
  game: 'tile_match' | 'pvp';
  year: number;
  week_no: number;
  rank: number;
  player_id: string;
  score: number;
  reward_amount: number;
}

const REST_URL = SUPABASE_URL + '/rest/v1';
const MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

function fetchTopRankings(game: 'tile_match' | 'pvp'): Promise<RankingRow[]> {
  const url =
    REST_URL +
    '/weekly_rankings?game=eq.' +
    encodeURIComponent(game) +
    '&order=year.desc,week_no.desc,rank.asc' +
    '&select=game,year,week_no,rank,player_id,score,reward_amount' +
    '&limit=10';
  return fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
  })
    .then((r) => r.json() as Promise<RankingRow[]>)
    .catch(() => []);
}

function renderPanel(
  panel: HTMLElement,
  rows: RankingRow[],
  membersById: Map<string, { nickname: string }>,
): void {
  const podiumEl = panel.querySelector<HTMLElement>('[data-field="podium"]');
  const noteEl = panel.querySelector<HTMLElement>('[data-field="bottom-note"]');
  const emptyEl = panel.querySelector<HTMLElement>('[data-field="empty"]');
  const weekEl = panel.querySelector<HTMLElement>('[data-field="week-label"]');
  if (!podiumEl || !noteEl || !emptyEl || !weekEl) return;

  panel.removeAttribute('aria-busy');

  if (rows.length === 0) {
    podiumEl.hidden = true;
    noteEl.hidden = true;
    emptyEl.hidden = false;
    patchText(weekEl, '');
    return;
  }

  const { year, week_no } = rows[0];
  const top3 = rows.filter((r) => r.year === year && r.week_no === week_no && r.rank <= 3);

  // 주차 라벨 — "18주차" (연도는 1월 1일 기준 리셋되므로 명시 X)
  void year;
  patchText(weekEl, t('weeklyRankings.weekLabel', { week: week_no }));

  podiumEl.hidden = false;
  noteEl.hidden = false;
  emptyEl.hidden = true;

  // row 단위 keyed reconcile (rank 가 key)
  const existing = new Map(
    Array.from(podiumEl.querySelectorAll<HTMLElement>('.wrp-row')).map((el) => [el.dataset.key!, el]),
  );
  const targetKeys = new Set(top3.map((r) => String(r.rank)));

  for (const r of top3) {
    const key = String(r.rank);
    let row = existing.get(key);
    if (!row) {
      row = document.createElement('li');
      row.className = 'wrp-row';
      row.dataset.key = key;
      row.innerHTML =
        '<span class="wrp-medal" data-field="medal" aria-hidden="true"></span>' +
        '<span class="wrp-name" data-field="name"></span>' +
        '<span class="wrp-reward" data-field="reward"></span>';
      podiumEl.appendChild(row);
    }
    const member = membersById.get(r.player_id);
    const nickname = member?.nickname ?? r.player_id;

    patchText(row.querySelector<HTMLElement>('[data-field="medal"]'), MEDALS[r.rank] ?? '');
    patchText(row.querySelector<HTMLElement>('[data-field="name"]'), nickname);
    patchText(
      row.querySelector<HTMLElement>('[data-field="reward"]'),
      '+' + r.reward_amount.toLocaleString('ko-KR') + ' 💎',
    );
  }

  // 빠진 rank row 제거 (e.g., 1·2 만 있고 3등이 없는 경우)
  for (const [key, el] of existing) {
    if (!targetKeys.has(key)) el.remove();
  }
}

function buildMembersMap(): Map<string, { nickname: string }> {
  const all = (membersStore.get() ?? []) as Array<{ kingshot_id: string; nickname: string }>;
  return new Map(all.map((m) => [m.kingshot_id, { nickname: m.nickname }]));
}

function loadAll(): void {
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.wrp[data-game]'));
  if (panels.length === 0) return;

  Promise.all([
    membersStore.refresh(fetchMembers),
    Promise.all(panels.map((p) => fetchTopRankings(p.dataset.game as 'tile_match' | 'pvp'))),
  ]).then(([_members, rankingsList]) => {
    const map = buildMembersMap();
    panels.forEach((panel, i) => renderPanel(panel, rankingsList[i] ?? [], map));
  });
}

function init(): void {
  loadAll();
  membersStore.subscribe(() => {
    const panels = Array.from(document.querySelectorAll<HTMLElement>('.wrp[data-game]'));
    if (panels.length === 0) return;
    const map = buildMembersMap();
    Promise.all(
      panels.map((p) => fetchTopRankings(p.dataset.game as 'tile_match' | 'pvp')),
    ).then((rankingsList) => {
      panels.forEach((panel, i) => renderPanel(panel, rankingsList[i] ?? [], map));
    });
  });
  onLangChange(() => loadAll());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
