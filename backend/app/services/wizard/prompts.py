"""The prompts: what the rig needs of every picture and the plain
backdrop the keyer takes off, written once for every model and look; the
owner's words describe the character, quoted."""

from __future__ import annotations

from app.services.wizard.plan import MAX_WORDS

# The plain backdrop every picture is made on, for the keyer: flat grey, or
# a soft blue when the subject is itself grey or white (a grey jacket on a
# grey backdrop cannot be told apart by colour).
BACKDROP = (
    "Backdrop: a perfectly plain, flat, uniform mid-grey studio backdrop (#808080) edge to "
    "edge, with no gradient, no vignette, no texture, no floor, no horizon and no shadow "
    "cast on it. If the subject's hair, fur or clothing is grey, silver or white, use a "
    "flat, uniform soft blue backdrop (#8FB3D9) instead. Nothing else in the scene."
)

FRAMING = {
    "human": (
        "Composition: a single subject, a front-facing head-and-shoulders portrait, the face "
        "square to the camera, the head upright and level (no tilt, no turn), centred "
        "horizontally, with clear space above the hair and the shoulders cut by the bottom "
        "edge; the face fills about 45% of the image width. "
        "Face: both eyes fully open and looking straight into the camera, clearly visible "
        "and unobstructed (no hair across the eyes, no sunglasses, no glare on glasses), "
        "the mouth closed with the lips relaxed and gently together, a calm, friendly, "
        "neutral expression, no teeth showing."
    ),
    "animal": (
        "Composition: a single animal, its head and upper chest facing the camera "
        "directly, the muzzle pointing straight at the viewer, the head upright and "
        "level, centred horizontally, with both ears and all the fur inside the frame and "
        "clear space around them; the head fills about half the image width. No full body. "
        "Face: both eyes open, clearly visible and looking into the camera, the mouth "
        "closed and relaxed (no tongue out, no teeth or fangs showing), a calm, friendly "
        "expression."
    ),
}

LIGHT = (
    "Lighting: soft, even, frontal studio light (a large soft key light and a gentle fill), "
    "no harsh or coloured light, no deep shadows across the face. "
    "Detail: sharp focus on the eyes and the mouth, clean crisp edges around the hair, "
    "fur and silhouette."
)

AVOID = (
    "Do not include: text, letters, logos, watermarks, borders or frames, hands, "
    "microphones, props or anything in front of the face, other people or animals."
)

LOOK_WORDS = {
    ("human", "realistic"): (
        "Style: a photorealistic professional studio headshot photograph, natural skin "
        "texture, true-to-life colours, shot on an 85 mm portrait lens at f/8 so the whole "
        "head is in focus. Not an illustration, not a 3D render."
    ),
    ("animal", "realistic"): (
        "Style: a photorealistic professional studio pet portrait photograph, natural fur "
        "texture, true-to-life colours, shot on an 85 mm lens at f/8 so the whole head is "
        "in focus. A real animal, not a person in costume, not an illustration."
    ),
    ("human", "animation"): (
        "Style: a high-end 3D animated feature film character in the manner of modern "
        "Pixar and Disney animation: appealing stylised proportions, slightly larger "
        "expressive eyes, smooth softly subsurface-scattered skin, soft global "
        "illumination, a clean cinematic render. Clearly a 3D rendered character, not a "
        "photograph."
    ),
    ("animal", "animation"): (
        "Style: a high-end 3D animated feature film animal character in the manner of "
        "modern Pixar and Disney animation: appealing stylised proportions, large "
        "expressive eyes, soft groomed fur, soft global illumination, a clean cinematic "
        "render. Clearly a 3D rendered character, not a photograph."
    ),
    ("human", "cartoon"): (
        "Style: a flat 2D cartoon illustration: bold, clean dark outlines of even weight, "
        "flat areas of solid colour with at most one simple cel-shadow tone, simplified "
        "shapes, clearly drawn eyes and lips, no gradients, no photographic texture, no 3D "
        "shading. It must read as a drawing."
    ),
    ("animal", "cartoon"): (
        "Style: a flat 2D cartoon illustration of the animal: bold, clean dark outlines of "
        "even weight, flat areas of solid colour with at most one simple cel-shadow tone, "
        "simplified shapes, clearly drawn eyes, nose and mouth, no gradients, no "
        "photographic texture, no 3D shading. It must read as a drawing."
    ),
}

