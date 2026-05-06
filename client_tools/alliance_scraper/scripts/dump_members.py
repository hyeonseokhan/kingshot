"""DB 의 연맹원 정보를 alliance_scraper/members.json 으로 저장.

검수 시 OCR 결과와 비교하기 위한 reference snapshot.
민감 데이터 (kingshot_id 등) 포함 → .gitignore 에 추가됨.

실행:
  .venv/Scripts/python.exe scripts/dump_members.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src.db_client import fetch_members

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = PROJECT_ROOT / "members.json"


def main() -> int:
    print("[db] members fetch 중...")
    members = fetch_members()
    print(f"[db] {len(members)}명 로드")

    # power 내림차순으로 정렬 (눈으로 검토 시 편함)
    members_sorted = sorted(
        members,
        key=lambda m: m.get("power") or 0,
        reverse=True,
    )

    OUTPUT_PATH.write_text(
        json.dumps(members_sorted, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[saved] {OUTPUT_PATH}")
    print(f"        ({OUTPUT_PATH.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
