"""The kit's versions, its shapes, and the MediaPipe landmarks it reads."""

from __future__ import annotations

import re

# The kit's own recipe: bump when prompts, checks or the fit change what a
# kit contains, so a stored kit says which recipe made it.
# 2 (2026-09-26): the teeth photo is an edit of its own; every shape's
# opening is held to the Reference's (by the AA it was scaled with); the
# retargeted shapes follow the mouth width alone.
KIT_VERSION = 2
# @2 (2026-09-26): AA, TH and F/V reworded after the first run on real
# Gemini (fictional faces): AA came back yawn-wide, TH with the tongue far
# out, F/V ambiguous.
# @3 (2026-09-26): EE asks for the "ee" of speech, and the teeth are asked
# for on their own (TEETH, mouth_photo.TEETH_PROMPT). EE used to double as
# the teeth photo, and the full crowns the embed needs from one (0.10 mouth
# widths of central crown) came with an upper lip lifted well above any
# spoken "ee", which the mouth then played on every "ih", "e" and "s".
# @4 (2026-09-26): OO and F/V reworded after the second real run (two
# fictional faces, gated by register_answer): with @3 both OOs came back a
# pressed pout (0.04 mouth widths open, a third of the Reference's; it
# reads as "mm") and both F/Vs with the lips parted over the teeth (1.3
# and 1.8 times the Reference's at the kit's size). Reworded, both F/Vs
# passed and one OO of two opened as the Reference's does (the other went
# too far and is refused, as a pout is: the Reference's then plays).
PROMPTS_VERSION = "pose-prompts@4"
# The manifest format ContinuousMouth accepts for a per-avatar kit. Version 1
# is the Reference's own (character "lab-reference-v1"), bundled with the
# embed as mouth-motion.json; version 2 adds provenance, the frame and the
# jaw range it was measured at (embed: validateMotionManifest).
MANIFEST_VERSION = 2
CHARACTER_PREFIX = "avatar-v1:"
REFERENCE_CHARACTER = "lab-reference-v1"
# The kit id in "avatar-v1:<kit id>", exactly as the embed accepts it
# (AVATAR_CHARACTER): ASCII only. str.isalnum would also let through
# letters and digits of every other script, which the embed refuses.
KIT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

SHAPES = ("aa", "ee", "oo", "oh", "fv", "th")
# The manifest's pose order: embed PERFORMANCE_POSES.
POSES = ("rest",) + SHAPES
# The seventh request: the person's teeth, photographed for the renderer
# (their oral photo), not a mouth shape; never in the manifest.
TEETH = "teeth"

# MediaPipe indices, as rig.OUTER_LIP_RING / INNER_LIP_RING.
# fmt: off
OUTER_LIP_RING = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
                  409, 270, 269, 267, 0, 37, 39, 40, 185]
INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
                  415, 310, 311, 312, 13, 82, 81, 80, 191]
# fmt: on
MOUTH_LEFT, MOUTH_RIGHT = 61, 291
UPPER_INNER, LOWER_INNER = 13, 14
FACE_LEFT, FACE_RIGHT = 234, 454
NOSE_TIP = 1
