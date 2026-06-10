from __future__ import annotations

from sqlalchemy import LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class ProviderCredential(TimestampedBase):
    """A single named secret (e.g. "elevenlabs_api_key"), Fernet-encrypted at rest.

    Global (not org-scoped): provider keys configure the deployment, and only
    org owners may read/write them through the API.
    """

    __tablename__ = "provider_credentials"

    name: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    encrypted_value: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
