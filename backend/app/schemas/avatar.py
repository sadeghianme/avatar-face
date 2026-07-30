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


class RigAdjust(BaseModel):
    """Manual fit correction, in ORIGINAL-image pixels. Applied to the
    stored rig so both texture mapping and deformation move together."""

    mouth_dx: float = Field(default=0, ge=-2000, le=2000)
    mouth_dy: float = Field(default=0, ge=-2000, le=2000)
    mouth_scale: float = Field(default=1, ge=0.4, le=2.5)
    left_eye_dx: float = Field(default=0, ge=-2000, le=2000)
    left_eye_dy: float = Field(default=0, ge=-2000, le=2000)
    right_eye_dx: float = Field(default=0, ge=-2000, le=2000)
    right_eye_dy: float = Field(default=0, ge=-2000, le=2000)


class AnchorBox(BaseModel):
    """Where the user says a region's four edges are, in ORIGINAL-image px."""

    left: float = Field(ge=-10000, le=10000)
    right: float = Field(ge=-10000, le=10000)
    top: float = Field(ge=-10000, le=10000)
    bottom: float = Field(ge=-10000, le=10000)


class AnchorPoint(BaseModel):
    x: float = Field(ge=-10000, le=10000)
    y: float = Field(ge=-10000, le=10000)


class RigFit(BaseModel):
    """Hand-placed landmark anchors.

    Every field is optional: a region left out is not touched, so a user who
    only needs to fix the mouth does not have to re-state the eyes.
    """

    head: AnchorBox | None = None
    left_eye: AnchorBox | None = None
    right_eye: AnchorBox | None = None
    mouth: AnchorBox | None = None
    mouth_center: AnchorPoint | None = None
    # False (the default) computes the corrected rig and returns it WITHOUT
    # writing, so the preview a user tests is the same object that gets saved.
    persist: bool = False


class RigFitResult(BaseModel):
    rig: dict
    persisted: bool


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
