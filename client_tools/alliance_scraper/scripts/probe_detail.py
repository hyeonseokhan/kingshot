"""Interactive UI exploration for calibration:
  1) scroll to top
  2) tap row 3 (Pirate King area, y=713)
  3) capture popup
  4) return by tapping outside (or back) and verify
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, config, nav, ocr


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    n = nav.RankingNavigator(dev, cfg)

    probe_dir = config.PROBE_DIR / "ui_calib"
    probe_dir.mkdir(exist_ok=True)

    print("[step] scrolling to top...")
    n.scroll_to_top(verbose=True)
    top_screen = dev.screencap()
    top_screen.save(probe_dir / "01_at_top.png")

    screen, obs = n.observe(top_screen)
    print(f"[top] {len(obs)} rows visible")
    for o in sorted(obs, key=lambda o: o.row_cy):
        pin = "PIN" if o.is_pinned else "   "
        print(f"  {pin}  rank={o.rank!s:>4}  power={o.power:>14,}  y={o.row_cy}")

    # Find a suitable row to tap: first non-pinned row that is NOT rank 1 or 2
    target = None
    for o in sorted(obs, key=lambda o: o.row_cy):
        if o.is_pinned:
            continue
        if o.rank in (1, 2):
            continue
        target = o
        break
    if target is None:
        print("[!] no suitable row to tap; aborting")
        return 1
    print(f"[target] tapping row at y={target.row_cy}  power={target.power:,}")

    # Tap center horizontal of row
    tap_x = 450
    tap_y = target.row_cy
    dev.tap(tap_x, tap_y)
    time.sleep(1.5)

    popup = dev.screencap()
    popup.save(probe_dir / "02_popup.png")
    print("[popup] captured")

    popup_hits = ocr.detect(popup)
    for h in popup_hits:
        if h.conf > 0.5:
            print(f"  hit: y={h.cy} x=[{h.x0}..{h.x1}] conf={h.conf:.2f} text={h.text!r}")

    # Do NOT proceed further yet — just capture and exit so user can verify.
    # Press back to dismiss popup.
    print("[cleanup] pressing BACK to dismiss popup...")
    dev.back()
    time.sleep(1.0)
    after = dev.screencap()
    after.save(probe_dir / "03_after_back.png")
    print(f"[done] artifacts under {probe_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
