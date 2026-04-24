"""Live calibration: tap rank 1..7 rows in turn, record popup y-center.

Results: popup_flip_threshold_y = midpoint of last "below" tap_y and first "above" tap_y.
Saves to config.json.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, buttons, config, nav


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    n = nav.RankingNavigator(dev, cfg)

    if not n.is_at_top():
        print("[scroll] moving to top...")
        n.scroll_to_top(verbose=True)

    regions = cfg["regions"]
    first = regions["first_row_y"]
    row_h = regions["row_height"]

    results = []
    for rank_idx in range(7):
        tap_y = first + rank_idx * row_h
        print(f"\n[probe] tap rank {rank_idx+1} at y={tap_y}")
        dev.tap(450, tap_y)
        time.sleep(1.0)
        popup = dev.screencap()
        grid = buttons.find_popup_buttons_grid(popup)
        if grid is None:
            print(f"  -> no popup detected (boxes found={len(buttons.find_cyan_buttons(popup))})")
            dev.back()
            time.sleep(1.0)
            continue
        ys = [(b[1] + b[3]) // 2 for b in grid]
        popup_cy = sum(ys) // len(ys)
        offset = popup_cy - tap_y
        direction = "below" if offset > 0 else "above"
        results.append((rank_idx + 1, tap_y, popup_cy, offset, direction))
        print(f"  -> popup_cy={popup_cy}  offset={offset:+d}  ({direction})")
        dev.back()
        time.sleep(1.0)

    print("\n=== summary ===")
    print(f"{'rank':>4} {'tap_y':>6} {'pop_cy':>7} {'offset':>7}  dir")
    for r, ty, pcy, off, d in results:
        print(f"{r:>4} {ty:>6} {pcy:>7} {off:>+7}  {d}")

    below = [r for r in results if r[4] == "below"]
    above = [r for r in results if r[4] == "above"]

    if not below or not above:
        print("[!] no clear transition found; popup always", results[0][4] if results else "unknown")
        return 1

    # Threshold: between last below's tap_y and first above's tap_y
    last_below_y = max(r[1] for r in below)
    first_above_y = min(r[1] for r in above)
    threshold = (last_below_y + first_above_y) // 2
    avg_below_offset = sum(r[3] for r in below) // len(below)
    avg_above_offset = sum(r[3] for r in above) // len(above)

    print(f"\n[flip] threshold_y={threshold}")
    print(f"[flip] below_offset avg={avg_below_offset:+d}")
    print(f"[flip] above_offset avg={avg_above_offset:+d}")

    cfg["regions"]["popup_flip_threshold_y"] = threshold
    cfg["regions"]["popup_below_offset"] = avg_below_offset
    cfg["regions"]["popup_above_offset"] = avg_above_offset
    config.save(cfg)
    print("[saved] to config.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
