from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.deps import DB, OrgAdmin, OrgMember
from app.core.config import get_settings
from app.core.errors import Validation422
from app.models import ApiKey
from app.schemas.api_key import ApiKeyCreate, ApiKeyCreated, ApiKeyOut
from app.services import api_keys
from app.services.simulator_token import DEFAULT_TTL_SECONDS, mint

router = APIRouter(prefix="/orgs/{org_id}/api-keys", tags=["api-keys"])


@router.post("", response_model=ApiKeyCreated, status_code=201)
async def create_api_key(body: ApiKeyCreate, ctx: OrgAdmin, db: DB) -> ApiKeyCreated:
    api_key, plaintext = await api_keys.create(
        db, ctx.org.id, ctx.membership.user_id, body.name, body.allowed_domains
    )
    # The plaintext key is returned exactly once; only the hash is stored.
    return ApiKeyCreated(api_key=ApiKeyOut.model_validate(api_key), plaintext=plaintext)


@router.get("", response_model=list[ApiKeyOut])
async def list_api_keys(ctx: OrgAdmin, db: DB) -> list[ApiKey]:
    return await api_keys.keys_of(db, ctx.org.id)


@router.delete("/{key_id}", status_code=204)
async def revoke_api_key(key_id: str, ctx: OrgAdmin, db: DB):
    await api_keys.revoke(db, ctx.org.id, key_id)


@router.post("/simulator-token")
async def create_simulator_token(request: Request, ctx: OrgMember) -> dict:
    """A short-lived credential for the in-dashboard Simulator.

    Any member, not just an admin: this grants strictly less than the session
    the caller already holds, and requiring admin would stop most people from
    testing their own avatars.

    Deliberately not an API key. It is signed rather than stored, expires in
    minutes, and only works from the origin that asked for it — see
    app.services.simulator_token for why a real key cannot be used here.
    """
    from urllib.parse import urlsplit

    origin = request.headers.get("origin") or request.headers.get("referer")
    host = (urlsplit(origin).hostname or "").lower() if origin else ""
    if not host:
        # Without an origin the token could not be bound to anything, and an
        # unbound token is just a key with a timer.
        raise Validation422("A browser origin is required", code="origin_required")

    token, expires_at = mint(get_settings().jwt_secret, ctx.org.id, host)
    return {"token": token, "expires_at": expires_at, "ttl_seconds": DEFAULT_TTL_SECONDS}
