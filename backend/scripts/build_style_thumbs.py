"""Build the creation wizard's style thumbnails from generated cut-outs.

The wizard shows each model and look as a small picture (the Human and
Animal cards, and the Realistic, Animation and Cartoon cards). They are
real outputs of the wizard's own prompts (services.wizard) on a plain
backdrop, cut out (services.backdrop), cropped to head and shoulders and
saved as small WebPs WITH transparency, so the card's own warm backdrop
(light or dark) shows through. Human + Realistic is the Reference
portrait (frontend/src/assets/demo/portrait.webp), not made here.

    cd backend
    PYTHONPATH=. .venv/bin/python scripts/build_style_thumbs.py CUTOUT_DIR

CUTOUT_DIR holds {human,animal}-{realistic,animation,cartoon}.cut.png (RGBA,
transparent background); a missing pair is skipped. Output:
frontend/src/assets/wizard/<model>-<look>.webp, 360 px square, each under
30 KB (the quality is lowered until it is).
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "assets" / "wizard"
SIZE = 360
MAX_BYTES = 30 * 1024
# Head room above the subject, and the crop's side relative to its width.
TOP_MARGIN = 0.07
PAIRS = [
    (model, look)
    for model in ("human", "animal")
    for look in ("realistic", "animation", "cartoon")
    if (model, look) != ("human", "realistic")
]


def crop_square(image: Image.Image) -> Image.Image:
    """Head and shoulders: a square as wide as the subject, from just above
    its top, centred on it."""
    alpha = np.asarray(image)[:, :, 3] > 24
    ys, xs = np.nonzero(alpha)
    left, right, top = int(xs.min()), int(xs.max()), int(ys.min())
    side = min(max(right - left, 1), image.width, image.height)
    side = int(side * 1.04)
    x0 = int(round((left + right) / 2 - side / 2))
    y0 = int(round(top - TOP_MARGIN * side))
    x0 = max(0, min(x0, image.width - side))
    y0 = max(0, min(y0, image.height - side))
    return image.crop((x0, y0, x0 + side, y0 + side))


def encode(image: Image.Image) -> bytes:
    for quality in range(86, 40, -6):
        buf = io.BytesIO()
        image.save(buf, format="WEBP", quality=quality, alpha_quality=90, method=6)
        if buf.tell() <= MAX_BYTES:
            break
    return buf.getvalue()


def main(source: Path) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    built = 0
    for model, look in PAIRS:
        path = source / f"{model}-{look}.cut.png"
        if not path.exists():
            print("missing", path.name)
            continue
        with Image.open(path) as opened:
            thumb = crop_square(opened.convert("RGBA")).resize(
                (SIZE, SIZE), Image.Resampling.LANCZOS
            )
        data = encode(thumb)
        (OUT / f"{model}-{look}.webp").write_bytes(data)
        print(f"{model}-{look}.webp {len(data) / 1024:.1f} KB")
        built += 1
    return 0 if built else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(Path(sys.argv[1])))
