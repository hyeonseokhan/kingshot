"""랭킹 화면 캡처에서 (rank, nickname, power) 추출 — Hybrid 스크래핑 핵심 모듈.

기존 src/rows.py 와 의도적으로 분리:
  - avatar_phash, role badge, popup detail 등 잔재 일체 import 안 함
  - OCR-only 흐름. rank/nickname/power 만 추출.

가드레일:
  - 1·2·3 위는 메달 아이콘이라 rank OCR 못 함 → rank=None
  - power OCR 실패 시 power=None
  - nickname OCR 실패 시 nickname_raw=""
  - 한 row 의 세 값 중 power 가 가장 정확도 높음 (숫자만) → 기준 신호로 활용
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image

from . import adb, kr_ocr, ocr


@dataclass
class OcrRow:
    """랭킹 화면의 한 행 OCR 결과. avatar_phash 없음 (의도적)."""

    rank: int | None         # 1·2·3 위 메달이면 None, 4 이후 OCR 숫자
    rank_conf: float         # rank OCR 신뢰도 (None 이면 0)
    nickname_raw: str        # OCR 원본 (정규화 전)
    nickname_conf: float
    power: int | None        # 전투력 OCR (콤마 제거된 정수)
    power_conf: float
    row_cy: int              # 화면 y 좌표 (overlap dedup 용)
    is_pinned: bool          # 본인(하단 고정) 행 여부
    source_capture: str | None = None  # 이 row 가 추출된 캡처 파일명 (검수 도구 연결용)


# ============================================================
# 행 좌표 계산
# ============================================================


def row_centers(
    first_row_y: int,
    row_height: int,
    rows_per_screen: int,
) -> list[int]:
    """첫 행 y + (행 간격 × i) 로 각 행의 중심 y 좌표 반환."""
    return [first_row_y + row_height * i for i in range(rows_per_screen)]


# ============================================================
# 컬럼별 OCR 추출
# ============================================================

_RANK_DIGITS_RE = re.compile(r"\d+")


def extract_rank(
    screen: Image.Image,
    row_cy: int,
    row_half_height: int,
    rank_col_x: tuple[int, int],
) -> tuple[int | None, float]:
    """rank 컬럼 OCR. 1·2·3 위는 메달 아이콘이라 보통 None.

    Returns: (rank_int | None, confidence). 추출 실패 시 (None, 0.0).
    """
    x0, x1 = rank_col_x
    y0 = max(0, row_cy - row_half_height)
    y1 = row_cy + row_half_height
    hits = ocr.detect_region(screen, x0, y0, x1, y1)
    for h in hits:
        m = _RANK_DIGITS_RE.search(h.text)
        if m:
            try:
                return int(m.group()), h.conf
            except ValueError:
                continue
    return None, 0.0


def extract_power(
    screen: Image.Image,
    row_cy: int,
    row_half_height: int,
    power_col_x: tuple[int, int],
    power_min: int = 100_000,
) -> tuple[int | None, float]:
    """전투력 컬럼 OCR. 콤마 제거된 정수 반환.

    Returns: (power | None, confidence).
    """
    x0, x1 = power_col_x
    y0 = max(0, row_cy - row_half_height)
    y1 = row_cy + row_half_height
    hits = ocr.detect_region(screen, x0, y0, x1, y1)
    best: tuple[int, float] | None = None
    for h in hits:
        v = ocr.parse_commafied_int(h.text)
        if v is None or v < power_min:
            continue
        if best is None or h.conf > best[1]:
            best = (v, h.conf)
    if best is None:
        return None, 0.0
    return best


def extract_nickname(
    screen: Image.Image,
    row_cy: int,
    row_half_height: int,
    nickname_col_x: tuple[int, int],
) -> tuple[str, float]:
    """닉네임 컬럼 OCR (한글+영문 혼용 → EasyOCR).

    Returns: (raw_text, confidence). 실패 시 ("", 0.0).
    """
    x0, x1 = nickname_col_x
    y0 = max(0, row_cy - row_half_height)
    y1 = row_cy + row_half_height
    crop = screen.crop((x0, y0, x1, y1))
    # kr_ocr.read_first_text 가 best 1개만 반환 — 여러 line 있으면 longest
    # min_conf 낮게 (0.2) 잡고 raw 반환 → 매칭 단계에서 신뢰도 함께 쓰임
    texts = kr_ocr.read_all_texts(crop, min_conf=0.2)
    if not texts:
        return "", 0.0
    # 가장 긴 텍스트 (닉네임은 보통 한 줄, 가장 긴 게 본문)
    best = max(texts, key=lambda t: len(t[0]))
    return best[0].strip(), best[1]


# ============================================================
# 한 캡처 → 모든 행 OCR
# ============================================================


def extract_rows_from_screen(
    screen: Image.Image,
    cfg_regions: dict,
    nickname_col_x: tuple[int, int] | None = None,
    source_capture: str | None = None,
) -> list[OcrRow]:
    """캡처 1장에서 각 행의 (rank, nickname, power) 추출.

    cfg_regions: config.json 의 ["regions"] 딕셔너리.
    nickname_col_x: 닉네임 컬럼 x 범위. 미지정 시 avatar_col_x 끝 ~ power_col_x 시작 간격 자동.

    is_pinned 는 본인 행 (하단 pinned_own_y 근처) 식별용 — 검증 시 분리 표시.
    """
    first_row_y = cfg_regions["first_row_y"]
    row_height = cfg_regions["row_height"]
    rows_per_screen = cfg_regions["rows_per_screen"]
    row_half_height = cfg_regions["row_half_height"]
    power_col_x = tuple(cfg_regions["power_col_x"])
    avatar_col_x = tuple(cfg_regions["avatar_col_x"])
    pinned_own_y = cfg_regions["pinned_own_y"]
    power_min = cfg_regions.get("power_min", 100_000)

    # rank 컬럼: 화면 좌측 (avatar 시작 전 영역)
    rank_col_x = (0, avatar_col_x[0])
    # 닉네임 컬럼: avatar 끝 ~ power 시작 사이
    if nickname_col_x is None:
        nickname_col_x = (avatar_col_x[1] + 5, power_col_x[0] - 5)

    centers = row_centers(first_row_y, row_height, rows_per_screen)
    # 본인(pinned) 행도 같이 추가
    centers_with_pinned = [(cy, False) for cy in centers] + [(pinned_own_y, True)]

    rows: list[OcrRow] = []
    for cy, pinned in centers_with_pinned:
        rank, rank_conf = extract_rank(screen, cy, row_half_height, rank_col_x)
        power, power_conf = extract_power(
            screen, cy, row_half_height, power_col_x, power_min
        )
        nick_raw, nick_conf = extract_nickname(
            screen, cy, row_half_height, nickname_col_x
        )

        # 빈 행 (모두 실패) 은 스킵 — 화면 끝 또는 로딩 중
        if rank is None and power is None and not nick_raw:
            continue

        rows.append(
            OcrRow(
                rank=rank,
                rank_conf=rank_conf,
                nickname_raw=nick_raw,
                nickname_conf=nick_conf,
                power=power,
                power_conf=power_conf,
                row_cy=cy,
                is_pinned=pinned,
                source_capture=source_capture,
            )
        )
    return rows


# ============================================================
# Phase 3 — Overlap 캡처 루프 + dedup
# ============================================================


def _row_quality(r: OcrRow) -> float:
    """OCR 신뢰도 합산. dedup 시 더 높은 쪽 채택."""
    score = (r.rank_conf or 0) + (r.power_conf or 0) + (r.nickname_conf or 0)
    # power 가 None 인 행은 사실상 쓸모 없음 (잘림 가능성 높음) → 강한 페널티
    if r.power is None:
        score -= 10.0
    if not r.nickname_raw:
        score -= 5.0
    return score


@dataclass
class CaptureLoopResult:
    """Phase 3 루프 결과.

    primary key 는 power (OCR 정확도 가장 높음). rank 는 row 의 attribute.
    같은 rank 가 서로 다른 power 두 row 에 등장하면 rank_conflicts 에 기록.
    """

    rows_by_power: dict[int, OcrRow]  # power → 최고 품질 OcrRow (정수 power 키)
    medal_rows: list[OcrRow]  # rank=None (1·2·3위 메달) — 첫 캡처에서만 수집
    pinned: OcrRow | None
    rank_conflicts: list[tuple[int, list[OcrRow]]]  # (rank, [row1, row2, ...]) — 같은 rank 다른 power
    captures_saved: list[Path]
    captures_count: int
    stop_reason: str  # "target_reached" / "no_progress" / "timeout" / "max_captures"


def _is_same_power(p1: int, p2: int, tolerance: float = 0.001) -> bool:
    """power 두 값이 같은 사람으로 볼 만한지 (±0.1% 이내). 0 또는 None 은 비교 X."""
    if not p1 or not p2:
        return False
    return abs(p1 - p2) / max(p1, p2) < tolerance


def collect_all_rows(
    dev: adb.Device,
    cfg: dict,
    target_total: int,
    captures_dir: Path,
    max_captures: int = 30,
    no_progress_retries: int = 2,
    timeout_seconds: float = 600.0,
    save_prefix: str = "loop",
    verbose: bool = True,
) -> CaptureLoopResult:
    """랭킹 화면 최상단부터 스크롤하며 모든 행 수집 (power 기반 dedup).

    전제: 호출 전 화면이 랭킹 최상단에 있어야 함.

    Dedup 정책 (rank OCR 오류 안전):
      - primary key = power (정확도 최고)
      - 같은 power (±0.1%) 면 같은 사람 → quality 높은 쪽 채택
      - rank 는 row.rank attribute 로만 저장 (덮어쓰기 X)
      - 결과 정리 단계에서 같은 rank 가 다른 power 에 등장하면 rank_conflicts 에 기록
      - 1·2·3 위 메달 (rank=None) 은 첫 캡처에서만 별도 list 로 수집
    """
    regions = cfg["regions"]
    scroll = regions["scroll"]
    sx1, sy1 = scroll["from"]
    sx2, sy2 = scroll["to"]
    duration_ms = scroll["duration_ms"]

    rows_by_power: dict[int, OcrRow] = {}
    medal_rows: list[OcrRow] = []
    pinned: OcrRow | None = None
    captures_saved: list[Path] = []
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    no_progress = 0
    started = time.monotonic()
    stop_reason = "max_captures"

    captures_dir.mkdir(parents=True, exist_ok=True)

    for capture_idx in range(max_captures):
        if time.monotonic() - started > timeout_seconds:
            stop_reason = "timeout"
            break

        screen = dev.screencap()
        path = captures_dir / f"{save_prefix}_{timestamp}_{capture_idx:02d}.png"
        screen.save(path)
        captures_saved.append(path)

        ocr_rows = extract_rows_from_screen(screen, regions, source_capture=path.name)
        new_unique = 0
        for r in ocr_rows:
            if r.is_pinned:
                if pinned is None or _row_quality(r) > _row_quality(pinned):
                    pinned = r
                continue

            # 메달 (1·2·3위) — 첫 캡처에서만 수집 (스크롤 후엔 안 보임)
            if r.rank is None and r.power is None:
                continue  # 노이즈
            if r.rank is None:
                if capture_idx == 0 and r.power:
                    # power 가 medal_rows 에 이미 있으면 quality 비교
                    found = False
                    for i, existing in enumerate(medal_rows):
                        if _is_same_power(existing.power or 0, r.power):
                            if _row_quality(r) > _row_quality(existing):
                                medal_rows[i] = r
                            found = True
                            break
                    if not found:
                        medal_rows.append(r)
                        new_unique += 1
                continue

            # rank 있는 일반 row — power 가 None 이면 dedup 불가 (잘림 위험) → 스킵
            if r.power is None:
                continue

            # power 기반 dedup
            existing_key = next(
                (k for k in rows_by_power if _is_same_power(k, r.power)),
                None,
            )
            if existing_key is None:
                rows_by_power[r.power] = r
                new_unique += 1
            elif _row_quality(r) > _row_quality(rows_by_power[existing_key]):
                rows_by_power[existing_key] = r

        accumulated = len(rows_by_power) + len(medal_rows)
        if verbose:
            print(
                f"[capture {capture_idx + 1:>2}] new={new_unique:>2} "
                f"accumulated={accumulated:>3}/{target_total} "
                f"-> {path.name}"
            )

        if accumulated >= target_total:
            stop_reason = "target_reached"
            break

        if new_unique == 0:
            no_progress += 1
            if no_progress > no_progress_retries:
                stop_reason = "no_progress"
                break
        else:
            no_progress = 0

        dev.swipe(sx1, sy1, sx2, sy2, duration_ms=duration_ms)
        time.sleep(0.6)

    # rank conflict 검출 — 같은 rank 가 서로 다른 power 두 row 에 등장하면 의심 (OCR 오류)
    by_rank: dict[int, list[OcrRow]] = {}
    for r in rows_by_power.values():
        if r.rank is None:
            continue
        by_rank.setdefault(r.rank, []).append(r)
    rank_conflicts = [(rk, rows) for rk, rows in by_rank.items() if len(rows) > 1]

    return CaptureLoopResult(
        rows_by_power=rows_by_power,
        medal_rows=medal_rows,
        pinned=pinned,
        rank_conflicts=rank_conflicts,
        captures_saved=captures_saved,
        captures_count=len(captures_saved),
        stop_reason=stop_reason,
    )
