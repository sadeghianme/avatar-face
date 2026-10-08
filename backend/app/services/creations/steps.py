"""A creation's steps: the images the wizard made, how each was made from
another, and what follows from that lineage (the current image, its pixel
frame and photo check, the statement finishing asks for).

`steps` is the JSON column: {"current": step id, "items": {id: item}, ...}.
Clients name steps by id ("original", "framed", "cutout", "adjusted:N",
"cutout:N"), never by storage key."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any, Literal, cast

from app.models import Creation
from app.models.shapes import AdjustRound, AiEdited, CreationSteps, Plan, StepCheck, StepItem
from app.services import consent
from app.services.creations.rules import (
    ADJUSTED_PREFIX,
    CHECK_KEYS,
    CUTOUT,
    CUTOUT_PREFIX,
)
from app.services.photo_analysis import recommend


def plan_of(steps: CreationSteps | None) -> Plan | None:
    """The four-step wizard's plan (services.wizard.plan), or None for a
    creation made without one."""
    plan = steps.get("plan") if steps else None
    return plan.copy() if isinstance(plan, dict) else None


def step_items(steps: CreationSteps | None) -> dict[str, StepItem]:
    return (steps.get("items") if steps else None) or {}


def current_step(steps: CreationSteps | None) -> str | None:
    return steps.get("current") if steps else None


def adjusted_index(step_id: str) -> int | None:
    """N of "adjusted:N", or None for any other step id."""
    if not step_id.startswith(ADJUSTED_PREFIX):
        return None
    tail = step_id[len(ADJUSTED_PREFIX):]
    return int(tail) if tail.isdigit() else None


def is_cutout_id(step_id: str | None) -> bool:
    """A background removal's output: "cutout", or "cutout:N" (of adjusted:N)."""
    return bool(step_id) and (step_id == CUTOUT or step_id.startswith(CUTOUT_PREFIX))


def cutout_id_for(source_id: str) -> str:
    """The id the cut-out of `source_id` is stored under."""
    index = adjusted_index(source_id)
    return CUTOUT if index is None else f"{CUTOUT_PREFIX}{index}"


def is_cut_out(items: dict[str, StepItem], step_id: str | None) -> bool:
    """Is the image transparent around the subject? A background removal's
    output, and a touch-up made from one (it keeps the cut-out's alpha)."""
    item = items.get(step_id) if step_id else None
    return is_cutout_id(step_id) or bool(item and item.get("cutout"))


def ordered_step_ids(items: dict[str, StepItem]) -> list[str]:
    """The steps in the wizard's order: original, framed, cut-out, then each
    AI result followed by its own cut-out."""
    indexed = {i: n for i in items if (n := adjusted_index(i)) is not None}
    adjusted = sorted(indexed, key=indexed.__getitem__)
    ordered = [i for i in ("original", "framed", CUTOUT) if i in items]
    for step_id in adjusted:
        ordered.append(step_id)
        cut = cutout_id_for(step_id)
        if cut in items:
            ordered.append(cut)
    # Anything else (nothing today) still shows, last.
    return ordered + sorted(i for i in items if i not in ordered)


def remove_steps(steps: CreationSteps, doomed: set[str]) -> list[str]:
    """Remove the steps `doomed` (in place); their keys, to delete.

    A surviving step made from a removed one now names what that one was
    made from, so every lineage stays walkable (an AI result made from a
    cut-out outlives the cut-out when the line changes). A removed current
    image hands over to its nearest surviving ancestor.
    """
    items = steps["items"]
    doomed = {i for i in doomed if i in items}
    if not doomed:
        return []

    def surviving(step_id: str | None) -> str | None:
        seen: set[str] = set()
        while step_id in doomed and step_id not in seen:
            seen.add(step_id)
            step_id = items[step_id].get("from")
        return step_id if step_id in items else None

    current = steps.get("current")
    if current in doomed:
        steps["current"] = surviving(current) or "original"
    for step_id, item in items.items():
        if step_id not in doomed and item.get("from") in doomed:
            item["from"] = surviving(item["from"])
    return [items.pop(i)["key"] for i in sorted(doomed)]


