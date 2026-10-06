"""AI adjust: a paid AI edit of the photo before it is rigged.

Step 3 of the creation wizard (docs/avatar-lines.md, "The creation flow"),
after the background: recommended when the photo check finds something to
fix (photo_analysis.recommend), and always the owner's choice. Three modes,
per line:

- **touchup** (human): open eyes looking at the camera and relaxed closed
  lips, nothing else. The model sees a FACE CROP, and only the eye and lip
  regions of its answer are pasted back onto the photo, at the photo's own
  resolution. Everything else (hair, skin, clothes, background, and every
  pixel of the face outside those regions) is the owner's original.
- **stylise** (human → animation): the existing imagegen styles, on the
  whole image. Choosing the result moves the creation to the animation line.
- **regenerate** (every line): a full edit to a frontal, evenly lit,
  plain-backdrop picture of the same subject.

Why touch-up is a crop and a paste, not an edit of the photo: an image model
asked to change the eyes of a whole portrait redraws the whole portrait. The
skin, the hair and the identity drift, and the result comes back at the
model's size, not the photo's. Sending only the face (about 1.6 face boxes,
square, 1024 px) spends the model's pixels where the change is, and pasting
back only the eye and lip regions keeps every other pixel. To make the paste
invisible the answer is:

1. aligned to the photo with a similarity transform estimated from STABLE
   landmarks (the nose bridge and the upper face oval), found by MediaPipe
   on both images. Never the eyes or the mouth: those are what changed, and
   the jaw moves when an open mouth closes;
2. low-passed before it is shrunk onto the photo's pixel grid (and the
   crop before it is shrunk to the model's size): a resampler that does not
   average leaves lashes and iris texture finer than the photo's pixels at
   full contrast, jagged and crisper than the face around them;
3. masked by the hulls of the eye and lip landmarks (the photo's and the
   answer's together, so an eye that opened is covered where it now is and
   where it was), dilated a little so the lids and lip edges come along,
   and never onto the eyebrows (the prompt keeps them; pasting their edge
   would show it twice, wherever the model drew it);
4. feathered with a smoothstep, so there is no seam to see;
5. colour-matched in LAB on a ring just outside each region (the model
   relights what it touches), and grain-matched (the model's pixels are
   cleaner than a phone photo's, and a smooth patch reads as a sticker).
   Both are measured robustly (median, MAD) on skin only: the ring leaves
   out the brows and, for the lips, whatever lies outside either face, so
   brow hairs are not taken for sensor grain nor a neck for skin.

A touch-up refuses an answer whose jaw moved (`jaw_moved`): closing an open
mouth raises the chin, and pasted closed lips on the photo's dropped chin
make a longer face. An open mouth is therefore a regenerate's job
(photo_analysis.recommend); a touch-up closes parted lips.

The image adjusted is the CURRENT one, which after step 2 is usually a
cut-out. The model is then shown the person on a flat neutral grey
(photo_io.on_backdrop), never the removed background, which is not in the
file anyway. A touch-up pastes its eyes and lips back into the cut-out's own
pixels and leaves the transparency alone, so the result is still a cut-out;
a regenerated or stylised picture comes back opaque on a plain backdrop, and
services.creations cuts it out again when the owner chose to remove the
background.

Every candidate is checked before it is offered: a face must still be found
(human and animation lines) and the fit validator must pass on it, and for a
person, the skin tone must not drift (mean cheek colour, delta E in LAB).
A failed candidate is kept with its reason and cannot be chosen; nothing is
ever used without the owner choosing it. There is deliberately no
face-recognition identity check: the owner compares side by side, and
biometric processing is not needed for that.

Everything here is CPU work (decode, MediaPipe, resampling, masks) and runs
on the jobs CPU thread; the provider call itself is awaited on the loop by
services.creations.

The package:

    scheme   the modes per line, the budgets and limits, the landmark
             groups and paste regions, the prompts, why a photo is skipped
    sending  what is sent: the photo prepared per mode (the face crop for
             a touch-up), and the head-crop fallback after a refusal
    paste    colour (LAB, delta E), alignment, masks, and the masked
             paste-back of the eyes and lips
    checks   what is checked on an answer, the candidate it makes, and
             the prompt of a generated creation

Everything is re-exported here, so `photo_adjust.X` keeps working.
"""

from __future__ import annotations

