"""EasyOCR wrapper for Korean/English/Chinese mixed-language text (member names).

Lazy-loaded so the model is only initialized on first use (~5-10s first time,
~400MB model download cached to ~/.EasyOCR on first run).
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
from PIL import Image


@lru_cache(maxsize=1)
def _reader():
    import easyocr
    # ko + en covers most member names. EasyOCR cannot combine ko with ch_sim;
    # Chinese names fall back to RapidOCR (which handles ch+en) at call sites.
    return easyocr.Reader(["ko", "en"], gpu=False, verbose=False)


def read_first_text(region: Image.Image, min_conf: float = 0.3) -> str | None:
    """OCR the region with multilingual model; return the best text or None."""
    arr = np.asarray(region)
    if arr.ndim == 3 and arr.shape[2] == 4:
        arr = arr[:, :, :3]
    results = _reader().readtext(arr)
    filtered = [(text, float(conf)) for _bbox, text, conf in results if conf >= min_conf]
    if not filtered:
        return None
    # Return longest text (full name line is usually the main content)
    filtered.sort(key=lambda r: -len(r[0]))
    return filtered[0][0]


def read_all_texts(region: Image.Image, min_conf: float = 0.3) -> list[tuple[str, float]]:
    """Return [(text, conf), ...] sorted by y then x."""
    arr = np.asarray(region)
    if arr.ndim == 3 and arr.shape[2] == 4:
        arr = arr[:, :, :3]
    results = _reader().readtext(arr)
    out = []
    for bbox, text, conf in results:
        if conf < min_conf:
            continue
        ys = [p[1] for p in bbox]
        xs = [p[0] for p in bbox]
        cy = sum(ys) / len(ys)
        cx = sum(xs) / len(xs)
        out.append((text, float(conf), cy, cx))
    out.sort(key=lambda r: (r[2], r[3]))
    return [(t, c) for t, c, _, _ in out]
