"""1. Pose prompts: what each request asks the image model for."""

from __future__ import annotations

from app.services.performance_kit.constants import TEETH

# What every pose edit must keep. The Reference's brief (docs/
# reference-avatar-lab.md, "Expression edits"): the same camera, light, face
# and skin, only speech anatomy changes. Registration checks it afterwards;
# the prompt is what makes it likely.
_KEEP = (
    "Change ONLY the mouth, lips, teeth, tongue and jaw. Keep exactly the same person "
    "and identity, the same face shape, skin, skin tone, skin texture and makeup, the "
    "same eyes looking in the same direction, the same eyebrows, nose, hair and ears, "
    "the same head position, head angle and head size in the frame, the same framing, "
    "lighting, colours, background and image size. Do not beautify, smooth, sharpen, "
    "relight, restyle, zoom or crop. Photorealistic: a natural moment of relaxed "
    "speech, not a grimace or an exaggerated expression."
)

# One sentence per shape: the anatomy of that sound, as the Reference's
# poses show it. EE is the "ee" of speech, the tips of the upper teeth at
# most, as the Reference's own EE shows them; the teeth photo is asked for
# on its own (teeth_prompt).
#
# Tuned on real Gemini (gemini-3.1-flash-image, two fictional faces, twelve
# poses, all registered within the Reference's gate): asked only for a
# dropped jaw, AA opened to a yawn (0.39 and 0.63 mouth widths against the
# Reference's 0.29); asked for the tongue "between the teeth", TH pushed it
# far out; and F/V was ambiguous until the teeth were said to press on the
# lower lip. Hence the "not a yawn or a shout", "the very tip" and
# "pressing gently" below. What still comes back too open is scaled or
# refused (normalize_amplitude, POSE_LIMITS).
POSE_PROMPTS: dict[str, str] = {
    "aa": (
        'saying the open vowel "ah" as in "father": the mouth moderately open, as in '
        "normal conversation, not a yawn or a shout, the opening about a third as tall "
        "as the mouth is wide, the lips relaxed, the tips of the upper front teeth just "
        "visible, the tongue resting low and flat"
    ),
    "ee": (
        'saying "ee" as in "see", in relaxed speech: the lips drawn wide, the mouth '
        "only slightly open, at most the biting edges of the upper front teeth showing"
    ),
    "oo": (
        'saying "oo" as in "you", in normal conversation: the lips rounded and pushed a '
        "little forward around a clearly open, round hole, not a kiss, a whistle or a pout, "
        "the corners of the mouth drawn in and no teeth showing"
    ),
    "oh": (
        'saying "oh" as in "go": the lips rounded into an open oval, taller than it is '
        'wide, the jaw lowered, less pushed forward than for "oo"'
    ),
    "fv": (
        'saying "f" as in "five": the lower lip drawn up and tucked lightly under the upper '
        "front teeth, which rest on it; the mouth otherwise closed, only the biting edges of "
        "the upper front teeth showing"
    ),
    "th": (
        'saying "th" as in "think": only the very tip of the tongue, barely visible '
        "between the front teeth, the mouth slightly open"
    ),
}


def pose_prompt(shape: str) -> str:
    """The whole edit prompt for one shape (PROMPTS_VERSION)."""
    return (
        "Edit this close-up portrait photograph so that the same person is "
        f"{POSE_PROMPTS[shape]}. {_KEEP}"
    )


# The teeth photo, as services.mouth_photo asks for it.
# Modelled on photo_adjust.TOUCHUP_PROMPT (change one thing, keep every
# other pixel) and on the oral-detail-v3 prompt of the Reference avatar
# (docs/dental-rendering-repair-2026-09-07.md), whose teeth the renderer was
# tuned on: whole upper crowns from the gum to the edge, one continuous
# arch, a dark gap between the rows, soft light with no stripe across them.
TEETH_PROMPT = (
    "Edit this close-up portrait photograph. Make exactly one change: the person "
    "says a long, broad \"ee\", lips drawn back and slightly apart, so that the "
    "ENTIRE upper front teeth are clearly visible from the gumline to the biting "
    "edge, with a thin band of gum above them, all the upper front teeth in one "
    "continuous natural arch, a small dark gap between the upper and lower teeth, "
    "and the top edge of the lower front teeth just visible. These are this "
    "person's own natural teeth: natural shape, spacing and shade for them, with "
    "no whitening, veneers or brightening beyond their natural tone. Change "
    "NOTHING else: keep the same person, the same face shape, skin, skin texture, "
    "pores, makeup, eyes, eye colour, eyebrows, hair, lighting, colours, framing, "
    "head position, head angle and image size. Do not beautify, smooth, sharpen, "
    "relight, restyle or crop. Soft, even light on the teeth with no dark stripe "
    "across them. Photorealistic, indistinguishable from the original photo "
    "except for the mouth."
)


def teeth_prompt() -> str:
    """The teeth photo's edit (TEETH_PROMPT, which services.mouth_photo
    asks for on its own too): the recipe of the photo the Reference renders its teeth from
    (oral-detail-v3): the whole upper crowns from the gum to the edge in one
    arch, a dark gap between the rows, even light, nothing else changed.
    What the embed needs of a teeth photo is not a shape of speech, so it
    is asked for apart from the six."""
    return TEETH_PROMPT


def request_prompt(shape: str) -> str:
    """The prompt sent for `shape`: one of SHAPES, or TEETH."""
    return teeth_prompt() if shape == TEETH else pose_prompt(shape)
