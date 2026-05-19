/**
 * 3 페이지 (members/coupons/blacklist) 의 "ID 조회 → preview → 저장" 모달
 * 컨트롤러. 마크업은 페이지별로 유지 (CSS/i18n 셀렉터가 ID 에 박혀 있어
 * 컴포넌트화 비용 큼) — 본 모듈은 이벤트 바인딩 + 조회 흐름만 흡수.
 *
 * 사용:
 *   const modal = bindPlayerSearchModal({
 *     overlayId: 'modal-overlay',
 *     inputId: 'input-kingshot-id',
 *     searchBtnId: 'btn-search-id',
 *     saveBtnId: 'btn-modal-save',
 *     searchingButtonText: () => t('members.modal.searchingButton'),
 *     searchButtonText: () => t('members.modal.searchButton'),
 *     onPreview: (data) => { ... preview 영역 갱신 ... },
 *     onReset: () => { ... preview 영역 숨김 ... },
 *     onSave: async (data) => { ... DB insert ... },
 *   });
 *   // + 등록 버튼:
 *   $('btn-add-member').addEventListener('click', () => {
 *     modal.reset();
 *     toggleOverlay(overlayId, true);
 *   });
 */

import { lookupPlayer, PlayerNotFoundError, type PlayerLookup } from './api/centurygame';
import { appAlert } from './dialog';
import { t } from '@/i18n';

export interface PlayerSearchModalOptions {
  overlayId: string;
  inputId: string;
  searchBtnId: string;
  /** 저장 버튼이 있는 모달 (members/coupons). blacklist 처럼 별도 submitForm 으로
   *  저장하는 페이지는 생략 — onSave 도 함께 생략. */
  saveBtnId?: string;
  /** 조회 중 버튼 라벨 — t() 호출이 매번 평가되도록 함수형. */
  searchingButtonText: () => string;
  /** 평상시 버튼 라벨. */
  searchButtonText: () => string;
  /** 조회 직전 사전 검증 (ID 형식 / 도메인 중복 등). false return 시 조회 차단.
   *  caller 가 자체적으로 alert 표시. blacklist 처럼 모드별 검증이 다른 페이지용. */
  beforeSearch?: (id: string) => boolean;
  /** 조회 성공 시 호출. preview 영역 갱신은 caller 책임. saveBtn 활성화는 컨트롤러가 처리. */
  onPreview: (data: PlayerLookup) => void;
  /** 모달 열림 / 조회 실패 / 빈 입력 시 — preview 숨김 + 상태 초기화. */
  onReset: () => void;
  /** 저장 버튼 클릭 (saveBtnId 가 있을 때만). 마지막 lookup 결과를 인자로 받음. */
  onSave?: (data: PlayerLookup) => Promise<void> | void;
}

export interface PlayerSearchModalHandles {
  /** 입력/preview 초기화 + 저장 비활성. + 등록 버튼이 호출. */
  reset(): void;
  /** 마지막 조회 결과 (저장 흐름에서 외부 참조 — blacklist 의 submitForm 등). */
  getResult(): PlayerLookup | null;
}

export function bindPlayerSearchModal(
  opts: PlayerSearchModalOptions,
): PlayerSearchModalHandles {
  let lastResult: PlayerLookup | null = null;

  const input = document.getElementById(opts.inputId) as HTMLInputElement | null;
  const searchBtn = document.getElementById(opts.searchBtnId) as HTMLButtonElement | null;
  const saveBtn = opts.saveBtnId
    ? (document.getElementById(opts.saveBtnId) as HTMLButtonElement | null)
    : null;
  if (!input || !searchBtn) {
    throw new Error(
      `bindPlayerSearchModal: missing input(#${opts.inputId}) or searchBtn(#${opts.searchBtnId})`,
    );
  }

  const setSaveDisabled = (disabled: boolean) => {
    if (saveBtn) saveBtn.disabled = disabled;
  };

  const triggerSearch = (): void => {
    const id = input.value.trim();
    if (!id) return;
    if (opts.beforeSearch && !opts.beforeSearch(id)) return;
    searchBtn.textContent = opts.searchingButtonText();
    searchBtn.disabled = true;

    lookupPlayer(id)
      .then((data) => {
        lastResult = data;
        opts.onPreview(data);
        setSaveDisabled(false);
      })
      .catch((err: Error) => {
        // 외부 API 의 raw msg ("Sign Error", "Player Not Existed" 등) 노출 금지.
        appAlert(
          t(
            err instanceof PlayerNotFoundError
              ? 'common.playerLookupNotFound'
              : 'common.playerLookupFailed',
          ),
        );
        lastResult = null;
        setSaveDisabled(true);
      })
      .finally(() => {
        searchBtn.textContent = opts.searchButtonText();
        searchBtn.disabled = false;
      });
  };

  searchBtn.addEventListener('click', triggerSearch);
  // input 안 Enter 키 = 조회. 모달 안 검색이라 form submit 대신 단축키 의도.
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') triggerSearch();
  });

  if (saveBtn && opts.onSave) {
    const handler = opts.onSave;
    saveBtn.addEventListener('click', () => {
      if (!lastResult) return;
      void handler(lastResult);
    });
  }

  return {
    reset(): void {
      input.value = '';
      lastResult = null;
      setSaveDisabled(true);
      opts.onReset();
    },
    getResult(): PlayerLookup | null {
      return lastResult;
    },
  };
}
