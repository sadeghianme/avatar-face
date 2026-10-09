"""What an answer must pass (alignment, jaw, skin colour, a face at all),
the candidate it makes for the owner, and the prompt of a generated
creation."""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from app.models.shapes import AdjustChecks, Note
from app.services import imagegen
from app.services.anchors import detect_anchors
from app.services.photo_adjust.paste import (
    _hull_mask,
    delta_e,
    paste_back,
    rgb_to_lab,
)
from app.services.photo_adjust.scheme import (
    CHEEK_IMAGE_LEFT,
    CHEEK_IMAGE_RIGHT,
    MAX_SKIN_DELTA_E,
    SKIN_L_WEIGHT,
    STORED_MAX_EDGE,
    STYLISE,
    TOUCHUP,
    AdjustSkipped,
    reason,
)
from app.services.photo_adjust.sending import (
    Prepared,
    decode_alpha,
    decode_own_rgb,
    decode_rgb,
    detect_points,
)
from app.services.photo_io import on_backdrop, png_bytes

logger = logging.getLogger("liveface.photo_adjust")


def cheek_colour(image: Image.Image, points: np.ndarray) -> np.ndarray | None:
    """Mean LAB colour over both cheeks, or None if they cover no pixels."""
    rgb = np.asarray(image.convert("RGB"))
    mask = _hull_mask(rgb.shape[:2], [points[CHEEK_IMAGE_LEFT], points[CHEEK_IMAGE_RIGHT]])
    if mask.sum() < 16:
        return None
    return rgb_to_lab(rgb[mask].astype(np.float64)).mean(axis=0)


def skin_drift(
    source: Image.Image,
    source_points: np.ndarray | None,
    candidate: Image.Image,
    candidate_points: np.ndarray | None,
) -> float | None:
    """Delta E (lightness at half weight) between the two cheek colours, or
    None when either face was not found."""
    if source_points is None or candidate_points is None:
        return None
    before = cheek_colour(source, source_points)
    after = cheek_colour(candidate, candidate_points)
    if before is None or after is None:
        return None
    return delta_e(before, after, SKIN_L_WEIGHT)


@dataclass
class Candidate:
    """One answer, as offered to the owner: the stored image (None when
    there is nothing to show) and, when it failed a check, why."""

    png: bytes | None
    width: int = 0
    height: int = 0
    rejected: Note | None = None
    generated_eyes: bool = False
    checks: AdjustChecks = field(default_factory=lambda: AdjustChecks())
    # A touch-up of a cut-out is a cut-out: transparent where the source was.
    cutout: bool = False


def _png(image: Image.Image) -> bytes:
    return png_bytes(image)


def _checked(
    image: Image.Image,
    mode: str,
    face_type: str,
    source: Image.Image,
    source_points: np.ndarray | None,
    generated_eyes: bool,
) -> Candidate:
    """Run the checks on a candidate image and package it."""
    png = _png(image)
    candidate = Candidate(png, image.width, image.height, generated_eyes=generated_eyes)
    # The line the result will be rigged on: a stylised person is animation.
    line = "cartoon" if mode == STYLISE else face_type
    if line in ("human", "cartoon"):
        try:
            found = detect_anchors(png, line)
        except Exception:
            # Broad on purpose: the detector's runtime fails in its own
            # types; a result that cannot be checked is not offered.
            logger.exception("checking a candidate failed")
            candidate.rejected = reason("check_failed", "The result could not be checked")
            return candidate
        candidate.checks["detected"] = found["detected"]
        if not found["detected"]:
            candidate.rejected = reason("no_face_in_result", "No face was found in the result")
            return candidate
        validation = found["validation"]
        candidate.checks["fit_ok"] = validation["ok"]
        if not validation["ok"]:
            details = "; ".join(r["detail"] for r in validation["reasons"])
            candidate.rejected = reason(
                "fit_invalid", f"The result's face would not rig cleanly: {details}"
            )
            return candidate
        if line == "human":
            # Like with like: the source is judged on the grey the model
            # saw, so a cut-out candidate is too (not on the black under
            # its alpha 0).
            drift = skin_drift(source, source_points, on_backdrop(image), np.asarray(found["base"]))
            if drift is not None:
                candidate.checks["skin_delta_e"] = round(drift, 1)
                if drift > MAX_SKIN_DELTA_E:
                    candidate.rejected = reason(
                        "skin_tone_changed", "The result changed the skin tone"
                    )
    return candidate


