"""The creation wizard's fixed rules: limits, what each line does, and
where a creation's files live in storage."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4



# An org's unfinished creations. A resume list longer than this is a pile,
# not work in progress, and each one holds a few MB of images.
MAX_DRAFTS_PER_ORG = 10
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
# A draft untouched this long is abandoned: its files go, its row stays a
# while (as expired) so a stale tab gets "expired" rather than "not found".
IDLE_EXPIRY = timedelta(days=7)
# Finished and expired rows are kept this long, then deleted.
ENDED_RETENTION = timedelta(days=30)
# A bigger turn than this is not levelling a photo, it is a different photo.
MAX_ROLL_DEGREES = 45.0
MIN_CROP_FRACTION = 0.15

STEP_ORDER = ("original", "framed", "cutout")
# AI point finding per creation (the vision model; cached answers are free).
AI_DETECTIONS_PER_CREATION = 1
ADJUSTED_PREFIX = "adjusted:"
CUTOUT = "cutout"
# The cut-out of an AI result "adjusted:N" is "cutout:N".
CUTOUT_PREFIX = "cutout:"
# The keys of photo_analysis.check_photo kept on each step.
CHECK_KEYS = (
    "detector", "detected", "face_box", "roll", "face_state", "checks", "recommendations",
)
FULL_FRAME = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
# In `steps`: {face_type, background} as they were before a stylised
# version was chosen, restored when the owner goes back to a picture that
# is not a drawing ("Keep my photo"). Dropped when the owner picks a line.
BEFORE_STYLISE = "before_stylise"


# --- Lines ----------------------------------------------------------------------


@dataclass(frozen=True)
class LineRules:
    """What the wizard does per line. M4's app/lines modules replace this
    table (detectors gain Gemini points behind consent, lines gain AI
    presets); until then it is the whole of the difference."""

    # "mediapipe": detect, and fall back to the face template when nothing
    # is found. "template": the face template, placed where a face usually is.
    detector: str
    # The person segmenter is trained on people. On a muzzle or a drawing it
    # cuts ears, whiskers and outlines, so only humans are offered it until
    # a general segmenter has been measured.
    background_removal: bool
    # Head/body layers depend on the same segmenter.
    layers: bool
    # May "Looks right" finish on the pre-filled marks? Never for an animal:
    # its marks are always a template guess.
    one_click: bool
    # The parts this line's owner marks (anchor_fit's scheme for the line).
    marks: tuple[str, ...]


LINES: dict[str, LineRules] = {
    "human": LineRules(
        detector="mediapipe", background_removal=True, layers=True, one_click=True,
        marks=("head", "left_eye", "right_eye", "mouth", "left_pupil", "right_pupil"),
    ),
    "cartoon": LineRules(
        detector="mediapipe", background_removal=False, layers=False, one_click=True,
        marks=(
            "head", "left_eye", "right_eye", "mouth_line", "chin", "left_pupil", "right_pupil",
        ),
    ),
    "animal": LineRules(
        detector="template", background_removal=False, layers=False, one_click=False,
        marks=("head", "left_eye", "right_eye", "mouth_line", "chin"),
    ),
}


def rules_for(face_type: str) -> LineRules:
    return LINES[face_type]


def required_marks(face_type: str, detected: bool) -> tuple[str, ...]:
    """The parts finish must be sent, because nothing but the owner vouches
    for where they sit.

    Every part, when the marks opened on the face template (an animal
    always; a person or a drawing the detector missed): a template is a
    guess, and nothing goes live on a guess. None when a detection on a
    one-click line put them there, since the owner may confirm it as found.
    """
    if detected and rules_for(face_type).one_click:
        return ()
    return rules_for(face_type).marks


# --- Storage layout ---------------------------------------------------------------


def creation_prefix(org_id: str, creation_id: str) -> str:
    return f"orgs/{org_id}/creations/{creation_id}/"


def incoming_key(org_id: str, creation_id: str) -> str:
    """The upload as received, until ingest has cleaned it. Private, and
    deleted as soon as the clean copy is stored; kept only so an ingest a
    restart interrupted can be retried without asking for the file again."""
    return f"{creation_prefix(org_id, creation_id)}incoming"


def step_key(org_id: str, creation_id: str, step: str) -> str:
    # A fresh key per image: a presigned URL a browser still holds keeps
    # pointing at the image it was issued for, and a discarded result can be
    # deleted without touching the one that replaced it.
    return f"{creation_prefix(org_id, creation_id)}{step}-{uuid4().hex[:12]}.png"


def avatar_prefix(org_id: str, avatar_id: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/"
