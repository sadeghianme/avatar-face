"""The AI expression pictures: the owner's choice, making them now, and
removing them (services.expressions, services.expression_kit)."""

from __future__ import annotations

from app.api.avatars.routing import one_edit_at_a_time, router
from app.api.deps import DB, OrgMember
from app.models import Avatar
from app.schemas.expressions import ExpressionsChoice, ExpressionsMake, ExpressionsOut
from app.services import expression_kit, expressions
from app.services.avatars import expression_edits, repo
from app.services.storage import get_storage


async def expressions_out(avatar: Avatar) -> ExpressionsOut:
    view = await expressions.owner_view(
        avatar, get_storage(), job=expression_kit.job_view(avatar.id)
    )
    return ExpressionsOut.model_validate(view)


@router.get("/{avatar_id}/expressions", response_model=ExpressionsOut)
async def get_expressions(avatar_id: str, ctx: OrgMember, db: DB) -> ExpressionsOut:
    """The DRAFT's AI expression pictures: whether the owner chose them, what
    was made (per expression, or why not: that one plays animated), the
    pictures and their manifest presigned for the preview, and the job."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    return await expressions_out(avatar)


@router.put("/{avatar_id}/expressions", response_model=ExpressionsOut)
@one_edit_at_a_time
async def choose_expressions(
    avatar_id: str, body: ExpressionsChoice, ctx: OrgMember, db: DB
) -> ExpressionsOut:
    """Choose AI expression pictures (or not), and how a publish makes them
    when none are made for the avatar's picture: `now` (about twenty
    seconds after the publish) or `batch` (half the price, ready within
    hours). On needs the caller's third_party_ai consent (403
    consent_required) and the organization's switch (403
    third_party_ai_disabled), on a person's ready photo avatar (409
    not_a_photo, 422 not_a_person). Nothing is sent here: the next publish,
    or Make, sends the picture. Pictures already made are kept when turned
    off. A DRAFT edit when visitors would see a change."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await expression_edits.choose(
        db,
        avatar,
        ctx.org,
        ctx.membership.user_id,
        body.ai,
        body.consent_id,
        body.delivery,
    )
    return await expressions_out(avatar)


@router.post("/{avatar_id}/expressions/make", response_model=ExpressionsOut, status_code=202)
async def make_expressions(
    avatar_id: str, body: ExpressionsMake, ctx: OrgMember, db: DB
) -> ExpressionsOut:
    """Make the five expression pictures now from the avatar's picture: a
    job (202, `job`), followed with GET above; five image-model calls take
    about twenty seconds. 409 expressions_in_progress while one runs for
    this avatar (and the runner's 429 too_many_jobs, 503 job_queue_full).
    Needs the caller's third_party_ai consent (403 consent_required) and the
    organization's switch (403 third_party_ai_disabled); metered against the
    monthly image limit (429 image_limit_reached, read again before each
    call). The choice is turned on. A DRAFT edit: visitors get the pictures,
    and the disclosure that AI made them, when the owner publishes."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await expression_edits.start_now(db, avatar, ctx.org, ctx.membership.user_id, body.consent_id)
    return await expressions_out(avatar)


@router.delete("/{avatar_id}/expressions", response_model=ExpressionsOut)
@one_edit_at_a_time
async def remove_expressions(avatar_id: str, ctx: OrgMember, db: DB) -> ExpressionsOut:
    """Remove the AI expression pictures from the draft and turn the choice
    off (the animated expressions play). The published snapshot keeps its
    own copies until the next publish."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await expression_edits.remove(db, avatar)
    return await expressions_out(avatar)
