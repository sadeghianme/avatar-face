"""The record a made kit leaves in the avatar's expression_config (what
services.expressions reads)."""

from __future__ import annotations

from typing import Literal

from app.models.shapes import ExpressionKitRecord, ExpressionPicture, ExpressionShot
from app.services.expression_kit.build import ExpressionsResult
from app.services.expression_kit.constants import KIT_VERSION, PROMPTS_VERSION
from app.services.expressions import now

Source = Literal["panel", "publish", "batch"]


def kit_record(
    result: ExpressionsResult,
    *,
    source: Source,
    picture: ExpressionPicture,
    image_keys: dict[str, str],
    manifest_key: str | None,
) -> ExpressionKitRecord:
    shots: dict[str, ExpressionShot] = {}
    for name, entry in result.report.items():
        shot: ExpressionShot = {
            "status": "ok" if name in image_keys else "failed",
            "outcome": entry["outcome"],
            "reason": entry.get("reason"),
            "attempts": list(entry.get("attempts") or []),
        }
        if name in image_keys:
            shot["image_key"] = image_keys[name]
            shot["smile"] = bool(result.made[name].entry.smile)
        shots[name] = shot
    return {
        "id": result.kit_id,
        "made_at": now(),
        "source": source,
        "recipe": {"kit_version": KIT_VERSION, "prompts_version": PROMPTS_VERSION},
        "model": result.model,
        "manifest_key": manifest_key,
        "shots": shots,
        "made": len(image_keys),
        "calls": result.calls,
        "billed_calls": result.billed_calls,
        "picture": picture,
        "rebased_at": None,
    }
