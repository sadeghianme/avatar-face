"""Face points from a vision model, for the faces MediaPipe cannot see.

MediaPipe finds human faces. On a dog or a cat it finds nothing, and on
much flat artwork nothing either, and those creations open the marking step
on the face template: a guess placed where a face usually is, which the
owner drags part by part onto the real one. A vision model can point at an
animal's eyes and mouth, which turns "drag everything" into "check and
nudge". It is a pre-fill, never a confirmation: points from here are stored
as not detected, so finishing still requires the owner to place or tick
every part (services.creations.required_marks), and nothing goes live on
the model's word.

The call (`request_points`) sends the picture to Google, so it runs only
with a third-party AI consent and the organization's switch on (enforced by
the route), is metered (usage.VISION_KIND), budgeted per creation, and its
answer is cached by the image's hash so asking twice about the same pixels
costs once.

Conventions, because both are easy to get backwards:

- Gemini's spatial answers are **[y, x]**, normalised to 0-1000 (its boxes
  are [ymin, xmin, ymax, xmax]). `to_pixels` is the one place that turns
  them into (x, y) pixels.
- Left and right. anchor_fit names parts by the side of the IMAGE they are
  on (its `left_eye` is the eye on the image's left, which is the subject's
  RIGHT eye). The prompt asks by image side too, but a model may still
  answer by the subject's side, so `to_marks` assigns eyes, corners and
  mouth points by their x position, never by the name they came back under.

Every answer is checked (`check_geometry`: inside the image, eyes side by
side above the mouth, the chin below it, everything inside the head), then
fitted with the same validator a hand-placed mark must pass. Any failure
falls back to the template, with the reason as a warning.
"""

from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass

import httpx
import numpy as np

from app.services import ai_models

logger = logging.getLogger("liveface.vision_points")

MODEL = ai_models.VISION_MODEL
PROVIDER = ai_models.PROVIDER
TIMEOUT_SECONDS = 60
SCALE = 1000  # Gemini's normalised coordinate range

# The anchors asked for, per line, with what each means. Named by IMAGE side
# (see the module docstring).
_EYE = {
    "left": "its corner nearest the image's left edge",
    "right": "its corner nearest the image's right edge",
    "top": "the middle of its upper lid",
    "bottom": "the middle of its lower lid",
}
ANCHOR_DESCRIPTIONS: dict[str, str] = {
    "head_top": "the top of the head where the skull ends (for an animal, between the "
    "ears, not the ear tips)",
    "head_left": "the edge of the face on the image's left side, level with the eyes "
    "(the cheek or jaw outline, not an ear)",
    "head_right": "the edge of the face on the image's right side, level with the eyes "
    "(the cheek or jaw outline, not an ear)",
    **{f"left_eye_{k}": f"the eye on the image's LEFT side: {v}" for k, v in _EYE.items()},
    **{f"right_eye_{k}": f"the eye on the image's RIGHT side: {v}" for k, v in _EYE.items()},
    "mouth_left": "the corner of the mouth nearest the image's left edge",
    "mouth_left_mid": "the point on the line where the lips meet, halfway between the "
    "left corner and the centre",
    "mouth_center": "the centre of the line where the lips meet",
    "mouth_right_mid": "the point on the line where the lips meet, halfway between the "
    "centre and the right corner",
    "mouth_right": "the corner of the mouth nearest the image's right edge",
    "chin": "the lowest point of the chin or lower jaw",
    "left_pupil": "the centre of the pupil of the eye on the image's LEFT side",
    "right_pupil": "the centre of the pupil of the eye on the image's RIGHT side",
}
_COMMON = tuple(k for k in ANCHOR_DESCRIPTIONS if not k.endswith("_pupil"))
ANCHORS: dict[str, tuple[str, ...]] = {
    "animal": _COMMON,
    "cartoon": (*_COMMON, "left_pupil", "right_pupil"),
}
MOUTH_LINE = ("mouth_left", "mouth_left_mid", "mouth_center", "mouth_right_mid", "mouth_right")

# Geometry sanity, in fractions of the image.
MIN_HEAD_FRACTION = 0.08
# Eyes must be roughly level: vertical offset at most this share of their
# horizontal distance (a tilted head passes, a transposed answer does not).
MAX_EYE_TILT = 0.6
# How far a feature may sit outside the head box, as a share of its size.
HEAD_SLACK = 0.08
# A marked pupil's rim: this share of its eye's width from the centre.
PUPIL_RADIUS = 0.22


