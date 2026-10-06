"""The face's marks: where each handle opens, and the rig fitted to them."""

from __future__ import annotations

from app.api.avatars.routing import one_edit_at_a_time, router
from app.api.deps import DB, OrgMember
from app.core.errors import Validation422
from app.schemas.avatar import FitReason, RigFit, RigFitResult
from app.services.avatars import fitting, repo


@router.get("/{avatar_id}/rig-anchors")
async def rig_anchors(avatar_id: str, ctx: OrgMember, db: DB) -> dict:
    """Where each handle of the avatar's line opens.

    On the owner's saved marks where there are some, returned as placed (the
    fitted mesh only passes near a mark, it is not where the handle was
    dropped). Anything never marked opens on the landmark it attaches to, in
    the mesh those saved marks make from the base — so a good detection
    means dragging nothing, and an eye left unmarked sits where the fit put
    it; a head saved with four points opens with its outline diagonals on
    the fitted mesh. Always in the line's scheme: an animal marked before
    mouth lines existed opens with a mouth line. Clamped to the image,
    because a later crop can leave a saved mark outside it, where no handle
    could be dragged from.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    return await fitting.rig_anchors(avatar)


@router.post("/{avatar_id}/rig-fit", response_model=RigFitResult)
@one_edit_at_a_time
async def rig_fit(avatar_id: str, body: RigFit, ctx: OrgMember, db: DB) -> RigFitResult:
    """Rebuild the rig from hand-placed anchors (services.anchor_fit).

    With `persist` false this computes the fitted rig and returns it without
    writing, with the validator's reasons, so the client can render and speak
    with the exact object a save would store — the preview cannot disagree
    with the result, because it IS the result. With `persist` true a fit the
    validator rejects is refused (422, with the reasons) and nothing changes.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    marks = body.model_dump(exclude={"persist"}, exclude_none=True)
    adjusted, problems = await fitting.fit(avatar, marks)
    reasons = [FitReason(code=p.code, detail=p.detail, count=p.count) for p in problems]

    if body.persist:
        if reasons:
            raise Validation422(
                "These marks would distort the face: " + "; ".join(r.detail for r in reasons),
                code="fit_invalid",
                extra={"reasons": [r.model_dump() for r in reasons]},
            )
        await fitting.save_fit(db, avatar, adjusted)
    return RigFitResult(rig=adjusted, persisted=body.persist, reasons=reasons)
