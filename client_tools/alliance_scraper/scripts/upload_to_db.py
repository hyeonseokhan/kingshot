"""Upload scraped member data to Supabase.

Flow:
  1. Load latest output/alliance_*.json (or path given via --file)
  2. For each member ID: call Supabase edge function "redeem-coupon" (action=player)
     to fetch authoritative nickname / level / kingdom / avatar from centurygame API
  3. Upsert each row into the `members` table (keyed by kingshot_id)

Usage:
  python scripts/upload_to_db.py              # uses latest output json
  python scripts/upload_to_db.py --file X.json
  python scripts/upload_to_db.py --dry-run    # print what would be upserted, no DB writes
  python scripts/upload_to_db.py --delay 0.8  # seconds between API calls (default 0.5)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import requests
from dotenv import load_dotenv
from supabase import create_client

from src import config


load_dotenv(config.PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")
PLAYER_API = f"{SUPABASE_URL}/functions/v1/redeem-coupon"

# Absent-member allowlist: kingshot_id -> human note.
# Members in this set are NEVER pruned from DB even if missing from a scrape.
# Use for members on temporary leave (e.g. 잠시 자리비움) so the website still
# shows them with their last-known power. Remove from this set when they rejoin
# (a regular scrape will refresh their power on the next run).
ABSENT_MEMBER_IDS: dict[str, str] = {
    "268960114": "Narcissus — temporary leave (since 2026-05-01)",
}


def fetch_player_info(
    player_id: str,
    timeout: float = 10.0,
    max_retries: int = 3,
    retry_delay: float = 1.5,
) -> dict[str, Any] | None:
    """Call the edge function (which proxies centurygame API) for one player.

    Auto-retries on 5xx errors (Supabase edge cold start / temporary outage)
    and on network errors with exponential backoff.
    """
    last_err = None
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                PLAYER_API,
                json={"action": "player", "fid": player_id},
                headers={
                    "Content-Type": "application/json",
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                },
                timeout=timeout,
            )
        except requests.RequestException as e:
            last_err = f"network error: {e}"
            if attempt < max_retries - 1:
                print(f"  [retry {attempt+1}/{max_retries}] {last_err}")
                time.sleep(retry_delay * (2 ** attempt))
                continue
            print(f"  [!] {last_err} (gave up after {max_retries} tries)")
            return None

        if 500 <= resp.status_code < 600:
            last_err = f"HTTP {resp.status_code}: {resp.text[:120]}"
            if attempt < max_retries - 1:
                print(f"  [retry {attempt+1}/{max_retries}] {last_err}")
                time.sleep(retry_delay * (2 ** attempt))
                continue
            print(f"  [!] {last_err} (gave up after {max_retries} tries)")
            return None

        if resp.status_code != 200:
            print(f"  [!] HTTP {resp.status_code}: {resp.text[:200]}")
            return None

        try:
            data = resp.json()
        except ValueError:
            print(f"  [!] non-JSON response: {resp.text[:200]}")
            return None

        if data.get("code") != 0 or not data.get("data"):
            print(f"  [!] API error code={data.get('code')}: {data.get('msg')}")
            return None

        d = data["data"]
        return {
            "nickname": d.get("nickname") or str(player_id),
            "level": d.get("stove_lv") or d.get("stove_lv_content") or 0,
            "kingdom": d.get("kid"),
            "profile_photo": d.get("avatar_image"),
        }
    return None


def pick_latest_output() -> Path:
    files = sorted((config.OUTPUT_DIR).glob("alliance_*.json"))
    if not files:
        raise FileNotFoundError(f"no alliance_*.json in {config.OUTPUT_DIR}")
    return files[-1]


def clean_scraper_name(raw: str | None) -> str | None:
    """Strip [TAG] prefix from OCR'd name if present."""
    if not raw:
        return None
    s = raw.strip()
    if s.startswith("[") and "]" in s:
        s = s.split("]", 1)[1].strip()
    return s or None


