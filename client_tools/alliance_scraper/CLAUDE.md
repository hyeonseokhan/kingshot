# Alliance Scraper — 작업 지침

> 이 디렉토리(client_tools/alliance_scraper)에서 작업할 때 항상 따라야 하는 지침이다.
> Claude 가 본 목적에서 벗어나지 않게 하기 위한 가드레일.

## 본 목적

**RPA(ADB) + OCR 로 Kingshot 게임 화면을 캡처해 연맹원 로스터를 DB 와 동기화한다.**

수집 대상:
1. **kingshot_id** — 고유 식별자 (검수 단계에서 사용자 입력 또는 DB lookup)
2. **닉네임** — 게임 표시 닉
3. **전투력 (power)** — 정렬 / 매칭 기준
4. **랭크** — power 순위 (자동 계산, OCR 불필요)

## 흐름 (Hybrid 스크래핑)

게임 폰트가 다양한 유니코드 (Cherokee, 티베트, NBSP 등) 를 사용하기 때문에 OCR 만으로 100% 매칭 불가 →
**OCR + DB fuzzy 매칭 + 사용자 검수** 의 hybrid 패턴.

```
1) 게임 화면 자동 캡처 (overlap 스와이프)
       scripts/test_capture_loop.py --total N
2) OCR → (rank, nickname, power) 추출 + power 기반 dedup
       src/ranking_capture.py — collect_all_rows()
3) DB members 와 fuzzy 매칭 (정규화 + 가변 임계값)
       src/nickname_matcher.py
4) 검수 도구 (브라우저) 에서 사용자 직접 확인 + 보정
       scripts/run_review.py + scripts/static/review.html
       - 좌측 캡처 사진 / 우측 표 (인라인 편집)
       - kid 입력 → DB lookup 으로 닉 자동 채움
5) review.json → SQL 마이그레이션 생성 → 사용자가 supabase db push
       supabase/migrations/<ts>_resync_alliance_roster.sql
```

## 빠지지 말아야 할 함정 (이전에 빠진 적 있음)

- ❌ **phash 캐싱 / 시간 단축 시나리오** — 사용자가 "시간 단축은 무관, 정확도 100% 가 목표" 라 명시했음
- ❌ **avatar phash 의 hamming 거리 분석, dedup 정책 튜닝** 등 — 본 목적 외 우회로
- ❌ **OCR 만으로 100% 매칭 시도** — 유니코드 닉 (Cherokee, NBSP, 풀와이드) 은 OCR 로 못 잡음.
       사용자 검수 단계가 필수. 자동화로 우회 시도 금지.
- ❌ **새 알고리즘 / 도구 도입을 사용자 확인 없이 시작** — 의사결정 점만 빠르게 짚고 사용자 신호 받기

이런 작업이 시작되려는 자기 자신을 발견하면 **즉시 멈추고 사용자에게 본 목적 재확인** 한다.

## 진행 원칙

1. **사용자가 게임 화면 보고 검증 가능한 출력** — 코드 결과와 사용자가 직접 본 게임 화면이 비교 가능해야 한다.
2. **짧은 호흡** — 한 번의 측정 → 결과 보고 → 다음 의사결정. 큰 스크립트로 한 번에 모든 걸 검증하지 않는다.
3. **production 적용은 사용자가 직접** — `supabase db push` 는 사용자가 실행. Claude 는 마이그레이션 SQL 만 작성.
4. **anon key 만 사용** — 자동 DB write 안 함. 검수 + 수동 마이그레이션 패턴 유지.

## 코드 위치

### src/
- `adb.py` — ADB 연결 / 캡처 / 스와이프
- `config.py` — config.json 로드 + CAPTURES_DIR 정의
- `db_client.py` — Supabase REST API anon key 로 members fetch
- `kr_ocr.py` — EasyOCR (한글+영문 닉네임용)
- `ocr.py` — RapidOCR (영문/숫자, rank+power 컬럼용)
- `nickname_matcher.py` — fuzzy 매칭 (difflib SequenceMatcher) + 가변 임계값
- `ranking_capture.py` — **핵심 모듈**. row 추출 + overlap 캡처 루프 + power 기반 dedup

### scripts/
- `dump_members.py` — DB → `members.json` (검수 시 reference + lookup 용)
- `test_capture_one.py` — 한 화면 캡처 + OCR (Phase 1 검증)
- `test_capture_match.py` — 한 화면 + OCR + DB 매칭 (Phase 2 검증)
- `test_capture_loop.py` — **메인 entry**. 캡처 루프 + DB 매칭 + `captures/review.json` 저장
- `run_review.py` — 검수 도구 미니 서버 (stdlib http.server, port 4000)
- `static/review.html` — 검수 도구 UI (단일 파일, 자체 포함)

## 환경

- ADB: `D:\LDPlayer\LDPlayer9\adb.exe`, serial `emulator-5554`
- venv: `.venv/Scripts/python.exe`
- 게임: `com.run.tower.defense` (Kingshot)
- 화면 해상도: 900×1600
- LDPlayer "로컬 디버깅" 켜져 있어야 함

## 표준 작업 흐름 (한 번 사이클)

```bash
# 1. DB 의 현재 멤버 dump (검수 lookup 용)
.venv/Scripts/python.exe scripts/dump_members.py

# 2. LD 플레이어에서 '연맹 → 전투력 랭킹' 화면 최상단으로 스크롤

# 3. 캡처 루프 실행 (자동 cleanup → 새 캡처만 남음)
.venv/Scripts/python.exe scripts/test_capture_loop.py --total <연맹원 수>

# 4. 검수 도구 실행 (브라우저 자동 오픈)
.venv/Scripts/python.exe scripts/run_review.py
#  → 좌측 사진 보며 우측 표 검수 / 빈 kid 입력 / 누락 row 추가
#  → 저장 버튼 → captures/review.json 갱신

# 5. review.json → SQL 마이그레이션 생성 (Claude 가 작성)
#    탈퇴/신규/잔류 분석 + DELETE/INSERT...ON CONFLICT 패턴
#    파일: supabase/migrations/<ts>_resync_alliance_roster.sql

# 6. 사용자가 production 적용
cd ../..
supabase db push
```

## 산출물 위치 (gitignore)

- `captures/loop_*.png` + `captures/review.json` — 캡처 + 검수 데이터
- `members.json` — DB dump (kingshot_id 민감)
- 매번 `test_capture_loop.py` 실행 시 자동 cleanup (--keep 으로 보존 가능)