from app.services.photo_adjust.checks import (
    Candidate,
    _checked,
    _png,
    cheek_colour,
    finish_candidate,
    generation_prompt,
    skin_drift,
)
from app.services.photo_adjust.paste import (
    _D65,
    _MAD_TO_STD,
    _RGB_TO_XYZ,
    _XYZ_TO_RGB,
    Region,
    _antialiased,
    _grain,
    _hull_mask,
    _invert,
    _paste_region,
    _polygon_mask,
    _smoothstep,
    align,
    apply,
    delta_e,
    jaw_shift,
    lab_to_rgb,
    paste_back,
    rgb_to_lab,
    similarity_transform,
)
from app.services.photo_adjust.scheme import (
    BROW_GUARD,
    BROW_IMAGE_LEFT,
    BROW_IMAGE_RIGHT,
    CHEEK_IMAGE_LEFT,
    CHEEK_IMAGE_RIGHT,
    CHIN,
    CROP_QUALITY,
    CROP_SCALE,
    CROP_SIZE,
    EYE_DILATE,
    EYE_FEATHER,
    EYE_IMAGE_LEFT,
    EYE_IMAGE_RIGHT,
    FACE_LEFT,
    FACE_OVAL,
    FACE_RIGHT,
    LIP_DILATE,
    LIP_FEATHER,
    LIPS,
    MAX_ALIGN_RESIDUAL,
    MAX_CANDIDATES,
    MAX_JAW_SHIFT,
    MAX_SKIN_DELTA_E,
    MAX_TOUCHUP_YAW,
    MODES,
    MODES_BY_LINE,
    NOSE_TIP,
    REGENERATE,
    REGENERATE_PROMPTS,
    RING_WIDTH,
    ROUNDS_PER_CREATION,
    SKIN_L_WEIGHT,
    SOURCE_MAX_EDGE,
    STABLE,
    STORED_MAX_EDGE,
    STYLISE,
    TOUCHUP,
    TOUCHUP_PROMPT,
    AdjustSkipped,
    reason,
)
from app.services.photo_adjust.sending import (
    FALLBACK_FACE_WIDTHS,
    Prepared,
    _alpha,
    _detect,
    _jpeg,
    _own_rgb,
    _rgb,
    crop_face,
    eyes_closed,
    face_crop_box,
    head_crop,
    head_crop_box,
    head_crop_fallback,
    prepare,
    yaw_offset,
)

__all__ = [
    "AdjustSkipped",
    "align",
    "_alpha",
    "_antialiased",
    "apply",
    "BROW_GUARD",
    "BROW_IMAGE_LEFT",
    "BROW_IMAGE_RIGHT",
    "Candidate",
    "_checked",
    "cheek_colour",
    "CHEEK_IMAGE_LEFT",
    "CHEEK_IMAGE_RIGHT",
    "CHIN",
    "crop_face",
    "CROP_QUALITY",
    "CROP_SCALE",
    "CROP_SIZE",
    "_D65",
    "delta_e",
    "_detect",
    "EYE_DILATE",
    "EYE_FEATHER",
    "EYE_IMAGE_LEFT",
    "EYE_IMAGE_RIGHT",
    "eyes_closed",
    "face_crop_box",
    "FACE_LEFT",
    "FACE_OVAL",
    "FACE_RIGHT",
    "FALLBACK_FACE_WIDTHS",
    "finish_candidate",
    "generation_prompt",
    "_grain",
    "head_crop",
    "head_crop_box",
    "head_crop_fallback",
    "_hull_mask",
    "_invert",
    "jaw_shift",
    "_jpeg",
    "lab_to_rgb",
    "LIP_DILATE",
    "LIP_FEATHER",
    "LIPS",
    "_MAD_TO_STD",
    "MAX_ALIGN_RESIDUAL",
    "MAX_CANDIDATES",
    "MAX_JAW_SHIFT",
    "MAX_SKIN_DELTA_E",
    "MAX_TOUCHUP_YAW",
    "MODES",
    "MODES_BY_LINE",
    "NOSE_TIP",
    "_own_rgb",
    "paste_back",
    "_paste_region",
    "_png",
    "_polygon_mask",
    "prepare",
    "Prepared",
    "reason",
    "REGENERATE",
    "REGENERATE_PROMPTS",
    "Region",
    "_rgb",
    "rgb_to_lab",
    "_RGB_TO_XYZ",
    "RING_WIDTH",
    "ROUNDS_PER_CREATION",
    "similarity_transform",
    "skin_drift",
    "SKIN_L_WEIGHT",
    "_smoothstep",
    "SOURCE_MAX_EDGE",
    "STABLE",
    "STORED_MAX_EDGE",
    "STYLISE",
    "TOUCHUP",
    "TOUCHUP_PROMPT",
    "_XYZ_TO_RGB",
    "yaw_offset",
]