def prune_left_members(sb, current_ids: set[str], dry_run: bool) -> tuple[int, list[str], list[str]]:
    """Delete rows in `members` whose kingshot_id is not in `current_ids`.

    Why: alliance roster is capped at 100. Members who left between scrapes must
    be removed so the DB reflects the live roster, not a historical superset.

    ABSENT_MEMBER_IDS bypass deletion — they're on temporary leave and the
    website still shows them.

    Returns (deleted_count, deleted_ids, kept_absent_ids).
    """
    resp = sb.table("members").select("kingshot_id").execute()
    db_ids = {str(row["kingshot_id"]) for row in (resp.data or [])}
    missing_ids = db_ids - current_ids
    kept_absent = sorted(missing_ids & ABSENT_MEMBER_IDS.keys())
    left_ids = sorted(missing_ids - ABSENT_MEMBER_IDS.keys())
    if not left_ids:
        return 0, [], kept_absent
    if dry_run:
        return 0, left_ids, kept_absent
    sb.table("members").delete().in_("kingshot_id", left_ids).execute()
    return len(left_ids), left_ids, kept_absent


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload scraper JSON to Supabase members table")
    parser.add_argument("--file", type=str, default=None,
                        help="path to alliance_*.json (default: latest in output/)")
    parser.add_argument("--delay", type=float, default=0.5,
                        help="seconds between API calls (default 0.5)")
    parser.add_argument("--dry-run", action="store_true",
                        help="preview upserts without writing to DB")
    parser.add_argument("--no-prune", action="store_true",
                        help="skip removing DB rows whose kingshot_id is missing from this scrape")
    args = parser.parse_args()

    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("[!] SUPABASE_URL or SUPABASE_ANON_KEY missing from .env")
        return 2

    src = Path(args.file) if args.file else pick_latest_output()
    print(f"[src] {src}")
    with src.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    members = payload.get("members", [])
    total = len(members)
    print(f"[src] {total} members to upload (scan_started_at={payload.get('scan_started_at')})")

    sb = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

    ok_count = api_fail = db_fail = 0
    t0 = time.time()

    for i, m in enumerate(members, 1):
        kid = str(m.get("id"))
        power = int(m.get("power") or 0)
        rank = int(m.get("final_rank") or 0)
        scraper_name = clean_scraper_name(m.get("name"))
        tag = m.get("alliance_tag")

        print(f"[{i:>3}/{total}] ID={kid} power={power:,} rank={rank}")

        info = fetch_player_info(kid)
        if info is None:
            api_fail += 1
            # fallback: use scraper-derived name so we still record something
            info = {
                "nickname": scraper_name or kid,
                "level": 0,
                "kingdom": None,
                "profile_photo": None,
            }

        row = {
            "kingshot_id": kid,
            "nickname": info["nickname"],
            "power": power,
            "level": info.get("level") or 0,
            "kingdom": info.get("kingdom"),
            "profile_photo": info.get("profile_photo"),
        }

        print(f"    -> nickname={row['nickname']!r} lv={row['level']} kingdom={row['kingdom']}")

        if not args.dry_run:
            try:
                sb.table("members").upsert(row, on_conflict="kingshot_id").execute()
                ok_count += 1
            except Exception as e:
                db_fail += 1
                print(f"    [!] DB upsert failed: {e}")
        else:
            ok_count += 1

        if i < total:
            time.sleep(args.delay)

    elapsed = time.time() - t0
    print()
    print(f"=== upload complete in {elapsed:.1f}s ===")
    print(f"  success: {ok_count}")
    print(f"  API failures (used scraper fallback): {api_fail}")
    print(f"  DB failures: {db_fail}")

    if not args.no_prune:
        current_ids = {str(m.get("id")) for m in members if m.get("id")}
        deleted, left_ids, kept_absent = prune_left_members(sb, current_ids, dry_run=args.dry_run)
        if left_ids:
            preview = ", ".join(left_ids[:10]) + (" ..." if len(left_ids) > 10 else "")
            if args.dry_run:
                print(f"  [dry-run] would delete {len(left_ids)} left members: {preview}")
            else:
                print(f"  pruned {deleted} left members from DB: {preview}")
        else:
            print("  no left members to prune")
        for kid in kept_absent:
            print(f"  kept absent: {kid} ({ABSENT_MEMBER_IDS[kid]})")
    elif args.no_prune:
        print("  prune skipped (--no-prune)")

    if args.dry_run:
        print("  [dry-run] no rows written to DB")
    return 0 if db_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
