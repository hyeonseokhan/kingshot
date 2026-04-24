"""Crop rank 1/2/3 medal icons from a known-good ranking screenshot.

Assumes the input image has rank 1 centered at y=376, rank 2 at y=545, rank 3 at
y=713, with the rank column on the left. Writes PNGs to assets/.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image

from src import config


RANK_COL_X = (25, 160)  # horizontal band of the rank column


def main() -> int:
    source = config.PROBE_DIR / "ranking_top.png"
    if not source.exists():
        print(f"[!] {source} not found")
        return 1
    img = Image.open(source).convert("RGB")

    assets = config.PROJECT_ROOT / "assets"
    assets.mkdir(exist_ok=True)

    regions = config.load()["regions"]
    first = regions["first_row_y"]
    h = regions["row_height"]
    half = regions["row_half_height"]

    for rank, cy in [(1, first), (2, first + h), (3, first + 2 * h)]:
        y0 = cy - half + 10
        y1 = cy + half - 10
        x0, x1 = RANK_COL_X
        crop = img.crop((x0, y0, x1, y1))
        out = assets / f"rank_{rank}.png"
        crop.save(out)
        print(f"  rank {rank}: cropped ({x0},{y0})-({x1},{y1}) size={crop.size} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
