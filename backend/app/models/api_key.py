from __future__ import annotations

import hashlib
import secrets
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase

KEY_PREFIX_LEN = 12  # "lf_" + 9 chars, enough to index without exposing the key


def generate_api_key() -> tuple[str, str, str]:
    """Return (plaintext, prefix, sha256_hash). Plaintext is shown exactly once."""
    plaintext = "lf_" + secrets.token_urlsafe(32)
    prefix = plaintext[:KEY_PREFIX_LEN]
    return plaintext, prefix, hash_api_key(plaintext)


def hash_api_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


class ApiKey(TimestampedBase):
    __tablename__ = "api_keys"

    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    prefix: Mapped[str] = mapped_column(String(KEY_PREFIX_LEN), index=True, nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    # Comma-separated domain patterns allowed to use this key from a browser,
    # e.g. "example.com,*.example.org". Empty = allow any origin.
    allowed_domains: Mapped[str] = mapped_column(Text, default="", nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None

    @property
    def domain_list(self) -> list[str]:
        return [d.strip().lower() for d in self.allowed_domains.split(",") if d.strip()]
