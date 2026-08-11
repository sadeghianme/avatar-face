"""Is this image good enough to become a talking avatar?

Generation is not finished when the picture looks nice — it is finished when
the rig fits. Every failure this checks for has already happened to a real
upload, and each one produces an avatar that is broken in a way the user
cannot diagnose from looking at it:

- No face found. rig.py falls back to a synthetic mesh rather than failing, so
  an image with no detectable face still becomes a "ready" avatar whose mouth
  moves somewhere near the middle of the picture. That silent fallback is the
  single most important thing to catch here.
- A face too small to carry detail. The mouth interior, the teeth and the lip
  bands are drawn from a handful of texture pixels; below a certain size they
  average into mush.
- A face running off the edge. The warp needs the surrounding pixels; a chin
  or forehead cropped at the frame tears when the mouth opens.
- A head turned away. The engine cannot rotate a head — established the hard
  way — so a three-quarter view can never be corrected later.

Used to accept or reject generated candidates, and worth surfacing on ordinary
uploads too: it is the same question.
"""

from __future__ import annotations

from dataclasses import dataclass

# Face width as a fraction of image width. Below this, per-tooth detail is a
# couple of pixels and the mouth reads as a smudge.
MIN_FACE_FRACTION = 0.22

# How close the face may come to the frame edge, as a fraction of face width.
# The warp reaches beyond the landmarks, so a face flush to the edge tears.
MIN_EDGE_MARGIN = 0.04

# Nose offset from the face-box centre, as a fraction of half-width. A frontal
# face sits near zero; a three-quarter view pushes the nose toward one side.
MAX_NOSE_OFFSET = 0.34

NOSE_TIP = 1  # MediaPipe canonical index


@dataclass
class RigCheck:
    ok: bool
    reason: str | None = None
    face_fraction: float = 0.0
    nose_offset: float = 0.0
    detected: bool = False

    @property
    def summary(self) -> str:
        if self.ok:
            return f"face {self.face_fraction:.0%} of frame, frontal"
        return self.reason or "unusable"


def check_landmarks(points, image_size: tuple[int, int], detected: bool) -> RigCheck:
    """Judge an already-detected mesh.

    `detected` must say whether MediaPipe actually found a face, as opposed to
    rig.py substituting its synthetic mesh — the synthetic one is perfectly
    proportioned and would pass every geometric test below while describing
    nothing that is in the picture.
    """
    if not detected:
        return RigCheck(False, "no face detected", detected=False)

    width, height = image_size
    if width <= 0 or height <= 0:
        return RigCheck(False, "empty image", detected=detected)

    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    face_w = x1 - x0
    face_h = y1 - y0
    if face_w <= 0 or face_h <= 0:
        return RigCheck(False, "degenerate face", detected=detected)

    fraction = face_w / width
    if fraction < MIN_FACE_FRACTION:
        return RigCheck(
            False,
            f"face too small ({fraction:.0%} of frame; needs {MIN_FACE_FRACTION:.0%})",
            fraction,
            detected=detected,
        )

    margin = face_w * MIN_EDGE_MARGIN
    if x0 < margin or y0 < margin or x1 > width - margin or y1 > height - margin:
        return RigCheck(False, "face runs off the edge of the frame", fraction, detected=detected)

    # Frontality. The nose tip sits near the middle of a face looking at you
    # and drifts toward one side as the head turns.
    nose_offset = 0.0
    if len(points) > NOSE_TIP:
        centre = (x0 + x1) / 2
        nose_offset = abs(float(points[NOSE_TIP][0]) - centre) / (face_w / 2)
        if nose_offset > MAX_NOSE_OFFSET:
            return RigCheck(
                False,
                "head is turned away — the avatar cannot turn it back",
                fraction,
                nose_offset,
                detected,
            )

    return RigCheck(True, None, fraction, nose_offset, detected)


def check_image(data: bytes) -> RigCheck:
    """Run detection on raw image bytes and judge the result."""
    import io

    from PIL import Image

    from app.core.config import get_settings

    try:
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return RigCheck(False, "not a readable image")

    if not get_settings().rig_model_path:
        # Without the model every image would be judged on the synthetic mesh,
        # which passes everything. Better to admit we cannot tell.
        return RigCheck(False, "no landmark model configured")

    from app.services.rig import _mediapipe_landmarks

    try:
        points = _mediapipe_landmarks(image)
    except Exception:
        return RigCheck(False, "no face detected", detected=False)

    return check_landmarks(points, image.size, detected=True)
