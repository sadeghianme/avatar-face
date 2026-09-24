"""A 478-point face in MediaPipe index order, for faces no detector finds.

An animal or a cartoon photo has no detection, and the fit needs a starting
mesh whose every index keeps its anatomical meaning: the marks are attached
to specific landmarks (61 is the left mouth corner, 152 the chin, 159 the
upper lid), and the triangles between them must describe a face, not a
cloud. The synthetic mesh in services.rig only honours that for lips, eyes
and the oval; its other points are filler, and warping filler folds it.

Provenance: the points are MediaPipe's own detection of the embed demo
portrait (embed/src/__tests__/fixtures/human-rig.json), a FICTIONAL,
AI-generated face, with its closed lips parted by a hair — see
scripts/build_face_template.py, which writes face_template.json.

Stored normalised to the face box (the bounding box of all 478 points), so
placing it into a box makes that box the rig's `face_box`.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np

TEMPLATE_PATH = Path(__file__).with_name("face_template.json")

Box = tuple[float, float, float, float]


@lru_cache(maxsize=1)
def _template() -> tuple[np.ndarray, float]:
    data = json.loads(TEMPLATE_PATH.read_text())
    points = np.array(data["points"], dtype=np.float64)
    points.setflags(write=False)
    return points, float(data["aspect"])


def normalised() -> np.ndarray:
    """The template in its unit face box, (478, 2). Read-only."""
    return _template()[0]


def place(box: Box) -> np.ndarray:
    """The template stretched into `box` (x0, y0, x1, y1), in pixels."""
    x0, y0, x1, y1 = box
    unit = normalised()
    return np.column_stack((x0 + unit[:, 0] * (x1 - x0), y0 + unit[:, 1] * (y1 - y0)))


def default_box(width: int, height: int) -> Box:
    """Where the face is assumed to be when nothing says otherwise.

    The synthetic mesh's face area (centred at half width, 46% down, 64% of
    the width by 80% of the height), which is also where the stock portraits
    draw their faces — but at the template's own proportions, so a wide
    photo does not open the marking panel on a squashed face.
    """
    aspect = _template()[1]
    cx, cy = width / 2, height * 0.46
    w, h = width * 0.64, height * 0.80
    if w / h > aspect:
        w = h * aspect
    else:
        h = w / aspect
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
