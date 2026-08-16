from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.avatar import AvatarKind, AvatarStatus


FaceType = Literal["human", "animal", "cartoon"]


class AvatarCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    content_type: str
    # Human unless stated: every existing client omits this and must keep
    # getting exactly what it got before.
    face_type: FaceType = "human"


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


class AnchorPoint(BaseModel):
    x: float = Field(ge=-10000, le=10000)
    y: float = Field(ge=-10000, le=10000)


class AnchorMarks(BaseModel):
    """A region's extremes as FREE 2D points.

    Not a box: a mouth's corners sit on a curve and are rarely level with each
    other, and a tilted eye has no meaningful "top". Free points let the fit
    carry rotation and shear.
    """

    left: AnchorPoint
    right: AnchorPoint
    top: AnchorPoint
    bottom: AnchorPoint
    center: AnchorPoint | None = None


class PupilAnchor(BaseModel):
    """A pupil as the user marked it: center, and one point on the rim."""

    center: AnchorPoint
    rim: AnchorPoint


class RigFit(BaseModel):
    """Hand-placed landmark anchors.

    Every region is optional: one left out is not touched, so a user who only
    needs to fix the mouth does not have to re-state the eyes.
    """

    head: AnchorMarks | None = None
    left_eye: AnchorMarks | None = None
    right_eye: AnchorMarks | None = None
    mouth: AnchorMarks | None = None
    left_pupil: PupilAnchor | None = None
    right_pupil: PupilAnchor | None = None
    # False (the default) computes the corrected rig and returns it WITHOUT
    # writing, so the preview a user tests is the object that gets saved.
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
    framing: str = "face"
    error: str | None
    quality_note: str | None = None
    # Non-null means the background has been removed and this is the photo as
    # uploaded — the UI uses it to know whether to offer remove or restore.
    original_image_key: str | None = None
    # Non-null means the photo has been cropped and the crop can be reset.
    precrop_image_key: str | None = None
    # Names the change an undo would reverse; null when there is nothing to undo.
    undo_label: str | None = None
    # Set means a public page exists at /s/<token>; null means not shared.
    share_token: str | None = None
    face_type: str = "human"
    created_at: datetime
    updated_at: datetime


class AvatarUpdate(BaseModel):
    """Owner-editable settings. Every field is optional; omitted means unchanged."""

    name: str | None = Field(default=None, min_length=1, max_length=128)
    framing: Literal["face", "full"] | None = None
    face_type: FaceType | None = None


class AvatarCreated(BaseModel):
    avatar: AvatarOut
    upload_url: str


class AvatarDetail(AvatarOut):
    image_url: str | None = None
    rig_url: str | None = None
    thumbnail_url: str | None = None
    # For kind=model3d: presigned URL of the GLB itself.
    model_url: str | None = None
    # Background/body/head decomposition, when built — the layered render
    # path. "background" may be absent (cut-outs have nothing behind them).
    layer_urls: dict[str, str] | None = None
