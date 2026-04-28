"""Write scrape results to txt and json, and load previous results for resume."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from . import scraper as scraper_mod


def _timestamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def write_outputs(state: scraper_mod.ScrapeState, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = _timestamp()

    # Sort by power descending, assign final rank
    records = sorted(state.members.values(), key=lambda m: m.power, reverse=True)

    now_iso = datetime.now().isoformat(timespec="seconds")

    # JSON
    json_path = out_dir / f"alliance_{ts}.json"
    data = {
        "scan_started_at": state.scan_started_at,
        "scan_completed_at": state.scan_completed_at or now_iso,
        "saved_at": now_iso,
        "total_members": len(records),
        "resumed_from": state.resumed_from or None,
        "failures": state.failures,
        "members": [
            {
                "final_rank": i + 1,
                "id": m.id,
                "name": m.name,
                "alliance_tag": m.alliance_tag,
                "alliance_role": m.alliance_role,
                "power": m.power,
                "rank_at_scan": m.rank_at_scan,
                "avatar_phash": m.avatar_phash,
                "scraped_at": m.scraped_at,
            }
            for i, m in enumerate(records)
        ],
    }
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # TXT (human-readable, sorted by power)
    txt_path = out_dir / f"alliance_{ts}.txt"
    with txt_path.open("w", encoding="utf-8") as f:
        f.write(f"# Kingshot alliance scan\n")
        f.write(f"# scan_started_at : {state.scan_started_at}\n")
        f.write(f"# scan_completed_at: {state.scan_completed_at or now_iso}\n")
        f.write(f"# saved_at         : {now_iso}\n")
        f.write(f"# total members   : {len(records)}\n")
        if state.resumed_from:
            f.write(f"# resumed_from    : {state.resumed_from}\n")
        if state.failures:
            f.write(f"# failures        : {len(state.failures)}\n")
        f.write("#\n")
        f.write(f"# {'rank':>4}  {'id':>11}  {'power':>14}  {'scraped_at':>19}  name\n")
        f.write("#" + "-" * 90 + "\n")
        for i, m in enumerate(records, 1):
            f.write(
                f"  {i:>4}  {m.id:>11}  {m.power:>14,}  {m.scraped_at:>19}  {m.name or ''}\n"
            )
    return txt_path, json_path


def latest_output_json(out_dir: Path) -> Path | None:
    if not out_dir.exists():
        return None
    candidates = sorted(out_dir.glob("alliance_*.json"))
    return candidates[-1] if candidates else None


def load_members_from_json(path: Path) -> dict[str, scraper_mod.MemberRecord]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    out: dict[str, scraper_mod.MemberRecord] = {}
    for m in data.get("members", []):
        rec = scraper_mod.MemberRecord(
            id=m["id"],
            power=m["power"],
            rank_at_scan=m.get("rank_at_scan"),
            name=m.get("name"),
            avatar_phash=m.get("avatar_phash", ""),
            alliance_tag=m.get("alliance_tag"),
            alliance_role=m.get("alliance_role"),
            scraped_at=m.get("scraped_at", ""),
        )
        out[rec.id] = rec
    return out
