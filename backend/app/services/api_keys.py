"""API keys: making, listing and revoking an organization's keys
(api.api_keys), and finding the key an embed request presents (api.embed).

Only a key's hash is stored; the plaintext exists once, in the answer to
the request that made it.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound404
from app.models import ApiKey, generate_api_key, hash_api_key, utcnow


async def create(
    db: AsyncSession, org_id: str, user_id: str, name: str, allowed_domains: list[str]
) -> tuple[ApiKey, str]:
    """A new key for the org, and its plaintext (never stored)."""
    plaintext, prefix, key_hash = generate_api_key()
    api_key = ApiKey(
        org_id=org_id,
        created_by_id=user_id,
        name=name,
        prefix=prefix,
        key_hash=key_hash,
        allowed_domains=",".join(d.strip().lower() for d in allowed_domains if d.strip()),
    )
    db.add(api_key)
    await db.commit()
    return api_key, plaintext


async def keys_of(db: AsyncSession, org_id: str) -> list[ApiKey]:
    """The org's keys, newest first, revoked ones included."""
    return list(
        (
            await db.execute(
                select(ApiKey).where(ApiKey.org_id == org_id).order_by(ApiKey.created_at.desc())
            )
        )
        .scalars()
        .all()
    )


async def revoke(db: AsyncSession, org_id: str, key_id: str) -> None:
    api_key = (
        await db.execute(select(ApiKey).where(ApiKey.id == key_id, ApiKey.org_id == org_id))
    ).scalar_one_or_none()
    if api_key is None:
        raise NotFound404("API key not found", code="api_key_not_found")
    api_key.revoked_at = utcnow()
    await db.commit()


async def by_plaintext(db: AsyncSession, plaintext: str) -> ApiKey | None:
    """The key with this plaintext, revoked or not."""
    return (
        await db.execute(select(ApiKey).where(ApiKey.key_hash == hash_api_key(plaintext)))
    ).scalar_one_or_none()


async def mark_used(db: AsyncSession, api_key: ApiKey) -> None:
    api_key.last_used_at = utcnow()
    await db.commit()
