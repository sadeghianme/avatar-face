"""The head's constants, each named and justified where it is declared,
and the smoothstep they are blended with."""

from __future__ import annotations

import numpy as np

#: Bizygomatic width of an adult face, ear-level landmark to landmark, metres.
#: Only the model's unit; every proportion below is relative to the face.
FACE_WIDTH_M = 0.14

#: How far the nose tip stands ahead of the mid-cheek plane, in face widths.
#: Anthropometry puts the pronasale about 3 cm ahead of the malar surface on a
#: 13.5 cm face (0.22); MediaPipe's own z, measured on the frontal subjects of
#: this spike, gives 0.24-0.25 on humans. Calibrating to one constant keeps
#: that relief and guards against a detection whose z scale drifted (a tilted
#: head, a long lens), and it is the one place a muzzle is made human-deep.
NOSE_PROTRUSION = 0.25

#: Laplacian passes over the face oval's z (MediaPipe's z is noisiest there).
OVAL_SMOOTH_PASSES = 3

#: The cranium's half-width over the face's half-width: head breadth (~15 cm)
#: over bizygomatic width (~13.5 cm).
HEAD_BREADTH = 1.10
#: The back of the skull behind the ear plane, in face half-widths: head
#: length (~19 cm) minus tragion-to-nose (~11.5 cm) = 7.5 cm over 6.75 cm.
HEAD_BACK = 1.10
#: The crown's height above the forehead landmark (10), in face heights,
#: when the cut-out's hair gives no better answer: clamp of the hair top.
CROWN_ABOVE_FOREHEAD = (0.25, 0.60)
#: How far the skirt between the face edge and the cranium's equator bulges
#: outward, as a share of the chord: a convex skull, not a cone.
SKIRT_BULGE = 0.18
SKIRT_RINGS = 3
BACK_RINGS = 4
#: The neck's radius in face widths (narrower than a real ~12 cm neck on a
#: 13.5 cm face, because every neck the picture shows thinner than the
#: cylinder would show the cylinder beside it) and its length below the chin
#: in face heights. Its axis sits back so its front stays behind the hair
#: card: the hair that hangs over a neck must stay in front of it, and under
#: the chin a turn reveals the cylinder, not the card.
NECK_RADIUS = 0.33
NECK_LENGTH = 0.45
NECK_SEGMENTS = 20
NECK_BEHIND_CARD = 0.03
#: The hair card sits this far behind the deepest oval landmark, and the body
#: card this far behind the hair card, in face widths.
HAIR_CARD_BEHIND = 0.02
BODY_CARD_BEHIND = 0.08
#: The 2D engine's head layer: the face box grown by these shares of the face
#: width (sides) and height (above, below), feathered by these shares of the
#: box's own width/height (sides, top) and of its height at the neck.
HEAD_BOX_SIDE, HEAD_BOX_ABOVE, HEAD_BOX_BELOW = 0.42, 0.9, 0.5
HEAD_FEATHER_SIDE, HEAD_FEATHER_TOP, HEAD_FEATHER_NECK = 0.16, 0.13, 0.26
#: The hair card's face hole: the oval shrunk by this many face widths, with
#: a feather of the same width outward.
OVAL_HOLE_FEATHER = 0.03

#: Morph z rules. The jaw rotates about the ears: a chin that drops moves back
#: by this share of the drop (a hinge 11 cm behind the chin dropping 2 cm
#: moves it back 0.2 cm... measured on a profile of an open "aa" it is nearer
#: 0.3 because the lip everts). Pucker and funnel push the lips forward by
#: these shares of the mouth width at the lip centre; a spread mouth pulls its
#: corners back around the teeth by this share of their lateral travel.
JAW_BACK = 0.30
LIP_PROTRUSION = {"mouthPucker": 0.08, "mouthFunnel": 0.06}
CORNER_RECESS = 0.15
#: Where the Left and Right halves of a symmetric target cross over, in
#: mouth widths about the face's centre line.
SIDE_BLEND = 0.15

#: The mouth interior, in mouth widths (corner to corner), as a SHELL just
#: behind the face surface: every part sits at the face's own depth at its
#: (x, y) minus an offset, because the face curves back below the lips (the
#: chin crease is ~0.12 widths behind the lip surface) and a flat part at
#: one depth pokes through it. The upper incisors hang from just above the
#: seam, the lower ones meet them with a small overbite; the cavity's
#: backdrop recedes further below the seam, behind where the jaw's back
#: travel (JAW_BACK) takes the lower lip on an open vowel.
#: The rows span the incisors and canines (the premolars sit behind the
#: corners), and recede toward their ends: a pucker slides the cheek skin
#: inward over a deeper part of the face, and a row that stayed at the
#: corners' rest depth would stand in front of it.
TEETH_WIDTH = 0.78
TEETH_ARCH_DEPTH = 0.12
UPPER_TEETH = {"top": 0.03, "bottom": -0.14, "behind": 0.03}
LOWER_TEETH = {"top": -0.09, "bottom": -0.24, "behind": 0.045}
TONGUE = {"centre": (0.0, -0.22, -0.10), "radii": (0.28, 0.07, 0.07)}
TONGUE_UNDER_SKIN = 0.03
CAVITY = {"top": 0.12, "bottom": -0.5, "width": 1.15, "behind": 0.06, "behind_low": 0.2}
#: Share of the chin's jaw drop the lower teeth and the tongue take. The
#: chin drops CHIN_SHARE (0.68) of the lower lip, so lower incisors riding
#: the chin stay mostly behind the lip, showing a sliver on an open vowel.
LOWER_TEETH_JAW_SHARE = 1.0
TONGUE_JAW_SHARE = 0.8

MORPH_NAMES = (
    "jawOpen", "mouthClose", "mouthPucker", "mouthFunnel",
    "mouthStretchLeft", "mouthStretchRight", "mouthSmileLeft", "mouthSmileRight",
    "eyeBlinkLeft", "eyeBlinkRight",
)
#: The viseme shapes' target names: the Ready Player Me convention the 3D
#: engine drives from its cue track (ih/oh/ou are I/O/U there).
VISEME_MORPH_NAMES = {
    "sil": "viseme_sil", "PP": "viseme_PP", "FF": "viseme_FF", "TH": "viseme_TH", "DD": "viseme_DD",
    "kk": "viseme_kk", "CH": "viseme_CH", "SS": "viseme_SS", "nn": "viseme_nn", "RR": "viseme_RR",
    "aa": "viseme_aa", "E": "viseme_E", "ih": "viseme_I", "oh": "viseme_O", "ou": "viseme_U",
}
#: The 2D rig's six symmetric weights and the targets each one becomes.
SYMMETRIC_TO_ARKIT = {
    "jawOpen": ("jawOpen",),
    "mouthClose": ("mouthClose",),
    "mouthPucker": ("mouthPucker",),
    "mouthFunnel": ("mouthFunnel",),
    "mouthStretch": ("mouthStretchLeft", "mouthStretchRight"),
    "mouthSmile": ("mouthSmileLeft", "mouthSmileRight"),
    "eyeBlink": ("eyeBlinkLeft", "eyeBlinkRight"),
}


def smoothstep(x: np.ndarray | float) -> np.ndarray | float:
    t = np.clip(x, 0.0, 1.0)
    return t * t * (3 - 2 * t)
