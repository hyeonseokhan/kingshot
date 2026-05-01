# PNX 사이트 다국어 지원 (KOR + ENG) 기획서

> 2026-04-30 작성. 사용자와 합의된 모든 결정사항 보존.
> 실제 구현은 별도 신호 시 `feat/i18n` 브랜치에서 진행.

---

## 1. 목적 및 범위

### 목적
PNX 연맹 사이트의 한국어 UI 를 영어로도 공식 지원. 영문 사용자(외부 농장 계정 운영자, 글로벌 서버 연계 등)가 사이트 기능을 모두 사용 가능하게.

### 범위 — 번역 대상
- 글로벌 컴포넌트: Header / MobileNav / AuthDialog / LoginedUserInfo / LangSwitcher
- 관리: members / coupons 페이지 전체
- 미니게임: tile-match / partner-draw / equipment / pvp 페이지 전체 (라벨 / 다이얼로그 / 토스트 / alert / confirm)
- 메인 페이지 (index)
- Edge Function 의 사용자 노출 에러 메시지

### 범위 — 번역 제외
- 가이드 본문: `src/content/beginner/*.md`, `src/content/events/*.md` — 한국어 유지
- DB 데이터 (회원 닉네임, 쿠폰 코드 `KS0426` 등 게임 코드, 등급 코드 `R1~R5`)
- 게임 고유명 중 "Stage N" 의 N (숫자) — "Stage" 단어 자체는 번역 대상이 아님, 한국어 UI 에서도 이미 "Stage" 영문 그대로 사용 중

> 가이드 페이지에서도 글로벌 UI (헤더 / 메뉴 라벨 / 햄버거 / LoginedUserInfo / 언어 토글) 는 번역됨. 본문만 한글.

---

## 2. 핵심 결정사항

| 항목 | 결정 |
|---|---|
| 라우팅 전략 | **B — 클라이언트 사이드 swap** (URL 그대로 `/manage/members/`) |
| Default 언어 | **브라우저 언어 자동 감지** (`navigator.language` 시작이 `ko-` 면 KOR, 그 외 ENG) |
| 전환 동작 | **즉시 swap, 새로고침 없음** |
| 영문 번역 채우기 | **AI 위임** (사용자 검수 단계에서 정정) |
| 에러 코드 표준화 | **본 PR 에서 같이 진행** — Edge Function 한글 문장 → 코드, 클라이언트 매핑 |
| 데이터 형태 | **TypeScript 객체** — `ko` 가 source of truth, `en` 누락 키 컴파일 에러 |
| 작업 분할 | **한 번에 (단일 PR / feature 브랜치 안 commit 단위 누적)** |
| Production 배포 | **영문 검수 끝나야 main 머지** |
| 공식 게임 용어 | **게임 영문판 표기 따름** (사전 준비 필요 — §9) |

### 라우팅 B 선택 이유
- PNX 사이트는 검색엔진 진입 거의 없음 (URL 직접 공유 위주) → SEO 우선순위 낮음
- GitHub Pages 정적 호스팅에서 빌드 페이지 수가 19 → ~30 으로 늘어나는 비용 회피
- 가이드는 한글 only 라 라우팅 분리 의미 약함
- 운영 단순성 우선

---

## 3. 아키텍처

### 디렉토리 구조 (신규)
```
src/i18n/
  ko.ts       # 한글 (source of truth)
  en.ts       # 영문 (ko 의 키 구조 거울, Translations 타입으로 강제)
  index.ts    # t() / getLang() / setLang() / detectLang() / onLangChange() 헬퍼
src/components/
  LangSwitcher.astro  # 헤더의 🌐 KOR/ENG 드롭다운
src/scripts/components/
  lang-switcher.ts    # 클라이언트 로직
```

### 번역 데이터 형태 (예시)
```ts
// src/i18n/ko.ts
export const ko = {
  common: {
    cancel: '취소', save: '저장', confirm: '확인',
    loading: '로딩 중...', login: '로그인', logout: '로그아웃',
    close: '닫기', back: '뒤로', refresh: '새로고침',
  },
  nav: {
    beginner: '입문 가이드',
    events: '이벤트',
    manage: '연맹관리',
    minigame: '미니게임',
    submenu: {
      members: '연맹원',
      coupons: '쿠폰 받기',
      tileMatch: '타일 매치',
      partnerDraw: '운명의 파트너',
      equipment: '장비 강화',
      pvp: '매칭 대결',
    },
  },
  auth: { /* ... */ },
  equipment: { /* ... */ },
  tileMatch: { /* ... */ },
  pvp: { /* ... */ },
  members: { /* ... */ },
  coupons: { /* ... */ },
  errors: {
    invalid_pin: '비밀번호를 확인해 주세요. 또는 비밀번호 초기화 요청을 해주세요.',
    member_not_found: '연맹원을 찾을 수 없습니다.',
    crystal_shortage: '크리스탈 부족',
    /* ... */
  },
} as const;
export type Translations = typeof ko;

// src/i18n/en.ts
import type { Translations } from './ko';
export const en: Translations = {
  common: { cancel: 'Cancel', save: 'Save', /* ... */ },
  /* ... */
};
```

