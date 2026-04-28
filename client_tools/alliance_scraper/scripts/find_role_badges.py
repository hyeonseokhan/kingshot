"""R 등급 배지 자동 탐지 — 보라색/금색 cluster 위치 찾기.

각 row 의 avatar 좌상단 영역에서 보라(R4) 픽셀 cluster 의 중심을 찾고,
표시한 결과를 시각화한다. 이걸로 정확한 badge 좌표를 알아낸다.
"""
import numpy as np
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC = ROOT / "_probe" / "ingame-now.png"

img = Image.open(SRC).convert("RGB")
arr = np.array(img)
H, W, _ = arr.shape
print(f"image: {W}×{H}")

# R4 보라 색상 범위 (사용자가 첨부한 작은 이미지 기준 추정)
# 보라 = R 80-160, G 50-110, B 160-220
def is_purple(r, g, b):
    return 80 <= r <= 170 and 50 <= g <= 120 and 160 <= b <= 230

# R 배지가 있을 만한 영역만 검사 (좌측 1/3, 위에서 270 ~ 1500)
# 픽셀별 검사
mask = np.zeros((H, W), dtype=bool)
search_x_max = 350
search_y_min = 200
search_y_max = 1550
sub = arr[search_y_min:search_y_max, :search_x_max]
sub_mask = (
    (sub[..., 0] >= 80) & (sub[..., 0] <= 170) &
    (sub[..., 1] >= 50) & (sub[..., 1] <= 120) &
    (sub[..., 2] >= 160) & (sub[..., 2] <= 230)
)
mask[search_y_min:search_y_max, :search_x_max] = sub_mask

print(f"보라 픽셀 수: {sub_mask.sum()}")

# 연결된 cluster 들 찾기 (단순 — 밴드 단위로 row 별 분리)
# 일반 row height 약 130. 각 row 에서 보라 픽셀의 평균 위치 (중심) 찾기.
ROW_H = 130
FIRST_ROW_Y = 295
clusters = []
for row_idx in range(11):
    cy = FIRST_ROW_Y + row_idx * ROW_H
    band_y0 = max(0, cy - 65)
    band_y1 = min(H, cy + 65)
    band = mask[band_y0:band_y1, :search_x_max]
    if band.sum() < 50:
        continue
    ys, xs = np.where(band)
    badge_cx = int(xs.mean()) + 0
    badge_cy = int(ys.mean()) + band_y0
    px_count = int(band.sum())
    clusters.append((row_idx + 1, badge_cx, badge_cy, px_count))
    print(f"row {row_idx + 1}: badge ~ ({badge_cx}, {badge_cy}), purple px = {px_count}")

# 핀된 본인 row
band_y0, band_y1 = 1390, 1520
band = mask[band_y0:band_y1, :search_x_max]
if band.sum() > 50:
    ys, xs = np.where(band)
    print(f"pinned own: badge ~ ({int(xs.mean())}, {int(ys.mean()) + band_y0}), purple px = {int(band.sum())}")

# 시각화
out = img.copy()
draw = ImageDraw.Draw(out)
for r, cx, cy, _ in clusters:
    draw.ellipse((cx - 35, cy - 35, cx + 35, cy + 35), outline="lime", width=3)
    draw.text((cx + 40, cy - 10), f"R{r}", fill="lime")
out.save(ROOT / "_probe" / "ingame-purple-detected.png")
print(f"saved → _probe/ingame-purple-detected.png")
