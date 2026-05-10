/**
 * 게임도구 페이지 진입 가드.
 *
 * 페이지 본문 컨테이너의 [data-gated-kingshot-id] 가 세션과 일치하면 본문 표시,
 * 일치하지 않으면 본문 자식을 숨기고 .gt-no-permission 안내문만 노출.
 *
 * 메뉴 항목 가드(헤더/모바일)는 별도 — components.css 의 [data-require-kingshot-id] 셀렉터.
 */

import { getSession, onSessionChange, type AuthSession } from '@/scripts/pages/tile-match-auth';

function applyGuard(session: AuthSession | null): void {
  const playerId = session?.player_id ?? null;
  const containers = document.querySelectorAll<HTMLElement>('[data-gated-kingshot-id]');
  const noPermission = document.querySelectorAll<HTMLElement>('.gt-no-permission');

  let allowed = true;
  containers.forEach((el) => {
    const required = el.dataset.gatedKingshotId;
    if (!required) return;
    if (required === playerId) {
      delete el.dataset.locked;
    } else {
      el.dataset.locked = 'true';
      allowed = false;
    }
  });

  noPermission.forEach((el) => {
    if (allowed) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  });
}

function init(): void {
  applyGuard(getSession());
  onSessionChange(applyGuard);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
