"""Dashboard-managed TTS provider credentials.

Secrets are WRITE-ONLY through this API: reads return a mask ("••••1234")
plus the source (db | env | unset), never the value. Gated to org owners.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import DB, OrgOwner
from app.core.credentials import CREDENTIAL_FIELDS, PROVIDER_KIND, credentials
from app.core.errors import Validation422

router = APIRouter(prefix="/orgs/{org_id}/integrations", tags=["integrations"])


class FieldStatus(BaseModel):
    name: str
    masked: str
    source: str  # db | env | unset


class ProviderStatus(BaseModel):
    provider: str
    # "voice" or "image" — the dashboard groups by this, and it decides what
    # "test" means.
    kind: str
    fields: list[FieldStatus]
    configured: bool


class IntegrationsUpdate(BaseModel):
    # {"elevenlabs_api_key": "sk-...", "azure_speech_region": ""} ("" clears)
    values: dict[str, str]


def _mask(value: str | None) -> str:
    if not value:
        return ""
    return "••••" + value[-4:] if len(value) >= 4 else "••••"


def _status() -> list[ProviderStatus]:
    out = []
    for provider, fields in CREDENTIAL_FIELDS.items():
        field_statuses = [
            FieldStatus(name=f, masked=_mask(credentials.get(f)), source=credentials.source(f))
            for f in fields
        ]
        out.append(
            ProviderStatus(
                provider=provider,
                kind=PROVIDER_KIND.get(provider, "voice"),
                fields=field_statuses,
                configured=all(credentials.get(f) for f in fields),
            )
        )
    return out


@router.get("", response_model=list[ProviderStatus])
async def get_integrations(ctx: OrgOwner) -> list[ProviderStatus]:
    return _status()


@router.put("", response_model=list[ProviderStatus])
async def update_integrations(
    body: IntegrationsUpdate, ctx: OrgOwner, db: DB
) -> list[ProviderStatus]:
    valid = {name for fields in CREDENTIAL_FIELDS.values() for name in fields}
    for name in body.values:
        if name not in valid:
            raise Validation422(f"Unknown credential field: {name}", code="unknown_field")
    for name, value in body.values.items():
        await credentials.put(db, name, value.strip())
    return _status()


@router.post("/{provider}/test")
async def test_provider(provider: str, ctx: OrgOwner) -> dict:
    if PROVIDER_KIND.get(provider) == "image":
        # Checks the key without generating: a real generation costs money and
        # ten seconds, which is a lot to spend on "is this key right".
        from app.services.imagegen import verify_key

        return await verify_key()

    from app.services.tts.registry import get_provider

    tts = get_provider(provider)  # raises 422 if not configured
    try:
        voices = await tts.voices()
        return {"ok": True, "voices": len(voices)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:300]}
