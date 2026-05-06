"""[Phase 1] 랭킹 화면 1장 캡처 → (rank, nickname, power) OCR + 사용자 검증 출력.

전제:
  LDPlayer 에서 '연맹 → 전투력 랭킹' 화면을 띄우고 최상단에 있어야 함.

목적:
  새 ranking_capture.extract_rows_from_screen() 가 정상 작동하는지 검증.
  사용자가 게임 화면 보면서 표 비교 가능 — rank/닉네임/전투력 모두.

실행:
  .venv/Scripts/python.exe scripts/test_capture_one.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, config
from src.ranking_capture import extract_rows_from_screen


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    print(f"[adb] {cfg['device_serial']}\n")

    print("[capture] 현재 화면 1장 캡처...")
    screen = dev.screencap()

    # 캡처 사진 저장 — 사용자가 직접 확인 + 사용자 검수에서 참고
    config.CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
    screen_path = config.CAPTURES_DIR / "test_capture_one.png"
    screen.save(screen_path)
    print(f"[saved] {screen_path}\n")

    print("[ocr] (rank, nickname, power) 추출 중... (EasyOCR 첫 호출 시 5~10s)")
    rows = extract_rows_from_screen(screen, cfg["regions"])

    main_rows = [r for r in rows if not r.is_pinned]
    pinned = [r for r in rows if r.is_pinned]

    # row_cy 순으로 정렬 (화면 위→아래)
    main_rows.sort(key=lambda r: r.row_cy)

    print()
    print("=== 추출 결과 (본인 제외, 화면 위→아래 순) ===")
    print(
        f"{'#':>3} {'rank':>5} {'r_conf':>7} {'power':>14} {'p_conf':>7}  "
        f"{'cy':>5}  닉네임 (n_conf)"
    )
    print("-" * 90)
    for i, r in enumerate(main_rows, 1):
        rk = str(r.rank) if r.rank is not None else "MEDAL?"
        pw = f"{r.power:,}" if r.power is not None else "❌"
        nick = r.nickname_raw if r.nickname_raw else "❌"
        print(
            f"{i:>3} {rk:>5} {r.rank_conf:>7.2f} {pw:>14} {r.power_conf:>7.2f}  "
            f"{r.row_cy:>5}  {nick} ({r.nickname_conf:.2f})"
        )

    if pinned:
        print()
        print("=== 본인(pinned) row ===")
        for r in pinned:
            rk = str(r.rank) if r.rank is not None else "(없음)"
            pw = f"{r.power:,}" if r.power is not None else "❌"
            nick = r.nickname_raw if r.nickname_raw else "❌"
            print(
                f"  rank={rk} power={pw} cy={r.row_cy} 닉네임={nick} "
                f"(rank_conf={r.rank_conf:.2f}, power_conf={r.power_conf:.2f}, "
                f"nick_conf={r.nickname_conf:.2f})"
            )

    # 정확도 통계
    n_total = len(main_rows)
    n_rank = sum(1 for r in main_rows if r.rank is not None)
    n_power = sum(1 for r in main_rows if r.power is not None)
    n_nick = sum(1 for r in main_rows if r.nickname_raw)

    print()
    print("=== 추출 통계 ===")
    print(f"  총 행: {n_total}")
    print(f"  rank 추출: {n_rank}/{n_total} (1·2·3 위는 메달이라 정상)")
    print(f"  power 추출: {n_power}/{n_total}")
    print(f"  nickname 추출: {n_nick}/{n_total}")

    print()
    print("=== 사용자 검증 요청 ===")
    print("게임 화면(또는 _probe/test_capture_one.png) 과 비교:")
    print("  1) 닉네임이 화면과 일치하는가?")
    print("  2) 전투력이 화면과 일치하는가?")
    print("  3) rank 가 4 이후 행에서 정확한가?")
    print("  4) ❌ 또는 OCR 신뢰도 낮은 (<0.7) 행이 있다면 어느 행인가?")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
