# 타일 매치 게임 자산

## 현재 자산 (SVG 플레이스홀더)

- `tile-frame.svg` — 마작 타일 프레임 (cream + gold border + 3D depth)
- `board-bg.svg` — 게임 보드 배경 (parchment + 가벼운 데코)

## AI 이미지 업그레이드 가이드

SVG 는 즉시 medieval 느낌을 주지만, AI 가 생성한 PNG/WebP 로 교체하면 더 풍부한 디테일을 얻을 수 있어.

### 워크플로우

1. ChatGPT (DALL-E 3) 또는 Midjourney 에 아래 프롬프트로 이미지 생성
2. 같은 폴더에 동일 파일명(다른 확장자)으로 저장
   - `tile-frame.png` (투명 배경 PNG)
   - `board-bg.webp` (또는 `.jpg`)
3. `src/styles/minigame.css` 에서 background-image 경로의 확장자만 수정
   - `tile-frame.svg` → `tile-frame.png`
   - `board-bg.svg` → `board-bg.webp`

### 프롬프트 1 — 타일 프레임 (`tile-frame.png`)

```
A premium 3D rendered medieval-style game tile, viewed from a slight overhead angle.

Tile design:
- Rounded rectangle, slightly taller than wide (aspect ratio ~22:27)
- Material: aged ivory or pale cream with warm golden undertones (light theme appropriate)
- Top face has a subtly recessed inner panel — empty, ready for an icon to be overlaid later
- Decorative border: thin engraved gold or bronze trim around the inner panel (medieval heraldic feel, but minimal)
- The inner panel area is COMPLETELY EMPTY — no symbols, no characters, no decorations, no text, no icon, no markings
- Subtle drop shadow below the tile suggests it sits on a surface
- The bottom edge is ~10–15% darker hinting at 3D thickness (about 25% of tile height visible as side)
- Corners gently rounded
- Soft top-light highlight (light hits from above-left)

Output requirements:
- Transparent PNG background (full alpha channel)
- Single tile centered in the canvas with comfortable padding
- Resolution at least 512x640 (will be downscaled to ~22x27 in the game)
- Crisp, premium quality — like a tile from a high-end fantasy board game (Hearthstone / King's Throne aesthetic)
- NO text anywhere, NO Chinese characters, NO numbers, NO icons on the tile face — just an empty inscribed frame

Style: Painterly medieval fantasy game UI asset, warm and inviting (not dark or grim), photo-real with painterly detail.
```

### 프롬프트 2 — 보드 배경 (`board-bg.webp`)

```
A horizontal game board background for a medieval fantasy mahjong-style mobile puzzle game.
Theme: Light/inviting medieval kingdom aesthetic (NOT dark fantasy — should feel pleasant and bright for a casual puzzle game).

Composition:
- Top-down view of an ornate game table or playing surface
- Center area is calm, light, and uniform (so floating tiles on top remain readable)
- Edges have subtle decorative elements: gold filigree in corners, faint heraldic patterns
- A very faint kingdom crest, shield, or laurel emblem in dead center at ~10% opacity (won't compete with tiles)

Colors:
- Warm muted palette suitable for a light theme: cream, beige, pale gold, soft burgundy or forest green accents
- Center area must be LIGHT (cream/pale) — NOT dark
- NO bright saturated colors — should serve as backdrop, not focal point

Texture:
- Aged parchment, polished pale oak wood, or rich felt — pick one and stay consistent
- Subtle grain or fiber detail visible on close inspection

Style: Painterly 2D illustrated game UI background. Hearthstone or Triple Triad aesthetic.
NO characters, NO tiles, NO text, just the background surface itself.

Output requirements:
- Aspect ratio 16:9 (landscape) — composition should still work cropped to portrait or square (key elements not at edges)
- Resolution at least 1920x1080
- High quality WebP or JPG, clean compression, no JPEG artifacts
```

### 결과 검증

이미지 적용 후 `/minigame/tile-match/` 진입 → 게임 시작 → 타일이 medieval frame 으로 보이고, 게임 영역이 parchment 배경 위에 떠있어야 함. 이모지(🐶🐱…)는 frame 의 inner panel 영역에 자연스럽게 안착.
