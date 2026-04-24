"""Small end-to-end test: scrape first 5 members."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, config, scraper


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)

    debug_dir = config.PROBE_DIR / "scrape_small"
    sc = scraper.AllianceScraper(dev, cfg, debug_dir=debug_dir)
    state = sc.run(max_members=5, verbose=True)

    print("\n=== collected ===")
    for rid, rec in state.members.items():
        print(
            f"  ID={rec.id}  rank={rec.rank_at_scan}  power={rec.power:,}  "
            f"name={rec.name!r}  tag={rec.alliance_tag!r}"
        )
    print(f"\nfailures: {len(state.failures)}")
    for f in state.failures:
        print(f"  {f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
