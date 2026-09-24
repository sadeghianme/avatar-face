"""Build the legacy animal rig the embed golden tests render.

An animal avatar today is built exactly like this: no detector finds a
muzzle, so process_avatar falls back to the synthetic mesh with the animal
viseme table, and the owner then places the head, eyes, mouth and pupils in
"Mark the face", which rig-fit applies with apply_anchors and records as
user_anchors. Rigs built this way are live on customer sites and must keep
rendering exactly as they do when the avatar lines add render profiles; the
fixture this writes is what pins them.

Pure computation: no model, database or storage. Run from backend/ after a
change to the synthetic mesh, the fit or the viseme table — and expect the
golden snapshots to change with it:

    .venv/bin/python -m scripts.build_legacy_animal_rig
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.schemas.avatar import RigFit
from app.services.rig import build_rig, synthetic_face_mesh
from app.services.rig_fit import PupilMarks, RegionMarks, apply_anchors

SIZE = (1024, 1024)
OUTPUT = (
    Path(__file__).resolve().parents[2] / "embed/src/__tests__/fixtures/legacy-animal-rig.json"
)

# A dog marked by hand: a wide head, eyes set apart and high, and a muzzle
# lower and narrower than the synthetic mesh guesses. Free 2D points, as the
# marking panel sends them — the mouth corners deliberately not level.
MARKS: dict[str, dict] = {
    "head": {
        "left": {"x": 250, "y": 520}, "right": {"x": 780, "y": 515},
        "top": {"x": 512, "y": 170}, "bottom": {"x": 515, "y": 900},
    },
    "left_eye": {
        "left": {"x": 350, "y": 420}, "right": {"x": 450, "y": 424},
        "top": {"x": 400, "y": 396}, "bottom": {"x": 400, "y": 448},
    },
    "right_eye": {
        "left": {"x": 575, "y": 424}, "right": {"x": 675, "y": 418},
        "top": {"x": 625, "y": 394}, "bottom": {"x": 625, "y": 446},
    },
    "mouth": {
        "left": {"x": 440, "y": 742}, "right": {"x": 592, "y": 736},
        "top": {"x": 515, "y": 718}, "bottom": {"x": 516, "y": 770},
        "center": {"x": 515, "y": 744},
    },
    "left_pupil": {"center": {"x": 401, "y": 422}, "rim": {"x": 421, "y": 422}},
    "right_pupil": {"center": {"x": 624, "y": 420}, "rim": {"x": 644, "y": 420}},
}


def _region(marks) -> RegionMarks:
    return RegionMarks(
        left=(marks.left.x, marks.left.y),
        right=(marks.right.x, marks.right.y),
        top=(marks.top.x, marks.top.y),
        bottom=(marks.bottom.x, marks.bottom.y),
        center=(marks.center.x, marks.center.y) if marks.center else None,
    )


def _pupil(marks) -> PupilMarks:
    return PupilMarks(center=(marks.center.x, marks.center.y), rim=(marks.rim.x, marks.rim.y))


def build() -> dict:
    """process_avatar's undetected-animal rig, then rig-fit with MARKS —
    parsed by the endpoint's own schema, so user_anchors is stored in the
    shape the API stores it."""
    body = RigFit.model_validate({**MARKS, "persist": True})
    rig = build_rig(synthetic_face_mesh(*SIZE), SIZE, None, face_type="animal")
    fitted = apply_anchors(
        rig,
        head=_region(body.head),
        left_eye=_region(body.left_eye),
        right_eye=_region(body.right_eye),
        mouth=_region(body.mouth),
        left_pupil=_pupil(body.left_pupil),
        right_pupil=_pupil(body.right_pupil),
    )
    fitted["user_anchors"] = {region: getattr(body, region).model_dump() for region in MARKS}
    return fitted


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    args.output.write_text(json.dumps(build(), separators=(",", ":")) + "\n")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
