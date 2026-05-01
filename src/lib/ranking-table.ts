/**
 * 미니게임 랭킹 테이블 — 공통 row 렌더 헬퍼.
 *
 * 컴포넌트 ([src/components/RankingTable.astro](../../components/RankingTable.astro))
 * 가 정적 골격(헤더 + 정렬바 + body 컨테이너) 을 그리고, 페이지 ts 는 데이터를
 * RankItem 로 변환해서 이 함수로 넘기면 keyed reconcile + 사진 fade-in + 1·2·3등
 * 글로우/색상 강조까지 자동 처리.
 *
 * 추가 컬럼은 columns 로 끼워넣음 (스테이지/시간, 전투력/승수, 그 외 …).
 * 닉네임 다음 인라인 Lv. 표시는 의도적으로 제외 — 페이지 데이터 mapping 에서
 * "Lv.X" 를 닉네임 뒤에 붙이고 싶다면 cells[*] 로 별도 컬럼화.
 */

import { patchList, patchText } from '@/lib/dom-diff';

export interface Column {
  /** 데이터 키. RankItem.cells[key] 로 셀 값 매칭. data-rank-sort/cell attr 에도 들어감 */
  key: string;
  /** 정렬바 pill 라벨 (e.g., '⚔️ 전투력') — sortable 일 때만 사용 */
  label: string;
  /** grid-template-columns 의 한 슬롯 (e.g., '60px' | '1fr' | 'auto') */
  width: string;
  /** 셀 정렬. 기본 left */
  align?: 'left' | 'right';
  /** 정렬 가능 여부 — 컴포넌트가 sort pill 자동 렌더 */
  sortable?: boolean;
  /** 추가 cell class (e.g., 'rank-cell-power' — 색상/폰트 customization) */
  cellClass?: string;
}

export interface RankItem {
  /** patchList key — 같은 entity 식별자 (kingshot_id 등) */
  id: string;
  /** 1-based 순위 */
  rank: number;
  /** 표시명 (Lv. 표시는 컴포넌트가 빼고, 필요하면 columns 로 별도 셀 추가) */
  name: string;
  /** 사진 URL — null 이면 닉네임 첫 글자 placeholder */
  photoUrl?: string | null;
  /** 본인 강조 (연두색 배경) */
  isMe?: boolean;
  /** 페이지가 정의한 컬럼별 셀 텍스트 (HTML 안 됨 — patchText 로 textContent set) */
  cells: Record<string, string>;
}

export interface RenderOpts {
  /** Astro 컴포넌트의 bodyId 와 동일 */
  bodyId: string;
  columns: ReadonlyArray<Column>;
  items: ReadonlyArray<RankItem>;
  /** row 클릭 가능 (PvP 의 장비 보기) — role/tabindex 부여, 클릭 핸들러는 페이지가 별도 위임 */
  clickable?: boolean;
  /** 빈 상태 메시지 */
  emptyMessage?: string;
}

function rankNumClass(rank: number): string {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return '';
}

function rankEffectClass(rank: number): string {
  if (rank >= 1 && rank <= 3) return 'rank-effect-' + rank;
  return '';
}

/** 사진 wrap 의 placeholder + img stack — img.onload 시 fade-in. */
function syncPhoto(wrap: HTMLElement, item: RankItem): void {
  const url = item.photoUrl ?? null;
  const fallback = ((item.name || '?').slice(0, 1) || '?').toUpperCase();

  let empty = wrap.querySelector<HTMLElement>('.rank-photo-empty');
  if (!empty) {
    empty = document.createElement('span');
    empty.className = 'rank-photo rank-photo-empty';
    wrap.appendChild(empty);
  }
  patchText(empty, fallback);

  let img = wrap.querySelector<HTMLImageElement>('img.rank-photo');
  if (url) {
    if (!img) {
      img = document.createElement('img');
      img.className = 'rank-photo rank-photo-fade';
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('load', () => img!.classList.add('rank-photo-loaded'));
      img.addEventListener('error', () => img!.classList.remove('rank-photo-loaded'));
      wrap.appendChild(img);
    }
    if (img.src !== url) {
      img.classList.remove('rank-photo-loaded');
      img.src = url;
    }
  } else {
    img?.remove();
  }
}

