from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.avatar import AvatarKind, AvatarStatus


class AvatarCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    content_type: str


class AvatarFromUrl(BaseModel):
    """Import a 3D avatar (GLB) from an allowed host, e.g. Ready Player Me."""

    url: str = Field(min_length=10, max_length=500)
    name: str = Field(default="", max_length=128)


class AvatarOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    org_id: str
    name: str
    status: AvatarStatus
    kind: AvatarKind
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
    # For kind=model3d: presigned URL of the GLB itself.
    model_url: str | None = None
