"""UI state transitions for the alliance ranking screen."""
from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
from PIL import Image

from . import adb, rows as rows_mod, templates


@dataclass
class NavConfig:
    regions: dict
    ocr_cfg: dict


def _screens_equal(a: Image.Image, b: Image.Image, tol: float = 1.0) -> bool:
    """Compare two screens by mean absolute pixel diff in the scroll area."""
    y0 = 300
    y1 = 1400
    aa = np.asarray(a.crop((0, y0, a.width, y1))).astype(np.int16)
    bb = np.asarray(b.crop((0, y0, b.width, y1))).astype(np.int16)
    diff = np.abs(aa - bb).mean()
    return diff < tol


class RankingNavigator:
    def __init__(self, device: adb.Device, cfg: dict):
        self.dev = device
        self.regions = cfg["regions"]
        self.ocr_cfg = cfg["ocr"]

    def observe(self, screen: Image.Image | None = None) -> tuple[Image.Image, list[rows_mod.RowObservation]]:
        if screen is None:
            screen = self.dev.screencap()
        obs = rows_mod.extract_rows(
            screen,
            first_row_y=self.regions["first_row_y"],
            row_height=self.regions["row_height"],
            rows_per_screen=self.regions["rows_per_screen"],
            row_half_height=self.regions["row_half_height"],
            power_col_x=tuple(self.regions["power_col_x"]),
            avatar_col_x=tuple(self.regions["avatar_col_x"]),
            pinned_own_y=self.regions["pinned_own_y"],
            power_min=self.ocr_cfg["power_min"],
        )
        return screen, obs

    def is_on_ranking_screen(self, screen: Image.Image | None = None) -> bool:
        """Verify we're on the alliance ranking screen (not outdoor/detail/etc).

        Uses multiple anchors that must each succeed OR one strong anchor:
          - Anchor A (strong): rank 1 crown visible at expected first_row_y
          - Anchor B (weak):   at least one rank number (1-99) in the left column
                                within the expected scroll area
        """
        if screen is None:
            screen = self.dev.screencap()

        # Anchor A: rank 1 template anywhere in the scroll area
        m = templates.match(screen, "rank_1.png", region=(0, 200, 180, 1500))
        if m is not None and m[0] > 0.75:
            return True

        # Anchor B: OCR rank numbers 1-99 in the rank column
        from . import ocr
        hits = ocr.detect_region(screen, 25, 300, 165, 1450)
        for h in hits:
            if h.conf < 0.7:
                continue
            v = ocr.parse_commafied_int(h.text)
            if v is not None and 1 <= v <= 99:
                return True
        return False

    def is_at_top(self, screen: Image.Image | None = None) -> bool:
        """Detect 'at top' primarily via template match on rank 1 crown.

        Template matching on a distinctive visual icon is far more robust than
        OCR'ing rank text (rank 1/2 icons are medallions that OCR misreads).
        """
        if screen is None:
            screen = self.dev.screencap()

        first_row_y = self.regions["first_row_y"]
        # Search for rank 1 crown in the expected left-column band around first row.
        search_region = (
            0, max(0, first_row_y - 90),
            180, first_row_y + 90,
        )
        m = templates.match(screen, "rank_1.png", region=search_region)
        if m is not None:
            score, _cx, cy = m
            # Must be reasonably close to expected y position
            if abs(cy - first_row_y) < 30:
                return True

        # Fallback to OCR rank-3 anchor (for paranoia / unseen edge cases)
        _, obs = self.observe(screen)
        row_h = self.regions["row_height"]
        expected_rank3_y = first_row_y + 2 * row_h
        for o in obs:
            if o.is_pinned:
                continue
            if o.rank == 3 and abs(o.row_cy - expected_rank3_y) < 30:
                return True
        return False

    def scroll_to_top(self, *, max_attempts: int = 25, verbose: bool = False) -> Image.Image:
        """Swipe down until rank 1 crown appears at the expected top-row position.

        Refuses to scroll if we're clearly NOT on the ranking screen (prevents
        random camera panning on outdoor view, etc).
        """
        screen = self.dev.screencap()
        if self.is_at_top(screen):
            if verbose:
                print("[scroll-top] already at top")
            return screen
        if not self.is_on_ranking_screen(screen):
            raise RuntimeError(
                "scroll_to_top aborted: not on the ranking screen. "
                "Navigate to 연맹 → 연맹 랭킹 → 전투력 랭킹 first."
            )

        prev = screen
        stable = 0
        for i in range(max_attempts):
            self.dev.swipe(450, 500, 450, 1250, 800)
            time.sleep(0.9)
            cur = self.dev.screencap()
            if self.is_at_top(cur):
                if verbose:
                    print(f"[scroll-top] iter {i+1}: at top (rank-3 anchor matched)")
                return cur
            if _screens_equal(prev, cur):
                stable += 1
                if verbose:
                    print(f"[scroll-top] iter {i+1}: screen unchanged ({stable})")
                if stable >= 3:
                    if verbose:
                        print("[scroll-top] giving up — screen stable without rank-3 anchor")
                    return cur
            else:
                stable = 0
                if verbose:
                    print(f"[scroll-top] iter {i+1}: still scrolling")
            prev = cur
        return prev

    def scroll_one_page(self, *, rows: int = 4) -> bool:
        """Swipe up by ~rows rows. Return True if view changed."""
        scroll = self.regions["scroll"]
        rh = self.regions["row_height"]
        distance = rh * rows
        fx = scroll["from"][0]
        fy = scroll["from"][1]
        tx = scroll["to"][0]
        ty = max(100, fy - distance)
        prev = self.dev.screencap()
        self.dev.swipe(fx, fy, tx, ty, scroll["duration_ms"])
        time.sleep(1.0)
        cur = self.dev.screencap()
        return not _screens_equal(prev, cur)
