"""1. What each request asks the image model for.

In the style of performance_kit.prompts: one sentence of anatomy for the
expression, then what must not change. Tuned on real Gemini
(gemini-3.1-flash-image) on two avatars, a photograph and a semi-realistic
illustration, 2026-10-11 (PROMPTS_VERSION's history):

- concern asked as "the inner ends raised" came back as the same knitted
  frown as anger and thinking; it says now what the brows must NOT do;
- thinking asked as "slightly raised" came back symmetric; it asks for
  brows "at visibly different heights";
- a drawn face came back as a photograph (skin colour 8 to 17 delta E off,
  refused by the kit's skin gate) until the picture's own medium was named;
- the photographed faces came back a few years older, with more lines and
  a greyer skin; the age and the skin tone are named, and what the model
  still changes of the skin is taken back afterwards (fidelity.keep_skin).
"""

from __future__ import annotations

from app.models.shapes import ExpressionName

KEEP = (
    "Change ONLY the facial expression: the eyebrows, the eyelids, the cheeks and the mouth. "
    "Keep exactly the same person and identity, the same face shape, skin, skin tone, skin "
    "texture, pores and makeup, the same eye colour, the eyes looking straight at the camera "
    "as before, the same nose, hair, ears and clothing, the same head position, head angle "
    "and head size in the frame, the same framing, lighting, colours, background and image "
    "size. Keep the person exactly as old as in the original: the skin exactly as smooth, "
    "even and clear as it is, with no added wrinkles, lines, eye bags, pores, spots, freckles "
    "or grain; only the few creases this expression itself makes, and those faint. Keep the "
    "skin tone, brightness and colour temperature exactly: not darker, greyer, warmer, "
    "cooler or more tanned. Keep the picture's own medium and rendering style exactly: if it "
    "is a painting, an illustration or a 3D render it stays one, with the same shading and "
    "colour palette; if it is a photograph it stays the same photograph. Do not beautify, "
    "smooth, sharpen, relight, restyle, zoom or crop. A natural, genuine moment in a friendly "
    "conversation, not a caricature, not a grimace, not an exaggerated or theatrical "
    "expression."
)

EXPRESSION_PROMPTS: dict[ExpressionName, str] = {
    "happy": (
        "smiling a genuine, warm smile (a Duchenne smile): the corners of the mouth drawn up "
        "and back, the lips parted to show the upper front teeth, the cheeks raised and "
        "rounded, the lower eyelids pushed up so the eyes narrow a little, with fine creases "
        "at their outer corners; the eyebrows relaxed, at most a little lowered at the outer ends"
    ),
    "surprised": (
        "pleasantly surprised, as on hearing unexpected good news: both eyebrows raised high "
        "and arched, a few horizontal creases across the forehead, the upper eyelids raised so "
        "the eyes look wider open, the jaw dropped slightly so the lips part softly; not "
        "shocked or frightened"
    ),
    "concerned": (
        "concerned and sympathetic, as when hearing that someone is having a hard time: the "
        "INNER ends of both eyebrows LIFTED UPWARD, so each eyebrow slants up towards the "
        "middle of the forehead (sad, worried eyebrows), the outer ends staying where they "
        "are, a few short horizontal creases in the middle of the forehead only, the eyes "
        "soft and open, the lips closed and relaxed with the corners of the mouth turned "
        "slightly down. The eyebrows must NOT be lowered, knitted or frowning: no vertical "
        "furrows between them, no anger; not crying"
    ),
    "thinking": (
        "thoughtful, pondering a question: an asymmetric look, the eyebrow on the right "
        "side of the picture clearly RAISED and arched, the eyebrow on the left side of the "
        "picture relaxed and slightly lowered, so the two eyebrows are at visibly different "
        "heights; the lips closed and pressed together and pulled slightly to one side, one "
        "corner of the mouth tucked in; still looking at the camera. Not frowning, not "
        "angry, not worried"
    ),
    "serious": (
        "serious and focused: the inner ends of the eyebrows lowered and drawn together, two "
        "short vertical furrows between the brows, the upper eyelids a little lowered, the "
        "lips closed and pressed together, the mouth straight; firm but calm, not angry"
    ),
}


def expression_prompt(name: str) -> str:
    """The whole edit prompt for one expression (PROMPTS_VERSION)."""
    anatomy = EXPRESSION_PROMPTS[name]  # type: ignore[index]  # a KeyError for any other name
    return f"Edit this close-up portrait photograph so that the same person is {anatomy}. {KEEP}"