class VisionError(Exception):
    """The point finder did not produce usable points. `code` is shown."""

    code = "ai_points_failed"

    def __init__(self, detail: str, code: str | None = None):
        self.detail = detail
        if code:
            self.code = code
        # Did the provider answer (and so bill) before this was raised? True
        # for an unusable or refused answer, False when nothing came back.
        self.answered = False
        super().__init__(detail)


class VisionUnavailable(VisionError):
    code = "ai_points_unavailable"


class VisionRefused(VisionError):
    """Declined on safety grounds: never retried."""

    code = "safety_refused"


def configured() -> bool:
    return bool(ai_models.api_key())


# --- The request ------------------------------------------------------------------


def _point_schema() -> dict:
    return {
        "type": "array",
        "items": {"type": "integer", "minimum": 0, "maximum": SCALE},
        "minItems": 2,
        "maxItems": 2,
    }


def response_schema(face_type: str) -> dict:
    names = ANCHORS[face_type]
    return {
        "type": "object",
        "properties": {"face_found": {"type": "boolean"}, **{n: _point_schema() for n in names}},
        "required": ["face_found", *names],
    }


def build_prompt(face_type: str) -> str:
    kind = "animal" if face_type == "animal" else "cartoon or illustrated character"
    lines = "\n".join(f"- {name}: {ANCHOR_DESCRIPTIONS[name]}" for name in ANCHORS[face_type])
    return (
        f"This picture shows the face of an {kind}. Locate these points on the one main "
        "face. Every point is [y, x], normalised to 0-1000 (y down from the top edge, "
        "x right from the left edge). 'Left' and 'right' mean the IMAGE's left and right "
        "as you look at it, not the subject's own left and right. If there is no clear "
        "face, set face_found to false and put every point at [0, 0].\n" + lines
    )


