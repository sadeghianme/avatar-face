"""The owner's edits to an avatar's AI expression pictures: the choice to
have them (and how a publish makes them), making them now, removing them,
and the kit a publish asks for (services.expression_kit). Draft edits:
visitors get the pictures, and the disclosure that AI made them, when the
owner publishes; a publish's own kit completes that publish.
"""

from __future__ import annotations

import logging
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict409
from app.models import Avatar, Organization
from app.services import consent, expressions, imagegen
from app.services.ai_models import PROVIDER
from app.services.expression_kit import jobs, require_person, storing
from app.services.publishing import config_of, mark_dirty
from app.services.storage import get_storage
from app.services.usage import check_image_limit

logger = logging.getLogger("liveface.expression_kit")

Delivery = Literal["now", "batch"]


async def choose(
    db: AsyncSession,
    avatar: Avatar,
    org: Organization,
    user_id: str,
    ai: bool,
    consent_id: str | None,
    delivery: Delivery | None = None,
) -> None:
    """The owner's choice. Turning AI pictures on needs this member's
    third_party_ai consent (403 consent_required, 403 third_party_ai_disabled)
    and a person's photo avatar (409, 422); the consent is kept for the
    publish that makes them. Turning them off needs nothing. A draft edit
    when visitors would see a change. Committed."""
    consent_kept = None
    if ai:
        require_person(avatar)
        agreed = await consent.require(
            db, consent_id, org, user_id, consent.THIRD_PARTY_AI, PROVIDER
        )
        consent_kept = agreed.id
    visible = storing.choose(avatar, ai, consent_kept)
    config = expressions.load(avatar) or {"ai": ai}
    if consent_kept:
        config["consent_user_id"] = user_id
    if delivery is not None:
        config["delivery"] = delivery
    avatar.expression_config = config
    if visible:
        mark_dirty(avatar)
    await db.commit()


async def start_now(
    db: AsyncSession, avatar: Avatar, org: Organization, user_id: str, consent_id: str | None
) -> dict:
    """Make the pictures now (the panel's Make): a job, as JobOut takes it.
    Refused like the choice, without an image model (409
    imagegen_unavailable) and past the monthly limit for five more (429)."""
    require_person(avatar)
    agreed = await consent.require(db, consent_id, org, user_id, consent.THIRD_PARTY_AI, PROVIDER)
    if not imagegen.configured():
        raise Conflict409(
            "AI editing is not configured on this server", code="imagegen_unavailable"
        )
    await check_image_limit(db, org.id, incoming=len(expressions.EXPRESSION_NAMES))
    storage = get_storage()
    if not avatar.image_key or not await storage.exists(avatar.image_key):
        raise Conflict409("The avatar's picture is gone", code="source_gone")
    return jobs.start(avatar, agreed.id)


async def remove(db: AsyncSession, avatar: Avatar) -> None:
    """The pictures out of the draft and the choice off. Committed; the
    files are deleted after (the published snapshot has its own copies)."""
    shown = expressions.shows(expressions.load(avatar))
    previous = storing.remove(avatar)
    if shown:
        mark_dirty(avatar)
    await db.commit()
    storage = get_storage()
    for key in previous:
        await storage.delete(key)


async def after_publish(db: AsyncSession, avatar: Avatar, org: Organization) -> dict | None:
    """What Publish asks of the expressions: when the owner chose AI pictures
    and none are made for this picture (nor on their way), the job that
    makes them (or sends them as a batch), which publishes them when ready.
    Never fails the publish: a consent no longer current, the switch off,
    no image model, or a job that cannot start now is logged and left (the
    panel can make them, and the next publish asks again). Returns the
    job, or None."""
    config = expressions.load(avatar)
    if not expressions.wants_kit(config):
        return None
    assert config is not None  # wants_kit is False without one
    try:
        require_person(avatar)
        agreed = await consent.require(
            db,
            config.get("consent_id"),
            org,
            config.get("consent_user_id") or "",
            consent.THIRD_PARTY_AI,
            PROVIDER,
        )
        if not imagegen.configured():
            raise Conflict409("no image model", code="imagegen_unavailable")
        await check_image_limit(db, org.id, incoming=len(expressions.EXPRESSION_NAMES))
        revision = (config_of(avatar) or {}).get("revision")
        return jobs.start(
            avatar,
            agreed.id,
            source="publish",
            revision=revision,
            delivery=config.get("delivery") or "now",
        )
    except AppError as exc:
        logger.info("publish of avatar %s: no expression pictures made (%s)", avatar.id, exc.code)
        return None
