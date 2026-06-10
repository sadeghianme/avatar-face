"""Dashboard-managed provider credentials.

Secrets live in the provider_credentials table, Fernet-encrypted at rest, and
are layered over env settings in an in-memory overlay (DB wins). The overlay
is loaded at startup and reloaded on every write, so a key pasted into the
dashboard takes effect with no restart.

Providers must read `credentials.get("elevenlabs_api_key")` instead of
`settings.elevenlabs_api_key`.
"""
from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.provider_credential import ProviderCredential

# Every secret the dashboard can manage, grouped by provider.
CREDENTIAL_FIELDS: dict[str, list[str]] = {
    "azure": ["azure_speech_key", "azure_speech_region"],
    "elevenlabs": ["elevenlabs_api_key"],
    "google": ["google_tts_credentials_json"],
    "openai": ["openai_api_key"],
}
ALL_CREDENTIAL_NAMES = [name for fields in CREDENTIAL_FIELDS.values() for name in fields]


def _fernet() -> Fernet:
    settings = get_settings()
    if settings.credential_encryption_key:
        return Fernet(settings.credential_encryption_key.encode())
    # Derive a stable key from the JWT secret so encryption-at-rest works
    # with zero configuration.
    digest = hashlib.sha256(f"liveface-credentials:{settings.jwt_secret}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_value(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt_value(ciphertext: bytes) -> str:
    return _fernet().decrypt(ciphertext).decode()


class CredentialStore:
    def __init__(self) -> None:
        self._overlay: dict[str, str] = {}

    async def load(self, db: AsyncSession) -> None:
        rows = (await db.execute(select(ProviderCredential))).scalars().all()
        self._overlay = {row.name: decrypt_value(row.encrypted_value) for row in rows}

    def get(self, name: str) -> str | None:
        if name in self._overlay:
            return self._overlay[name] or None
        # "" from env counts as unset.
        return getattr(get_settings(), name, None) or None

    def source(self, name: str) -> str:
        if self._overlay.get(name):
            return "db"
        if getattr(get_settings(), name, None):
            return "env"
        return "unset"

    async def put(self, db: AsyncSession, name: str, value: str) -> None:
        if name not in ALL_CREDENTIAL_NAMES:
            raise ValueError(f"unknown credential: {name}")
        row = (
            await db.execute(select(ProviderCredential).where(ProviderCredential.name == name))
        ).scalar_one_or_none()
        if value == "":
            # Clearing removes the DB override; the env value (if any) shows through.
            if row is not None:
                await db.delete(row)
            self._overlay.pop(name, None)
        else:
            if row is None:
                db.add(ProviderCredential(name=name, encrypted_value=encrypt_value(value)))
            else:
                row.encrypted_value = encrypt_value(value)
            self._overlay[name] = value
        await db.commit()

    def clear(self) -> None:
        self._overlay = {}


credentials = CredentialStore()
