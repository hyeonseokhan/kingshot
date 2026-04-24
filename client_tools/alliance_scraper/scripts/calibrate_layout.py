"""Offline calibration from ranking_top.png:
  - extract rank 1/2/3 icon templates into assets/
  - measure actual card height via row background color analysis
  - write results back into config.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import cv2
import numpy as np
from PIL import Image

from src import config


RANK_COL_X = (25, 160)


def measure_card_height(img_bgr: np.ndarray, row_cy: int) -> tuple[int, int, int]:
    """Return (card_top, card_bottom, card_height) by detecting horizontal gaps.

    A gap between cards is a horizontal strip with near-uniform bright background
    color. Scan rows above/below row_cy until hitting such a gap.
    """
    h = img_bgr.shape[0]
    # Use x range that avoids avatar and text: middle empty band between avatar and name
    x0, x1 = 140, 200  # narrow vertical strip inside the card but between avatar+name
    strip = img_bgr[:, x0:x1, :]
    # Per-row mean color
    row_mean = strip.mean(axis=1)  # (H, 3) BGR
    # Card background saturates in some channel; gap is near-uniform bright
    # Compute saturation proxy: max(channel) - min(channel)
    sat = row_mean.max(axis=1) - row_mean.min(axis=1)

    def is_gap(y: int) -> bool:
        return sat[y] < 18  # gaps are near-neutral

    # Walk up from row_cy to find top of card
    top = row_cy
    while top > 0 and not is_gap(top - 1):
        top -= 1
    # Walk down from row_cy to find bottom of card
    bottom = row_cy
    while bottom < h - 1 and not is_gap(bottom + 1):
        bottom += 1
    return top, bottom, bottom - top + 1


def main() -> int:
    source = config.PROBE_DIR / "ranking_top.png"
    if not source.exists():
        print(f"[!] {source} not found — capture a top ranking screenshot first")
        return 1

    img_pil = Image.open(source).convert("RGB")
    w, h = img_pil.size
    arr = np.asarray(img_pil)
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

    assets = config.PROJECT_ROOT / "assets"
    assets.mkdir(exist_ok=True)

    cfg = config.load()
    regions = cfg["regions"]
    first = regions["first_row_y"]
    row_h = regions["row_height"]
    half = regions["row_half_height"]

    # Extract rank 1/2/3 icon templates
    for rank, cy in [(1, first), (2, first + row_h), (3, first + 2 * row_h)]:
        y0 = cy - half + 10
        y1 = cy + half - 10
        x0, x1 = RANK_COL_X
        crop = img_pil.crop((x0, y0, x1, y1))
        out = assets / f"rank_{rank}.png"
        crop.save(out)
        print(f"  template rank {rank}: size={crop.size} -> {out.name}")

    # Measure card height for rank 1 (use this as canonical)
    top, bottom, card_h = measure_card_height(bgr, first)
    print(f"\n[card] rank 1 row: top={top}  bottom={bottom}  height={card_h}")

    # Also measure rank 4 (regular white-ish card) as cross-check
    top4, bot4, h4 = measure_card_height(bgr, first + 3 * row_h)
    print(f"[card] rank 4 row: top={top4}  bottom={bot4}  height={h4}")

    # Use the more conservative (smaller) height for safety
    measured = min(card_h, h4)
    card_top_offset = first - top      # how far above row_cy the card extends
    card_bot_offset = bottom - first   # how far below row_cy

    # Persist
    regions["card_height"] = measured
    regions["card_top_offset"] = card_top_offset
    regions["card_bottom_offset"] = card_bot_offset
    cfg["regions"] = regions
    config.save(cfg)
    print(
        f"\n[saved] card_height={measured}  top_offset={card_top_offset}  "
        f"bot_offset={card_bot_offset}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