function createRow(columns: ReadonlyArray<Column>, clickable: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rank-row';
  if (clickable) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
  }
  // 공통 골격: rank-num + photo + name
  row.appendChild(Object.assign(document.createElement('span'), { className: 'rank-num' }));
  const photoWrap = document.createElement('div');
  photoWrap.className = 'rank-photo-wrap';
  row.appendChild(photoWrap);
  row.appendChild(Object.assign(document.createElement('span'), { className: 'rank-name' }));
  // 페이지가 정의한 컬럼 — 헤더가 안 보여도 셀 자체로 자기 정체성 가지도록 색상/정렬 cellClass 활용
  for (const col of columns) {
    const cell = document.createElement('span');
    const cls = ['rank-cell'];
    if (col.cellClass) cls.push(col.cellClass);
    if (col.align === 'right') cls.push('rank-cell-align-right');
    cell.className = cls.join(' ');
    cell.dataset.rankCell = col.key;
    row.appendChild(cell);
  }
  return row;
}

function updateRow(
  row: HTMLElement,
  item: RankItem,
  columns: ReadonlyArray<Column>,
): void {
  row.className = 'rank-row' + (item.isMe ? ' rank-row-me' : '');
  row.dataset.rankId = item.id;
  row.dataset.rankName = item.name;
  if (item.photoUrl) row.dataset.photo = item.photoUrl;
  else delete row.dataset.photo;

  const numEl = row.querySelector<HTMLElement>('.rank-num')!;
  const numCls = rankNumClass(item.rank);
  numEl.className = 'rank-num' + (numCls ? ' ' + numCls : '');
  patchText(numEl, item.rank);

  const wrap = row.querySelector<HTMLElement>('.rank-photo-wrap')!;
  const effect = rankEffectClass(item.rank);
  wrap.className = 'rank-photo-wrap' + (effect ? ' ' + effect : '');
  syncPhoto(wrap, item);

  patchText(row.querySelector<HTMLElement>('.rank-name'), item.name);

  for (const col of columns) {
    const cell = row.querySelector<HTMLElement>(`[data-rank-cell="${CSS.escape(col.key)}"]`);
    if (cell) patchText(cell, item.cells[col.key] ?? '');
  }
}

/** 랭킹 body 를 items 로 갱신 — keyed reconcile (깜박임 X). */
export function renderRankingTable(opts: RenderOpts): void {
  const body = document.getElementById(opts.bodyId);
  if (!body) return;
  const { items, columns, clickable = false, emptyMessage = '데이터 없음' } = opts;

  if (items.length === 0) {
    body.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'rank-empty';
    empty.textContent = emptyMessage;
    body.appendChild(empty);
    return;
  }

  // 빈 상태 / 로딩 placeholder marker (data-key 없는 자식) 제거
  Array.from(body.children).forEach((child) => {
    if (!(child as HTMLElement).dataset.key) child.remove();
  });

  patchList({
    container: body,
    items: items as RankItem[],
    key: (it) => it.id,
    render: (it) => {
      const row = createRow(columns, clickable);
      updateRow(row, it, columns);
      return row;
    },
    update: (row, it) => {
      updateRow(row, it, columns);
    },
  });
}

/** 정렬 pill 바의 active 상태 토글 — 페이지가 클릭 핸들러에서 호출. */
export function setActiveSortPill(bodyId: string, key: string): void {
  // 정렬 바는 body 의 형제 element. body 에서 부모 .rank 를 찾아 그 아래 pill 들 동기화.
  const body = document.getElementById(bodyId);
  const root = body?.closest<HTMLElement>('.rank');
  if (!root) return;
  root.querySelectorAll<HTMLButtonElement>('.rank-sort-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.rankSort === key);
  });
}
