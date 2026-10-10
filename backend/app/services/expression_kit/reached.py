"""2. Did the answer make the expression it was asked for?

What it moved, measured on the registered landmarks against the base
photo's, in face widths (234 to 454), "up" positive; the eyes' openings as
a ratio of the base's. Each expression has a signature (the trial of
2026-10-11, ten answers on two faces, two prompt rounds):

    happy      the mouth's corners up 0.012 to 0.026; the eyes at 0.72 to
               0.85 of their opening (the cheeks push the lower lids up)
    surprised  the brows up 0.019 to 0.042 on average
    concerned  the inner brow above the outer: +0.010 to +0.023 (the brows
               slant up toward the middle), the corners not up
    thinking   the picture-right brow's outer end above the left's by 0.021
               to 0.029 (one brow raised)
    serious    the inner brow ends down 0.011 to 0.025, not above the outer

The limits below are under the least of each, with a margin; the first
round's "frown for everything" (concern, thinking and anger drawn alike)
fails thinking's asymmetry and is caught there. Concern and anger differ
by the brows' slant, and the slant is the measure that separates them.
"""

from __future__ import annotations

import numpy as np

from app.services.expression_kit.constants import (
    BROW_INNER_LEFT,
    BROW_INNER_RIGHT,
    BROW_OUTER_LEFT,
    BROW_OUTER_RIGHT,
    FACE_LEFT,
    FACE_RIGHT,
    LIDS,
    MOUTH_LEFT,
    MOUTH_RIGHT,
)
from app.services.performance_kit.answers import opening

HAPPY_MIN_CORNERS = 0.008
HAPPY_MAX_EYES = 0.93
SURPRISED_MIN_BROWS = 0.012
CONCERNED_MIN_SLANT = 0.006
CONCERNED_MAX_CORNERS = 0.004
THINKING_MIN_ASYMMETRY = 0.012
SERIOUS_MAX_INNER = -0.005
SERIOUS_MAX_SLANT = 0.004
# A happy picture whose lips part this much (in rest mouth widths, as the
# mouth kit measures an opening) shows its teeth: the smile the engine may
# show while the avatar is silent.
SMILE_MIN_OPENING = 0.06


def measures(registered: np.ndarray, base: np.ndarray) -> dict[str, float]:
    """What the expression moved (see the module docstring)."""
    face = float(np.linalg.norm(base[FACE_RIGHT] - base[FACE_LEFT]))
    moved = (registered - base) / max(face, 1.0)

    def up(ids) -> float:
        return float(-moved[list(ids), 1].mean())

    inner_l, inner_r = up(BROW_INNER_LEFT), up(BROW_INNER_RIGHT)
    outer_l, outer_r = up(BROW_OUTER_LEFT), up(BROW_OUTER_RIGHT)
    eyes = []
    for top, bottom in LIDS:
        before = float(np.linalg.norm(base[top] - base[bottom]))
        after = float(np.linalg.norm(registered[top] - registered[bottom]))
        eyes.append(after / max(before, 1e-6))
    values = {
        "brow_inner": (inner_l + inner_r) / 2,
        "brow_outer": (outer_l + outer_r) / 2,
        "brows": (inner_l + inner_r + outer_l + outer_r) / 4,
        "brow_slant": (inner_l + inner_r - outer_l - outer_r) / 2,
        "brow_asymmetry": outer_r - outer_l,
        "corners": (up([MOUTH_LEFT]) + up([MOUTH_RIGHT])) / 2,
        "eyes": float(np.mean(eyes)),
        "opening": opening(registered, base),
    }
    return {name: round(value, 4) for name, value in values.items()}


def expression_reached(name: str, values: dict[str, float]) -> str | None:
    """None when `values` (measures) show `name`; otherwise what is missing."""
    if name == "happy":
        if values["corners"] < HAPPY_MIN_CORNERS:
            return (
                f"the mouth's corners rose {values['corners']:.3f}, less than {HAPPY_MIN_CORNERS}"
            )
        if values["eyes"] > HAPPY_MAX_EYES:
            return f"the eyes kept {values['eyes']:.2f} of their opening (a smile narrows them)"
        return None
    if name == "surprised":
        if values["brows"] < SURPRISED_MIN_BROWS:
            return f"the brows rose {values['brows']:.3f}, less than {SURPRISED_MIN_BROWS}"
        return None
    if name == "concerned":
        if values["brow_slant"] < CONCERNED_MIN_SLANT:
            return (
                f"the brows slant {values['brow_slant']:+.3f} toward the middle, less than "
                f"{CONCERNED_MIN_SLANT} (a frown, not concern)"
            )
        if values["corners"] > CONCERNED_MAX_CORNERS:
            return f"the mouth's corners rose {values['corners']:.3f}"
        return None
    if name == "thinking":
        if values["brow_asymmetry"] < THINKING_MIN_ASYMMETRY:
            return (
                f"one brow is {values['brow_asymmetry']:+.3f} above the other, less than "
                f"{THINKING_MIN_ASYMMETRY}"
            )
        return None
    if name == "serious":
        if values["brow_inner"] > SERIOUS_MAX_INNER:
            return f"the brows' inner ends moved {values['brow_inner']:+.3f}, not down"
        if values["brow_slant"] > SERIOUS_MAX_SLANT:
            return f"the brows slant {values['brow_slant']:+.3f} up toward the middle"
        return None
    raise ValueError(f"unknown expression {name!r}")


def shows_smile(name: str, values: dict[str, float]) -> bool:
    """A happy picture with its lips parted: its mouth may be shown while
    the avatar is silent (the engine's pause smile)."""
    return name == "happy" and values["opening"] >= SMILE_MIN_OPENING
