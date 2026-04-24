"""Simple OpenCV template matching for fixed UI icons."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import config as cfg_mod


@lru_cache(maxsize=8)
def _load_template(name: str) -> np.ndarray:
    path = cfg_mod.PROJECT_ROOT / "assets" / name
    if not path.exists():
        raise FileNotFoundError(f"template not found: {path}")
    pil = Image.open(path).convert("RGB")
    return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)


def match(
    screen: Image.Image,
    template_name: str,
    *,
    region: tuple[int, int, int, int] | None = None,
) -> tuple[float, int, int] | None:
    """Return (score, x_center, y_center) of best match, or None if low score.

    If `region` (x0, y0, x1, y1) is given, search only within it.
    """
    template = _load_template(template_name)
    screen_bgr = cv2.cvtColor(np.asarray(screen), cv2.COLOR_RGB2BGR)
    if region is not None:
        x0, y0, x1, y1 = region
        screen_bgr = screen_bgr[y0:y1, x0:x1]
        dx, dy = x0, y0
    else:
        dx, dy = 0, 0

    th, tw = template.shape[:2]
    if screen_bgr.shape[0] < th or screen_bgr.shape[1] < tw:
        return None

    res = cv2.matchTemplate(screen_bgr, template, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    if max_val < 0.70:
        return None
    x, y = max_loc
    cx = dx + x + tw // 2
    cy = dy + y + th // 2
    return float(max_val), cx, cy
