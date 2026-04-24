"""Popup button detection via template matching (primary) and HSV color (legacy)."""
from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

from . import templates


def find_view_button(screen: Image.Image) -> tuple[float, int, int] | None:
    """Template-match the 보기 button anywhere on screen.

    Robust against friend/non-friend popup variants (where some buttons change
    color) because it matches only the 보기 button's visual signature.
    Returns (score, cx, cy) or None if no confident match.
    """
    return templates.match(screen, "btn_bogi.png")


def find_cyan_buttons(img: Image.Image) -> list[tuple[int, int, int, int]]:
    arr = np.array(img)
    hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    lower = np.array([85, 60, 100])
    upper = np.array([110, 255, 255])
    mask = cv2.inRange(hsv, lower, upper)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    num, _labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    boxes = []
    for i in range(1, num):
        x, y, w, h, area = stats[i]
        if w < 100 or w > 250:
            continue
        if h < 40 or h > 120:
            continue
        if area < 3000:
            continue
        boxes.append((x, y, x + w, y + h))
    return boxes


def find_popup_view_button(img: Image.Image) -> tuple[int, int] | None:
    """Locate the '보기' (top-left) button of the 4-button popup, return (cx, cy)."""
    boxes = find_popup_buttons_grid(img)
    if boxes is None:
        return None
    boxes.sort(key=lambda b: (b[1], b[0]))
    bogi = boxes[0]
    cx = (bogi[0] + bogi[2]) // 2
    cy = (bogi[1] + bogi[3]) // 2
    return cx, cy


def find_popup_buttons_grid(img: Image.Image) -> list[tuple[int, int, int, int]] | None:
    """Return exactly 4 cyan boxes that form a 2x2 popup grid, or None.

    When the popup overlaps rank 2 (which has a blue-cyan highlight), the color
    segmentation may catch 5+ blobs. Use the 2x2 grid geometric constraint to
    pick out the true popup buttons: two pairs of boxes with matching y-centers
    and matching x-centers.
    """
    boxes = find_cyan_buttons(img)
    if len(boxes) == 4 and _is_2x2_grid(boxes):
        return boxes
    if len(boxes) < 4:
        return None

    n = len(boxes)
    best: list[tuple[int, int, int, int]] | None = None
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                for l in range(k + 1, n):
                    subset = [boxes[i], boxes[j], boxes[k], boxes[l]]
                    if _is_2x2_grid(subset):
                        if best is None or _grid_score(subset) < _grid_score(best):
                            best = subset
    return best


def _is_2x2_grid(boxes: list[tuple[int, int, int, int]]) -> bool:
    if len(boxes) != 4:
        return False
    ys = sorted([(b[1] + b[3]) // 2 for b in boxes])
    # top pair y-close, bottom pair y-close, top/bottom gap wider
    top_pair_gap = ys[1] - ys[0]
    bot_pair_gap = ys[3] - ys[2]
    inter_row_gap = ys[2] - ys[1]
    if top_pair_gap > 30 or bot_pair_gap > 30:
        return False
    if inter_row_gap < 70 or inter_row_gap > 200:
        return False
    # widths and heights should be similar
    ws = [b[2] - b[0] for b in boxes]
    hs = [b[3] - b[1] for b in boxes]
    if max(ws) - min(ws) > 40 or max(hs) - min(hs) > 30:
        return False
    # column x-centers: 2 distinct columns
    xs = sorted([(b[0] + b[2]) // 2 for b in boxes])
    col_gap_1 = xs[1] - xs[0]
    col_gap_2 = xs[3] - xs[2]
    inter_col_gap = xs[2] - xs[1]
    if col_gap_1 > 40 or col_gap_2 > 40:
        return False
    if inter_col_gap < 100:
        return False
    return True


def _grid_score(boxes: list[tuple[int, int, int, int]]) -> int:
    """Lower score = tighter grid. Used to pick best subset."""
    ys = sorted([(b[1] + b[3]) // 2 for b in boxes])
    xs = sorted([(b[0] + b[2]) // 2 for b in boxes])
    return abs(ys[1] - ys[0]) + abs(ys[3] - ys[2]) + abs(xs[1] - xs[0]) + abs(xs[3] - xs[2])
