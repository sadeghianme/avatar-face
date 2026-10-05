"""Write the embed tests' head3d fixture: a synthetic head as a GLB.

    .venv/bin/python scripts/build_head3d_fixture.py

No picture, no landmarker, no node: the canonical face placed in a small
synthetic cut-out, a synthetic bake (the lower lip and the chin drop on
jawOpen, the lids lower on the blink, every viseme a mix of those), PNG
textures a few pixels wide. What the embed's GLB-loading tests load into
three.js to check the names, counts and hierarchy the engine relies on.
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "tests"))

from app.services.head3d.build import HeadSubject, build_head  # noqa: E402
from app.services.rig import build_rig  # noqa: E402

OUTPUT = BACKEND.parent / "embed/src/head3d/__tests__/fixtures/synthetic-head.glb"


def main() -> None:
    from test_head3d import canonical_face, cut_out_picture, synthetic_bake

    points, z = canonical_face(128)
    picture = cut_out_picture(128)
    rig = build_rig(points, picture.size, None)
    rig["render_profile"] = None
    bake = synthetic_bake(points)
    bake["image_size"] = [128, 128]
    subject = HeadSubject(name="synthetic", picture=picture, points=points, z=z, rig=rig, bake=bake, look="photo")
    build = build_head(subject, texture_format="png")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(build.glb)
    print(f"{OUTPUT}: {len(build.glb) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
