from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class OCRHit:
    text: str
    conf: float
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def cx(self) -> int:
        return (self.x0 + self.x1) // 2

    @property
    def cy(self) -> int:
        return (self.y0 + self.y1) // 2

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0


@lru_cache(maxsize=1)
def _engine():
    from rapidocr_onnxruntime import RapidOCR
    return RapidOCR()


def _run(img: Image.Image) -> list[tuple[list[list[float]], str, float]]:
    arr = np.asarray(img)
    if arr.ndim == 3 and arr.shape[2] == 4:
        arr = arr[:, :, :3]
    result, _ = _engine()(arr)
    return result or []


def detect(region: Image.Image) -> list[OCRHit]:
    """Run OCR and return structured hits sorted top-to-bottom, left-to-right."""
    items = _run(region)
    hits: list[OCRHit] = []
    for box, text, conf in items:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        hits.append(
            OCRHit(
                text=text,
                conf=float(conf),
                x0=int(min(xs)),
                y0=int(min(ys)),
                x1=int(max(xs)),
                y1=int(max(ys)),
            )
        )
    hits.sort(key=lambda h: (h.cy, h.cx))
    return hits


def detect_region(
    img: Image.Image, x0: int, y0: int, x1: int, y1: int
) -> list[OCRHit]:
    """OCR only a cropped region, then translate coordinates back to full image."""
    crop = img.crop((x0, y0, x1, y1))
    hits = detect(crop)
    translated: list[OCRHit] = []
    for h in hits:
        translated.append(
            OCRHit(
                text=h.text,
                conf=h.conf,
                x0=h.x0 + x0,
                y0=h.y0 + y0,
                x1=h.x1 + x0,
                y1=h.y1 + y0,
            )
        )
    return translated


def read_text(region: Image.Image) -> list[tuple[str, float]]:
    return [(h.text, h.conf) for h in detect(region)]


_DIGITS_RE = re.compile(r"[^\d]")


def parse_commafied_int(s: str) -> int | None:
    cleaned = _DIGITS_RE.sub("", s)
    if not cleaned:
        return None
    return int(cleaned)


def first_int(texts: Iterable[tuple[str, float]]) -> int | None:
    for text, _ in texts:
        value = parse_commafied_int(text)
        if value is not None and value > 0:
            return value
    return None
