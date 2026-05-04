/**
 * 주간 랭킹 패널 — 가장 최근 주차의 1·2·3등 표시 (Track 7).
 *
 * 데이터 출처: weekly_rankings 테이블 (anon SELECT 허용).
 *   1. game 별 최근 (year, week_no) 조회
 *   2. 같은 (year, week_no) 의 rank 1~3 row 표시
 *   3. 회원 정보(닉네임/사진) 는 membersStore 에서 lookup
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

function fetchTopRankings(game: 'tile_match' | 'pvp'): Promise<RankingRow[]> {
  // 최근 주차의 rank 1~3 추출 — order DESC year/week + ASC rank, limit 10 한 번에 받아서 클라이언트 필터.
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

function renderPanel(panel: HTMLElement, rows: RankingRow[], membersById: Map<string, { nickname: string; profile_photo: string | null }>): void {
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

  // 가장 최근 (year, week_no) 만 추출 — 첫 row 와 같은 주차 + rank ≤ 3
  const { year, week_no } = rows[0];
  const top3 = rows.filter((r) => r.year === year && r.week_no === week_no && r.rank <= 3);

  // 주차 라벨 — "18주차" (연도는 1월 1일 기준 리셋되므로 명시 X)
  void year; // 미사용 — 향후 다년치 표시 시 활용
  patchText(weekEl, t('weeklyRankings.weekLabel', { week: week_no }));

  podiumEl.hidden = false;
  noteEl.hidden = false;
  emptyEl.hidden = true;

  // row 단위 keyed reconcile (rank 가 key) — 매번 통째 교체 X
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
        '<span class="wrp-rank" data-field="rank"></span>' +
        '<span class="wrp-photo-wrap"><span class="wrp-photo-empty"></span></span>' +
        '<span class="wrp-name" data-field="name"></span>' +
        '<span class="wrp-reward" data-field="reward"></span>';
      podiumEl.appendChild(row);
    }
    const member = membersById.get(r.player_id);
    const nickname = member?.nickname ?? '(' + r.player_id + ')';
    const photo = member?.profile_photo ?? null;

    const rankEl = row.querySelector<HTMLElement>('[data-field="rank"]')!;
    rankEl.textContent = String(r.rank) + '등';
    rankEl.dataset.rank = String(r.rank);

    patchText(row.querySelector<HTMLElement>('[data-field="name"]'), nickname);
    patchText(
      row.querySelector<HTMLElement>('[data-field="reward"]'),
      '+' + r.reward_amount.toLocaleString('ko-KR') + ' 💎',
    );

    // 사진 패치 — 같은 url 이면 재할당 X (브라우저 재로드 차단)
    const photoWrap = row.querySelector<HTMLElement>('.wrp-photo-wrap')!;
    const empty = photoWrap.querySelector<HTMLElement>('.wrp-photo-empty')!;
    empty.textContent = nickname.slice(0, 1).toUpperCase();
    let img = photoWrap.querySelector<HTMLImageElement>('img.wrp-photo');
    if (photo) {
      if (!img) {
        img = document.createElement('img');
        img.className = 'wrp-photo';
        img.decoding = 'async';
        img.addEventListener('load', () => img!.classList.add('loaded'));
        img.addEventListener('error', () => img!.classList.remove('loaded'));
        photoWrap.appendChild(img);
      }
      if (img.src !== photo) {
        img.classList.remove('loaded');
        img.src = photo;
      }
    } else if (img) {
      img.remove();
    }
  }

  // 사라진 rank row 제거 (예: 다음 주에 1등이 생겼는데 현재 1등이 빠진 경우는 거의 없지만 안전)
  for (const [key, el] of existing) {
    if (!targetKeys.has(key)) el.remove();
  }
}

function buildMembersMap(): Map<string, { nickname: string; profile_photo: string | null }> {
  const all = (membersStore.get() ?? []) as Array<{
    kingshot_id: string;
    nickname: string;
    profile_photo: string | null;
  }>;
  return new Map(all.map((m) => [m.kingshot_id, { nickname: m.nickname, profile_photo: m.profile_photo }]));
}

function loadAll(): void {
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.wrp[data-game]'));
  if (panels.length === 0) return;

  // 회원 + 랭킹 병렬 fetch
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
  // 회원 정보 변경 시 닉네임/사진 갱신 반영
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
  // 언어 변경 시 라벨 다시 그리기 (week_no 라벨)
  onLangChange(() => loadAll());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
