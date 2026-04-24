"""Main entry: scrape the entire alliance ranking and save txt+json.

Prereq: Kingshot running, alliance ranking (전투력 랭킹) tab open.
The script scrolls to the top automatically before starting.

Usage:
  python scripts/scrape.py                  # fresh scan
  python scripts/scrape.py --resume         # skip members already in latest output
  python scripts/scrape.py --max-members 15 # stop after N members (for testing)
"""
from __future__ import annotations

import argparse
import atexit
import os
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, config, nav as nav_mod, output, scraper


LOCK_MAX_AGE_SEC = 300  # anything older than 5 min is considered stale


def _acquire_lock() -> Path:
    lock = config.PROBE_DIR / ".scrape.lock"
    config.PROBE_DIR.mkdir(parents=True, exist_ok=True)
    if lock.exists():
        age = time.time() - lock.stat().st_mtime
        existing_pid = lock.read_text(errors="replace").strip()
        if age < LOCK_MAX_AGE_SEC:
            print(f"[!] Another scrape may be running (pid={existing_pid}, lock age {age:.0f}s)")
            print("    If you're sure no other scrape is running, delete:")
            print(f"    {lock}")
            sys.exit(2)
        print(f"[lock] stale lock ({age:.0f}s old, pid={existing_pid}) — replacing")
    lock.write_text(str(os.getpid()))
    return lock


def _release_lock(lock: Path) -> None:
    try:
        lock.unlink()
    except FileNotFoundError:
        pass


def _install_signal_handlers() -> None:
    """Ensure SIGINT/SIGTERM exit cleanly so atexit/finally blocks run."""
    def _handler(signum, frame):
        print(f"\n[signal] received {signum}, cleaning up...")
        raise KeyboardInterrupt
    signal.signal(signal.SIGINT, _handler)
    try:
        signal.signal(signal.SIGTERM, _handler)
    except (AttributeError, ValueError):
        pass  # SIGTERM may not be available on Windows in some contexts


def main() -> int:
    parser = argparse.ArgumentParser(description="Kingshot alliance scraper")
    parser.add_argument("--resume", action="store_true",
                        help="Skip members already in the latest output/alliance_*.json")
    parser.add_argument("--max-members", type=int, default=None,
                        help="Stop after collecting N members (for testing)")
    parser.add_argument("--force", action="store_true",
                        help="Bypass the 'on ranking screen' pre-flight check")
    args = parser.parse_args()

    _install_signal_handlers()
    lock = _acquire_lock()
    atexit.register(_release_lock, lock)

    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    print(f"[adb] {cfg['device_serial']} foreground={dev.foreground_package()}")

    # Pre-flight check: must be on the ranking screen
    nav_ = nav_mod.RankingNavigator(dev, cfg)
    if not args.force:
        print("[preflight] verifying we are on the alliance ranking screen...")
        if not nav_.is_on_ranking_screen():
            print("[!] NOT on the alliance ranking screen.")
            print("    Navigate to: 연맹 → 연맹 랭킹 → 전투력 랭킹, then re-run.")
            print("    (Use --force to skip this check.)")
            return 3
        print("[preflight] OK")

    debug_dir = config.PROBE_DIR / "full_run"
    sc = scraper.AllianceScraper(dev, cfg, debug_dir=debug_dir)

    if args.resume:
        latest = output.latest_output_json(config.OUTPUT_DIR)
        if latest is None:
            print("[resume] no previous output found; doing fresh scan")
        else:
            members = output.load_members_from_json(latest)
            sc.preload_state(latest, members)
            print(f"[resume] loaded {len(members)} members from {latest.name}")

    t0 = time.time()
    interrupted = False
    try:
        state = sc.run(max_members=args.max_members, verbose=True)
    except KeyboardInterrupt:
        print("\n[!] interrupted — saving partial results")
        state = sc.state
        interrupted = True
    elapsed = time.time() - t0

    # Always save whatever we collected, even on interrupt
    txt_path, json_path = output.write_outputs(state, config.OUTPUT_DIR)

    new_count = len(state.members)
    if state.resumed_from:
        try:
            prev = output.load_members_from_json(Path(state.resumed_from))
            new_count = len(state.members) - len(prev)
        except Exception:
            pass

    print()
    header = "=== interrupted after" if interrupted else "=== scan complete in"
    print(f"{header} {elapsed:.1f}s ===")
    print(f"  total members: {len(state.members)}  (new this run: {new_count})")
    print(f"  failures:      {len(state.failures)}")
    print(f"  txt  -> {txt_path}")
    print(f"  json -> {json_path}")
    return 1 if interrupted else 0


if __name__ == "__main__":
    raise SystemExit(main())
