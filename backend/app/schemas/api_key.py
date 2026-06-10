from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    allowed_domains: list[str] = []


class ApiKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    prefix: str
    allowed_domains: str
    created_at: datetime
    revoked_at: datetime | None
    last_used_at: datetime | None


class ApiKeyCreated(BaseModel):
    api_key: ApiKeyOut
    # The full key, returned exactly once at creation time.
    plaintext: str