### 런타임 헬퍼 (예시)
```ts
// src/i18n/index.ts
import { ko } from './ko';
import { en } from './en';

const STORAGE_KEY = 'pnx-lang';
const dictionaries = { ko, en } as const;
type Lang = keyof typeof dictionaries;

let current: Lang = detectLang();
const listeners = new Set<(lang: Lang) => void>();

export function detectLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'ko' || saved === 'en') return saved;
  return navigator.language.startsWith('ko') ? 'ko' : 'en';
}

export function getLang(): Lang { return current; }

export function setLang(lang: Lang): void {
  current = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn(lang));
}

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 점 표기법 키로 번역 가져옴. 예: t('equipment.modal.cost') */
export function t(key: string): string {
  const parts = key.split('.');
  let v: unknown = dictionaries[current];
  for (const p of parts) {
    if (v && typeof v === 'object' && p in v) v = (v as Record<string, unknown>)[p];
    else return key;  // 누락 키 — 키 자체 반환 (디버그용)
  }
  return typeof v === 'string' ? v : key;
}
```

---

## 4. UI 텍스트 swap 패턴

### HTML 정적 텍스트
`data-i18n` 속성 + 일괄 swap:

```astro
<!-- 마크업 -->
<button class="btn-primary" data-i18n="common.save">저장</button>
<input data-i18n-attr-placeholder="auth.searchPlaceholder" placeholder="닉네임 또는 ID 검색" />

<!-- 클라이언트 (i18n/index.ts 의 boot 시점) -->
function applyTranslations(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n!;
    el.textContent = t(key);
  });
  // attr 별 처리
  document.querySelectorAll<HTMLElement>('[data-i18n-attr-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nAttrPlaceholder!));
  });
  // aria-label 등 추가 attr 도 같은 패턴
}
```

`setLang()` 시 `applyTranslations()` 자동 호출.

### 동적 메시지 (alert/toast/dialog 본문)
직접 `t()` 호출:
```ts
alert(t('errors.crystal_shortage'));
showToast(t('common.saved'));
```

### 숫자 / 날짜 포매팅
locale 분기:
```ts
const locale = getLang() === 'ko' ? 'ko-KR' : 'en-US';
value.toLocaleString(locale);
```

`formatTime()` / `formatRelativeTime()` 등 시간 헬퍼도 lang 에 따라 단위 텍스트 swap (`13일 4시간 35분` ↔ `13d 4h 35m`).

---

## 5. 언어 전환 UI

### 위치
헤더 우측 — `LoginedUserInfo` (또는 비로그인 시 "로그인" 버튼) 의 좌측에 배치.

```
[ 헤더 좌: 로고 / 탭 ]    [ 우: 🌐 KOR ▾ ] [ 로그인 또는 LoginedUserInfo ] [ 햄버거 ]
```

### 동작
- 클릭 시 작은 드롭다운: `✓ 한국어 / English`
- 항목 선택 → `setLang(...)` 호출 → 즉시 swap (페이지 이동/새로고침 없음)
- 외부 클릭 시 자동 닫기

### 모바일 처리
- 데스크톱: 풀텍스트 `🌐 KOR ▾`
- 모바일: 아이콘 + 약자 (`🌐 KO ▾`) — 폭 절약

---

## 6. Edge Function 에러 코드 표준화

### 목적
서버 응답 메시지가 한글 문장이면 영문 사용자에게도 그대로 노출됨. 서버는 **코드만** 반환하고 클라이언트가 lang 별로 번역하게 분리.

### 현재 → 변경 (예시)

```ts
// Before — supabase/functions/tile-match-auth/index.ts
const FAIL_MSG = '비밀번호를 확인해 주세요. 또는 비밀번호 초기화 요청을 해주세요.';
return { ok: false, error: FAIL_MSG };

// After
return { ok: false, error: 'invalid_pin' };
```

### 클라이언트 매핑 (i18n/ko.ts 의 errors 네임스페이스)
```ts
errors: {
  invalid_pin: '비밀번호를 확인해 주세요. 또는 비밀번호 초기화 요청을 해주세요.',
  // ...
}
```