def drop_adjusted(steps: CreationSteps) -> list[str]:
    """Remove every AI adjust candidate and its cut-out (the frame they were
    made from changed); their keys, to delete."""
    items = steps["items"]
    return remove_steps(
        steps,
        {i for i in items if adjusted_index(i) is not None or i.startswith(CUTOUT_PREFIX)},
    )


def drop_cutouts(steps: CreationSteps) -> list[str]:
    """Remove every cut-out, a touch-up of one included (the line changed,
    so the segmenter that made them no longer applies); their keys."""
    items = steps["items"]
    return remove_steps(steps, {i for i in items if is_cut_out(items, i)})


def lineage(steps: CreationSteps | None, step_id: str | None) -> list[StepItem]:
    """The step `step_id` and every step it was made from, newest first."""
    items = step_items(steps)
    chain: list[StepItem] = []
    seen: set[str] = set()
    while step_id in items and step_id not in seen:
        seen.add(step_id)
        chain.append(items[step_id])
        step_id = items[step_id].get("from")
    return chain


def ai_edited_of(steps: CreationSteps | None, step_id: str | None) -> AiEdited | None:
    """{mode, model} when an AI made or changed the image `step_id` shows:
    the latest adjust in its lineage, else a generated original. None for
    a photo as its owner gave it (framing and cut-outs are not AI edits)."""
    for item in lineage(steps, step_id):
        adjust = item.get("adjust")
        if adjust:
            return {"mode": adjust["mode"], "model": adjust.get("model")}
        generated = item.get("generated")
        if generated:
            return {"mode": "generate", "model": generated.get("model")}
    return None


def detected_a_person(item: StepItem) -> bool:
    """Did the photo check find a human face on this image? MediaPipe's
    face landmarker is trained on people: a detection is a person's face,
    or a drawing close enough to one to be a likeness."""
    check = item.get("check") or {}
    return bool(check.get("detected")) and check.get("detector") == "mediapipe"


def statement_for(creation: Creation) -> Literal["depiction", "generated_face"] | None:
    """The uploader's statement finishing needs (a consent scope), or None.

    Tied to where the pixels came from, not to the line the creation is on
    now: a person's photo stays a person's photo when it is stylised into an
    animation, switched to another line, or chosen again after a stylise.
    So the lineage of the current image decides:

    - made from words by the image model: "generated_face" when it is a
      face of a person (on the human line, or one the check found), since
      "I am this person" cannot be true of it and a prompt can still ask
      for someone real; a picture redrawn from one of the org's avatars
      needs "depiction", like the photo it came from. An animal the
      wizard drew from words in an animated or cartoon look (the prompt
      asks for an animal, not a person) is not a person's likeness: the
      detector's "face" on a cartoon dog is a false positive, so nothing
      is asked unless it is a realistic picture or a person was found
      on the human line;
    - an upload: "depiction" when it is on the human line, or when the
      photo check found a human face on an image in its lineage that no AI
      made (the upload, its framing, its cut-out). So it is for a photo
      uploaded under an "Animal" plan on which the detector read a face:
      someone may pick Animal and upload a real person. The dashboard words
      that case for the plan ("this photo shows an animal, not a real
      person; or, if it shows a person, I am that person or have their
      permission…"): the same statement, made conditional, the same scope
      (the plan on the creation says which form was shown);
    - otherwise (an animal, a drawing the detector does not read as a
      face) nothing.
    """
    steps = creation.steps
    chain = lineage(steps, current_step(steps))
    human_line = creation.face_type == "human"
    if not chain:
        return consent.DEPICTION if human_line else None
    root = chain[-1]
    generated = root.get("generated")
    if generated:
        plan = (steps or {}).get("plan") or {}
        drawn_animal = plan.get("model") == "animal" and plan.get("look") in ("animation", "cartoon")
        found_person = detected_a_person(root) and not drawn_animal
        if not (human_line or found_person):
            return None
        return consent.DEPICTION if generated.get("source_avatar_id") else consent.GENERATED_FACE
    photographed = [item for item in chain if not item.get("adjust")]
    if human_line or any(detected_a_person(item) for item in photographed):
        return consent.DEPICTION
    # A draft made before checks were kept per step: the upload's analysis.
    if all(item.get("check") is None for item in photographed) and (
        (creation.analysis or {}).get("suggested_face_type") == "human"
    ):
        return consent.DEPICTION
    return None