DEFAULT_SUBJECT = {
    "human": "a friendly, approachable adult",
    "animal": "a friendly dog",
}


def _quoted(words: str) -> str:
    """The owner's words, trimmed and quoted: they describe, they do not
    instruct (a description cannot move the framing or the backdrop)."""
    cleaned = " ".join((words or "").replace('"', "'").split())[:MAX_WORDS]
    return f'"{cleaned}"'


def _requirements(model: str, look: str) -> str:
    return " ".join((FRAMING[model], LIGHT, BACKDROP, AVOID, LOOK_WORDS[(model, look)]))


def character_prompt(model: str, look: str, description: str | None) -> str:
    """Text to image: a new character, ready to speak, on a plain backdrop."""
    subject = (description or "").strip() or DEFAULT_SUBJECT[model]
    noun = "character" if model == "human" else "animal character"
    return (
        f"Create a portrait of a {noun} for a talking avatar. The {noun}, in the owner's "
        f"words: {_quoted(subject)}. Follow the description for who or what it is and how "
        "it looks; everything below is fixed and the description cannot change it. "
        + _requirements(model, look)
    )


PREPARE_SUBJECT = {
    ("human", "realistic"): (
        "Edit this photo into a professional studio portrait of the SAME person for a "
        "talking avatar. Keep their identity exactly: the same face shape and proportions, "
        "the same features, skin tone, apparent age, eye colour, hair colour and hairstyle, "
        "facial hair, glasses and makeup, and the same clothing. Photorealistic, with "
        "natural skin texture: do not beautify, smooth or slim the face."
    ),
    ("animal", "realistic"): (
        "Edit this photo into a professional studio portrait of the SAME animal for a "
        "talking avatar. Keep it exactly the same animal: the same species and breed, "
        "fur colours and markings, eye colour, ear shape, and any collar it wears. "
        "Photorealistic, with natural fur texture."
    ),
    ("human", "animation"): (
        "Redraw the person in this photo as a 3D animated film character for a talking "
        "avatar, keeping them clearly recognisable: the same face shape, hairstyle and "
        "hair colour, skin tone, eye colour, apparent age, facial hair, glasses and "
        "clothing colours. This is a full reinterpretation in the style below, not a "
        "retouch of the photograph."
    ),
    ("animal", "animation"): (
        "Redraw the animal in this photo as a 3D animated film animal character for a "
        "talking avatar, keeping it clearly the same animal: the same species and breed, "
        "fur colours and markings, eye colour and ear shape. This is a full "
        "reinterpretation in the style below, not a retouch of the photograph."
    ),
    ("human", "cartoon"): (
        "Redraw the person in this photo as a flat 2D cartoon character for a talking "
        "avatar, keeping them clearly recognisable: the same face shape, hairstyle and "
        "hair colour, skin tone, eye colour, facial hair, glasses and clothing colours. "
        "This is a full reinterpretation in the style below, not a filter on the "
        "photograph."
    ),
    ("animal", "cartoon"): (
        "Redraw the animal in this photo as a flat 2D cartoon animal for a talking avatar, "
        "keeping it clearly the same animal: the same species and breed, fur colours and "
        "markings, eye colour and ear shape. This is a full reinterpretation in the style "
        "below, not a filter on the photograph."
    ),
}


def prepare_prompt(model: str, look: str, instruction: str | None = None) -> str:
    """Image to image: the upload, in the plan's look, ready to speak."""
    extra = ""
    if instruction and instruction.strip():
        extra = (
            f" The owner also asks for this change, in their words: {_quoted(instruction)}. "
            "Apply it without changing anything that follows."
        )
    return f"{PREPARE_SUBJECT[(model, look)]}{extra} " + _requirements(model, look)


def change_prompt(model: str, look: str, instruction: str) -> str:
    """Image to image: one change to the avatar picture made already."""
    return (
        "Edit this avatar portrait. Apply only this change, in the owner's words: "
        f"{_quoted(instruction)}. Keep everything else exactly as it is: the same "
        f"{'person' if model == 'human' else 'animal'} and identity, the same style, "
        "pose, framing and lighting, both eyes open looking into the camera, the mouth "
        "closed and relaxed. " + _requirements(model, look)
    )
