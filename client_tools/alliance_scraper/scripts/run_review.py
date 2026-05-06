"""검수 도구 미니 서버 — stdlib 만 사용 (Flask 등 의존성 없음).

흐름:
  1. test_capture_loop.py 가 captures/review.json 생성
  2. python scripts/run_review.py → 브라우저 자동 오픈 (localhost:4000)
  3. 좌측: 캡처 PNG 다음/이전 / 우측: 표 검수 + kingshot_id 입력
  4. "저장" → POST /api/review → review.json 덮어쓰기
  5. (Phase 5) update_db.py 가 review.json 읽어 DB upsert

라우팅:
  GET  /                 → static/review.html
  GET  /captures/<file>  → captures/<file> (PNG 직접 서빙)
  GET  /api/review       → review.json 내용
  POST /api/review       → 본문 JSON 으로 review.json 덮어쓰기
"""
from __future__ import annotations

import json
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import config

PORT = 4000
PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
CAPTURES_DIR = config.CAPTURES_DIR
REVIEW_PATH = CAPTURES_DIR / "review.json"
MEMBERS_PATH = PROJECT_ROOT / "members.json"


_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
}


class ReviewHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002 (stdlib name)
        # 콘솔 노이즈 줄이기 — 에러만 표시
        if args and len(args) >= 2 and str(args[1]).startswith(("4", "5")):
            sys.stderr.write(
                "%s - - [%s] %s\n"
                % (self.address_string(), self.log_date_time_string(), format % args)
            )

    def _write(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self._write(404, "text/plain; charset=utf-8", b"not found")
            return
        ct = _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
        self._write(200, ct, path.read_bytes())

    def do_GET(self) -> None:  # noqa: N802 (stdlib name)
        path = unquote(self.path.split("?", 1)[0])

        if path in ("/", "/index.html"):
            self._serve_file(STATIC_DIR / "review.html")
            return

        if path == "/api/members":
            # kid → nickname lookup 용 (검수 도구가 kid 입력 시 닉 자동 채움)
            if not MEMBERS_PATH.exists():
                self._write(
                    404,
                    "application/json; charset=utf-8",
                    json.dumps(
                        {"error": "members.json 없음. dump_members.py 실행 필요."},
                        ensure_ascii=False,
                    ).encode("utf-8"),
                )
                return
            self._write(
                200,
                "application/json; charset=utf-8",
                MEMBERS_PATH.read_bytes(),
            )
            return

        if path == "/api/review":
            if not REVIEW_PATH.exists():
                self._write(
                    404,
                    "application/json; charset=utf-8",
                    json.dumps(
                        {
                            "error": "review.json 없음. 먼저 test_capture_loop.py 실행.",
                            "expected_path": str(REVIEW_PATH),
                        },
                        ensure_ascii=False,
                    ).encode("utf-8"),
                )
                return
            self._write(
                200,
                "application/json; charset=utf-8",
                REVIEW_PATH.read_bytes(),
            )
            return

        if path.startswith("/captures/"):
            fname = path[len("/captures/") :]
            # path traversal 차단
            if "/" in fname or "\\" in fname or ".." in fname:
                self._write(400, "text/plain; charset=utf-8", b"bad request")
                return
            self._serve_file(CAPTURES_DIR / fname)
            return

        # 기타 정적 (CSS/JS 별도 파일 추가 시 대응)
        if path.startswith("/static/"):
            rel = path[len("/static/") :]
            if ".." in rel:
                self._write(400, "text/plain; charset=utf-8", b"bad request")
                return
            self._serve_file(STATIC_DIR / rel)
            return

        self._write(404, "text/plain; charset=utf-8", b"not found")

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(self.path.split("?", 1)[0])
        if path != "/api/review":
            self._write(404, "text/plain; charset=utf-8", b"not found")
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            self._write(
                400,
                "application/json; charset=utf-8",
                b'{"error":"empty body"}',
            )
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            self._write(
                400,
                "application/json; charset=utf-8",
                json.dumps({"error": f"invalid json: {e}"}).encode("utf-8"),
            )
            return

        # 최소 검증 — schema_version 만 확인 (자유 편집 허용)
        if not isinstance(payload, dict) or "schema_version" not in payload:
            self._write(
                400,
                "application/json; charset=utf-8",
                b'{"error":"schema_version missing"}',
            )
            return

        CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
        REVIEW_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self._write(
            200,
            "application/json; charset=utf-8",
            json.dumps(
                {"ok": True, "saved_path": str(REVIEW_PATH)}, ensure_ascii=False
            ).encode("utf-8"),
        )


def _open_browser_later(url: str, delay: float = 0.5) -> None:
    def _open():
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    t = threading.Thread(target=_open, daemon=True)
    t.start()


def main() -> int:
    if not REVIEW_PATH.exists():
        print(f"[!] review.json 없음: {REVIEW_PATH}")
        print("[!] 먼저 test_capture_loop.py 실행해서 캡처 + 매칭부터 진행하세요:")
        print("       .venv/Scripts/python.exe scripts/test_capture_loop.py --total N")
        return 2

    if not (STATIC_DIR / "review.html").exists():
        print(f"[!] review.html 없음: {STATIC_DIR / 'review.html'}")
        return 2

    addr = ("127.0.0.1", PORT)
    httpd = ThreadingHTTPServer(addr, ReviewHandler)
    url = f"http://{addr[0]}:{addr[1]}/"
    print(f"[review] 서버 시작: {url}")
    print(f"[review] captures: {CAPTURES_DIR}")
    print(f"[review] data:     {REVIEW_PATH}")
    print(f"[review] 종료: Ctrl+C")
    _open_browser_later(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[review] 종료")
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
