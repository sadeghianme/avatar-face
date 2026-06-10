from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.avatar import AvatarStatus


class AvatarCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    content_type: str


class AvatarOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    org_id: str
    name: str
    status: AvatarStatus
    content_type: str
    error: str | None
    created_at: datetime
    updated_at: datetime


class AvatarCreated(BaseModel):
    avatar: AvatarOut
    upload_url: str


class AvatarDetail(AvatarOut):
    image_url: str | None = None
    rig_url: str | None = None
    thumbnail_url: str | None = None
