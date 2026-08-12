"""Usage metering: every synthesis is recorded; orgs have a monthly char limit."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import RateLimit429
from app.models import UsageEvent


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def chars_used_this_month(db: AsyncSession, org_id: str) -> int:
    total = (
        await db.execute(
            select(func.coalesce(func.sum(UsageEvent.char_count), 0)).where(
                UsageEvent.org_id == org_id,
                UsageEvent.created_at >= month_start(),
            )
        )
    ).scalar_one()
    return int(total)


IMAGE_KIND = "image_generation"
GENERATED_AVATAR_KIND = "avatar_generated"


async def _count_this_month(db: AsyncSession, org_id: str, kind: str) -> int:
    total = (
        await db.execute(
            select(func.count()).where(
                UsageEvent.org_id == org_id,
                UsageEvent.kind == kind,
                UsageEvent.created_at >= month_start(),
            )
        )
    ).scalar_one()
    return int(total)


async def images_used_this_month(db: AsyncSession, org_id: str) -> int:
    """Every ATTEMPT, not every accepted image — a candidate the rig rejects
    was still generated and still charged for."""
    return await _count_this_month(db, org_id, IMAGE_KIND)


async def check_image_limit(db: AsyncSession, org_id: str, incoming: int = 1) -> None:
    limit = get_settings().image_generation_monthly_limit
    used = await images_used_this_month(db, org_id)
    if used + incoming > limit:
        raise RateLimit429(
            f"Monthly image generation limit reached ({used}/{limit})",
            code="image_limit_reached",
        )


async def record_generation(db: AsyncSession, org_id: str, provider: str) -> None:
    """One row per attempt. char_count is 0 so this cannot disturb the
    character total, which is metered separately and would otherwise be
    silently inflated by a feature that has nothing to do with speech."""
    db.add(UsageEvent(org_id=org_id, kind=IMAGE_KIND, provider=provider, char_count=0))
    await db.commit()


async def record_generated_avatar(db: AsyncSession, org_id: str, provider: str) -> None:
    """A candidate the user actually kept."""
    db.add(
        UsageEvent(org_id=org_id, kind=GENERATED_AVATAR_KIND, provider=provider, char_count=0)
    )
    await db.commit()


async def check_usage_limit(db: AsyncSession, org_id: str, incoming_chars: int) -> None:
    limit = get_settings().monthly_char_limit
    used = await chars_used_this_month(db, org_id)
    if used + incoming_chars > limit:
        raise RateLimit429(
            f"Monthly character limit reached ({used}/{limit})",
            code="usage_limit_reached",
        )


async def record_synthesis(
    db: AsyncSession, org_id: str, provider: str, char_count: int,
    cached: bool, source: str
) -> None:
    db.add(
        UsageEvent(
            org_id=org_id,
            kind="tts_synthesis",
            provider=provider,
            char_count=char_count,
            cached=cached,
            source=source,
        )
    )
    await db.commit()


async def usage_summary(db: AsyncSession, org_id: str) -> dict:
    settings = get_settings()
    used = await chars_used_this_month(db, org_id)
    counts = (
        await db.execute(
            select(UsageEvent.provider, func.count(), func.sum(UsageEvent.char_count))
            # Speech only: image rows carry no characters and would appear as
            # a provider with zero usage in the voice breakdown.
            .where(UsageEvent.kind == "tts_synthesis")
            .where(UsageEvent.org_id == org_id, UsageEvent.created_at >= month_start())
            .group_by(UsageEvent.provider)
        )
    ).all()
    images = await images_used_this_month(db, org_id)
    generated = await _count_this_month(db, org_id, GENERATED_AVATAR_KIND)
    return {
        "month_start": month_start().isoformat(),
        "chars_used": used,
        "char_limit": settings.monthly_char_limit,
        # Attempts, kept, and what it cost. `images` counts attempts because
        # that is what is charged; `avatars_generated` counts the ones kept,
        # which is what the user thinks they made.
        "images_generated": images,
        "image_limit": settings.image_generation_monthly_limit,
        "avatars_generated": generated,
        "image_cost_usd": round(images * settings.image_generation_cost_usd, 2),
        "by_provider": [
            {"provider": provider, "syntheses": int(count), "chars": int(chars or 0)}
            for provider, count, chars in counts
        ],
    }
