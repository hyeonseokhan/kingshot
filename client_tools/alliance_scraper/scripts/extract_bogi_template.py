"""Crop the 보기 button from a known popup screenshot and save as a template."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image

from src import config


def main() -> int:
    candidates = [
        config.PROBE_DIR / "ui_calib" / "02_popup.png",
        config.PROBE_DIR / "ui_calib" / "10_popup_rank3.png",
    ]
    src = next((p for p in candidates if p.exists()), None)
    if src is None:
        print("[!] no popup source image found")
        return 1
    print(f"[source] {src}")

    img = Image.open(src).convert("RGB")
    # 보기 button for rank 1's popup (at top) is at approx (63,477)-(294,555) from
    # the earlier analyze_popup run. Tighten slightly to get solid inner button.
    x0, y0, x1, y1 = 75, 485, 280, 550
    btn = img.crop((x0, y0, x1, y1))
    assets = config.PROJECT_ROOT / "assets"
    assets.mkdir(exist_ok=True)
    out = assets / "btn_bogi.png"
    btn.save(out)
    print(f"[saved] {out}  size={btn.size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
