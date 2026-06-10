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
            .where(UsageEvent.org_id == org_id, UsageEvent.created_at >= month_start())
            .group_by(UsageEvent.provider)
        )
    ).all()
    return {
        "month_start": month_start().isoformat(),
        "chars_used": used,
        "char_limit": settings.monthly_char_limit,
        "by_provider": [
            {"provider": provider, "syntheses": int(count), "chars": int(chars or 0)}
            for provider, count, chars in counts
        ],
    }
