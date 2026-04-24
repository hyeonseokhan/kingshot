"""End-to-end sanity check: ADB + screencap + OCR on whatever is on screen.

Usage: python scripts/probe.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from src import adb, config, ocr


def main() -> int:
    cfg = config.load()
    print(f"[cfg] adb={cfg['adb_path']}  serial={cfg['device_serial']}")

    dev = adb.connect_from_config(cfg)
    print(f"[adb] connected. foreground={dev.foreground_package()}")
    print(f"[adb] wm size={dev.wm_size()}")

    img = dev.screencap()
    print(f"[screen] {img.size} mode={img.mode}")
    out_path = config.PROBE_DIR / "probe_full.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"[screen] saved -> {out_path}")

    print("[ocr] running on full screen (first 15 detections)...")
    results = ocr.read_text(img)
    for text, conf in results[:15]:
        print(f"  {conf:.2f}  {text!r}")
    print(f"[ocr] total detections: {len(results)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
