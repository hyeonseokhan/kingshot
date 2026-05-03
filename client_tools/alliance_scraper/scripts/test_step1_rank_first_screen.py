"""[Step 1-A] 랭크 정확도 — 첫 화면 (스크롤 없음).

전제:
  LDPlayer 에서 '연맹 → 전투력 랭킹' 화면을 띄우고 최상단(rank 1 근처) 에 있어야 함.

목적:
  메인 화면 1장 캡처 → rows.extract_rows + scraper._identify_top3_rank 결과 출력.
  사용자가 게임 화면 보면서 직접 검증 가능하게 닉네임 추정도 함께.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, config, nav as nav_mod, rows
from src.scraper import AllianceScraper


def main() -> int:
    cfg = config.load()
    dev = adb.connect_from_config(cfg)
    print(f"[adb] {cfg['device_serial']}\n")

    nav_ = nav_mod.RankingNavigator(dev, cfg)
    if not nav_.is_on_ranking_screen():
        print("[!] 랭킹 화면이 아닙니다. 게임에서 '연맹 → 전투력 랭킹' 화면을 띄워주세요.")
        return 3

    # 닉네임 추정용 (4/27 cache, 사용자 검증 보조)
    files = sorted(config.OUTPUT_DIR.glob("alliance_*.json"))
    known_by_power = {}
    if files:
        payload = json.load(files[-1].open(encoding="utf-8"))
        known_by_power = {m["power"]: m.get("name") for m in payload.get("members", []) if m.get("power")}

    def guess_name(power: int, tol: float = 0.05) -> str:
        for kp, nm in known_by_power.items():
            if power and abs(kp - power) / power < tol:
                return nm or "?"
        return "(unknown)"

    print("[scroll] 최상단으로 정렬...")
    nav_.scroll_to_top(verbose=False)

    print("[capture] 첫 화면 1장 캡처...")
    screen = dev.screencap()
    regions = cfg["regions"]

    obs = rows.extract_rows(
        screen,
        first_row_y=regions["first_row_y"], row_height=regions["row_height"],
        rows_per_screen=regions["rows_per_screen"], row_half_height=regions["row_half_height"],
        power_col_x=tuple(regions["power_col_x"]), avatar_col_x=tuple(regions["avatar_col_x"]),
        pinned_own_y=regions["pinned_own_y"], power_min=regions.get("power_min", 1_000_000),
    )

    # rank 가 None 인 row 는 _identify_top3_rank 로 보강 (1-3위 왕관 템플릿)
    sc = AllianceScraper(dev, cfg)
    enhanced = []
    for o in obs:
        rank = o.rank
        rank_source = "OCR"
        if rank is None and not o.is_pinned:
            rank = sc._identify_top3_rank(screen, o.row_cy)
            if rank is not None:
                rank_source = "TEMPLATE"
        enhanced.append((o, rank, rank_source))

    # 본인(pinned) 분리
    main_rows = [(o, r, src) for o, r, src in enhanced if not o.is_pinned]
    pinned = [(o, r, src) for o, r, src in enhanced if o.is_pinned]

    print()
    print("=== 추출 결과 (본인 제외, row_cy 순) ===")
    print(f"{'#':>3} {'rank':>5} {'source':>9} {'power':>14}  {'cy':>5}  추정 닉네임")
    print("-" * 70)
    main_rows.sort(key=lambda x: x[0].row_cy)
    for i, (o, rank, src) in enumerate(main_rows, 1):
        rk_str = str(rank) if rank else "❌ MISS"
        nm = guess_name(o.power) if o.power else "?"
        print(f"{i:>3} {rk_str:>5} {src:>9} {o.power:>14,}  {o.row_cy:>5}  {nm}")

    if pinned:
        print()
        print(f"=== 본인(pinned) row ===")
        for o, rank, src in pinned:
            rk_str = str(rank) if rank else "(없음)"
            print(f"  rank={rk_str} power={o.power:,} cy={o.row_cy}")

    # 정확도 통계
    total = len(main_rows)
    rank_extracted = sum(1 for _, r, _ in main_rows if r is not None)
    print()
    print(f"=== 정확도 ===")
    print(f"  추출된 row: {total}")
    print(f"  랭크 추출 성공: {rank_extracted}/{total} ({rank_extracted/total*100:.0f}% if total else 0)")
    if rank_extracted < total:
        miss = [(o, src) for o, r, src in main_rows if r is None]
        print(f"  랭크 추출 실패: {len(miss)}건")
        for o, src in miss:
            print(f"    cy={o.row_cy} power={o.power:,}")

    print()
    print("=== 사용자 검증 요청 ===")
    print("게임 화면에서 다음을 비교해주세요:")
    print("  1) 화면에 보이는 rank 들이 위 표의 'rank' 와 일치하는가?")
    print("  2) 추정 닉네임이 화면의 닉네임과 일치하는가? (4/27 데이터 기준이라 일부 오차 가능)")
    print("  3) ❌ MISS 가 있다면 그 위치의 실제 rank/닉네임이 무엇인가?")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
