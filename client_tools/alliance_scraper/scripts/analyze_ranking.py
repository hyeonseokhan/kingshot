"""Analyze ranking screenshot using OCR bboxes to derive row layout.

Strategy: locate all numbers that look like 'power scores' (>=1e6) by OCR bbox,
then each such number's y-center anchors one row. From row y-centers we derive:
  - row height (avg gap)
  - per-row vertical span (y0..y1)
  - power column x range (min/max x0..x1 across detected power values)
  - avatar crop region (row y-span, left ~15-30% of screen)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image, ImageDraw

from src import config, ocr


POWER_MIN = 1_000_000  # any member's power should exceed this


def main() -> int:
    path = config.PROBE_DIR / "ranking_top.png"
    pil = Image.open(path).convert("RGB")
    w, h = pil.size
    print(f"[img] {path.name}  {w}x{h}")

    hits = ocr.detect(pil)
    print(f"[ocr] {len(hits)} total detections")

    # Extract power-score-like numbers (>=1M, with comma-ish formatting)
    power_hits = []
    for hit in hits:
        if hit.conf < 0.5:
            continue
        value = ocr.parse_commafied_int(hit.text)
        if value is None or value < POWER_MIN:
            continue
        # heuristic: power numbers are on the right side
        if hit.cx < w * 0.55:
            continue
        power_hits.append((hit, value))

    power_hits.sort(key=lambda p: p[0].cy)
    print(f"\n[power] {len(power_hits)} candidates:")
    for hit, value in power_hits:
        print(f"  y={hit.cy:4d}  x=[{hit.x0}..{hit.x1}]  conf={hit.conf:.2f}  value={value:>14,}  text={hit.text!r}")

    if len(power_hits) < 2:
        print("[!] not enough power rows detected")
        return 1

    # Row metrics
    ys = [h.cy for h, _ in power_hits]
    gaps = [ys[i + 1] - ys[i] for i in range(len(ys) - 1)]
    print(f"\n[row metric] y gaps between consecutive rows: {gaps}")
    avg_gap = sum(gaps) / len(gaps)
    print(f"[row metric] avg gap: {avg_gap:.1f}  -> row height estimate")

    # Detect the pinned 'own rank' row at bottom: its y-gap to previous row will be much larger
    main_ys = [ys[0]]
    for i, g in enumerate(gaps):
        if g > avg_gap * 1.7:
            print(f"[own row] large gap detected before y={ys[i+1]} (gap={g}) -> pinned/own row")
            break
        main_ys.append(ys[i + 1])
    print(f"[main rows] y-centers of top-list rows: {main_ys}")

    # Power column x range
    power_x0 = min(h.x0 for h, _ in power_hits)
    power_x1 = max(h.x1 for h, _ in power_hits)
    print(f"\n[power col] x range: {power_x0}..{power_x1}")

    # Derive row vertical span
    inner_gap = int(sum(main_ys[i+1] - main_ys[i] for i in range(len(main_ys) - 1)) / max(1, len(main_ys) - 1))
    row_half = inner_gap // 2
    print(f"[row span] half-height: {row_half}")

    # Render overlay for visual verification
    overlay = pil.copy()
    draw = ImageDraw.Draw(overlay)
    for hit, value in power_hits:
        color = (255, 0, 0) if hit.cy in main_ys else (0, 120, 255)
        draw.rectangle((hit.x0, hit.y0, hit.x1, hit.y1), outline=color, width=3)
    for cy in main_ys:
        draw.line([(0, cy - row_half), (w, cy - row_half)], fill=(0, 200, 0), width=2)
        draw.line([(0, cy + row_half), (w, cy + row_half)], fill=(0, 200, 0), width=2)
        # avatar crop area: left ~15-30% horizontal
        draw.rectangle(
            (int(w * 0.15), cy - row_half + 5, int(w * 0.30), cy + row_half - 5),
            outline=(255, 165, 0),
            width=2,
        )

    out = config.PROBE_DIR / "ranking_top_annotated.png"
    overlay.save(out)
    print(f"\n[save] annotated -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
