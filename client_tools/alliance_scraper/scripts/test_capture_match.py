"""[Phase 2] 캡처 1장 → OCR → DB 닉네임 매칭 + 검증 출력.

Phase 1 의 OCR 결과에 fuzzy 매칭 단계 추가.
사용자가 게임 화면 + DB 매칭 결과를 한 번에 검증 가능.

실행:
  .venv/Scripts/python.exe scripts/test_capture_match.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, config
from src.db_client import fetch_members
from src.nickname_matcher import match
from src.ranking_capture import extract_rows_from_screen


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    print(f"[adb] {cfg['device_serial']}")

    print("[db] members fetch 중...")
    db_members = fetch_members()
    print(f"[db] {len(db_members)}명 로드\n")

    print("[capture] 현재 화면 1장 캡처...")
    screen = dev.screencap()
    config.CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
    screen_path = config.CAPTURES_DIR / "test_capture_match.png"
    screen.save(screen_path)
    print(f"[saved] {screen_path}")

    print("[ocr] (rank, nickname, power) 추출 중...")
    ocr_rows = extract_rows_from_screen(screen, cfg["regions"])

    main_rows = sorted(
        (r for r in ocr_rows if not r.is_pinned), key=lambda r: r.row_cy
    )
    pinned = [r for r in ocr_rows if r.is_pinned]

    # 매칭 + 출력
    print()
    print("=== OCR + DB 매칭 결과 (본인 제외) ===")
    print(
        f"{'#':>3} {'rank':>5} {'power':>14}  "
        f"{'OCR 닉네임':<22} → {'매칭':^8} {'DB 닉네임':<22} (kingshot_id)"
    )
    print("-" * 110)

    matched_count = 0
    unmatched_count = 0

    for i, r in enumerate(main_rows, 1):
        result = match(r.nickname_raw, db_members)
        rk = str(r.rank) if r.rank is not None else "MEDAL"
        pw = f"{r.power:,}" if r.power is not None else "❌"
        ocr_nick = (r.nickname_raw or "❌")[:22]

        if result.matched:
            matched_count += 1
            ms = f"{result.matched.score:.2f}"
            db_nick = result.matched.nickname[:22]
            kid = result.matched.kingshot_id
            mark = "✓"
        else:
            unmatched_count += 1
            ms = (
                f"{result.candidates_top3[0].score:.2f}"
                if result.candidates_top3
                else "0.00"
            )
            db_nick = (
                result.candidates_top3[0].nickname[:22]
                if result.candidates_top3
                else "(없음)"
            )
            kid = (
                result.candidates_top3[0].kingshot_id
                if result.candidates_top3
                else ""
            )
            mark = "✗"

        print(
            f"{i:>3} {rk:>5} {pw:>14}  "
            f"{ocr_nick:<22} → {mark} {ms:>5} {db_nick:<22} ({kid})"
        )

        # 매칭 실패 시 top3 후보 들여쓰기로 표시
        if not result.matched:
            for j, c in enumerate(result.candidates_top3[1:], 2):
                print(
                    f"{'':>3} {'':>5} {'':>14}  "
                    f"{'':<22}   {j} {c.score:.2f} {c.nickname[:22]:<22} ({c.kingshot_id})"
                )
            print(
                f"{'':>3} {'':>5} {'':>14}  "
                f"{'(임계값 ' + f'{result.threshold:.2f})':<22}"
            )

    if pinned:
        print()
        print("=== 본인(pinned) row ===")
        for r in pinned:
            result = match(r.nickname_raw, db_members)
            rk = str(r.rank) if r.rank is not None else "(없음)"
            pw = f"{r.power:,}" if r.power is not None else "❌"
            mark = "✓" if result.matched else "✗"
            db_nick = (
                result.matched.nickname
                if result.matched
                else (result.candidates_top3[0].nickname if result.candidates_top3 else "")
            )
            print(
                f"  rank={rk} power={pw} OCR={r.nickname_raw} → {mark} DB={db_nick}"
            )

    print()
    print("=== 매칭 통계 ===")
    print(f"  총 행: {len(main_rows)}")
    print(f"  자동 매칭 성공: {matched_count}")
    print(f"  매칭 실패 (수동 검수 대기): {unmatched_count}")

    print()
    print("=== 사용자 검증 요청 ===")
    print(
        f"캡처 사진 ({screen_path.name}) + 게임 화면과 비교:\n"
        "  1) ✓ 표시된 자동 매칭 row 들이 정말 같은 사람인가?\n"
        "  2) ✗ 표시된 row 의 top3 후보 중 정답이 있는가?\n"
        "  3) Phase 3 (overlap 캡처 루프) 진행 전 매칭 로직 신뢰성 확인 차원."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
