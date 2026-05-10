# Kingshot Troops Calculator — 온보딩

> 출처: <https://www.kingshotguide.org/calculator/troops-calculator>
> 분석일: 2026-05-10

---

## 1. 한 줄 요약

**Bear Hunt(10/10/80)와 Vikings(60/40/0) 부대 편성을 계산해주고, 목표 비율 대비 부족한 병력 수까지 알려주는 계산기.**

플레이어가 가진 총 병력(보병/기병/궁병)과 1부대 수용량을 입력하면, 4부대(Bear) 또는 3부대(Vikings)에 어떻게 분배해야 하는지를 즉시 계산해준다. 동시에 "이 컨텐츠를 풀로 돌리려면 어떤 병종이 몇 명 더 필요한지" 갭을 보여줘서 훈련 우선순위 결정에 쓴다.

---

## 2. 입력 (Inputs)

좌측 상단에 4개 숫자 입력. 단위는 모두 명(병력 수).

| 라벨 | 의미 | 예시값 |
|---|---|---|
| **Solo Squad Capacity** (`mySquad`) | 한 부대의 최대 병력 수용량 (요새/연구 등으로 결정) | 325,156 |
| **Total Infantry** | 보유한 총 보병 수 | 62,892 |
| **Total Cavalry** | 보유한 총 기병 수 | 62,892 |
| **Total Archers** | 보유한 총 궁병 수 | 443,056 |

> **공식**: 목표 병력 = `mySquad × ratio × 부대수`
> 예) 4부대 Bear, 1부대 32만 수용 → 궁병 목표 = 325,156 × 0.8 × 4 ≈ **1,040,499**

---

## 3. 출력 (Outputs)

### 3-1. Bear Split (4개 부대, 10/10/80)

각 부대마다 다음을 표로 보여준다:

- **Infantry / Cavalry / Archers** 각 부대 분배량
- **Used** — 실제 배치된 병력 합
- **Supply** — 부대 수용량 (= mySquad)
- **Unused** — 남은 슬롯 (수용량 - Used)

### 3-2. Vikings Split (3개 부대, 60/40/0)

같은 형식이지만 **궁병은 0으로 고정**, 보병/기병만 분배.

### 3-3. Training Focus (훈련 갭 분석)

세 가지 프리셋에 대해 "현재 보유량으로 부대를 가득 채우려면 얼마나 더 훈련해야 하는가"를 보여준다.

| 프리셋 | 비율(I/C/A) | 예시 출력 (위 입력값 기준) |
|---|---|---|
| Balanced | 50/20/30 | 부족 0/0/0 |
| Bear | 10/10/80 | 궁병 12,018 부족 |
| Vikings | 60/40/0 | 보병 16,148 / 기병 3,380 부족 |

> 모든 출력은 **정수**로 반올림 (게임 내 배치 단위와 일치).

---

## 4. 사용 흐름 (Step-by-step)

1. **(좌측 상단)** Solo Squad Capacity, Infantry, Cavalry, Archers 입력
2. **프리셋 선택** — Bear (10/10/80) 또는 Vikings (60/40/0) 클릭
3. **Squads 슬라이더** 조정 (1~6) — 보낼 부대 수 변경
4. **분배 결과 확인** — 각 부대의 I/C/A 배치량과 Unused 빈자리 확인
5. **Training Focus 확인** — 어떤 병종이 부족한지 체크리스트로 활용

---

## 5. 부가 기능

- **프리셋 토글**: Bear Preset / Vikings Preset 원클릭 전환
- **부대 수 슬라이더**: Bear Squads (1~6), Viking Squads 별도 조정 가능
- **Custom Ratios**: 프리셋 외 임의 비율 입력 가능 (자유 비율 시나리오)
- **Strict Total Conservation 토글**: 분배 시 입력 총합을 엄격히 보존할지 옵션
- **Reset to 10/10/80**: 비율을 Bear 기본으로 즉시 복원

---

## 6. 사이트가 명시한 팁/주의사항

**Quick Start (원문)**
> "Top-left: input your Solo Squad Capacity, total Infantry, total Cavalry, and total Archers."

**Practical Tips (원문)**
> - "Before rallies, open the kingshot troop calc and confirm the archer cap."
>   → **연합전(rally) 전에 궁병 cap을 반드시 확인.**
> - "During Vikings, rerun the kingshot troop calc after each training session."
>   → **Vikings 컨텐츠 진행 중엔 훈련 한 번 끝낼 때마다 재계산.**
> - "Use training gaps as a checklist; aim for zeros across the board."
>   → **Training Focus 의 갭이 모두 0이 되는 걸 훈련 목표로.**

**기술 노트**
> - "All outputs are integers to match in-game deployment." (정수 반올림)
> - "Targets are computed as (mySquad × ratio × 4)." (계산식 공개)

---

## 7. 게임 내 활용 시나리오

| 상황 | 어떻게 쓰나 |
|---|---|
| **Bear Hunt 출진 직전** | 4부대 10/10/80 분배가 가능한지 / 빈자리(Unused)가 얼마나 나오는지 즉시 확인 |
| **Vikings 출진 직전** | 3부대 60/40/0 으로 보병·기병 부족분 점검 |
| **훈련 우선순위 결정** | Training Focus 갭이 가장 큰 병종부터 훈련 (예: 궁병 12k 부족 → 궁병 우선) |
| **요새 업그레이드 후** | mySquad 늘어났을 때 새 cap 기준으로 모든 컨텐츠 재계산 |
| **연합전(rally) 직전** | 궁병 cap 도달 여부 빠른 점검 |

---

## 8. 사이트 내 동반 도구 (네비게이션)

- 📖 Guides — 가이드
- 🎁 Gift Codes — 기프트 코드
- ⚔️ Heroes — 영웅 정보
- 🏰 Buildings — 건물 정보
- 📊 Data Center — 데이터 센터
- 🧮 **Calculator** (이 도구가 속한 카테고리)

---

## 9. 우리 프로젝트 입장에서의 시사점 (참고)

bear-trap-planner 와는 **목적이 다름**:

- 이 사이트의 troops-calculator는 **"내 병력을 부대에 어떻게 나눌까"** (병력 → 부대 분배)
- 우리 bear-trap-planner는 **"곰덫 주변에 어떤 시설을 어디에 둘까"** (지도 위 시설 배치)

다만 공통적으로 차용할 만한 UX 패턴:
- **프리셋 + 슬라이더 + Custom 토글** 조합 (10/10/80 같은 표준값을 기본으로 두고 임의 조정 허용)
- **목표 대비 갭 표시** (Training Focus 처럼 "현재 상태 - 목표" 차이를 한눈에)
- **정수 반올림 + 입력 합 보존** 같은 신뢰성 안내문 명시
