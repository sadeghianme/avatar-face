"""Build the standard teeth: the Reference's own teeth photo, admitted like
every mouth photo, for the continuous mouth of an avatar without teeth of
its own.

Why. Rendered with the real engine on a person who has no teeth photo (a
fictional bearded man, 2026-09-26, beside the lab Reference), the teeth the
continuous mouth drew for him read as a denture: flat grey-beige slabs with
a dark seam down the middle, no gum line, and a tongue blob in "oo" and
"th". The Reference's own photographed teeth (oral-detail-v3), borrowed
onto the same face, were clean, complete and symmetric: a little whiter and
wider than his own, and far better than the drawn ones. So an avatar
without a teeth photo of its own (no AI consent, the organization's AI
switch off, AI teeth refused or failed, or removed by the owner) gets these
(embed loadAvatarMouth), drawn where and as large as the Reference draws
them (services.performance_kit.for_standard_teeth).

What. The lab's delivery pair, frontend/public/lab/reference/
oral-detail-v3.webp and its detected rig, through
services.mouth_photo.admit_photo, the end of every mouth photo's
admission: the photo cut to its lips with their margin (crop_to_mouth),
the WebP visitors get, and the embed's own teeth test
(services.dental_photo) run on those bytes. A pair it refuses is not
written: every avatar without its own teeth would draw the drawn ones
again. Written to embed/assets/mouth-teeth.webp and mouth-teeth.rig.json;
the embed's build copies them to dist, and the API serves them beside
/mouth-motion.json, where the widget, the share page and the dashboard
load them from.

The rig given to admit_photo is rig.build_rig of the detected points, as
for an uploaded photo; only what the renderer reads of it is kept. The
lossless master of the same photo (assets/reference-performance/
oral-detail-v3.png, the same 1254 px frame, so the same rig) can be given
with --image; the default is the delivery WebP, the very pixels the lab's
Reference is rendered with.

Run from backend: .venv/bin/python scripts/build_standard_teeth.py
No database, no network and no image model: the same inputs give the same
files (for the same Pillow and libwebp).
"""

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.core.errors import Validation422  # noqa: E402
from app.services.mouth_photo import admit_photo, teeth_verdict  # noqa: E402
from app.services.photo_io import png_bytes  # noqa: E402
from app.services.rig import build_rig  # noqa: E402

REFERENCE = BACKEND.parent / "frontend/public/lab/reference"
ASSETS = BACKEND.parent / "embed/assets"
IMAGE_NAME, RIG_NAME = "mouth-teeth.webp", "mouth-teeth.rig.json"


def build(image: Path, rig: Path) -> tuple[bytes, dict]:
    """The standard teeth (the WebP and its rig) from a teeth photo and the
    rig detected on it, admitted as every mouth photo is. Validation422
    (mouth_teeth_unclear) when the embed would not draw them."""
    detected = json.loads(rig.read_text())
    with Image.open(image) as source:
        source.load()
        size = source.size
        # A clean PNG, as ingest_photo makes: the pixels, no metadata.
        png = png_bytes(source.convert("RGB"))
    if list(size) != list(detected["image_size"]):
        raise ValueError(f"{image.name} is {size[0]} x {size[1]}, its rig "
                         f"{detected['image_size']}: not the photo the rig was detected on")
    points = np.asarray(detected["points"], dtype=np.float64)
    return admit_photo(png, build_rig(points, size))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", type=Path, default=REFERENCE / "oral-detail-v3.webp")
    parser.add_argument("--rig", type=Path, default=REFERENCE / "oral-detail-v3.rig.json")
    parser.add_argument("--out", type=Path, default=ASSETS)
    args = parser.parse_args()
    try:
        photo, rig = build(args.image, args.rig)
    except Validation422 as exc:
        raise SystemExit(f"Refused, nothing written: {exc.detail} ({exc.extra})") from exc
    verdict = teeth_verdict(photo, rig)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / IMAGE_NAME).write_bytes(photo)
    rig_text = json.dumps(rig, separators=(",", ":"))
    (args.out / RIG_NAME).write_text(rig_text)
    with Image.open(io.BytesIO(photo)) as written:
        width, height = written.size
    print(f"{IMAGE_NAME}: {width} x {height} px, {len(photo)} bytes; "
          f"{RIG_NAME}: {len(rig_text)} bytes")
    print(f"Teeth test: upper arch {verdict.arch_width} px wide, {verdict.arch_pixels} px of "
          f"enamel, central crown {verdict.crown_coverage:.3f} mouth widths: accepted")


if __name__ == "__main__":
    main()
