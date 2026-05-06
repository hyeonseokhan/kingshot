"""Supabase REST API 로 members 테이블 fetch — 매칭/업데이트용 경량 클라이언트.

upload_to_db.py 와 분리:
  - 이쪽은 read-only fetch 만 (매칭 기준 데이터)
  - upsert / write 는 update_db 스크립트가 담당
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

# alliance_scraper/.env 로드 — dotenv 라이브러리 의존성 회피
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_ENV_PATH = _PROJECT_ROOT / ".env"


def _load_env() -> dict[str, str]:
    """alliance_scraper/.env 파일 한 번만 파싱."""
    out: dict[str, str] = {}
    if not _ENV_PATH.exists():
        return out
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        out[k.strip()] = v
    return out


_ENV = _load_env()


def _env(key: str) -> str:
    val = os.environ.get(key) or _ENV.get(key)
    if not val:
        raise RuntimeError(
            f"환경변수 {key} 미설정. alliance_scraper/.env 또는 OS env 에 추가 필요."
        )
    return val


def fetch_members(
    select: str = "kingshot_id,nickname,power,alliance_rank,updated_at",
    limit: int = 1000,
) -> list[dict]:
    """members 테이블 전체 fetch. anon key 로 read 가능 (RLS SELECT public)."""
    url = _env("SUPABASE_URL")
    key = _env("SUPABASE_ANON_KEY")
    full_url = f"{url}/rest/v1/members?select={select}&limit={limit}"
    req = urllib.request.Request(
        full_url,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected members response: {data}")
    return data
