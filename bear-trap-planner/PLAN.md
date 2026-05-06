# Bear Trap Planner — 기획서 (초안)

**기준 레퍼런스**: https://www.kingshotguide.org/map/kingshot-map-builder/
**목적**: 위 사이트를 우선 그대로 복제한다는 가정의 기획서. 우리 프로젝트(PNX 연맹) 맥락 반영은 사용자가 추후 직접 가감.

---

## 1. 목적 / 정체성

연맹 영지의 **곰덫(Bear Trap, 게임 공식명 Pitfall) 배치 시뮬레이터**.
사용자는 비어있는 격자 위에 곰덫·요새·깃발·블록 등을 배치해 영지 레이아웃을 설계하고, 결과를 PNG/텍스트로 내보내거나 다른 사람의 레이아웃을 가져와 검토한다. 게임 내 R4/R5 가 연맹 가이드 문서로 공유하는 용도.

> 곰덫 이벤트는 정해진 위치에 곰덫이 설치되고 그 주변으로 동맹원이 깃발과 요새를 어떻게 배치하느냐로 화력 집중 효율이 갈리기 때문에, "한 장의 도면으로 합의" 하는 도구가 핵심 가치.

---

## 2. 격자 / 좌표 시스템

- 직교 격자(square grid). 각 셀 1칸 = 게임 내 1타일 가정.
- **너비/높이 동적 조절**: `Width`, `Height` 입력 + `Resize` 버튼.
- 좌상단 (0,0) 기준 정수 좌표로 객체 저장.
- **기본 80×80** (레퍼런스 스크린샷 확인).

### 다이아 표시 (결정: 옵션 A — CSS `transform: rotate(45deg)`)
- 격자 컨테이너에 `rotate(45deg)` 한 번 적용해 정사각형이 마름모로 보이게.
- 마킹 용도이므로 게임 화면처럼 2:1 isometric 비율(옵션 B)까지는 불필요.
- 객체 아이콘/라벨은 같이 회전되지 않게 자식 요소에 `rotate(-45deg)` 로 상쇄(똑바로 보이게).
- 마우스 좌표 → 셀 좌표 변환은 회전된 컨테이너 기준 inverse transform 1줄로 처리.

### 두 개의 영역(zone) — 레퍼런스 소스코드 분석 확정

**Green/Blue 모두 깃발+본부에서 자동 생성** (사전 정의된 지형 아님):

| 건축물 | Blue 반경 | Green 반경 | Blue 영역 | Green 영역 |
|---|---|---|---|---|
| **깃발** (1×1) | 3 | 7 | 7×7 | 15×15 |
| **연맹 본부** (3×3) | 6 (footprint 기준) | 10 | 18×18 | 26×26 |

- Blue 가 Green 위에 덧씌워짐 (같은 셀에서 Blue 우선)
- 여러 깃발/본부의 영역은 합쳐짐 (누적)
- 도시 중심/제분소/곰덫/장애물은 영역 생성 안 함
- 시작 시 영역 없음. 깃발/본부 놓아야 영역이 생김

### 배치 검증 — 자유 배치 + 시각 뱃지

레퍼런스는 **bounds + 겹침만** 강제. Green/Blue 위치 강제 X.
대신 Pitfall/TC/Mill/HQ 의 모서리에 작은 12×12 뱃지를 그려서
"이 객체의 모든 셀이 Blue 안인가?" 표시 (✅ 초록 / ❌ 빨강).
→ **하드 거부 아닌 시각 피드백만**.

---

## 3. 배치 가능 객체 (7종)

| 이름 | 크기 | 비고 |
|---|---|---|
| 이름 | 크기 | 코드 | 역할 |
|---|---|---|---|
| Pitfall / 곰덫 | 3×3 | P | **이벤트 중심점**. 보통 1~2개 |
| Town Center / 도시 중심 | 2×2 | T | 연맹원 각자의 성. 60~100개 가능. 자동 번호 TC#N + 6색 팔레트 순환 |
| Banner / 깃발 | 1×1 | B | **영역 생성기** — Blue 7×7 + Green 15×15 펼침 |
| Alliance Mills / 연맹 제분소 | 2×2 | M | 자원 건물 (영역 생성 X) |
| Alliance HQ / 연맹 본부 | 3×3 | H | **영역 생성기** — Blue 18×18 + Green 26×26 펼침 |
| Blocked Path (S) / 장애물 | 1×1 | X | 통행 차단 |
| Blocked Path (L) / 큰 장애물 | 2×2 | Y | 통행 차단 |

**배치 규칙 (레퍼런스)**:
- 격자 안 + 겹침 없음만 강제
- Pitfall/TC/Mill/HQ 는 "Blue 안인지" 뱃지로 표시만, 배치는 막지 않음

---

## 4. 도구 / 인터랙션

좌측 또는 상단 툴바:

