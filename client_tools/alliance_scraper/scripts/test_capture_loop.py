"""[Phase 3] Overlap 캡처 루프 — 랭킹 최상단부터 끝까지 스와이프하며 모든 행 수집.

전제:
  LDPlayer 에서 '연맹 → 전투력 랭킹' 화면을 띄우고 최상단에 있어야 함.

인자:
  --total N         (필수) 현재 연맹원 총 수. 미지정 시 즉시 에러.
  --max-captures N  (옵션, 기본 30) 안전 제한.
  --dry-run         (옵션) 첫 2 캡처만 (overlap 검증용).
  --keep            (옵션) 기존 captures/loop_*.png + review.json 보존.
                    기본은 시작 시 정리 (사용자 요청).

실행:
  .venv/Scripts/python.exe scripts/test_capture_loop.py --total 100
  .venv/Scripts/python.exe scripts/test_capture_loop.py --total 100 --dry-run

산출물:
  captures/loop_<ts>_NN.png   (각 캡처 화면)
  captures/review.json        (검수 도구용 — DB 매칭 포함)
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src import adb, config
from src.db_client import fetch_members
from src.nickname_matcher import match
from src.ranking_capture import OcrRow, collect_all_rows


def _cleanup_captures(captures_dir: Path) -> int:
    """기존 loop_*.png + review.json 삭제. 사용자 요청: 매번 새 결과만."""
    removed = 0
    if not captures_dir.exists():
        return 0
    for p in captures_dir.glob("loop_*.png"):
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
    rj = captures_dir / "review.json"
    if rj.exists():
        try:
            rj.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def _row_to_dict(r: OcrRow) -> dict:
    """OcrRow → JSON 직렬화 가능한 dict."""
    return {
        "rank": r.rank,
        "rank_conf": round(r.rank_conf, 3),
        "nickname_raw": r.nickname_raw,
        "nickname_conf": round(r.nickname_conf, 3),
        "power": r.power,
        "power_conf": round(r.power_conf, 3),
        "row_cy": r.row_cy,
        "is_pinned": r.is_pinned,
        "source_capture": r.source_capture,
    }


def _attach_match(row_dict: dict, db_members: list[dict]) -> dict:
    """OCR row 에 DB 매칭 결과 attach. 매칭 성공 시 kingshot_id/db_nickname/score,
    실패 시 top3 후보 제공 (검수자가 dropdown 선택)."""
    nick = row_dict.get("nickname_raw") or ""
    if not nick:
        return {
            **row_dict,
            "kingshot_id": "",
            "db_nickname": "",
            "match_score": 0.0,
            "match_status": "no_nickname",
            "candidates": [],
        }
    res = match(nick, db_members)
    candidates = [
        {
            "kingshot_id": c.kingshot_id,
            "nickname": c.nickname,
            "score": round(c.score, 3),
        }
        for c in res.candidates_top3
    ]
    if res.matched:
        return {
            **row_dict,
            "kingshot_id": res.matched.kingshot_id,
            "db_nickname": res.matched.nickname,
            "match_score": round(res.matched.score, 3),
            "match_status": "matched",
            "candidates": candidates,
        }
    return {
        **row_dict,
        "kingshot_id": "",
        "db_nickname": "",
        "match_score": candidates[0]["score"] if candidates else 0.0,
        "match_status": "needs_review",
        "candidates": candidates,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 3 overlap capture loop")
    parser.add_argument(
        "--total",
        type=int,
        required=True,
        help="현재 연맹원 총 수 (필수). 사용자 결정사항 8번.",
    )
    parser.add_argument(
        "--max-captures",
        type=int,
        default=30,
        help="안전 제한 (기본 30).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="첫 2 캡처만 (overlap dedup 동작 검증용).",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="기본 cleanup 비활성화 (기존 캡처/JSON 보존).",
    )
    args = parser.parse_args()

    if args.total <= 0:
        print("[!] --total 은 양의 정수여야 합니다.")
        return 2

    cfg = config.load()
    captures_dir = config.CAPTURES_DIR

    if not args.keep:
        removed = _cleanup_captures(captures_dir)
        if removed:
            print(f"[cleanup] 기존 파일 {removed}개 삭제 (loop_*.png + review.json)")

    dev = adb.connect_from_config(cfg)
    print(f"[adb] {cfg['device_serial']}")
    print(f"[target] 총 {args.total}명")
    if args.dry_run:
        print("[dry-run] 첫 2 캡처만 실행 — overlap dedup 동작 검증용")
        max_captures = 2
    else:
        max_captures = args.max_captures

    print(
        f"[loop] 시작 (max_captures={max_captures}). "
        "랭킹 화면 최상단인지 다시 한 번 확인하세요.\n"
    )

    result = collect_all_rows(
        dev=dev,
        cfg=cfg,
        target_total=args.total,
        captures_dir=captures_dir,
        max_captures=max_captures,
        verbose=True,
    )

    # 결과 정리
    total_collected = len(result.rows_by_power) + len(result.medal_rows)
    print()
    print(f"=== 종료 ({result.stop_reason}) ===")
    print(f"  캡처 수: {result.captures_count}")
    print(f"  수집된 unique row: {total_collected}")
    print(f"    - 메달 (1·2·3위 후보): {len(result.medal_rows)}")
    print(f"    - rank 있는 row: {len(result.rows_by_power)}")
    if result.pinned:
        print(
            f"  본인(pinned): rank={result.pinned.rank} power={result.pinned.power:,}"
            f" nick={result.pinned.nickname_raw}"
        )

    # ============================================================
    # DB 매칭 (Phase 4 통합)
    # ============================================================
    print()
    print("[db] members fetch + 매칭...")
    db_members = fetch_members()
    print(f"[db] {len(db_members)}명 로드")

    medal_sorted = sorted(result.medal_rows, key=lambda r: r.row_cy)
    ranked_sorted = sorted(
        result.rows_by_power.values(),
        key=lambda r: (r.rank if r.rank is not None else 99999),
    )

    medal_dicts = [_attach_match(_row_to_dict(r), db_members) for r in medal_sorted]
    ranked_dicts = [_attach_match(_row_to_dict(r), db_members) for r in ranked_sorted]
    pinned_dict = (
        _attach_match(_row_to_dict(result.pinned), db_members)
        if result.pinned
        else None
    )

    matched_count = sum(
        1 for d in (*medal_dicts, *ranked_dicts) if d["match_status"] == "matched"
    )
    needs_review = sum(
        1 for d in (*medal_dicts, *ranked_dicts) if d["match_status"] == "needs_review"
    )
    print(f"[match] 자동 매칭: {matched_count} / 검수 필요: {needs_review}")

    # ============================================================
    # 콘솔 표 (사용자 즉시 확인용 — 기존 출력 유지)
    # ============================================================
    print()
    print("=== 수집된 row (정렬: 메달 → rank, DB 매칭 포함) ===")
    print(
        f"{'#':>3} {'rank':>6} {'power':>14} {'p_conf':>7}  "
        f"{'OCR 닉네임':<22} {'→':^3} {'kingshot_id':<14} {'DB 닉네임':<22}"
    )
    print("-" * 110)
    counter = 1
    for d in (*medal_dicts, *ranked_dicts):
        rk = "MEDAL" if d["rank"] is None else str(d["rank"])
        pw = f"{d['power']:,}" if d["power"] is not None else "❌"
        nick = (d["nickname_raw"] or "❌")[:22]
        mark = "✓" if d["match_status"] == "matched" else "✗"
        kid = d["kingshot_id"] or "(검수)"
        db_nick = (d["db_nickname"] or "")[:22]
        print(
            f"{counter:>3} {rk:>6} {pw:>14} {d['power_conf']:>7.2f}  "
            f"{nick:<22} {mark:^3} {kid:<14} {db_nick:<22}"
        )
        counter += 1

    # rank conflict 알림
    if result.rank_conflicts:
        print()
        print(
            f"=== ⚠️ rank conflict ({len(result.rank_conflicts)}건) — "
            "OCR 가 잘못 읽었을 가능성, 캡처 PNG 비교 필요 ==="
        )
        for rk, rows in result.rank_conflicts:
            print(f"  rank={rk}:")
            for r in rows:
                pw = f"{r.power:,}" if r.power is not None else "❌"
                print(
                    f"    power={pw} OCR={r.nickname_raw} "
                    f"(p_conf={r.power_conf:.2f}, n_conf={r.nickname_conf:.2f})"
                )

    # 누락된 rank 검출
    missing: list[int] = []
    if not args.dry_run:
        all_ranks = sorted(
            r.rank for r in result.rows_by_power.values() if r.rank is not None
        )
        if all_ranks:
            expected = set(range(min(all_ranks), max(all_ranks) + 1))
            missing = sorted(expected - set(all_ranks))
        if missing:
            print()
            print(f"=== ⚠️ 누락된 rank ({len(missing)}건) — 스와이프 강도 점검 필요 ===")
            print("  ", missing)

    # ============================================================
    # review.json 저장 — 검수 도구가 사용
    # ============================================================
    review_payload = {
        "schema_version": 1,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "target_total": args.total,
        "stop_reason": result.stop_reason,
        "captures_count": result.captures_count,
        "captures": [p.name for p in result.captures_saved],
        "stats": {
            "total_collected": total_collected,
            "medal_count": len(result.medal_rows),
            "ranked_count": len(result.rows_by_power),
            "matched": matched_count,
            "needs_review": needs_review,
            "missing_ranks": missing,
            "rank_conflicts": [rk for rk, _ in result.rank_conflicts],
        },
        "medal_rows": medal_dicts,
        "ranked_rows": ranked_dicts,
        "pinned": pinned_dict,
    }
    review_path = captures_dir / "review.json"
    review_path.write_text(
        json.dumps(review_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print()
    print("=== 산출물 ===")
    print(f"  캡처 PNG: {captures_dir} ({result.captures_count}장)")
    print(f"  검수용 JSON: {review_path}")
    print()
    print("=== 다음 단계 — 검수 도구 ===")
    print(f"  .venv/Scripts/python.exe scripts/run_review.py")
    print(f"  → 브라우저에서 좌측 사진 + 우측 표 검수, kingshot_id 직접 입력 후 저장")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
