/**
 * 운명의 파트너 — partner-draw.js 의 TypeScript 이식.
 * 슬롯머신 staggered 애니메이션 + tile-match-auth 재사용.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase';

const PARTY_MIN = 2;
const PARTY_MAX = 4;
const DEFAULT_PARTY = 4;

interface MemberLite {
  kingshot_id: string;
  nickname: string;
  level?: number | null;
  profile_photo?: string | null;
}

interface Session {
  player_id: string;
  nickname: string;
}

let initialized = false;
let members: MemberLite[] = [];
let selfId: string | null = null;
let partySize = DEFAULT_PARTY;
let drawing = false;

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function initPartnerDraw(): void {
  if (!initialized) {
    initialized = true;
    $('pd-stepper-minus')?.addEventListener('click', () => setPartySize(partySize - 1));
    $('pd-stepper-plus')?.addEventListener('click', () => setPartySize(partySize + 1));
    $('pd-draw-btn')?.addEventListener('click', onDrawClick);
  }

  setPartySize(partySize);
  if (window.TileMatchAuth) {
    window.TileMatchAuth.initPage();
    window.TileMatchAuth.ensureAuth().then(onSessionReady);
  }
}

function onSessionReady(session: Session | null): void {
  if (!session?.player_id) {
    selfId = null;
    members = [];
    return;
  }
  selfId = String(session.player_id);
  refreshMemberPool();
}

function refreshMemberPool(): void {
  const cached = window.TileMatchAuth?._cachedMembers || null;
  if (cached?.length) {
    members = cached.filter((m) => m && String(m.kingshot_id) !== selfId);
    return;
  }
  fetch(
    SUPABASE_URL +
      '/rest/v1/members?select=kingshot_id,nickname,level,profile_photo&limit=200',
    {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    },
  )
    .then((r) => r.json())
    .then((list: unknown) => {
      const arr = Array.isArray(list) ? (list as MemberLite[]) : [];
      members = arr.filter((m) => m && String(m.kingshot_id) !== selfId);
    })
    .catch(() => {
      members = [];
    });
}

function setPartySize(n: number): void {
  if (n < PARTY_MIN) n = PARTY_MIN;
  if (n > PARTY_MAX) n = PARTY_MAX;
  partySize = n;
  const v = $('pd-stepper-value');
  if (v) v.textContent = String(n);
  const minus = $<HTMLButtonElement>('pd-stepper-minus');
  const plus = $<HTMLButtonElement>('pd-stepper-plus');
  if (minus) minus.disabled = n <= PARTY_MIN;
  if (plus) plus.disabled = n >= PARTY_MAX;
}

function onDrawClick(): void {
  if (drawing) return;
  if (!selfId) {
    window.TileMatchAuth?.ensureAuth().then(onSessionReady);
    return;
  }
  if (!members.length) {
    refreshMemberPool();
    return;
  }
  const pickCount = partySize - 1;
  if (pickCount < 1 || members.length < pickCount) return;

  const winners = pickRandom(members, pickCount);
  runSlotAnimation(winners);
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const pool = arr.slice();
  const picked: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]!);
  }
  return picked;
}

function runSlotAnimation(winners: MemberLite[]): void {
  drawing = true;
  const result = $('pd-result');
  const slotsBox = $('pd-slots');
  const dateEl = $('pd-result-date');
  if (!result || !slotsBox) {
    drawing = false;
    return;
  }
  if (dateEl) dateEl.textContent = formatDate(new Date());

  const FILLER = 22;
  const BASE_DURATION = 1800;
  const STAGGER = 350;
  const html = winners
    .map((_, i) => '<div class="pd-slot" data-idx="' + i + '"><div class="pd-slot-strip"></div></div>')
    .join('');
  slotsBox.innerHTML = html;
  result.style.display = '';

  const slotEls = slotsBox.querySelectorAll<HTMLElement>('.pd-slot');
  slotEls.forEach((slot, i) => {
    const strip = slot.querySelector<HTMLElement>('.pd-slot-strip');
    if (!strip) return;
    const seq: MemberLite[] = [];
    for (let j = 0; j < FILLER; j++) {
      seq.push(members[Math.floor(Math.random() * members.length)]!);
    }
    seq.push(winners[i]!);
    strip.innerHTML = seq.map(renderSlotCard).join('');
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0)';
  });
  // reflow
  void slotsBox.offsetWidth;

  slotEls.forEach((slot, i) => {
    const strip = slot.querySelector<HTMLElement>('.pd-slot-strip');
    if (!strip) return;
    const firstCard = strip.querySelector<HTMLElement>('.pd-slot-card');
    const cardH = firstCard ? firstCard.getBoundingClientRect().height : 140;
    const totalShift = FILLER * cardH;
    const duration = BASE_DURATION + i * STAGGER;
    strip.style.transition = 'transform ' + duration + 'ms cubic-bezier(0.18, 0.74, 0.12, 1)';
    strip.style.transform = 'translateY(-' + totalShift + 'px)';
    setTimeout(() => slot.classList.add('pd-slot-locked'), duration);
  });

  const totalTime = BASE_DURATION + (slotEls.length - 1) * STAGGER + 200;
  setTimeout(() => {
    drawing = false;
  }, totalTime);
}

function renderSlotCard(m: MemberLite | undefined): string {
  const photo = m?.profile_photo
    ? '<img src="' + escAttr(m.profile_photo) + '" alt="">'
    : '<div class="pd-slot-card-empty">' +
      escHtml((m?.nickname || '?').slice(0, 1).toUpperCase()) +
      '</div>';
  const name = escHtml(m?.nickname || '?');
  const meta = m?.level ? '<div class="pd-slot-card-meta">Lv.' + m.level + '</div>' : '';
  return (
    '<div class="pd-slot-card">' +
    photo +
    '<div class="pd-slot-card-name">' +
    name +
    '</div>' +
    meta +
    '</div>'
  );
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return y + '.' + m + '.' + dd;
}

function escHtml(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return map[c]!;
  });
}
function escAttr(s: unknown): string {
  return escHtml(s);
}

declare global {
  interface Window {
    PartnerDraw: { initPage: () => void };
  }
}
window.PartnerDraw = { initPage: initPartnerDraw };
