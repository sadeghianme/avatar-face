from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.avatar import AvatarKind, AvatarStatus


FaceType = Literal["human", "animal", "cartoon"]


class VoiceConfig(BaseModel):
    """What the avatar speaks with. The trio always changes together."""

    provider: str = Field(min_length=1, max_length=32)
    voice: str = Field(default="", max_length=200)
    locale: str = Field(default="en-US", max_length=16)


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


class HeadAnchorMarks(AnchorMarks):
    """The head: its four edges, and the outline between them at the
    temples (upper) and the jaw corners (lower), image left and right.

    The diagonals are optional so a client that sends four points, as every
    client did before them, still fits: a diagonal left out is not pinned
    and follows the warp (services.anchor_fit.HEAD_DIAGONALS). Sent with the
    very edges saved before, the head keeps the diagonals saved with them
    (services.anchor_fit.merge).
    """

    upper_left: AnchorPoint | None = None
    upper_right: AnchorPoint | None = None
    lower_right: AnchorPoint | None = None
    lower_left: AnchorPoint | None = None


class PupilAnchor(BaseModel):
    """A pupil as the user marked it: center, and one point on the rim."""

    center: AnchorPoint
    rim: AnchorPoint


class RigFit(BaseModel):
    """Hand-placed landmark anchors, in the scheme of the avatar's line.

    Every region is optional: one left out keeps its saved marking (or the
    detection, if it was never marked), so a user who only needs to fix the
    mouth does not have to re-state the eyes.

    A human mouth is marked by its edges (`mouth`). Animals and cartoons mark
    it as a line (`mouth_line`: corner, three points along the seam, corner)
    plus the `chin`; an edge-marked mouth sent for them is read as a line
    through its centre. Animals have no pupils: pupil marks are ignored.
    """

    head: HeadAnchorMarks | None = None
    left_eye: AnchorMarks | None = None
    right_eye: AnchorMarks | None = None
    mouth: AnchorMarks | None = None
    mouth_line: list[AnchorPoint] | None = Field(default=None, min_length=5, max_length=5)
    chin: AnchorPoint | None = None
    left_pupil: PupilAnchor | None = None
    right_pupil: PupilAnchor | None = None
    # False (the default) computes the corrected rig and returns it WITHOUT
    # writing, so the preview a user tests is the object that gets saved.
    persist: bool = False


class FitReason(BaseModel):
    """Why a fit cannot be saved: a stable code, prose, and a count where
    one applies (how many triangles fold)."""

    code: str
    detail: str
    count: int | None = None


class RigFitResult(BaseModel):
    rig: dict
    persisted: bool
    # Empty when the fit may be saved. A preview returns its rig either way,
    # so the owner can see what the reasons are about.
    reasons: list[FitReason] = Field(default_factory=list)


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
    # The DRAFT voice; what visitors hear is the published snapshot's copy.
    voice: dict | None = None
    # The DRAFT mouth: {renderer, profile, has_oral_photo}. Null = classic.
    mouth: dict | None = None
    # True when the draft has moved ahead of the published snapshot — the
    # dashboard shows a Publish bar on this.
    unpublished: bool = False
    # True while visitors are served a snapshot. Use this, not published_at,
    # to ask "is it live": snapshots backfilled by migration 020 are live
    # and have no publish date.
    published: bool = False
    published_at: str | None = None
    # {mode, model} when an AI made or changed the picture (creation
    # wizard: adjust or generate); null otherwise. Visitors see it through
    # the published snapshot's disclosure.
    ai_edited: dict | None = None
    created_at: datetime
    updated_at: datetime


class MouthProfile(BaseModel):
    """Fit of the oral geometry to this face. Ranges mirror PROFILE_LIMITS
    in embed/src/mouth/reference-mouth-model.ts; the client clamps too, but
    a published config is served to strangers and must not trust it."""

    teethScale: float = Field(default=1.0, ge=0.75, le=1.2)
    teethY: float = Field(default=0.0, ge=-0.06, le=0.06)
    warmth: float = Field(default=0.5, ge=0.0, le=1.0)
    lipProjection: float = Field(default=0.55, ge=0.0, le=1.0)
    jawRange: float = Field(default=0.85, ge=0.6, le=1.1)


class MouthUpdate(BaseModel):
    renderer: Literal["classic", "continuous"]
    profile: MouthProfile = Field(default_factory=MouthProfile)


class AvatarUpdate(BaseModel):
    """Owner-editable settings. Every field is optional; omitted means unchanged."""

    name: str | None = Field(default=None, min_length=1, max_length=128)
    framing: Literal["face", "full"] | None = None
    face_type: FaceType | None = None
    voice: VoiceConfig | None = None
    mouth: MouthUpdate | None = None


class AvatarCreated(BaseModel):
    avatar: AvatarOut
    upload_url: str


class AvatarDetail(AvatarOut):
    # Presigned {image_url, rig_url} of the draft mouth photo, when one exists.
    mouth_photo: dict | None = None
    image_url: str | None = None
    rig_url: str | None = None
    thumbnail_url: str | None = None
    # For kind=model3d: presigned URL of the GLB itself.
    model_url: str | None = None
    # Background/body/head decomposition, when built — the layered render
    # path. "background" may be absent (cut-outs have nothing behind them).
    layer_urls: dict[str, str] | None = None
