"""The kit's versions, its expressions, where its files live, and the
MediaPipe landmarks it measures."""

from __future__ import annotations

from typing import get_args

from app.models.shapes import ExpressionName

# The kit's own recipe: bump when the prompts, the checks or the picture's
# processing change what a kit contains, so a stored kit says which made it.
# 1 (2026-10-11): five expressions, registered on the mouth kit's anchors,
# the source's own skin detail and colour kept (fidelity.keep_skin).
KIT_VERSION = 1
# @1: the first prompts (frowns for concern, thinking and anger alike; a
# drawn face turned into a photograph). @2: concern and thinking reworded,
# the picture's own medium kept. @3: the source's age and skin tone kept
# (the trial of 2026-10-11 found the pictures a few years older and a
# little greyer).
PROMPTS_VERSION = "expr-prompts@3"
# The manifest format the embed's expression pictures accept.
MANIFEST_VERSION = 1
MANIFEST_KIND = "liveface-expressions"

EXPRESSIONS: tuple[ExpressionName, ...] = get_args(ExpressionName)

# What each call is recorded as in usage (usage.IMAGE_CALLS).
EXPRESSIONS_CALL = "expressions"
# Calls in flight at once, as the mouth kit's.
CONCURRENCY = 3

IMAGE_TYPE = "image/webp"
IMAGE_QUALITY = 90
MANIFEST_TYPE = "application/json"


# MediaPipe indices.
FACE_LEFT, FACE_RIGHT = 234, 454
MOUTH_LEFT, MOUTH_RIGHT = 61, 291
# The upper brow lines: the picture's left brow 70 63 105 66 107, its right
# 336 296 334 293 300. Inner ends 107/66 and 336/296, outer 70/63 and 300/293.
BROW_INNER_LEFT, BROW_OUTER_LEFT = (107, 66), (70, 63)
BROW_INNER_RIGHT, BROW_OUTER_RIGHT = (336, 296), (300, 293)
# Upper and lower lid middles, each eye.
LIDS = ((159, 145), (386, 374))
