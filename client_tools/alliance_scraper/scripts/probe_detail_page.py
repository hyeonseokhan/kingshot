"""Full UI exploration: rank 3 → popup → 보기 → detail → back×2 → verify."""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image

from src import adb, config, nav, ocr
from scripts.analyze_popup import find_cyan_buttons


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    n = nav.RankingNavigator(dev, cfg)

    outdir = config.PROBE_DIR / "ui_calib"
    outdir.mkdir(exist_ok=True)

    print("[step 1] scrolling to top...")
    n.scroll_to_top(verbose=True)
    screen, obs = n.observe()

    # Pick the row with rank==3 specifically
    target = next((o for o in obs if o.rank == 3 and not o.is_pinned), None)
    if target is None:
        print("[!] rank 3 not detected; aborting")
        return 1
    print(f"[target] rank 3 at y={target.row_cy} power={target.power:,}")

    print(f"[step 2] tap row at ({450}, {target.row_cy})")
    dev.tap(450, target.row_cy)
    time.sleep(1.2)
    popup = dev.screencap()
    popup.save(outdir / "10_popup_rank3.png")

    boxes = find_cyan_buttons(popup)
    print(f"[popup] found {len(boxes)} buttons")
    if len(boxes) != 4:
        print(f"[!] expected 4 buttons, got {len(boxes)}; aborting")
        return 1
    boxes.sort(key=lambda b: (b[1], b[0]))
    bogi = boxes[0]  # top-left
    bogi_cx = (bogi[0] + bogi[2]) // 2
    bogi_cy = (bogi[1] + bogi[3]) // 2
    print(f"[보기] center=({bogi_cx},{bogi_cy})  offset_from_row_y={bogi_cy - target.row_cy}")

    print(f"[step 3] tap 보기 at ({bogi_cx},{bogi_cy})")
    dev.tap(bogi_cx, bogi_cy)
    time.sleep(2.0)  # detail page may take a moment
    detail = dev.screencap()
    detail.save(outdir / "11_detail_page.png")
    print("[detail] captured")

    print("[detail OCR - hits with 'ID' or near-it]:")
    for h in ocr.detect(detail):
        if h.conf > 0.5:
            print(f"  y={h.cy:>4}  x=[{h.x0:>4}..{h.x1:>4}]  conf={h.conf:.2f}  text={h.text!r}")

    print("\n[step 4] pressing BACK twice to return to ranking...")
    dev.back()
    time.sleep(1.0)
    after_back1 = dev.screencap()
    after_back1.save(outdir / "12_after_back1.png")
    dev.back()
    time.sleep(1.0)
    after_back2 = dev.screencap()
    after_back2.save(outdir / "13_after_back2.png")

    # Verify: are we back on ranking?
    if n.is_at_top(after_back2):
        print("[verify] at top of ranking — PASS")
    else:
        _, obs_after = n.observe(after_back2)
        print(f"[verify] observed {len(obs_after)} rows after back — check 13_after_back2.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
