"""What an avatar's mouth config keeps of a kit, what the owner API shows
of it, and the AI disclosure of the shapes it made."""

from __future__ import annotations

from typing import Literal, cast

from app.models.shapes import KitRecord, KitShape, KitTeeth, Note, TeethNote
from app.services import performance_kit
from app.services.mouth_kit.calls import (
    CONSENT_NOT_RECORDED,
    GENERATED,
    RETARGETED,
    SHAPE_COUNT,
    _note,
    _now,
    generated_count,
    kit_model,
)

# Why the kit's teeth request brought nothing, passed on as its own note
# (the Mouth panel words each, as for the single "ee" photo's): what
# stopped the calls, or what the AI answered.
_TEETH_NOTE_CODES = frozenset(
    {
        "safety_refused",
        "no_image",
        "provider_error",
        "timeout",
        "imagegen_unavailable",
        "image_limit_reached",
        "third_party_ai_disabled",
        CONSENT_NOT_RECORDED[0],
    }
)
# The embed's own refusal of a teeth photo that passed every other check.
_UNCLEAR_CODES = frozenset({"teeth_photo_refused", "no_teeth_visible"})


def teeth_reason(result: performance_kit.KitResult) -> Note | None:
    """Why the kit brings no teeth photo, as a note the Mouth panel words
    (mouth.teeth.note, kit.teeth.reason), or None when it brings one (or
    was not asked for any). The request stopped or the AI did not answer
    with a picture (its own reason); the picture showed too little of the
    upper teeth for the embed (`mouth_teeth_unclear`, as for any mouth
    photo); or it failed a check, which the note names (`reason`) for the
    dashboard to word: `teeth_photo_rejected` alone would not say whether
    the lips were too close or the head moved."""
    if result.teeth_source is not None or result.teeth_report is None:
        return None
    reason = result.teeth_report.get("reason") or {}
    code = reason.get("code")
    if code in _TEETH_NOTE_CODES:
        return _note(code, reason["detail"])
    if code in _UNCLEAR_CODES:
        return _note(
            "mouth_teeth_unclear",
            "The AI's teeth photo shows too little of the upper teeth for the photographic "
            "mouth, so it was not used",
        )
    rejected: TeethNote = {
        "code": "teeth_photo_rejected",
        "detail": "The AI's teeth photo did not pass its checks "
        f"({reason.get('detail') or 'no reason given'}), so it was not used",
        # The check's own {code, detail} (performance_kit's teeth report).
        "reason": cast(Note, reason) if reason else None,
    }
    return rejected


def _standard_teeth(reason: Note) -> Note:
    """The teeth note for a mouth left with the standard teeth."""
    return {**reason, "detail": f"{reason['detail']}; this avatar uses standard teeth"}


def kit_record(
    result: performance_kit.KitResult,
    *,
    source: Literal["finish", "mouth_panel"],
    teeth: KitTeeth,
    fitted: dict[str, float],
) -> KitRecord:
    """What `mouth_config.kit` keeps of a kit, for the owner: its id and
    recipe, the model, each shape's provenance with why a shape was
    retargeted, whether its teeth photo is the avatar's (`teeth`: {used,
    reason}), the profile values it set (`fitted`, so they can be refitted
    when the teeth change and the owner has not moved them), what the fit
    could not measure, and what it took. `source` says where it was made:
    "finish" or "mouth_panel"."""
    shapes: dict[str, KitShape] = {}
    for shape in performance_kit.SHAPES:
        entry = result.report[shape]
        shapes[shape] = {
            "provenance": GENERATED if entry["status"] == "ok" else RETARGETED,
            "outcome": entry["outcome"],
            "reason": entry.get("reason"),
            "attempts": entry["attempts"],
        }
    generated = generated_count(result)
    manifest = result.manifest
    return {
        "id": manifest["character"][len(performance_kit.CHARACTER_PREFIX) :],
        "state": "made",
        "made_at": _now(),
        "source": source,
        "recipe": manifest.get("kit"),
        "model": kit_model(result),
        "shapes": shapes,
        "generated": generated,
        "retargeted": SHAPE_COUNT - generated,
        "teeth": teeth,
        "fitted": fitted,
        "fit_reasons": result.profile_fit.get("reasons") or [],
        "calls": result.calls,
        "billed_calls": result.billed_calls,
        "base_detected": result.base_detected,
        "rebased_at": None,
        "dropped": None,
    }


def public_kit(record: KitRecord | None) -> dict | None:
    """The kit as AvatarOut.mouth.kit tells the owner (api.avatars.presenting.mouth_view):
    {state: "made" | "dropped", made_at, model, generated, retargeted,
    shapes: [{shape, provenance, reason}] in the manifest's order, teeth:
    {used, reason}, dropped: {code, detail} | null}. None without a kit."""
    if not record:
        return None
    shapes = record.get("shapes") or {}
    return {
        "state": record.get("state") or "made",
        "made_at": record.get("made_at"),
        "model": record.get("model"),
        "generated": int(record.get("generated") or 0),
        "retargeted": int(record.get("retargeted") or 0),
        "shapes": [
            {
                "shape": shape,
                "provenance": shapes[shape].get("provenance"),
                "reason": shapes[shape].get("reason"),
            }
            for shape in performance_kit.SHAPES
            if shape in shapes
        ],
        "teeth": record.get("teeth"),
        "dropped": record.get("dropped"),
    }
