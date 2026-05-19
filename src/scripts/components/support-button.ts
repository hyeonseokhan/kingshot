/**
 * 후원 버튼 + 다이얼로그 핸들러 (`src/components/SupportButton.astro` 짝꿍).
 * native <dialog> 의 backdrop / ESC 동작은 자동 — 명시 핸들러는 backdrop 클릭 → close 만.
 */

function init(): void {
  const btn = document.getElementById('support-btn');
  const dlg = document.getElementById('support-dialog') as HTMLDialogElement | null;
  const closeBtn = document.getElementById('support-dialog-close');
  if (!btn || !dlg) return;

  btn.addEventListener('click', () => {
    dlg.showModal();
  });
  closeBtn?.addEventListener('click', () => {
    dlg.close();
  });
  // backdrop 클릭 (dialog element 자체가 target 이면 외부 영역)
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
