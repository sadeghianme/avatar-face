"""The modes each line offers, the budgets and limits, the landmark groups
and paste regions a touch-up works with, the prompts, and why a photo is
skipped."""

from __future__ import annotations

from app.models.shapes import Note

TOUCHUP = "touchup"
STYLISE = "stylise"
REGENERATE = "regenerate"
MODES = (TOUCHUP, STYLISE, REGENERATE)

# Which modes each line offers (docs/avatar-lines.md, the "AI presets" row).
# Touch-up and stylise need a detected human face: touch-up to know where the
# eyes are, stylise because turning a drawing into a drawing is regenerate.
MODES_BY_LINE: dict[str, tuple[str, ...]] = {
    "human": (TOUCHUP, STYLISE, REGENERATE),
    "animal": (REGENERATE,),
    "cartoon": (REGENERATE,),
}

# Per round, and per creation. Each candidate is a paid call and ~10 s; two
# are enough to compare, and two rounds are enough to try another mode. A
# photo that needs more than that needs replacing, not more rolls.
MAX_CANDIDATES = 2
ROUNDS_PER_CREATION = 2

# The face crop sent for a touch-up: this many face boxes, square, at this
# size. 1.6 keeps the brows, the lids' surroundings and the lips well inside
# the crop, with enough context that the model draws a face, not a mask.
CROP_SCALE = 1.6
CROP_SIZE = 1024
CROP_QUALITY = 94
# Whole-image edits (stylise, regenerate) are sent at this long edge.
SOURCE_MAX_EDGE = 1024
# Where a whole-image result is stored at most (as for uploads).
STORED_MAX_EDGE = 2048

# A similarity fit whose landmarks miss by more than this (fraction of the
# face width, RMS) did not find the same face: the model moved or reshaped
# it too much to paste back.
MAX_ALIGN_RESIDUAL = 0.04
# Skin tone drift allowed between the photo and a candidate: delta E in LAB
# over the mean cheek colour, with lightness at half weight (regenerate asks
# for even light, which changes L on purpose; a change of hue or chroma is
# what reads as a different person's skin).
MAX_SKIN_DELTA_E = 12.0
SKIN_L_WEIGHT = 0.5

# MediaPipe indices. Eyes are named by the side of the IMAGE they are on
# (as in anchor_fit: 33 is the image-left eye's outer corner).
EYE_IMAGE_LEFT = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
                  468, 469, 470, 471, 472]
EYE_IMAGE_RIGHT = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384,
                   398, 473, 474, 475, 476, 477]
LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
# The eyebrows as closed contours (upper edge outward, lower edge back), not
# hulls: an arched brow's hull reaches down to the lid.
BROW_IMAGE_LEFT = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
BROW_IMAGE_RIGHT = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
# The face oval, in order round the face: where skin ends. The lips' colour
# ring must stay inside it, in the photo and in the answer alike.
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
             400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
             54, 103, 67, 109]
# The chin and the jaw beside it: where a mouth that closed shows it.
CHIN = [152, 148, 377, 176, 400]
# Landmarks a touch-up does not move: the nose bridge and the face oval above
# the mouth. The lower oval is left out because the jaw rises when a mouth
# closes.
STABLE = [168, 6, 197, 195, 5,
          10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 93, 234, 127, 162, 21, 54, 103, 67, 109]
CHEEK_IMAGE_LEFT = [50, 101, 118, 117, 116, 123, 147, 187, 205, 36]
CHEEK_IMAGE_RIGHT = [280, 330, 347, 346, 345, 352, 376, 411, 425, 266]
NOSE_TIP = 1
FACE_LEFT, FACE_RIGHT = 234, 454

# Mask geometry, as fractions of the region's own size (eye width, mouth
# width): the dilation brings the lids, lashes and lip edges along, the
# feather hides the join, the ring beyond it is where colour is measured.
# The eye's paste ends 0.30 eye widths out, short of the brow (0.3 to 0.4
# out on the face template); BROW_GUARD keeps it off a brow that sits
# closer, fading to nothing on the brow itself.
EYE_DILATE, EYE_FEATHER = 0.12, 0.18
LIP_DILATE, LIP_FEATHER = 0.15, 0.20
RING_WIDTH = 0.20
BROW_GUARD = 0.05
# How far the answer's chin may sit from the photo's once aligned, as a
# fraction of the face height, before the paste is refused. Parted lips
# (photo_analysis.TEETH_RATIO to OPEN_MOUTH_RATIO of the mouth width) close
# with the chin rising under 3.6% of the face; an open mouth moves it more.
MAX_JAW_SHIFT = 0.04

TOUCHUP_PROMPT = (
    "Edit this close-up portrait photograph. Make exactly two changes: the eyes "
    "are open naturally and looking straight into the camera, and the lips are "
    "relaxed and closed. Change NOTHING else: keep the same person, the same face "
    "shape, skin, skin texture, pores, makeup, eye colour, eyebrows, hair, "
    "lighting, colours, framing, head position, head angle and image size. Do not "
    "beautify, smooth, sharpen, relight, restyle or crop. Photorealistic, "
    "indistinguishable from the original photo except for the eyes and the lips."
)

# Regenerate, per line: the rig's requirements (frontal, eyes visible, mouth
# closed, plain backdrop) stated for the kind of face it is, plus what must
# not change.
REGENERATE_PROMPTS: dict[str, str] = {
    "human": (
        "Edit this photo into a head-and-shoulders portrait of the same person facing "
        "the camera directly, with even, soft, frontal lighting, both eyes open and "
        "looking at the camera, lips relaxed and closed, and a plain, uncluttered, "
        "evenly lit backdrop. Keep the person's identity exactly: same face shape and "
        "proportions, same skin tone, same hair and hairstyle, same apparent age, same "
        "clothing. Photorealistic. The whole head must be inside the frame with space "
        "around it; the face fills roughly half the image width. No text, no "
        "watermark, no hands or objects in front of the face."
    ),
    "animal": (
        "Edit this picture into a portrait of the same animal facing the camera "
        "directly, both eyes clearly visible, mouth closed, on a plain, uncluttered, "
        "evenly lit backdrop. Keep it the same animal: same species and breed, same "
        "fur or skin colours and markings, same eye colour, same style of picture. "
        "The whole head must be inside the frame with space around it, filling "
        "roughly half the image width. No text, no watermark, no people, no objects "
        "in front of the face."
    ),
    "cartoon": (
        "Edit this picture into a clean portrait of the same character facing the "
        "camera directly: clean lines, clearly drawn open eyes, mouth closed, on a "
        "plain, uncluttered backdrop. Keep it the same character: same design, "
        "colours, proportions, hair and clothing, and the same art style. The whole "
        "head must be inside the frame with space around it, filling roughly half the "
        "image width. No text, no watermark, no objects in front of the face."
    ),
}


class AdjustSkipped(Exception):
    """This photo cannot be adjusted in this mode; say why, spend nothing."""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(detail)


def reason(code: str, detail: str) -> Note:
    return {"code": code, "detail": detail}
