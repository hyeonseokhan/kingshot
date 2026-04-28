"""rows.match_role_badges + find_role_for_row 통합 검증.

각 row 의 row_cy 에서 어떤 R 등급이 인식되는지 확인.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image
from src.rows import match_role_badges, find_role_for_row

ROOT = Path(__file__).parent.parent
SRC = ROOT / "_probe" / "ingame-now.png"

img = Image.open(SRC)
print(f"image: {img.size}")

hits = match_role_badges(img)
print(f"\n전체 hit 수: {len(hits)}")
for r, score, cx, cy in sorted(hits, key=lambda h: h[3]):
    print(f"  R{r} score={score:.3f} ({cx}, {cy})")

# 시각으로 측정한 row_cy 들
ROWS = [
    ("1위 SsungBi (R5 기대)", 320),
    ("2위 Raducanu (R4)",     442),
    ("3위 Pirate King (R4)",  570),
    ("4위 dean (R4)",         700),
    ("5위 KASI (R4)",         830),
    ("6위 King KORKO (R4)",   960),
    ("7위 Rai (?)",          1090),
    ("20위 Toycode (R3)",    1455),
]
print("\nrow 별 검출 결과:")
for label, row_cy in ROWS:
    role = find_role_for_row(hits, row_cy)
    print(f"  cy={row_cy:>4} → {role!r:>6}  ({label})")
