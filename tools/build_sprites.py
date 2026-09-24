"""Pack the raw animal frames into one PixiJS spritesheet per character.

Source layout: assets/animal/<Source>/<anim>/<direction>/NN.png
Output: client/public/assets/characters/<id>.png + <id>.json
Animation names in the sheet: "<state>_<direction>", e.g. "run_east".
"""
import json
import os
import shutil
from glob import glob
from PIL import Image

SRC = "assets/animal"
OUT = "client/public/assets/characters"
DIRECTIONS = ["south", "west", "east", "north"]

# id -> (source folder, source anim used for "idle", source anim used for "run")
# Only the deer ships a real run cycle; the others reuse walk (played faster).
CHARACTERS = {
    "deer": ("Ciervo", "idle", "run"),
    "rabbit_brown": ("Conejo", "idle", "walk"),
    "rabbit_white": ("Conejo_blanco", "idle", "walk"),
    "rabbit_gray": ("Conejo_gris", "idle", "walk"),
    "wolf_gray": ("Lobo", "idle", "walk"),
    "wolf_white": ("Lobo_blanco", "idle", "walk"),
    "wolf_black": ("Lobo_negro", "idle", "walk"),
}


def load_frames(folder, anim, direction):
    paths = sorted(glob(os.path.join(SRC, folder, anim, direction, "*.png")))
    assert paths, f"no frames for {folder}/{anim}/{direction}"
    return [Image.open(p).convert("RGBA") for p in paths]


def build(char_id, folder, idle_anim, run_anim):
    rows = []  # (animation name, frames)
    for state, anim in (("idle", idle_anim), ("run", run_anim)):
        for d in DIRECTIONS:
            rows.append((f"{state}_{d}", load_frames(folder, anim, d)))

    fw, fh = rows[0][1][0].size
    cols = max(len(frames) for _, frames in rows)
    sheet = Image.new("RGBA", (cols * fw, len(rows) * fh), (0, 0, 0, 0))

    # Feet anchor: lowest opaque pixel across every frame, centered horizontally.
    # Head: highest opaque pixel, used to place name tags and chat bubbles.
    bottom, top = 0, fh
    for _, frames in rows:
        for im in frames:
            bbox = im.getbbox()
            if bbox:
                bottom = max(bottom, bbox[3])
                top = min(top, bbox[1])
    anchor = {"x": 0.5, "y": round(bottom / fh, 4)}

    frames_json = {}
    animations = {}
    for r, (name, frames) in enumerate(rows):
        animations[name] = []
        for c, im in enumerate(frames):
            sheet.paste(im, (c * fw, r * fh))
            key = f"{name}_{c:02d}"
            frames_json[key] = {
                "frame": {"x": c * fw, "y": r * fh, "w": fw, "h": fh},
                "sourceSize": {"w": fw, "h": fh},
                "spriteSourceSize": {"x": 0, "y": 0, "w": fw, "h": fh},
                "anchor": anchor,
            }
            animations[name].append(key)

    sheet.save(os.path.join(OUT, f"{char_id}.png"), optimize=True)
    data = {
        "frames": frames_json,
        "animations": animations,
        "meta": {
            "image": f"{char_id}.png",
            "size": {"w": sheet.width, "h": sheet.height},
            "scale": 1,
            # Pixels from the feet up to the top of the tallest frame.
            "height": bottom - top,
        },
    }
    with open(os.path.join(OUT, f"{char_id}.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))

    # Single south-facing idle frame, used as the portrait in the lobby.
    rows[0][1][0].save(os.path.join(OUT, f"{char_id}_portrait.png"))
    print(f"{char_id}: {fw}x{fh} frames, sheet {sheet.width}x{sheet.height}, anchor {anchor}")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for char_id, spec in CHARACTERS.items():
        build(char_id, *spec)
    shutil.copy("assets/Scene Overview.png", "client/public/assets/map.png")
