"""1-pass alliance member scraper:

For each visible non-pinned row: tap → popup → 보기 → detail → OCR ID → back.
Store keyed by ID. Scroll when all visible rows are already visited.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from PIL import Image

from . import adb, buttons, config as cfg_mod, nav, ocr, templates


ID_RE = re.compile(r"ID\s*[:：]?\s*(\d{5,12})")
# EasyOCR commonly misreads `]` as `l`, `L`, `I`, `J`, `i`, `j`, or `1`.
# Non-greedy tag capture ensures tag stops at the first bracket-like char.
NAME_TAG_RE = re.compile(r"^\[([A-Za-z0-9]{1,8}?)[\]lLIJij1](.+)$")

DETAIL_OCR_REGION = (200, 1100, 700, 1260)
DETAIL_NAME_REGION = (300, 1100, 700, 1160)

# Hardcoded ID for the user's own profile (pinned row cannot be tapped like others)
OWN_USER_ID = "270680423"

# Visible ranking list area (between column header and pinned own row)
LIST_AREA_Y = (280, 1440)
# Maximum alliance size (Kingshot cap)
MAX_ALLIANCE_SIZE = 100


@dataclass
class MemberRecord:
    id: str
    power: int
    rank_at_scan: int | None
    name: str | None
    avatar_phash: str
    detail_power_str: str | None = None
    alliance_tag: str | None = None
    kingdom: str | None = None
    scraped_at: str = ""


@dataclass
class ScrapeState:
    members: dict[str, MemberRecord] = field(default_factory=dict)
    visited_powers: set[int] = field(default_factory=set)
    failures: list[dict] = field(default_factory=list)
    scan_started_at: str = ""
    scan_completed_at: str = ""
    resumed_from: str = ""


class AllianceScraper:
    def __init__(self, device: adb.Device, cfg: dict, *, debug_dir: Path | None = None):
        self.dev = device
        self.cfg = cfg
        self.nav = nav.RankingNavigator(device, cfg)
        self.state = ScrapeState()
        self.debug_dir = debug_dir
        self._debug_idx = 0

    def _dbg(self, label: str, img: Image.Image) -> None:
        if self.debug_dir is None:
            return
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        img.save(self.debug_dir / f"{self._debug_idx:03d}_{label}.png")
        self._debug_idx += 1

    def _detail_hits(self, detail: Image.Image) -> list[ocr.OCRHit]:
        x0, y0, x1, y1 = DETAIL_OCR_REGION
        return ocr.detect_region(detail, x0, y0, x1, y1)

    def _extract_id_from_detail(self, detail: Image.Image) -> str | None:
        for h in self._detail_hits(detail):
            m = ID_RE.search(h.text)
            if m:
                return m.group(1)
        return None

    def _extract_name_from_detail(self, detail: Image.Image) -> tuple[str | None, str | None]:
        """Return (name_with_tag, alliance_tag). Uses EasyOCR (ko+en) primary,
        falls back to RapidOCR for Chinese-only names.
        """
        name_crop = detail.crop(DETAIL_NAME_REGION)

        # Primary: EasyOCR (Korean + English). Low threshold because Korean on
        # small crops often reports 0.2-0.3 confidence even when mostly correct.
        name: str | None = None
        try:
            from . import kr_ocr
            name = kr_ocr.read_first_text(name_crop, min_conf=0.1)
        except Exception:
            name = None

        # Fallback: RapidOCR detail hits (covers Chinese names)
        if not name or not name.strip():
            for h in self._detail_hits(detail):
                txt = h.text
                if txt.startswith("[") and "]" in txt:
                    name = txt
                    break

        if not name:
            return None, None

        # Parse [TAG]Name — tolerate common EasyOCR misreads of `]`
        m = NAME_TAG_RE.match(name.strip())
        if m:
            tag = m.group(1)
            name_part = m.group(2).strip()
            # A stray `]` inside the name is usually an `l` misread (e.g., "kk]av" -> "kklav")
            name_part = name_part.replace("]", "l")
            return f"[{tag}]{name_part}", tag
        return name, None

    def _tap_and_get_popup(self, tap_x: int, tap_y: int, popup_timeout: float):
        """Tap a row position, wait, capture, detect cyan buttons. Return (img, boxes)."""
        self.dev.tap(tap_x, tap_y)
        time.sleep(popup_timeout)
        img = self.dev.screencap()
        from .buttons import find_cyan_buttons
        return img, find_cyan_buttons(img)

    def _find_row_by_power(self, power: int) -> Optional[object]:
        _, obs = self.nav.observe()
        for o in obs:
            if o.power == power and not o.is_pinned and 300 <= o.row_cy <= 1450:
                return o
        return None

    def _jiggle(self, direction: int) -> None:
        """Nudge the list up or down by ~1 row to reshuffle y positions.

        direction: +1 = scroll up (rows move up, showing rows below); -1 = down.
        """
        rh = self.cfg["regions"]["row_height"]
        dy = rh  # ~1 row
        fx, fy = 450, 900
        tx, ty = 450, 900 - direction * dy
        self.dev.swipe(fx, fy, tx, ty, 600)
        time.sleep(1.0)

    def _expected_popup_cy(self, tap_y: int) -> int:
        """Predict popup y-center based on flip threshold."""
        regions = self.cfg["regions"]
        threshold = regions.get("popup_flip_threshold_y")
        if threshold is None:
            return tap_y  # no prediction available
        if tap_y <= threshold:
            return tap_y + regions.get("popup_below_offset", 199)
        return tap_y + regions.get("popup_above_offset", -198)

    def _visit_member(self, row, popup_timeout: float = 0.9, detail_timeout: float = 1.5) -> bool:
        """Visit one row; on success add to members dict and return True.

        Uses template matching on the 보기 button — robust against friend/non-friend
        popup variants and popup flip direction (above vs below).
        """
        tap_x = 450
        target_power = row.power

        def _try_tap(tap_y: int, timeout: float):
            self.dev.tap(tap_x, tap_y)
            time.sleep(timeout)
            popup = self.dev.screencap()
            from .buttons import find_view_button
            match = find_view_button(popup)
            if match is None:
                return popup, None
            score, bx, by = match
            # Sanity: 보기 must not be wildly far from tap point (within ±500px vertical)
            if abs(by - tap_y) > 500:
                return popup, None
            return popup, (bx, by)

        tap_y = row.row_cy
        popup, view = _try_tap(tap_y, popup_timeout)
        self._dbg(f"popup_p{target_power}", popup)

        if view is None:
            self.dev.back()
            time.sleep(1.0)
            for direction in (+1, -1):
                self._jiggle(direction)
                row2 = self._find_row_by_power(target_power)
                if row2 is None:
                    self._jiggle(-direction)
                    continue
                tap_y = row2.row_cy
                popup, view = _try_tap(tap_y, popup_timeout + 0.2)
                self._dbg(f"popup_retry_{direction:+d}_p{target_power}", popup)
                if view is not None:
                    break
                self.dev.back()
                time.sleep(1.0)

        if view is None:
            return False

        bx, by = view

        self.dev.tap(bx, by)
        time.sleep(detail_timeout)
        detail = self.dev.screencap()
        self._dbg(f"detail_p{row.power}", detail)

        id_value = self._extract_id_from_detail(detail)
        if id_value is None:
            self.state.failures.append({"stage": "ocr_id", "power": row.power})
            self.dev.back()
            time.sleep(1.0)
            return False

        name, alliance_tag = self._extract_name_from_detail(detail)

        record = MemberRecord(
            id=id_value,
            power=row.power,
            rank_at_scan=row.rank,
            name=name,
            avatar_phash=row.avatar_phash,
            alliance_tag=alliance_tag,
            scraped_at=datetime.now().isoformat(timespec="seconds"),
        )
        if id_value not in self.state.members:
            self.state.members[id_value] = record
        else:
            # Update existing record with fresh data (power may have changed)
            self.state.members[id_value].power = row.power
            self.state.members[id_value].rank_at_scan = row.rank
            self.state.members[id_value].scraped_at = record.scraped_at
            if name:
                self.state.members[id_value].name = name
                self.state.members[id_value].alliance_tag = alliance_tag
        self.state.visited_powers.add(row.power)

        self.dev.back()
        time.sleep(1.0)
        return True

    def _identify_top3_rank(self, screen: Image.Image, row_cy: int) -> int | None:
        """Template match rank 1/2/3 crown icons near a row's left column.

        OCR misreads these ornate medallions. Template matching is reliable.
        """
        y0 = max(0, row_cy - 80)
        y1 = min(screen.height, row_cy + 80)
        region = (0, y0, 180, y1)
        best_score = 0.0
        best_rank = None
        for rank_num in (1, 2, 3):
            m = templates.match(screen, f"rank_{rank_num}.png", region=region)
            if m is None:
                continue
            score, _cx, _cy = m
            if score > 0.75 and score > best_score:
                best_score = score
                best_rank = rank_num
        return best_rank

    def _identify_all_ranks(self, screen: Image.Image, obs: list) -> list[tuple[int | None, object]]:
        """Return [(rank, row_obs), ...] for each row (excluding pinned).

        Rank comes from OCR when available; for top-3 crown icons falls back to
        template matching against rank_1/2/3 assets.
        """
        y_min, y_max = LIST_AREA_Y
        results = []
        for o in obs:
            if o.is_pinned:
                continue
            if not (y_min <= o.row_cy <= y_max):
                continue
            rank = o.rank
            if rank is None:
                rank = self._identify_top3_rank(screen, o.row_cy)
            results.append((rank, o))
        return results

    def _find_row_for_rank(self, ranked: list, target_rank: int):
        """Find obs row for target_rank. Falls back to position interpolation
        when OCR missed a rank inside a visible-rank gap.
        """
        # Exact match
        for r, o in ranked:
            if r == target_rank:
                return o

        # Gap-fill via linear interpolation from neighbors
        labeled = [(r, o) for r, o in ranked if r is not None]
        if not labeled:
            return None
        lower_pairs = [(r, o) for r, o in labeled if r < target_rank]
        upper_pairs = [(r, o) for r, o in labeled if r > target_rank]
        if not lower_pairs or not upper_pairs:
            return None
        lower = max(lower_pairs, key=lambda p: p[0])
        upper = min(upper_pairs, key=lambda p: p[0])
        steps = upper[0] - lower[0]
        if steps <= 1:
            return None  # no gap — target is missing entirely
        frac = (target_rank - lower[0]) / steps
        expected_y = lower[1].row_cy + frac * (upper[1].row_cy - lower[1].row_cy)

        # Find unlabeled row closest to expected_y (must be within one row's height)
        unlabeled = [o for r, o in ranked if r is None]
        if not unlabeled:
            return None
        closest = min(unlabeled, key=lambda o: abs(o.row_cy - expected_y))
        if abs(closest.row_cy - expected_y) < 80:
            return closest
        return None

    def _scroll_small(self, rows: float = 1.3) -> bool:
        """Swipe up by ~rows rows. Slow swipe for low inertia. Return True if moved.

        Falls back to a stronger swipe if the first attempt doesn't move the view
        (happens near list edges or after jiggle leaves list in a sticky state).
        """
        from .nav import _screens_equal
        distance = int(150 * rows)
        prev = self.dev.screencap()
        self.dev.swipe(450, 900, 450, 900 - distance, 900)
        time.sleep(1.1)
        cur = self.dev.screencap()
        if not _screens_equal(prev, cur):
            return True

        # Retry with a bigger, faster swipe
        prev = cur
        self.dev.swipe(450, 1250, 450, 450, 1000)
        time.sleep(1.3)
        cur = self.dev.screencap()
        return not _screens_equal(prev, cur)

    def _detect_own_row(self) -> tuple[int | None, int | None]:
        """Read pinned row's power and rank (user's own ranking info). Call once at start."""
        screen = self.dev.screencap()
        _, obs = self.nav.observe(screen)
        pinned = next((o for o in obs if o.is_pinned), None)
        if pinned is None:
            return None, None
        rank = self._ocr_rank_at(screen, self.cfg["regions"]["pinned_own_y"])
        return rank, pinned.power

    def _ocr_rank_at(self, screen: Image.Image, row_y: int) -> int | None:
        x0, y0 = 25, max(0, row_y - 70)
        x1, y1 = 165, min(screen.height, row_y + 70)
        hits = ocr.detect_region(screen, x0, y0, x1, y1)
        for h in hits:
            if h.conf < 0.7:
                continue
            value = ocr.parse_commafied_int(h.text)
            if value is not None and 1 <= value <= 9999:
                return value
        return None

    def _read_row_name(self, screen: Image.Image, row_cy: int) -> str | None:
        """OCR the name column of a list row (ko+en). Used for own row capture."""
        x0, y0 = 295, max(0, row_cy - 35)
        x1, y1 = 620, min(screen.height, row_cy + 35)
        crop = screen.crop((x0, y0, x1, y1))
        try:
            from . import kr_ocr
            return kr_ocr.read_first_text(crop, min_conf=0.3)
        except Exception:
            return None

    def _infer_own_alliance_tag(self) -> str | None:
        """Most common alliance tag among collected members (user's tag inference)."""
        tags = [m.alliance_tag for m in self.state.members.values() if m.alliance_tag]
        if not tags:
            return None
        return max(set(tags), key=tags.count)

    def _capture_own_row(self, row, rank_now: int, screen: Image.Image) -> None:
        """Record the user's own row using hardcoded ID — no tap needed."""
        raw_name = self._read_row_name(screen, row.row_cy)
        tag = self._infer_own_alliance_tag()
        if raw_name and tag:
            full_name = f"[{tag}]{raw_name}"
        else:
            full_name = raw_name
        record = MemberRecord(
            id=OWN_USER_ID,
            power=row.power,
            rank_at_scan=rank_now,
            name=full_name,
            avatar_phash=row.avatar_phash,
            alliance_tag=tag,
            scraped_at=datetime.now().isoformat(timespec="seconds"),
        )
        self.state.members[OWN_USER_ID] = record
        self.state.visited_powers.add(row.power)

    def run(
        self,
        *,
        max_members: int | None = None,
        max_batches: int = 25,  # unused in sequential mode, kept for signature compat
        verbose: bool = True,
    ) -> ScrapeState:
        """Sequential rank-target scrape: find next_rank in visible area, tap, advance."""
        self.state.scan_started_at = datetime.now().isoformat(timespec="seconds")
        self.nav.scroll_to_top(verbose=verbose)
        if verbose:
            print("[scraper] at top; beginning sequential rank-target visit...")

        # Detect own (pinned) row — we can't tap it normally (different popup)
        own_rank, own_power = self._detect_own_row()
        if verbose:
            if own_power is not None:
                print(f"[scraper] detected own row: rank={own_rank}, power={own_power:,}")
            else:
                print("[scraper] no own/pinned row detected")

        fail_counts: dict[int, int] = {}
        permanent_fails: set[int] = set()
        max_fails = 3

        next_rank = 1
        no_progress = 0
        max_rank_seen_global = 0
        consecutive_skips = 0  # already-visited skips with no new collection
        max_consecutive_skips = 15

        while next_rank <= MAX_ALLIANCE_SIZE:
            if max_members is not None and len(self.state.members) >= max_members:
                if verbose:
                    print(f"\n[scraper] reached max_members={max_members}")
                break

            screen = self.dev.screencap()
            _, obs = self.nav.observe(screen)
            ranked = self._identify_all_ranks(screen, obs)
            visible_ranks = [r for r, _ in ranked if r is not None]
            if visible_ranks:
                max_rank_seen_global = max(max_rank_seen_global, max(visible_ranks))

            # Early termination: next_rank past all known ranks + all visible already visited
            if self.state.members:
                known_max_rank = max(
                    (m.rank_at_scan for m in self.state.members.values() if m.rank_at_scan is not None),
                    default=0,
                )
                if next_rank > known_max_rank:
                    visible_powers = {o.power for _r, o in ranked}
                    if visible_powers and visible_powers.issubset(self.state.visited_powers):
                        if verbose:
                            print(f"[end] all known ranks collected "
                                  f"(next_rank={next_rank} > max_known={known_max_rank})")
                        break

            # Find the row matching our target rank (with gap-fill fallback)
            target = self._find_row_for_rank(ranked, next_rank)

            if target is not None:
                # Own row: don't tap (popup differs and can lock the list).
                # Record with hardcoded ID using the row's power + OCR'd name.
                if own_power is not None and target.power == own_power:
                    if OWN_USER_ID not in self.state.members:
                        self._capture_own_row(target, next_rank, screen)
                        m = self.state.members.get(OWN_USER_ID)
                        if verbose and m:
                            print(f"rank {next_rank} (y={target.row_cy}) OWN ROW captured: "
                                  f"id={m.id} name={m.name!r} power={m.power:,}")
                    elif verbose:
                        print(f"rank {next_rank} (y={target.row_cy}): OWN ROW (already recorded)")
                    next_rank += 1
                    no_progress = 0
                    continue
                if target.power in self.state.visited_powers:
                    if verbose:
                        print(f"rank {next_rank} (y={target.row_cy}, p={target.power:,}): already visited")
                    next_rank += 1
                    no_progress = 0
                    consecutive_skips += 1
                    if consecutive_skips >= max_consecutive_skips:
                        if verbose:
                            print(f"[end] {consecutive_skips} consecutive already-visited; stopping early")
                        break
                    continue
                if target.power in permanent_fails:
                    next_rank += 1
                    continue

                if verbose:
                    print(f"rank {next_rank} (y={target.row_cy}) power={target.power:,}")
                ok = self._visit_member(target)
                if ok:
                    fail_counts.pop(target.power, None)
                    m = next(
                        (x for x in self.state.members.values() if x.power == target.power),
                        None,
                    )
                    if verbose and m:
                        print(f"  -> ID={m.id} {m.name!r}  total={len(self.state.members)}")
                    next_rank += 1
                    no_progress = 0
                    consecutive_skips = 0  # new collection resets the streak
                else:
                    fail_counts[target.power] = fail_counts.get(target.power, 0) + 1
                    if fail_counts[target.power] >= max_fails:
                        permanent_fails.add(target.power)
                        self.state.failures.append({
                            "stage": "permanent_fail",
                            "rank": next_rank,
                            "power": target.power,
                            "attempts": fail_counts[target.power],
                        })
                        if verbose:
                            print(f"  -> FAILED {max_fails}x, giving up on rank {next_rank}")
                        next_rank += 1
                    elif verbose:
                        print(f"  -> FAILED x{fail_counts[target.power]}, will retry")
                continue

            # target not visible — decide direction
            if visible_ranks and min(visible_ranks) > next_rank:
                # we scrolled past it (shouldn't happen with forward-only swipes)
                skipped = list(range(next_rank, min(visible_ranks)))
                self.state.failures.append({
                    "stage": "scroll_past", "skipped_ranks": skipped,
                })
                if verbose:
                    print(f"[skip] rank(s) {skipped} scrolled past; jumping to {min(visible_ranks)}")
                next_rank = min(visible_ranks)
                continue

            if visible_ranks and min(visible_ranks) <= next_rank <= max(visible_ranks):
                # should be visible but OCR/template missed; wait & retry
                if verbose:
                    print(f"rank {next_rank}: should be visible (visible={sorted(visible_ranks)}), retrying...")
                time.sleep(0.6)
                no_progress += 1
                if no_progress >= 5:
                    if verbose:
                        print(f"  [!] 5 retries without finding rank {next_rank}; skipping")
                    self.state.failures.append({"stage": "ocr_miss", "rank": next_rank})
                    next_rank += 1
                    no_progress = 0
                continue

            # next_rank > any visible rank → need to scroll up (show later ranks)
            moved = self._scroll_small()
            if not moved:
                if verbose:
                    print(f"[end] cannot scroll further; max visible rank = {max_rank_seen_global}")
                break
            no_progress += 1
            if no_progress >= 15:
                if verbose:
                    print(f"[end] too many scrolls without finding rank {next_rank}")
                break

        self.state.scan_completed_at = datetime.now().isoformat(timespec="seconds")
        return self.state

    def preload_state(self, resumed_from: Path, members: dict[str, "MemberRecord"]) -> None:
        """Seed state from a previous run so those rows are skipped on this pass."""
        self.state.resumed_from = str(resumed_from)
        for rid, rec in members.items():
            self.state.members[rid] = rec
            self.state.visited_powers.add(rec.power)
