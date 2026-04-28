"""Extract per-row data (rank, power, avatar hash, alliance role) from a ranking screenshot."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import cv2
import imagehash
import numpy as np
from PIL import Image

from . import config as cfg_mod
from . import ocr


@dataclass(frozen=True)
class RowObservation:
    rank: int | None
    power: int
    avatar_phash: str
    row_cy: int
    is_pinned: bool
    alliance_role: str | None = None  # "R1"~"R5" 또는 None


# ===== R1~R5 등급 배지 매칭 =====

ROLE_MATCH_THRESHOLD = 0.65
ROLE_NMS_RADIUS = 30
ROLE_SCALE_PCTS = (140, 160, 180, 200)
ROLE_BADGE_X_MAX = 350  # 화면 좌측 1/3 영역 — 배지 위치 한정
ROLE_VERTICAL_TOLERANCE = 50


@lru_cache(maxsize=8)
def _load_role_template(rank: int) -> np.ndarray | None:
    path = cfg_mod.PROJECT_ROOT / "assets" / f"R{rank}.png"
    if not path.exists():
        return None
    pil = Image.open(path).convert("RGB")
    return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)


def match_role_badges(screen: Image.Image) -> list[tuple[int, float, int, int]]:
    """전체 화면에서 R1~R5 배지 위치 탐지. (rank, score, cx, cy) 리스트."""
    screen_bgr = cv2.cvtColor(np.asarray(screen.convert("RGB")), cv2.COLOR_RGB2BGR)
    H, W = screen_bgr.shape[:2]
    all_hits: list[tuple[int, float, int, int]] = []

    for rank in range(1, 6):
        tpl = _load_role_template(rank)
        if tpl is None:
            continue
        per_rank: list[tuple[float, int, int]] = []
        for scale_pct in ROLE_SCALE_PCTS:
            new_w = tpl.shape[1] * scale_pct // 100
            new_h = tpl.shape[0] * scale_pct // 100
            if new_h >= H or new_w >= W:
                continue
            scaled = cv2.resize(tpl, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
            res = cv2.matchTemplate(screen_bgr, scaled, cv2.TM_CCOEFF_NORMED)
            ys, xs = np.where(res >= ROLE_MATCH_THRESHOLD)
            for x, y in zip(xs, ys):
                per_rank.append((float(res[y, x]), int(x + new_w // 2), int(y + new_h // 2)))

        # NMS — 가까운 hit 중 최고 score 만 보존
        per_rank.sort(key=lambda h: -h[0])
        kept: list[tuple[float, int, int]] = []
        for score, cx, cy in per_rank:
            if any(abs(cx - k[1]) < ROLE_NMS_RADIUS and abs(cy - k[2]) < ROLE_NMS_RADIUS for k in kept):
                continue
            kept.append((score, cx, cy))
        for score, cx, cy in kept:
            all_hits.append((rank, score, cx, cy))

    return all_hits


def find_role_for_row(role_hits: list[tuple[int, float, int, int]], row_cy: int) -> str | None:
    """주어진 row 의 cy 와 가장 잘 맞는 R 등급. 없으면 None."""
    candidates = [
        (rank, score) for (rank, score, cx, cy) in role_hits
        if abs(cy - row_cy) < ROLE_VERTICAL_TOLERANCE and cx <= ROLE_BADGE_X_MAX
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda c: -c[1])
    return f"R{candidates[0][0]}"


def extract_rows(
    screen: Image.Image,
    *,
    first_row_y: int,
    row_height: int,
    rows_per_screen: int,
    row_half_height: int,
    power_col_x: tuple[int, int],
    avatar_col_x: tuple[int, int],
    pinned_own_y: int,
    power_min: int,
) -> list[RowObservation]:
    w, _h = screen.size
    hits = ocr.detect(screen)
    role_hits = match_role_badges(screen)

    # Find all power-score-like hits
    power_hits = []
    for hit in hits:
        if hit.conf < 0.5:
            continue
        value = ocr.parse_commafied_int(hit.text)
        if value is None or value < power_min:
            continue
        if hit.cx < w * 0.55 or hit.cx > w * 0.98:
            continue
        power_hits.append((hit, value))
    power_hits.sort(key=lambda p: p[0].cy)

    observations: list[RowObservation] = []
    for hit, power in power_hits:
        row_cy = hit.cy
        is_pinned = abs(row_cy - pinned_own_y) < 40

        # Avatar crop: same vertical band, avatar_col_x horizontal band
        ax0, ax1 = avatar_col_x
        ay0 = max(0, row_cy - row_half_height + 5)
        ay1 = row_cy + row_half_height - 5
        avatar = screen.crop((ax0, ay0, ax1, ay1))
        phash = str(imagehash.phash(avatar, hash_size=16))

        # Rank: find a small integer text roughly to the LEFT of avatar_col_x, same row
        rank = _find_rank_for_row(hits, row_cy, avatar_col_x[0])

        # Alliance role (R1~R5)
        alliance_role = find_role_for_row(role_hits, row_cy)

        observations.append(
            RowObservation(
                rank=rank,
                power=power,
                avatar_phash=phash,
                row_cy=row_cy,
                is_pinned=is_pinned,
                alliance_role=alliance_role,
            )
        )
    return observations


def _find_rank_for_row(hits: list[ocr.OCRHit], row_cy: int, max_x: int) -> int | None:
    best = None
    for hit in hits:
        if abs(hit.cy - row_cy) > 40:
            continue
        if hit.cx >= max_x:
            continue
        value = ocr.parse_commafied_int(hit.text)
        if value is None:
            continue
        if value < 1 or value > 9999:
            continue
        if best is None or hit.cx < best[0].cx:
            best = (hit, value)
    return best[1] if best else None
