"""Build the 478-point face template that animals and cartoons start from.

Provenance: the points are MediaPipe's detection of the embed demo portrait
(embed/src/__tests__/fixtures/human-rig.json), a FICTIONAL, AI-generated
face — no real person's geometry is shipped. A detection rather than a
hand-made layout because the fit needs every index to mean what it means in
MediaPipe (61 the left mouth corner, 10 the top of the forehead, 152 the
chin), and a detected frontal face is the only honest source of all 478 at
once.

One correction is applied, for the same reason the fit applies it: the
portrait's lips are closed, so its inner-lip rings coincide (13 even sits a
tenth of a pixel BELOW 14). A template whose upper lip is not above its
lower lip gives every lip triangle between them zero or inverted area, and
the fit validator would then count folds that no marking caused. The lips
are parted by anchor_fit.part_lips, as a mouth-line fit parts a detected
closed mouth.

Pure computation, deterministic. Run from backend/ and commit the result:

    .venv/bin/python -m scripts.build_face_template
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from app.services.anchor_fit import part_lips
from app.services.face_template import TEMPLATE_PATH

SOURCE = Path(__file__).resolve().parents[2] / "embed/src/__tests__/fixtures/human-rig.json"


def build() -> dict:
    points = part_lips(np.array(json.loads(SOURCE.read_text())["points"], dtype=float)[:478])

    # Normalised to the face box, the rig's own `face_box`: placing the
    # template into a box then makes that box the rig's face box.
    lo = points.min(axis=0)
    size = points.max(axis=0) - lo
    unit = (points - lo) / size
    return {
        "source": "embed/src/__tests__/fixtures/human-rig.json (fictional, AI-generated portrait)",
        "aspect": round(float(size[0] / size[1]), 6),
        "points": [[round(float(x), 6), round(float(y), 6)] for x, y in unit],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", type=Path, default=TEMPLATE_PATH)
    args = parser.parse_args()
    args.output.write_text(json.dumps(build(), separators=(",", ":")) + "\n")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
