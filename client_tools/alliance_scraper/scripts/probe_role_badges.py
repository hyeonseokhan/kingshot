"""인게임 캡처에서 각 row 의 R 등급 배지 위치를 시각화 + crop 추출.

- 화면 해상도: 900×1600
- 각 row 의 avatar 좌상단에 작은 둥근 R 배지가 있음
- 본 스크립트는 우선 row 좌표를 추정하여 각 row 의 [좌상단 ~50×50] 영역을 crop
- 사용자 확인 후 등급별 template 으로 저장
"""
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC = ROOT / "_probe" / "ingame-now.png"
OUT = ROOT / "_probe" / "role_crops"
OUT.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC)
W, H = img.size
print(f"image: {W}×{H}")

# 화면에서 row 위치 추정
FIRST_ROW_Y = 295
ROW_H = 130
ROW_HALF = 60
# avatar 좌측 위치 (배지는 avatar 의 좌상단 모서리에 걸쳐 있음)
AVATAR_X = 150
BADGE_W = 70
BADGE_H = 70
BADGE_OFFSET_X = -5
BADGE_OFFSET_Y = -10

annotated = img.copy()
draw = ImageDraw.Draw(annotated)

# 보이는 row 9개 정도 + 핀된 본인 row(맨 아래)
positions = []
for i in range(10):
    cy = FIRST_ROW_Y + i * ROW_H
    if cy + ROW_HALF > H - 200:  # 핀된 row 와 겹치면 중단
        break
    x0 = AVATAR_X + BADGE_OFFSET_X
    y0 = cy - ROW_HALF + 5 + BADGE_OFFSET_Y
    x1 = x0 + BADGE_W
    y1 = y0 + BADGE_H
    positions.append((i + 1, x0, y0, x1, y1, cy))

# 핀된 본인 row (맨 아래)
PINNED_OWN_Y = 1455
positions.append(("own", AVATAR_X + BADGE_OFFSET_X, PINNED_OWN_Y - ROW_HALF + 5 + BADGE_OFFSET_Y,
                  AVATAR_X + BADGE_OFFSET_X + BADGE_W, PINNED_OWN_Y - ROW_HALF + 5 + BADGE_OFFSET_Y + BADGE_H,
                  PINNED_OWN_Y))

for label, x0, y0, x1, y1, cy in positions:
    draw.rectangle((x0, y0, x1, y1), outline="red", width=3)
    draw.text((x1 + 5, y0), str(label), fill="red")
    crop = img.crop((x0, y0, x1, y1))
    crop.save(OUT / f"row_{label}.png")

annotated.save(ROOT / "_probe" / "ingame-annotated.png")
print(f"annotated → _probe/ingame-annotated.png")
print(f"crops    → _probe/role_crops/ ({len(positions)} crops)")
