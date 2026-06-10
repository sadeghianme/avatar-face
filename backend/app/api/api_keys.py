from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import DB, OrgAdmin
from app.core.errors import NotFound404
from app.models import ApiKey, generate_api_key, utcnow
from app.schemas.api_key import ApiKeyCreate, ApiKeyCreated, ApiKeyOut

router = APIRouter(prefix="/orgs/{org_id}/api-keys", tags=["api-keys"])


@router.post("", response_model=ApiKeyCreated, status_code=201)
async def create_api_key(body: ApiKeyCreate, ctx: OrgAdmin, db: DB) -> ApiKeyCreated:
    plaintext, prefix, key_hash = generate_api_key()
    api_key = ApiKey(
        org_id=ctx.org.id,
        created_by_id=ctx.membership.user_id,
        name=body.name,
        prefix=prefix,
        key_hash=key_hash,
        allowed_domains=",".join(d.strip().lower() for d in body.allowed_domains if d.strip()),
    )
    db.add(api_key)
    await db.commit()
    # The plaintext key is returned exactly once; only the hash is stored.
    return ApiKeyCreated(api_key=ApiKeyOut.model_validate(api_key), plaintext=plaintext)


@router.get("", response_model=list[ApiKeyOut])
async def list_api_keys(ctx: OrgAdmin, db: DB) -> list[ApiKey]:
    return list(
        (
            await db.execute(
                select(ApiKey)
                .where(ApiKey.org_id == ctx.org.id)
                .order_by(ApiKey.created_at.desc())
            )
        )
        .scalars()
        .all()
    )


@router.delete("/{key_id}", status_code=204)
async def revoke_api_key(key_id: str, ctx: OrgAdmin, db: DB):
    api_key = (
        await db.execute(
            select(ApiKey).where(ApiKey.id == key_id, ApiKey.org_id == ctx.org.id)
        )
    ).scalar_one_or_none()
    if api_key is None:
        raise NotFound404("API key not found", code="api_key_not_found")
    api_key.revoked_at = utcnow()
    await db.commit()
