"""Build a 3D head (GLB) from one picture: the head3d spike's command line.

    .venv/bin/python scripts/build_head3d.py --image photo.png --out head.glb \
        [--cut cutout.png] [--face-type human|cartoon|animal] [--look photo|render|flat] \
        [--teeth teeth.webp --teeth-rig teeth.rig.json] [--matte] [--texture webp|png] \
        [--rig-out rig.json] [--bake-out bake.json] [--report report.json] [--template]

Landmarks come from the local MediaPipe model (backend/models, read-only);
the morph targets from the node bake of the 2D engine (embed/dist). No
database, no storage, no remote service: every output goes to a file.
`--matte` cuts an opaque picture out with the local selfie segmenter;
`--template` builds an undetected face from the face template at its
default box, which is where the product's marking panel would start.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.core import config  # noqa: E402

MODELS = BACKEND / "models"
settings = config.Settings(
    _env_file=None,
    rig_model_path=str(MODELS / "face_landmarker.task"),
    segment_model_path=str(MODELS / "selfie_segmenter.tflite"),
)
config.get_settings = lambda: settings

from PIL import Image  # noqa: E402
import numpy as np  # noqa: E402

from app.services import rig as rig_service  # noqa: E402
from app.services.head3d.bake import bake_rig  # noqa: E402
from app.services.head3d.build import HeadSubject, build_head  # noqa: E402
from app.services.landmarks import detect  # noqa: E402

PROFILES = {"human": None, "cartoon": "toon@1", "animal": "animal@2"}
STANDARD_TEETH = BACKEND.parent / "embed/assets/mouth-teeth.webp"
STANDARD_TEETH_RIG = BACKEND.parent / "embed/assets/mouth-teeth.rig.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", type=Path, required=True, help="the picture the landmarks are found in")
    parser.add_argument("--cut", type=Path, help="its cut-out (RGBA); defaults to the picture itself")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--face-type", choices=sorted(PROFILES), default="human")
    parser.add_argument("--look", choices=("photo", "render", "flat"), default="photo")
    parser.add_argument("--teeth", type=Path, default=STANDARD_TEETH)
    parser.add_argument("--teeth-rig", type=Path, default=STANDARD_TEETH_RIG)
    parser.add_argument("--matte", action="store_true", help="cut an opaque picture out with the selfie segmenter")
    parser.add_argument("--texture", choices=("webp", "png"), default="webp")
    parser.add_argument("--template", action="store_true", help="use the face template when no face is detected")
    parser.add_argument("--rig-out", type=Path)
    parser.add_argument("--bake-out", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    started = time.perf_counter()
    image = Image.open(args.image)
    image.load()
    detect_started = time.perf_counter()
    found = detect(image)
    detect_s = time.perf_counter() - detect_started
    if found is None:
        if not args.template:
            raise SystemExit("no face detected (pass --template to build from the face template)")
        from app.services.rig import template_mesh
        from app.services.head3d.topology import canonical_shape
        points = template_mesh(image.size)
        # No measured depth: the canonical face's own relief, scaled to the template.
        z = -canonical_shape()[:, 2]
        z = np.concatenate((z, np.full(10, z.min())))
        detected = False
    else:
        points, z, detected = found.points, found.z, True

    cut = Image.open(args.cut) if args.cut else image
    cut.load()
    if args.matte and not (cut.mode == "RGBA" and np.asarray(cut)[..., 3].min() < 128):
        from app.services.segment import remove_background
        buffer = io.BytesIO()
        cut.convert("RGB").save(buffer, format="PNG")
        cut = Image.open(io.BytesIO(remove_background(buffer.getvalue())))
        cut.load()
    if cut.size != image.size:
        raise SystemExit("the cut-out must be the picture's size")

    rig = rig_service.build_rig(points, image.size, None, face_type=args.face_type)
    rig["render_profile"] = PROFILES[args.face_type]
    if args.rig_out:
        args.rig_out.write_text(json.dumps(rig))
    bake_started = time.perf_counter()
    bake = bake_rig(rig)
    bake_s = time.perf_counter() - bake_started
    if args.bake_out:
        args.bake_out.write_text(json.dumps(bake))

    teeth = None
    if args.teeth and args.teeth.exists() and args.teeth_rig and args.teeth_rig.exists():
        teeth_rig = json.loads(args.teeth_rig.read_text())
        teeth = (Image.open(args.teeth).convert("RGB"), np.array(teeth_rig["points"], dtype=np.float64))

    subject = HeadSubject(
        name=args.image.stem.split(".")[0], picture=cut, points=np.asarray(points), z=np.asarray(z),
        rig=rig, bake=bake, look=args.look, teeth=teeth,
    )
    build = build_head(subject, texture_format=args.texture)
    args.out.write_bytes(build.glb)
    report = {
        **build.report,
        "detected": detected,
        "detect_s": round(detect_s, 4),
        "bake_s": round(bake_s, 4),
        "total_s": round(time.perf_counter() - started, 4),
    }
    if args.report:
        args.report.write_text(json.dumps(report, indent=2))
    print(f"{args.out}: {len(build.glb) / 1024:.0f} KB, build {report['build_s']:.2f}s "
          f"(detect {detect_s:.2f}s, bake {bake_s:.2f}s), {sum(report['triangles'].values())} triangles")


if __name__ == "__main__":
    main()
