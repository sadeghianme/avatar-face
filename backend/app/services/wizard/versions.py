"""Versions: every picture step 3 made is kept, and the owner may go back
to any of them."""

from __future__ import annotations

import copy

from app.core.errors import Conflict409, Validation422
from app.services.wizard.plan import (
    AI,
    CHANGE,
    GENERATE,
    KEPT_ANCHORS,
    KEPT_RECORD,
    ORIGINAL,
)

# Every try on step 3 is kept: the upload (a realistic one, framed and cut
# out by "use my original photo") and each AI result, with the cut-out made
# of it. The owner may go back to any of them (POST /version): the newest
# is not better for being newest.


def version_of(steps: dict | None, step_id: str | None) -> str | None:
    """The version the image `step_id` belongs to: "original" for the
    upload, its framing and their cut-out; "adjusted:N" for an AI result
    and its cut-out."""
    from app.services import creations as svc

    source = svc._through_cutouts(steps, step_id)
    return "original" if source == "framed" else source


def use_version(steps: dict | None, version: str, plan: dict) -> tuple[dict, dict | None, dict]:
    """The steps with `version` current (its cut-out when it has one), the
    anchors kept with it (None when it has none: they are found again), and
    the record of the try that made it, for `ai.last_prepare`, so Retry and
    "describe a change" carry on from the version chosen.

    Raises: unknown_version, candidate_rejected, original_not_for_look (the
    upload of a stylised plan is not a picture the avatar is made of),
    version_not_prepared (an upload never framed and cut out: "use my
    original photo" makes it).
    """
    from app.services import creations as svc

    items = svc.step_items(steps)
    if version not in items or version_of(steps, version) != version:
        raise Validation422("There is no such version", code="unknown_version")
    item = items[version]
    adjust = item.get("adjust") or {}
    if adjust.get("rejected"):
        raise Validation422(
            "This result failed its checks and cannot be used", code="candidate_rejected"
        )
    opaque = version
    if version == "original" and plan["source"] == "upload":
        if plan["look"] != "realistic":
            raise Validation422(
                "Your own photo is used as it is only for a realistic avatar",
                code="original_not_for_look",
            )
        opaque = "framed" if "framed" in items else "original"
        prepared = (
            "framed" in items
            or (items.get(svc.CUTOUT) or {}).get("from") == "original"
            or KEPT_RECORD in item
        )
        if not prepared:
            raise Conflict409("Your photo has not been prepared yet", code="version_not_prepared")
    out = svc.copied(steps)
    cut = svc.cutout_id_for(opaque)
    if cut in items and items[cut].get("from") == opaque:
        out["current"], out["background"] = cut, "remove"
    else:
        out["current"], out["background"] = opaque, "keep"
    record = dict(items[opaque].get(KEPT_RECORD) or {})
    if not record:
        # A version made before records were kept: read off the step.
        if version == "original":
            mode = GENERATE if plan["source"] == GENERATE else ORIGINAL
        elif adjust.get("mode") == GENERATE:
            mode = GENERATE
        else:
            mode = CHANGE if adjust.get("instruction") else AI
        record = {
            "mode": mode,
            "look": adjust.get("look") or plan["look"],
            "instruction": adjust.get("instruction"),
            "step": opaque,
        }
    record["cut"] = out["current"] != opaque
    kept = items[opaque].get(KEPT_ANCHORS)
    return out, copy.deepcopy(kept) if kept else None, record