- **Select/Move** — 객체 선택 & 드래그로 이동
- **Pan/Navigate** — 캔버스 자체를 끌어 이동(큰 격자에서 시야 이동)
- **Delete** — 선택 객체 제거
- **Clear** — 캔버스 전체 비우기
- **Resize** (+ Width/Height 입력) — 격자 크기 변경
- **Samples** — 미리 만들어둔 레이아웃 모달 열기
- **Export PNG** — 현재 캔버스를 이미지로 다운로드
- **Export Text** — 레이아웃 직렬화 텍스트(JSON 또는 자체 포맷)
- **Import Text** — 위 텍스트를 붙여넣어 복원

확인되지 않은 것: 회전/뒤집기, undo/redo, march-time 계산기, 그리드 줌. **레퍼런스에는 없는 듯**.

---

## 5. 데이터 모델 (제안)

```ts
type Layout = {
  width: number;
  height: number;
  zones: Array<{ kind: 'alliance' | 'buildable'; x: number; y: number; w: number; h: number }>;
  objects: Array<{
    type: 'pitfall' | 'town_center' | 'banner' | 'mills' | 'hq' | 'block_s' | 'block_l';
    x: number; y: number;       // 좌상단 셀 좌표
  }>;
  version: 1;
};
```

- Export Text = JSON.stringify(layout) 또는 base64 압축. **공유 URL** 까지는 레퍼런스에 없음(우리가 추가 가능).

---

## 6. 모달 / 화면 구성

- **Import Layout 모달** — textarea + Import/Cancel
- **Export Layout 모달** — textarea(read-only) + Copy to Clipboard/Close
- **Sample Layouts 모달** — 썸네일 그리드 + Close. 클릭 시 캔버스에 즉시 로드

---

## 7. 시각 / 톤

**레퍼런스 (스크린샷 확인)**:
- **라이트 테마** (흰 배경, 옅은 격자선)
- 좌측 사이드바: 배치 객체 팔레트 + 하단에 Select/Move, Pan/Navigate, Delete 도구
- 상단 바: Clear / Export PNG / Export Text / Import Text / Samples / Width·Height 입력 / Resize
- 캔버스 하단: Blue/Green/Valid/Invalid 색 범례
- 객체: 단색 사각형(예: Pitfall = 갈색) + 텍스트 라벨, Banner 는 작은 노란 사각형 + "B" 글자
- 다이아 회전 없음(원본은 평면) — 우리는 §2 의 옵션 A 로 회전 적용

**우리 선택**: 라이트/다크 추후 결정. 일단 placeholder 의 다크(`#0f1216`)는 갈아엎을 수 있다고 가정.

---

## 8. MVP 범위 / 단계

### MVP (단일 HTML 파일, 의존성 0)
- [ ] 격자 렌더링 + Resize
- [ ] 7종 객체 팔레트 → 클릭 후 캔버스 클릭으로 배치
- [ ] Select/Move/Delete
- [ ] Blue/Green 영역 하드코딩(고정 좌표)으로 시작
- [ ] Export/Import Text (JSON)
- [ ] Clear
- [ ] Export PNG (`canvas.toBlob`)

### 후속
- [ ] Sample Layouts (3~5개 프리셋)
- [ ] 영역(zone) 자체도 사용자가 그리기/조정 가능하게
- [ ] URL 공유(쿼리스트링 base64)
- [ ] 모바일 터치 최적화
- [ ] (우리 프로젝트 한정 가산점) 다국어 ko/en, 가이드 페이지로 임베드

---

## 9. 레퍼런스에 없어 생각해볼 것 (우리가 더 넣을 수 있는 것)

- **곰덫 영향권 시각화** — 3×3 곰덫 주변 N칸을 반투명 오버레이로 표시
- **합류 시간(march time) 계산기** — 깃발/요새 위치에서 곰덫까지의 거리 → 평균/최장 합류 시간
- **레이어**: 영역(zone) 레이어 / 객체 레이어 / 라벨 레이어 토글
- **R4/R5 메모** — 객체별 담당자 닉네임 라벨
- **연맹 멤버 수 기반 자동 배치 추천** (members 테이블 연동)

> 위 항목들은 본 기획서 다듬기 단계에서 우리 프로젝트 맥락에 맞춰 선별/추가 예정.

---

## 10. 결정 로그 (대화 누적)

> 사용자와의 대화에서 확정된 결정사항을 시간순으로 기록. 본문 섹션에 반영하면서 여기에도 한 줄 요약 남김.