### 변경 대상 함수 5개 + 수정 범위 (예상)
| Edge Function | 한글 응답 개수 | 비고 |
|---|---|---|
| `tile-match-auth` | ~3 | PIN 검증 실패 등 |
| `economy` | ~2 | 보상 청구 |
| `equipment` | ~1 | 대부분 이미 코드형 |
| `pvp` | ~3 | 자기공격, 한도 등 |
| `redeem-coupon` | (외부 API 결과 그대로 전달) | 처리 결과 코드만 표준화 |
| `gift-codes` | 0 | 데이터 응답만 |

총 ~10개 정도. 작은 변경.

### 호출 흐름 (변경 후)
```ts
// 클라이언트
const res = await callAuth('verify-pin', { ... });
if (!res.ok) {
  showAuthMsg(t('errors.' + res.error));  // 'invalid_pin' → "비밀번호를 확인해..."
}
```

---

## 7. 단계별 작업 계획 (commit 단위)

`feat/i18n` 단일 브랜치 안에서 5 commit 누적:

### C1 — i18n 인프라 (코드만)
- `src/i18n/{ko,en,index}.ts` 골격 (몇 개 키만 채워둠)
- `LangSwitcher.astro` + 헤더에 마운트
- `<html lang>` 자동 토글
- 브라우저 언어 자동 감지 + localStorage persistence
- 검증: 헤더의 토글 동작 확인 (텍스트 변동은 아직 없음, 인프라만)

### C2 — 글로벌 컴포넌트
- Header / MobileNav / AuthDialog / LoginedUserInfo / LangSwitcher 자체
- 메뉴 라벨 (입문가이드 / 이벤트 / 연맹관리 / 미니게임)
- 검증: 모든 페이지에서 헤더/햄버거 영문 모드 확인

### C3 — 관리 페이지
- members 페이지 (검색/등록/수정/삭제 다이얼로그)
- coupons 페이지 (쿠폰 카드 / 수령 / 이력)
- alert/confirm/toast 메시지 t() 화

### C4 — 미니게임 (4 페이지 일괄)
- tile-match (런치카드 / 게임보드 / 결과 다이얼로그 / 랭킹)
- partner-draw (인원 stepper / 슬롯머신 / 결과)
- equipment (인벤토리 / 강화 모달 / 등급 라벨)
- pvp (매칭 / 카드 대결 / 결과 / 랭킹)

### C5 — Edge Function 에러 코드 표준화 + 동적 메시지
- 5개 Edge Function 의 한글 문장형 에러 → 코드 변환
- 클라이언트 errors 네임스페이스 매핑 채우기
- formatTime 등 시간 헬퍼 lang 분기

---

## 8. 영문 검수 + 배포 절차

### 검수 단계
1. C1~C5 모두 commit 완료 (영문 placeholder 1차 채움)
2. AI 가 1차 영문 번역 완료 → en.ts 채워짐
3. **Playwright 모든 화면 ENG 모드 캡처** (~20 캡처):
   - 헤더 / 모바일 메뉴
   - 멤버 관리 (목록 / 등록 모달 / 수정 / 삭제 confirm)
   - 쿠폰 받기 (카드 목록 / 수령 진행 / 이력 다이얼로그)
   - 타일매치 (런치 / 게임 / 결과 / 랭킹)
   - 운명파트너 (인원 / 결과)
   - 장비강화 (인벤토리 / 모달 / 모든 등급)
   - PvP (매칭 / 배틀 / 결과 / 랭킹)
4. 사용자 캡처 검토 → 어색한 번역 / 깨진 레이아웃 정정 요청
5. 사용자 OK → main 머지
6. push → GitHub Actions → production 배포

### 배포 시 주의
- 작업 중엔 절대 main 으로 push 하지 않음 (자동 배포돼버림)
- feature 브랜치에만 commit/push
- 검수 끝난 후 사용자 명시 신호 시 머지

### Edge Function 배포 동시성
- 서버 (에러 코드) 와 클라이언트 (코드 매핑) 가 동시에 production 가야 mismatch 없음
- 순서: Management API 로 5 Edge Function 배포 → 직후 main push (클라이언트 빌드 자동 시작)
- mismatch 윈도우는 GitHub Actions 빌드 시간 ~40초 — 그 동안 영문 사용자가 옛 한글 에러 한 번 정도 볼 수 있음 (수용 가능)

---

## 9. 사전 준비 — 게임 영문 표기 (사용자 작업)

### 결정: 게임 영문판 표기 따름 → **사용자가 미리 정리**

작업 시작 전에 다음 용어들의 게임 공식 영문 표기를 정리해서 줘야 함:

### 필수 수집 항목 (~30개)

#### 장비 슬롯 (6)
- 월계관 / 목걸이 / 상의 / 하의 / 반지 / 지팡이

#### 강화 등급 (6)
- 일반 / 고급 / 희귀 / 영웅 / 레전드 / 신화

