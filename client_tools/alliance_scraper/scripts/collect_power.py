"""Run the power-collection pass against the live emulator."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, collector, config


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    fg = dev.foreground_package()
    print(f"[fg] {fg}")
    print("[!] expecting the ranking screen to already be scrolled to the top.")

    col = collector.PowerCollector(dev, cfg)
    members = col.run(max_swipes=50, verbose=True)

    print(f"\n=== {len(members)} members collected (excluding own pinned row) ===")
    for i, m in enumerate(members, 1):
        rank = f"{m.rank}" if m.rank is not None else "?"
        print(f"  #{i:3d}  listed-rank={rank:>4}  power={m.power:>14,}  phash={m.avatar_phash[:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
