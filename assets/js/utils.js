/**
 * @fileoverview PNX 연맹 가이드 - 공통 유틸리티 모듈
 * 모든 JS 파일에서 공유하는 함수와 상수를 정의합니다.
 */

var Utils = (function() {
  'use strict';

  // ===== 상수 =====

  /** 쿠폰 교환 상태 코드 */
  var REDEEM_STATUS = {
    SUCCESS: 'success',
    ALREADY: 'already_redeemed'
  };

  /** 쿠폰 교환 응답에서 "이미 수령" 판별 키워드 */
  var ALREADY_REDEEMED_KEYWORDS = ['RECEIVED', 'redeemed once'];

  /** centurygame 쿠폰 교환 err_code → 사용자용 한글 라벨 매핑 */
  var REDEEM_ERR_CODES = {
    40004: '인증코드 불일치',
    40005: '존재하지 않는 쿠폰 코드',
    40007: '만료된 쿠폰 코드',
    40008: '이미 수령된 쿠폰',
    40014: '서버 시간 오류',
    40017: '영주 상담원 전속 코드 (카카오톡 채널 자격 필요)'
  };

  /** 레벨별 프로필 테두리 CSS 클래스 매핑 (임계값 내림차순) */
  var LEVEL_CLASSES = [
    { min: 30, cls: ' lv-30' },
    { min: 29, cls: ' lv-29' },
    { min: 28, cls: ' lv-28' }
  ];

  // ===== 유틸 함수 =====

  /**
   * HTML 특수문자를 이스케이프합니다.
   * @param {string} s - 이스케이프할 문자열
   * @returns {string} 이스케이프된 문자열
   */
  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
  }

  /**
   * ISO 날짜 문자열을 YYYY-MM-DD 형식으로 변환합니다.
   * @param {string} isoStr - ISO 8601 날짜 문자열
   * @returns {string} 포맷된 날짜 또는 '-'
   */
  function formatDate(isoStr) {
    if (!isoStr) return '-';
    var d = new Date(isoStr);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /**
   * 지정된 밀리초만큼 대기하는 Promise를 반환합니다.
   * @param {number} ms - 대기 시간 (밀리초)
   * @returns {Promise<void>}
   */
  function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  /**
   * 숫자를 천 단위 쉼표가 포함된 문자열로 변환합니다.
   * @param {number|null} n - 변환할 숫자
   * @returns {string} 포맷된 숫자 또는 '-'
   */
  function formatNum(n) {
    if (!n) return '-';
    return Number(n).toLocaleString();
  }

  /**
   * 레벨에 해당하는 프로필 테두리 CSS 클래스를 반환합니다.
   * @param {number} level - 플레이어 레벨
   * @returns {string} CSS 클래스 문자열 (예: ' lv-30') 또는 빈 문자열
   */
  function getLevelClass(level) {
    for (var i = 0; i < LEVEL_CLASSES.length; i++) {
      if (level >= LEVEL_CLASSES[i].min) return LEVEL_CLASSES[i].cls;
    }
    return '';
  }

  /**
   * 메모 텍스트를 지정된 길이로 말줄임 처리합니다.
   * @param {string} text - 원본 텍스트
   * @param {number} limit - 최대 글자 수
   * @returns {string} 말줄임 처리된 텍스트
   */
  function truncate(text, limit) {
    if (!text) return '';
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  /**
   * centurygame API 응답이 "이미 수령됨" 상태인지 판별합니다.
   * @param {Object} json - API 응답 객체
   * @returns {boolean}
   */
  function isAlreadyRedeemed(json) {
    if (!json.msg) return false;
    return ALREADY_REDEEMED_KEYWORDS.some(function(kw) {
      return json.msg.indexOf(kw) !== -1;
    });
  }

  /**
   * 쿠폰 교환 응답을 사람이 이해할 수 있는 라벨로 변환합니다.
   * err_code 매핑이 우선, 그 다음 keyword 검사, 마지막은 raw msg.
   * @param {Object} resp - {code, msg, err_code}
   * @returns {string} 한글 라벨 또는 원본 메시지
   */
  function describeRedeemError(resp) {
    if (!resp) return '실패';
    if (resp.err_code != null && REDEEM_ERR_CODES[resp.err_code]) {
      return REDEEM_ERR_CODES[resp.err_code];
    }
    if (isAlreadyRedeemed(resp)) return '이미 수령됨';
    return resp.msg || '실패';
  }

  /**
   * 모달/다이얼로그 오버레이를 열거나 닫습니다.
   * @param {string} overlayId - 오버레이 요소의 ID
   * @param {boolean} open - true면 열기, false면 닫기
   */
  function toggleOverlay(overlayId, open) {
    var el = document.getElementById(overlayId);
    if (el) el.classList.toggle('open', open);
  }

  /**
   * 특정 탭이 활성화될 때 콜백을 실행하는 MutationObserver를 등록합니다.
   * 한 번만 실행됩니다.
   * @param {string} tabId - 감시할 탭 요소의 ID
   * @param {Function} callback - 탭 활성화 시 실행할 함수
   */
  function onTabActive(tabId, callback) {
    var fired = false;
    var observer = new MutationObserver(function() {
      var el = document.getElementById(tabId);
      if (el && el.classList.contains('active') && !fired) {
        fired = true;
        callback();
      }
    });
    observer.observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ['class']
    });
  }

  // ===== Public API =====
  return {
    REDEEM_STATUS: REDEEM_STATUS,
    esc: esc,
    formatDate: formatDate,
    formatNum: formatNum,
    delay: delay,
    getLevelClass: getLevelClass,
    truncate: truncate,
    isAlreadyRedeemed: isAlreadyRedeemed,
    describeRedeemError: describeRedeemError,
    toggleOverlay: toggleOverlay,
    onTabActive: onTabActive
  };

})();