#### 미니게임 (4)
- 매칭 대결 / 운명의 파트너 / 타일 매치 / 장비 강화

#### 핵심 시스템 용어
- 총리대신 / 도시 센터 / 법령 / 펫 (회색늑대) / 연맹
- 크리스탈 / 가속권 / 전투력 / 등급 (R1~R5)
- 공격 / 방어 / 강화 (PvP 카드)

#### 메뉴
- 입문 가이드 / 이벤트 / 연맹관리 / 미니게임
- 연맹원 / 쿠폰 받기

#### 기타
- 자동 받기 / 수령 이력 / 등록 / 수정 / 삭제

### 수집 방법 제안
1. 게임 영문판 (글로벌 서버) 설치 또는 언어 설정 영어로 변경
2. 각 화면 캡처 → 위 용어 매핑 정리
3. CSV 또는 마크다운 표로 작성 후 본 문서에 추가

또는 모르는 항목만 작업 도중 사용자에게 confirm — 흐름은 끊기지만 가능.

---

## 10. 리스크 / 엣지 케이스

| 리스크 | 대응 |
|---|---|
| 영문 텍스트 한글보다 길어 헤더/버튼 폭 깨짐 | min-width 충분히, ellipsis 적용, 모바일 대응 |
| 영문 모드에서 가이드 본문은 한글 — 일관성 위화감 | LangSwitcher 옆 작은 안내 ("Guides remain in Korean") 또는 가이드 진입 시 토스트 1회 |
| AuthDialog / 다이얼로그 등 동적 마운트 컴포넌트의 텍스트 swap | mount 시 t() 호출 + onLangChange listener 자체 갱신 |
| Edge Function 에러 코드 변경 PR 동시 배포 mismatch 윈도우 | 서버 먼저 배포 (코드 추가, 한글 응답도 fallback 으로 잠시 유지) → 클라 배포 → 그 후 한글 fallback 제거 (추가 PR) — 이 정도는 과한 보호. 동시 배포 + 짧은 mismatch 수용이 현실적 |
| 영문 번역 누락 키 (ko 추가했는데 en 깜빡) | Translations 타입으로 컴파일 에러. CI 의 `astro check` 가 검출 |
| 게임 영문판이 한국어판과 용어 다름 (일부 게임 잘 알려진 패턴) | §9 의 사용자 사전 정리로 해결 |
| 폰트 — Pretendard 영문 표시 | 그대로 사용 (Pretendard 영문도 가독성 OK). 필요 시 영문 모드만 별도 폰트 추가 가능 |
| `formatTime()` 등 한글 단위 박힌 함수 | locale 분기 추가 |

---

## 11. 작업 시작 시 체크리스트

작업 재개 시 이 순서로:

1. [ ] 사용자가 §9 의 게임 영문 용어 정리 완료 (또는 작업 중 confirm 정책 합의)
2. [ ] `feat/i18n` 브랜치 생성
3. [ ] C1 — i18n 인프라 commit
4. [ ] 사용자 점검 (LangSwitcher 동작 / 자동 감지 OK?)
5. [ ] C2~C4 commit (페이지별 진행)
6. [ ] C5 — Edge Function 에러 코드 표준화 commit
7. [ ] AI 영문 번역 채우기 → en.ts 완성
8. [ ] Playwright 전 화면 ENG 모드 캡처 → 사용자 검토
9. [ ] 정정 + 재캡처 (몇 번 반복)
10. [ ] 사용자 OK → Edge Function Management API 배포 → main 머지 + push
11. [ ] GitHub Actions 배포 success 확인
12. [ ] CLAUDE.md 에 다국어 운영 메모 추가 (어떻게 키 추가하나, 영문 누락 검출법 등)

---

## 12. 참고 — 본 문서 외 영향

### 본 문서 적용 시 변경되는 외부 파일/문서
- `CLAUDE.md` — 다국어 운영 메모 추가 (작업 완료 시점)
- `MIGRATION_PLAN.md` — 영향 없음
- `ISSUES.md` — 영향 없음 (단 다국어 작업 중 발견 이슈는 추가될 수 있음)

### 향후 확장 가능성
- 3 번째 언어 (중국어 / 일본어 등) 추가 — 본 설계 그대로 `zh.ts` / `ja.ts` 만 추가하면 됨
- 사용자별 언어 설정 (DB 저장) — 현재는 localStorage 만. 필요 시 `members.preferred_lang` 컬럼 추가
- 가이드 본문도 다국어화 — 현재 범위 외. Astro Content Collections 의 i18n 기능 활용 가능

---

**Status**: 기획 완료. 구현 대기 중.
**Next signal**: 사용자가 게임 영문 표기 정리 후 "i18n 시작" 신호 → §11 의 체크리스트대로 진행.