def round_source(steps: CreationSteps | None, last_round: AdjustRound | None) -> str | None:
    """The image the last adjust round was made from, as a step that still
    exists.

    A round records its source's id, but that step can go later: choosing a
    stylised version drops the cut-outs (the animation line keeps its drawn
    backdrop), and the round may have been made from one. The candidates'
    `from` links were moved to the nearest surviving ancestor then
    (remove_steps), so the first surviving candidate says where the round
    now comes from; without one, the original.
    """
    if not last_round:
        return None
    items = step_items(steps)
    source = last_round.get("source")
    if source in items:
        return source
    for candidate in last_round.get("candidates") or []:
        made = items.get(candidate.get("step") or "")
        if made and made.get("from") in items:
            return made["from"]
    return "original" if "original" in items else None


def stylised(steps: CreationSteps | None, step_id: str | None) -> bool:
    """Is the image `step_id` shows a stylised version (a drawing made by
    AI adjust from the photo), or made from one?"""
    return any(
        (item.get("adjust") or {}).get("mode") == "stylise" for item in lineage(steps, step_id)
    )


def through_cutouts(steps: CreationSteps | None, step_id: str | None) -> str | None:
    """`step_id`, or when it is a background removal's output, the image it
    was cut from (repeatedly): the step whose pixels it shows."""
    items = step_items(steps)
    seen: set[str] = set()
    while is_cutout_id(step_id) and step_id in items and step_id not in seen:
        seen.add(step_id)
        source = items[step_id].get("from")
        if source not in items:
            break
        step_id = source
    return step_id if step_id in items else None


def frame_key(steps: CreationSteps | None, step_id: str | None) -> str | None:
    """The key of the image whose pixel grid `step_id` shares. A cut-out
    shares its source's (no pixel moved); every other step is its own, an
    AI result included (the model redrew it)."""
    source = through_cutouts(steps, step_id)
    return step_items(steps)[source]["key"] if source else None


def check_of(steps: CreationSteps | None, step_id: str | None) -> StepCheck | None:
    """The photo check of the image `step_id` shows (a cut-out shows its
    source's face, so it has its source's check). None for images made
    before checks were kept per step."""
    source = through_cutouts(steps, step_id)
    return step_items(steps)[source].get("check") if source else None


def background_source(steps: CreationSteps | None) -> str | None:
    """The opaque image behind the current one: the current image, or when
    that is a cut-out (a touch-up of one included), the image it was cut
    from. What "keep the background" goes back to."""
    items = step_items(steps)
    step_id = current_step(steps)
    seen: set[str] = set()
    while step_id is not None and is_cut_out(items, step_id) and step_id not in seen:
        seen.add(step_id)
        source = items[step_id].get("from")
        if source not in items:
            break
        step_id = source
    return step_id


def copied(steps: CreationSteps | None) -> CreationSteps:
    """A deep copy to edit: JSON columns are replaced, never mutated."""
    return copy.deepcopy(steps or {"current": None, "items": {}})


def step_check(check: Mapping[str, Any]) -> StepCheck:
    """The part of a photo check (or of an analysis) a step keeps."""
    # Read off a check or an analysis, both written by photo_analysis.
    return cast(StepCheck, {k: check.get(k) for k in CHECK_KEYS})


def recommendation_of(steps: CreationSteps | None, face_type: str | None) -> dict | None:
    """{image, mode, reasons}: what step 3 recommends for the CURRENT image
    on the creation's line (photo_analysis.recommend). None until the line
    is known, and for an image made before checks were kept per step."""
    current = current_step(steps)
    check = check_of(steps, current)
    if face_type is None or check is None:
        return None
    found = (check.get("recommendations") or {}).get(face_type) or recommend(check, face_type)
    return {"image": current, "mode": found["mode"], "reasons": list(found["reasons"])}
