"""Analyze an existing popup screenshot to find the 4 cyan buttons via color."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import cv2
import numpy as np
from PIL import Image, ImageDraw

from src import config


def find_cyan_buttons(img: Image.Image) -> list[tuple[int, int, int, int]]:
    """Return [(x0, y0, x1, y1), ...] for detected cyan button rectangles."""
    arr = np.array(img)
    hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    # Cyan/teal range — tuned to the popup's button color
    lower = np.array([85, 60, 100])
    upper = np.array([110, 255, 255])
    mask = cv2.inRange(hsv, lower, upper)
    # Clean up
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    num, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    boxes = []
    for i in range(1, num):
        x, y, w, h, area = stats[i]
        # Buttons are roughly 140-200 px wide, 60-100 tall
        if w < 100 or w > 250:
            continue
        if h < 40 or h > 120:
            continue
        if area < 3000:
            continue
        boxes.append((x, y, x + w, y + h))
    return boxes


def main() -> int:
    popup_path = config.PROBE_DIR / "ui_calib" / "02_popup.png"
    if not popup_path.exists():
        print(f"[!] {popup_path} not found")
        return 1
    img = Image.open(popup_path).convert("RGB")
    boxes = find_cyan_buttons(img)
    print(f"[found] {len(boxes)} cyan button candidates:")
    for x0, y0, x1, y1 in boxes:
        cx = (x0 + x1) // 2
        cy = (y0 + y1) // 2
        print(f"  box=({x0},{y0})-({x1},{y1})  center=({cx},{cy})  w={x1-x0} h={y1-y0}")

    # Draw overlay and save
    overlay = img.copy()
    draw = ImageDraw.Draw(overlay)
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        draw.rectangle((x0, y0, x1, y1), outline=(255, 0, 0), width=3)
        cx = (x0 + x1) // 2
        cy = (y0 + y1) // 2
        draw.text((x0 + 4, y0 + 4), f"#{i}", fill=(255, 0, 0))
        draw.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=(255, 0, 0))
    out = popup_path.parent / "02_popup_annotated.png"
    overlay.save(out)
    print(f"[save] {out}")

    # Identify '보기' as top-left button (smallest x, then smallest y)
    if boxes:
        boxes_sorted = sorted(boxes, key=lambda b: (b[1], b[0]))  # top-to-bottom
        top_row = [b for b in boxes_sorted if abs(b[1] - boxes_sorted[0][1]) < 40]
        top_row.sort(key=lambda b: b[0])
        if top_row:
            bogi = top_row[0]
            cx = (bogi[0] + bogi[2]) // 2
            cy = (bogi[1] + bogi[3]) // 2
            print(f"\n[보기 candidate] x={cx}  y={cy}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
