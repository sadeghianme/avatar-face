"""The checks an owner's request passes before it changes a creation: the
state it must be in, and marks that fit the line and the image. Each
refusal is the same whichever request makes it."""

from __future__ import annotations

from app.core.errors import Conflict409, Validation422
from app.models import Creation, CreationStatus
from app.schemas.creation import CreationMarks
from app.services.creations.detect import anchors_are_current
from app.services.creations.steps import step_items


def require_draft(creation: Creation) -> None:
    if creation.status != CreationStatus.draft:
        raise Conflict409(
            f"This creation is {creation.status.value} and can no longer change",
            code="creation_not_draft",
        )


def require_image(creation: Creation) -> None:
    if "original" not in step_items(creation.steps):
        raise Conflict409("The photo is still being prepared", code="creation_not_ready")


def require_face_type(creation: Creation) -> str:
    if creation.face_type is None:
        raise Validation422(
            "Choose whether this is a person, an animal or an animation first",
            code="face_type_required",
        )
    return creation.face_type


def check_marks(marks: CreationMarks | None, face_type: str, size: list[int]) -> dict | None:
    """The marks as a dict, refused where the line or the image rules them
    out (the same refusals as the avatar rig-fit endpoint)."""
    from app.services.anchor_fit import marks_mouth_as_line

    if marks is None:
        return None
    data = marks.model_dump(exclude_none=True)
    if ("mouth_line" in data or "chin" in data) and not marks_mouth_as_line(face_type):
        raise Validation422(
            "A human mouth is marked by its edges, not as a line with a chin",
            code="mouth_line_not_for_face_type",
        )
    width, height = size

    def points(value):
        if isinstance(value, dict):
            if "x" in value and "y" in value:
                yield value
            else:
                for v in value.values():
                    yield from points(v)
        elif isinstance(value, list):
            for v in value:
                yield from points(v)

    if any(not (0 <= p["x"] <= width and 0 <= p["y"] <= height) for p in points(data)):
        raise Validation422("Every mark must be inside the image", code="mark_outside_image")
    return data


def anchors_for(creation: Creation, anchors_id: str) -> dict:
    """The creation's anchors, when they are the ones `anchors_id` names and
    still belong to the current image (409 anchors_stale otherwise)."""
    # No anchors at all is stale too: the client holds an id, so it placed
    # marks on something that has since been cleared (reframed, line switched).
    anchors = creation.anchors
    if not anchors or anchors.get("id") != anchors_id or not anchors_are_current(creation):
        raise Conflict409(
            "These marks belong to another image; place them again", code="anchors_stale"
        )
    return anchors
