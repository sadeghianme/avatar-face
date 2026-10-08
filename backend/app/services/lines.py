"""The lines an avatar can be made on (human, cartoon, animal), and what
each does: which detector finds its face, which parts its owner marks,
whether its background can be removed. A leaf: the creation wizard, the
photo touch-up's checks and the anchor fit all ask it."""

from __future__ import annotations

from dataclasses import dataclass


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
