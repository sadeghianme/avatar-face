"""What visitors are told was made by AI: the `ai_edited` record of an
avatar, as its mouth's AI parts come and go.

A leaf, on purpose: the teeth photo (services.mouth_photo), the mouth kit
(services.mouth_kit) and publishing all rewrite this record, and each of
them depends on the others for everything else.

`ai_edited` is {mode, model, ...}: a picture's own mode (touchup, stylise,
regenerate, generate) when an AI made or changed the picture, outranking
the mouth's; otherwise "teeth" or "mouth_shapes" while only the mouth was
AI-made, with the entries for each ({"teeth": {model}}, {"mouth_shapes":
{model, generated}}). New dicts every time: JSON columns are replaced,
never mutated.
"""

from __future__ import annotations

from app.models.shapes import AiEdited, AiShapesEntry

# The disclosure's modes that say only the MOUTH was AI-made, the picture
# itself not: its teeth photo (`teeth`), its mouth shapes (`mouth_shapes`,
# services.mouth_kit). Every other mode is the picture's own (touchup,
# stylise, regenerate, generate) and outranks them.
MOUTH_MODES = ("teeth", "mouth_shapes")


def mouth_disclosure(ai_edited: AiEdited | None) -> AiEdited | None:
    """`ai_edited` with its mode re-derived when only the mouth was AI-made:
    "teeth" while there is a teeth entry, else "mouth_shapes" while there is
    a shapes entry, else nothing to disclose (None). The model is that
    entry's. A picture's own mode is left as it is."""
    if not ai_edited:
        return None
    if ai_edited.get("mode") not in MOUTH_MODES:
        return ai_edited
    teeth, shapes = ai_edited.get("teeth"), ai_edited.get("mouth_shapes")
    if teeth:
        derived: AiEdited = {"mode": "teeth", "model": teeth.get("model"), "teeth": teeth}
        if shapes:
            derived["mouth_shapes"] = shapes
        return derived
    if shapes:
        return {"mode": "mouth_shapes", "model": shapes.get("model"), "mouth_shapes": shapes}
    return None


def with_ai_teeth(ai_edited: AiEdited | None, model: str | None) -> AiEdited:
    """The disclosure once AI made the teeth (a new dict: JSON columns are
    replaced, never mutated)."""
    if not ai_edited:
        return {"mode": "teeth", "model": model, "teeth": {"model": model}}
    edited = ai_edited.copy()
    edited["teeth"] = {"model": model}
    disclosed = mouth_disclosure(edited)
    assert disclosed is not None  # a teeth entry is always disclosed
    return disclosed


def without_ai_teeth(ai_edited: AiEdited | None) -> AiEdited | None:
    """The disclosure once AI-made teeth are gone (replaced or removed):
    whatever else AI did, to the picture or to the mouth's shapes, stays
    disclosed."""
    if not ai_edited:
        return None
    rest = ai_edited.copy()
    rest.pop("teeth", None)
    return mouth_disclosure(rest)


def with_ai_shapes(ai_edited: AiEdited | None, model: str | None, generated: int) -> AiEdited:
    """The disclosure once AI made `generated` of the mouth's shapes (a new
    dict: JSON columns are replaced, never mutated)."""
    entry: AiShapesEntry = {"model": model, "generated": generated}
    if not ai_edited:
        return {"mode": "mouth_shapes", "model": model, "mouth_shapes": entry}
    edited = ai_edited.copy()
    edited["mouth_shapes"] = entry
    disclosed = mouth_disclosure(edited)
    assert disclosed is not None  # a shapes entry is always disclosed
    return disclosed


def without_ai_shapes(ai_edited: AiEdited | None) -> AiEdited | None:
    """The disclosure once no AI-made shape is shown (the kit dropped, a
    kit with none, the published mouth without its motion): whatever else
    AI made stays disclosed."""
    if not ai_edited:
        return None
    rest = ai_edited.copy()
    rest.pop("mouth_shapes", None)
    return mouth_disclosure(rest)
