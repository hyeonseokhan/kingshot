"""인게임 캡처에서 R1~R5 template 으로 매칭 검증 + 시각화.

각 등급 template 을 multi-scale 로 시도하여 모든 hit 위치 반환.
"""
import cv2
import numpy as np
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).parent.parent
ASSETS = ROOT / "assets"
SRC = ROOT / "_probe" / "ingame-now.png"
OUT = ROOT / "_probe" / "role-match-result.png"

THRESHOLD = 0.62

# 화면 RGB → BGR
screen_pil = Image.open(SRC).convert("RGB")
screen_bgr = cv2.cvtColor(np.asarray(screen_pil), cv2.COLOR_RGB2BGR)
H, W = screen_bgr.shape[:2]
print(f"screen: {W}×{H}")

annotated = screen_pil.copy()
draw = ImageDraw.Draw(annotated)

# 각 등급별
COLORS = {1: "#888888", 2: "#22aa22", 3: "#2266ee", 4: "#aa44ee", 5: "#ee9922"}
for r in range(1, 6):
    tpl_path = ASSETS / f"R{r}.png"
    tpl_pil = Image.open(tpl_path).convert("RGB")
    tpl_bgr = cv2.cvtColor(np.asarray(tpl_pil), cv2.COLOR_RGB2BGR)

    # 화면 해상도 대비 template 이 작아서 multi-scale 시도 (1.5x ~ 3x)
    best_hits = []
    for scale_pct in [140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250]:
        new_w = tpl_bgr.shape[1] * scale_pct // 100
        new_h = tpl_bgr.shape[0] * scale_pct // 100
        scaled = cv2.resize(tpl_bgr, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
        if scaled.shape[0] >= H or scaled.shape[1] >= W:
            continue
        res = cv2.matchTemplate(screen_bgr, scaled, cv2.TM_CCOEFF_NORMED)
        ys, xs = np.where(res >= THRESHOLD)
        for x, y in zip(xs, ys):
            score = float(res[y, x])
            best_hits.append((score, x, y, new_w, new_h, scale_pct))

    # NMS — 같은 영역의 중복 제거 (가까운 hit 들 중 최고 score 만)
    best_hits.sort(key=lambda h: -h[0])
    kept = []
    for h in best_hits:
        score, x, y, w, h_, sc = h
        cx, cy = x + w // 2, y + h_ // 2
        too_close = any(abs(cx - (k[1] + k[3] // 2)) < 30 and abs(cy - (k[2] + k[4] // 2)) < 30 for k in kept)
        if not too_close:
            kept.append(h)

    print(f"R{r}: {len(kept)} hit{'s' if len(kept) != 1 else ''}", end="")
    if kept:
        print(f"   (best score={kept[0][0]:.3f}, scale={kept[0][5]}%)")
        for score, x, y, w, h_, sc in kept[:8]:
            draw.rectangle((x, y, x + w, y + h_), outline=COLORS[r], width=2)
            draw.text((x + w + 2, y - 2), f"R{r}", fill=COLORS[r])
    else:
        print()

annotated.save(OUT)
print(f"\nsaved → {OUT}")
