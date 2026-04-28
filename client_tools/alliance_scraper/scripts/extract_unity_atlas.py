"""Unity asset bundle 에서 PNG 추출."""
import sys
from pathlib import Path
import UnityPy

bundle = Path(r"C:\temp\kingshot_apk\atlas_ui_alliance.unity3d")
out = Path(r"C:\temp\kingshot_apk\atlas_extracted")
out.mkdir(parents=True, exist_ok=True)

env = UnityPy.load(str(bundle))
print(f"objects: {len(env.objects)}")
extracted = 0
for obj in env.objects:
    if obj.type.name in ("Texture2D", "Sprite"):
        try:
            data = obj.read()
            name = getattr(data, "m_Name", None) or getattr(data, "name", None) or f"obj_{obj.path_id}"
            if hasattr(data, "image") and data.image:
                img = data.image
                save_path = out / f"{name}.png"
                img.save(save_path)
                extracted += 1
        except Exception as e:
            print(f"  fail: {obj.type.name} — {e}")

print(f"extracted: {extracted} → {out}")
# R 등급 후보만 추려서
matches = [p for p in out.glob("*.png") if any(s in p.stem.lower() for s in ("rank", "role", "r1", "r2", "r3", "r4", "r5", "officer"))]
print(f"\n관련 후보:")
for p in matches:
    print(f"  {p.name}")