- **2026-05-06** — 격자 표시는 **옵션 A (CSS `rotate(45deg)`)** 로 다이아 형태. 게임처럼 2:1 isometric(옵션 B)까지는 마킹 용도라 불필요. → §2 반영
- **2026-05-06** — 기본 격자 **80×80** 확정 (레퍼런스 스크린샷 기준). → §2 반영
- **2026-05-06** — Banner 배치 시 주변에 Blue 영역(연맹 영토) 자동 펼침 — 레퍼런스 스크린샷에서 관찰. 정확한 펼침 반경은 추후 확인. → §3 반영
- **2026-05-06** — 레퍼런스는 라이트 테마. 우리 테마(라이트/다크)는 미정. → §7 반영
- **2026-05-06** — **MVP 1차 구현 완료** (`index.html`, 단일 파일, 의존성 0). 포함된 것:
  - 80×80 기본 격자 + 다이아 회전(CSS rotate 45°)
  - 좌측 7종 팔레트 + Select/Move/Pan/Delete 도구, 상단 툴바, 하단 범례 (레퍼런스 1:1)
  - 클릭으로 객체 배치, 드래그로 이동, Delete 도구로 삭제
  - Banner 배치 시 7×7 Blue 영역 자동 생성 (반경 3, 임시값)
  - Green 영역: 25,25,30×30 직사각형 1개 하드코딩 (게임 실제 모양은 추후)
  - Valid/Invalid placement ghost (클릭 전 hover 시 초록/빨강 외곽선)
  - Export Text(JSON) / Import Text / Export PNG (회전 반영) / Samples 3종 / Resize / Clear
  - 라벨 직립: 객체 자식 `<span>` 에 `rotate(-45deg)` 상쇄
  - 좌표 변환: `getBoundingClientRect` 중심 + 역회전(-45°)으로 clientX/Y → 셀 좌표
- **2026-05-06** — **배치 규칙 정정 (옵션 A 엄격 모드)**:
  - `tc` 'any' → **'blue'** (도시 중심도 연맹 영역 안에서만, Green 제거 시 회귀 fix)
  - `hq` 'blue' → **'any'** (HQ 가 자기 영역을 만드는데 'blue' 강제하면 첫 HQ 못 놓는 모순. 깃발과 동일하게 자유)
  - 결과: 영역 생성기(깃발, HQ)는 어디든, 그 외(곰덫/TC/제분소)는 Blue 안에서만
- **2026-05-06** — **레퍼런스 소스코드 재분석** (script.js + sample-layouts.js 직접 다운로드 분석). 발견:
  1. **영역 생성 규칙 확정**: Banner = Blue 반경3 + Green 반경7, HQ = Blue 반경6 + Green 반경10, Blue 우선
  2. **배치 검증**: bounds + 겹침만 강제. Green/Blue 안인지는 **뱃지(✅/❌)로 표시만**, 거부 X
  3. **Town Center = 연맹원 마커**: 영역 생성 안 함, TC#N 자동 번호 + 6색 순환, 60~100개 가능
  4. **데이터 포맷**: P/T/B/M/H/X/Y 코드 → JSON → base64 → "code" 문자열
  5. **격자 범위**: 10~500 (현재 우리 10~200), 셀 20px (현재 16px)
  6. **샘플 5종**: Sample 1, Double Hunting Trap, Double Pitfall 1/2, KvK Castle Shield Wall — 모두 80×80 합류 hive
  → 현재 우리 구현과 큰 차이 7개. 다듬기 단계에서 어디까지 따라갈지 결정 필요.
- **2026-05-06** — **하드코딩된 Green(건설 가능) 영역 제거**. Green/Blue 는 게임 내 건축물의 효과 영역을 나타내는 색이지 임의 사각형이 아니라는 사용자 지적 반영.
  - `state.green` 필드 + 렌더링 + 검증 + Resize 보정 + Export/Import/PNG/Sample 데이터 모두 제거
  - `PLACEMENT` 단순화: `tc`/`banner` 가 'buildable'(green or blue) → 'any'. Pitfall/HQ/Mills 는 'blue' 유지(깃발이 만든 연맹 영역 안)
  - CSS `.zone.green` + 하단 범례 "건설 가능 (초록)" 은 보존 — 추후 도시 중심 등이 Green 효과를 만들 가능성 열어둠
- **2026-05-06** — **UI 전체 한국어화**. 게임 한국어 용어 적용: Pitfall→곰덫, Town Center→도시 중심, Banner→깃발, Alliance Mills→연맹 제분소, Alliance HQ→연맹 본부, Blocked Path→장애물. 코드 식별자(`pitfall`, `banner` 등)와 JSON 포맷 키는 호환성 위해 영어 유지. 코드 주석도 한국어로.
- **2026-05-06** — 임시 결정값 (다듬기 단계에서 검토 대상):
  - Banner Blue 반경 = 3 (= 7×7 펼침). 실제 게임 값 확인 필요
  - 배치 규칙: Pitfall/HQ/Mills = Blue only, TC/Banner = Green or Blue, Block = anywhere
  - 객체 배치 시 cursor cell 이 객체의 중앙(홀수 크기) 또는 좌하(짝수 크기) — 미세조정 여지
  - 레퍼런스의 Green 모양은 비정형 다각형. 우리는 단일 사각형으로 시작
