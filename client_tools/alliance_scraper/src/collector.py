"""Power-score collection loop: scroll through ranking and dedup by power value.

Dedup strategy: power (10+ digit integer) is effectively unique across members,
so we use it as the primary key. Avatar phash is retained per-member as a
visual signature used later when matching to member IDs from detail pages.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from PIL import Image

from . import adb, rows as rows_mod


@dataclass
class MemberPower:
    power: int
    rank: int | None
    avatar_phashes: list[str] = field(default_factory=list)
    seen_as_pinned: bool = False
    first_seen_cy: int | None = None


class PowerCollector:
    def __init__(self, device: adb.Device, cfg: dict):
        self.dev = device
        self.cfg = cfg
        self.regions = cfg["regions"]
        self.ocr_cfg = cfg["ocr"]
        self.by_power: dict[int, MemberPower] = {}
        self.own_power: int | None = None

    def _observe(self, screen: Image.Image) -> tuple[int, int, int]:
        """Return (new, updated, pinned_seen)."""
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
        new = upd = pinned_seen = 0
        for o in obs:
            if o.is_pinned:
                pinned_seen += 1
                if self.own_power is None:
                    self.own_power = o.power
                m = self.by_power.setdefault(o.power, MemberPower(power=o.power, rank=o.rank))
                m.seen_as_pinned = True
                if o.avatar_phash not in m.avatar_phashes:
                    m.avatar_phashes.append(o.avatar_phash)
                continue

            m = self.by_power.get(o.power)
            if m is None:
                self.by_power[o.power] = MemberPower(
                    power=o.power,
                    rank=o.rank,
                    avatar_phashes=[o.avatar_phash],
                    first_seen_cy=o.row_cy,
                )
                new += 1
            else:
                changed = False
                if m.rank is None and o.rank is not None:
                    m.rank = o.rank
                    changed = True
                if o.avatar_phash not in m.avatar_phashes:
                    m.avatar_phashes.append(o.avatar_phash)
                    changed = True
                if changed:
                    upd += 1
        return new, upd, pinned_seen

    def _swipe_once(self) -> None:
        s = self.regions["scroll"]
        fx, fy = s["from"]
        tx, ty = s["to"]
        self.dev.swipe(fx, fy, tx, ty, s["duration_ms"])
        time.sleep(1.0)  # settle (scroll inertia + render)

    def run(
        self,
        *,
        max_swipes: int = 50,
        verbose: bool = True,
        debug_dir=None,
    ) -> list[MemberPower]:
        def _save(idx: int, screen: Image.Image) -> None:
            if debug_dir is None:
                return
            debug_dir.mkdir(parents=True, exist_ok=True)
            screen.save(debug_dir / f"scan_{idx:03d}.png")

        screen = self.dev.screencap()
        _save(0, screen)
        n, u, p = self._observe(screen)
        if verbose:
            print(f"[obs 0] new={n} upd={u} pinned={p} total={len(self.by_power)}")

        stable_rounds = 0
        for i in range(1, max_swipes + 1):
            prev_count = len(self.by_power)
            self._swipe_once()
            screen = self.dev.screencap()
            _save(i, screen)
            n, u, p = self._observe(screen)
            if verbose:
                print(f"[obs {i}] new={n} upd={u} pinned={p} total={len(self.by_power)}")
            if len(self.by_power) == prev_count and n == 0:
                stable_rounds += 1
                if stable_rounds >= 2:
                    if verbose:
                        print("[end] two consecutive swipes with zero new — done.")
                    break
            else:
                stable_rounds = 0

        members = list(self.by_power.values())
        members.sort(key=lambda m: m.power, reverse=True)
        return members