def build_request(face_type: str, payload: bytes, mime: str) -> dict:
    return {
        "contents": [
            {
                "parts": [
                    {"text": build_prompt(face_type)},
                    {
                        "inline_data": {
                            "mime_type": mime,
                            "data": base64.b64encode(payload).decode(),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": response_schema(face_type),
            # Pointing is perception, not reasoning: Google's guidance for
            # spatial tasks is to keep thinking low, which is also cheaper
            # and steadier. Not "minimal": gemini-3.8-flash answers that with
            # a 400 ("Thinking level MINIMAL is not supported"), which made
            # every AI points request fail in production (checked against
            # the real model: low, medium and no setting all answer).
            "thinkingConfig": {"thinkingLevel": "low"},
            "temperature": 0,
        },
    }


def parse_answer(body: dict, face_type: str) -> dict[str, list[int]]:
    """The named [y, x] points from a generateContent response. Raises
    VisionRefused on a safety refusal, VisionError on anything unusable."""
    from app.services.imagegen import refusal_reason

    refused = refusal_reason(body)
    if refused:
        raise VisionRefused(f"The AI declined this picture ({refused})")
    text = "".join(
        part.get("text", "")
        for candidate in body.get("candidates") or []
        for part in (candidate.get("content") or {}).get("parts") or []
        if not part.get("thought")
    )
    try:
        answer = json.loads(text)
    except ValueError as exc:
        raise VisionError("The AI's answer was not readable") from exc
    if not isinstance(answer, dict):
        raise VisionError("The AI's answer was not readable")
    if answer.get("face_found") is False:
        raise VisionError("The AI found no face in this picture", code="ai_no_face")
    points: dict[str, list[int]] = {}
    for name in ANCHORS[face_type]:
        value = answer.get(name)
        if (
            not isinstance(value, list)
            or len(value) != 2
            or not all(isinstance(v, (int, float)) and 0 <= v <= SCALE for v in value)
        ):
            raise VisionError(f"The AI gave no usable '{name}' point")
        points[name] = [float(value[0]), float(value[1])]
    return points


async def request_points(payload: bytes, mime: str, face_type: str) -> dict[str, list[float]]:
    """Ask the vision model for the line's anchors. [y, x] 0-1000 by name.

    Awaited on the loop (network only). `payload` is already shrunk and
    encoded (on the CPU thread). Raises VisionUnavailable (no key),
    VisionRefused (safety; do not retry) or VisionError.
    """
    key = ai_models.api_key()
    if not key:
        raise VisionUnavailable("AI point finding is not configured on this server")
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.post(
                ai_models.generate_url(MODEL),
                headers={"x-goog-api-key": key},
                json=build_request(face_type, payload, mime),
            )
    except httpx.HTTPError as exc:
        raise VisionError("The AI service did not answer") from exc
    if response.status_code >= 300:
        logger.error(
            "vision model rejected the request (%s): %s", response.status_code, response.text[:400]
        )
        raise VisionError("The AI could not find the points this time, so they start from a guess")
    try:
        return parse_answer(response.json(), face_type)
    except VisionError as exc:
        exc.answered = True
        raise
    except ValueError as exc:
        error = VisionError("The AI's answer was not readable")
        error.answered = True
        raise error from exc


# --- From the answer to marks -------------------------------------------------------


def to_pixels(point: list[float], size: tuple[int, int]) -> tuple[float, float]:
    """[y, x] in 0-1000 → (x, y) in pixels of an image of `size` (w, h)."""
    y, x = point
    width, height = size
    return (x / SCALE * width, y / SCALE * height)


def _xy(p: tuple[float, float]) -> dict:
    return {"x": round(p[0], 2), "y": round(p[1], 2)}


def _eye(points: dict, prefix: str, size) -> dict[str, tuple[float, float]]:
    return {edge: to_pixels(points[f"{prefix}_{edge}"], size) for edge in _EYE}


def to_marks(points: dict[str, list[float]], size: tuple[int, int], face_type: str) -> dict:
    """The answer as marks in the line's scheme (anchor_fit's dict form), in
    pixels. Sides are assigned by position, whatever the answer called them."""
    eyes = [_eye(points, "left_eye", size), _eye(points, "right_eye", size)]

    def centre_x(eye: dict) -> float:
        return (eye["left"][0] + eye["right"][0]) / 2

    eyes.sort(key=centre_x)
    for eye in eyes:
        if eye["left"][0] > eye["right"][0]:
            eye["left"], eye["right"] = eye["right"], eye["left"]

    head_sides = sorted(
        (to_pixels(points["head_left"], size), to_pixels(points["head_right"], size))
    )
    chin = to_pixels(points["chin"], size)
    top = to_pixels(points["head_top"], size)
    mouth = sorted(to_pixels(points[name], size) for name in MOUTH_LINE)

    marks: dict = {
        "head": {
            "left": _xy(head_sides[0]),
            "right": _xy(head_sides[1]),
            "top": _xy(top),
            # The head's bottom IS the chin in the mesh (landmark 152 both).
            "bottom": _xy(chin),
        },
        "left_eye": {edge: _xy(eyes[0][edge]) for edge in _EYE},
        "right_eye": {edge: _xy(eyes[1][edge]) for edge in _EYE},
        "mouth_line": [_xy(p) for p in mouth],
        "chin": _xy(chin),
    }
    if face_type == "cartoon":
        pupils = sorted(
            (to_pixels(points["left_pupil"], size), to_pixels(points["right_pupil"], size))
        )
        for name, eye, pupil in (("left_pupil", eyes[0], pupils[0]),
                                 ("right_pupil", eyes[1], pupils[1])):
            radius = max(PUPIL_RADIUS * abs(eye["right"][0] - eye["left"][0]), 2.0)
            marks[name] = {"center": _xy(pupil), "rim": _xy((pupil[0] + radius, pupil[1]))}
    return marks


def check_geometry(marks: dict, size: tuple[int, int]) -> list[str]:
    """What is implausible about these marks, or nothing. A transposed
    ([x, y] read as [y, x]) or mislabelled answer fails here."""
    width, height = size
    problems: list[str] = []
    head = marks["head"]
    x0, x1 = head["left"]["x"], head["right"]["x"]
    y0, y1 = head["top"]["y"], head["bottom"]["y"]
    if x1 - x0 < MIN_HEAD_FRACTION * width or y1 - y0 < MIN_HEAD_FRACTION * height:
        problems.append("the head is too small or upside down")
        return problems
    slack_x, slack_y = HEAD_SLACK * (x1 - x0), HEAD_SLACK * (y1 - y0)

    def inside(p: dict) -> bool:
        return x0 - slack_x <= p["x"] <= x1 + slack_x and y0 - slack_y <= p["y"] <= y1 + slack_y

    centres = []
    for name in ("left_eye", "right_eye"):
        eye = marks[name]
        if not eye["left"]["x"] < eye["right"]["x"]:
            problems.append(f"the {name.replace('_', ' ')} has no width")
        if not eye["top"]["y"] < eye["bottom"]["y"]:
            problems.append(f"the {name.replace('_', ' ')}'s lids are upside down")
        centre = {
            "x": (eye["left"]["x"] + eye["right"]["x"]) / 2,
            "y": (eye["top"]["y"] + eye["bottom"]["y"]) / 2,
        }
        if not inside(centre):
            problems.append(f"the {name.replace('_', ' ')} is outside the head")
        centres.append(centre)
    if marks["left_eye"]["right"]["x"] >= marks["right_eye"]["left"]["x"]:
        problems.append("the eyes overlap")
    dx = centres[1]["x"] - centres[0]["x"]
    dy = abs(centres[1]["y"] - centres[0]["y"])
    if dx <= 0 or dy > MAX_EYE_TILT * dx:
        problems.append("the eyes are not side by side")
    mouth = marks["mouth_line"]
    centre = mouth[2]
    if not all(inside(p) for p in mouth):
        problems.append("the mouth is outside the head")
    if centre["y"] <= max(c["y"] for c in centres):
        problems.append("the mouth is not below the eyes")
    if marks["chin"]["y"] < centre["y"]:
        problems.append("the chin is above the mouth")
    for name, eye in (("left_pupil", "left_eye"), ("right_pupil", "right_eye")):
        if name in marks:
            box = marks[eye]
            pupil = marks[name]["center"]
            pad = 0.25 * (box["right"]["x"] - box["left"]["x"])
            if not (
                box["left"]["x"] - pad <= pupil["x"] <= box["right"]["x"] + pad
                and box["top"]["y"] - pad <= pupil["y"] <= box["bottom"]["y"] + pad
            ):
                problems.append(f"the {name.replace('_', ' ')} is outside its eye")
    return problems


@dataclass
class PointsResult:
    anchors: dict | None
    problems: list[str]


def anchors_from_points(
    points: dict[str, list[float]], size: tuple[int, int], face_type: str
) -> PointsResult:
    """The detect result (the same shape as creations.detect_anchors) built
    on the model's points, or the reasons it cannot be. CPU work.

    The base mesh is the face template stretched over the head the model
    found, and its marks are the model's points: finishing fits one onto the
    other exactly as it would a hand-placed set, so the validator here is
    the one the owner's marks will face.
    """
    from app.services import face_template
    from app.services.anchor_fit import (
        fit_rig,
        marks_from_dict,
        marks_to_dict,
        with_head_outline,
    )
    from app.services.rig import build_rig

    marks = to_marks(points, size, face_type)
    problems = check_geometry(marks, size)
    if problems:
        return PointsResult(None, problems)
    head = marks["head"]
    box = (head["left"]["x"], head["top"]["y"], head["right"]["x"], head["bottom"]["y"])
    base = np.round(np.asarray(face_template.place(box), dtype=np.float64), 3)
    skeleton = build_rig(base, size, None, face_type=face_type)
    # The model names the head's edges only; its outline diagonals open
    # where a fit of those edges puts them. Eight marks then set the whole
    # oval, so what is validated is the fit of the eight, stored form and
    # all, exactly as finish will read them back.
    edges_only = marks_from_dict(marks, face_type)
    fitted, _ = fit_rig(skeleton, base, edges_only, face_type)
    stored = marks_to_dict(with_head_outline(edges_only, np.array(fitted["points"])))
    _, fit_problems = fit_rig(skeleton, base, marks_from_dict(stored, face_type), face_type)
    if fit_problems:
        return PointsResult(None, [p.detail for p in fit_problems])
    return PointsResult(
        {
            "image_size": list(size),
            # Not a detection: the owner still places or ticks every part.
            "detected": False,
            "base": base.tolist(),
            "marks": stored,
            "validation": {
                "ok": True,
                "reasons": [],
                "warnings": [],
                "detected": False,
                "one_click": False,
            },
        },
        [],
    )