def finish_candidate(
    data: bytes, prepared: Prepared, answer: bytes, mode: str, face_type: str
) -> Candidate:
    """Turn a provider answer into a checked candidate. CPU work."""
    source = decode_rgb(data)
    try:
        with Image.open(io.BytesIO(answer)) as decoded:
            result = decoded.convert("RGB")
    except Exception:
        # Broad on purpose: Pillow raises many types on bytes it cannot
        # decode, and any of them is an unusable answer.
        logger.warning("an adjust answer is not a readable image", exc_info=True)
        return Candidate(
            None, rejected=reason("unreadable_result", "The AI returned no usable image")
        )

    if mode == TOUCHUP:
        try:
            result_points = detect_points(result)
        except Exception:
            # Broad on purpose: the detector's runtime fails in its own types.
            logger.exception("detecting the touch-up answer failed")
            result_points = None
        if result_points is None:
            return Candidate(
                None, rejected=reason("no_face_in_result", "No face was found in the result")
            )
        alpha = decode_alpha(data)
        assert prepared.source_points is not None  # a touch-up is prepared with them
        try:
            # Into the image's own pixels, not the grey composite the model
            # saw: outside the eyes and lips a cut-out stays bit-identical.
            image = paste_back(
                decode_own_rgb(data) if alpha is not None else source,
                prepared.source_points,
                result,
                result_points,
            )
        except AdjustSkipped as exc:
            return Candidate(None, rejected=reason(exc.code, exc.detail))
        if alpha is not None:
            # A cut-out stays a cut-out: only eyes and lips were touched,
            # and they are inside the opaque face. The alpha is the source's.
            image = image.convert("RGBA")
            image.putalpha(alpha)
        candidate = _checked(
            image, mode, face_type, source, prepared.source_points, prepared.generated_eyes
        )
        candidate.cutout = alpha is not None
        return candidate

    if max(result.size) > STORED_MAX_EDGE:
        result.thumbnail((STORED_MAX_EDGE, STORED_MAX_EDGE), Image.Resampling.LANCZOS)
    source_points = None
    if face_type == "human":
        try:
            source_points = detect_points(source)
        except Exception:
            # Broad on purpose: the detector's runtime fails in its own types;
            # the result is then checked without the source's face.
            logger.exception("detecting the source of an adjust answer failed")
            source_points = None
    return _checked(result, mode, face_type, source, source_points, False)


def generation_prompt(style: str, face_type: str | None, prompt: str, has_source: bool) -> str:
    """The prompt for a creation made by generation (POST /creations/generate).

    A person keeps imagegen's portrait prompt, which states the rig's needs.
    An animal or a character is asked for in the same terms, since the rig
    needs the same things of them: frontal, both eyes, mouth closed.
    """
    if face_type == "human":
        return imagegen.build_prompt(style, has_source, prompt)
    look = imagegen.STYLES.get(style, imagegen.STYLES["photoreal"])
    noun = "animal" if face_type == "animal" else "character"
    if has_source:
        head = (
            f"Redraw the {noun} in this picture as {look}. Keep it the same {noun}: "
            "same colours, markings and proportions. "
        )
    else:
        head = f"Create {look} of {'an' if noun == 'animal' else 'a'} {noun}. "
    needs = (
        "Facing the camera directly, both eyes clearly visible, mouth closed, the whole "
        "head inside the frame with space around it and filling roughly half the image "
        "width, on a plain, uncluttered, evenly lit backdrop. No text, no watermark, no "
        "objects in front of the face."
    )
    note = f" {prompt.strip()}" if prompt.strip() else ""
    return f"{head}{needs}{note}"
