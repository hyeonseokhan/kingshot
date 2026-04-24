"""Extract per-row data (rank, power, avatar hash) from a ranking screenshot."""
from __future__ import annotations

from dataclasses import dataclass

import imagehash
from PIL import Image

from . import ocr


@dataclass(frozen=True)
class RowObservation:
    rank: int | None
    power: int
    avatar_phash: str
    row_cy: int
    is_pinned: bool


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

        observations.append(
            RowObservation(
                rank=rank,
                power=power,
                avatar_phash=phash,
                row_cy=row_cy,
                is_pinned=is_pinned,
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
