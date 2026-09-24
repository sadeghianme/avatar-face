"""Request and response shapes of the creation wizard (api.creations)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.avatar import AnchorMarks, AnchorPoint, FaceType, FitReason, PupilAnchor

CreationStatusName = Literal["draft", "finishing", "finished", "expired"]


class CreationMarks(BaseModel):
    """Marks in the scheme of the creation's line, in the pixels of the
    image they were placed on (see RigFit, which this mirrors without its
    persist flag). Every region is optional: one left out keeps the marking
    detect opened it on."""

    head: AnchorMarks | None = None
    left_eye: AnchorMarks | None = None
    right_eye: AnchorMarks | None = None
    mouth: AnchorMarks | None = None
    mouth_line: list[AnchorPoint] | None = Field(default=None, min_length=5, max_length=5)
    chin: AnchorPoint | None = None
    left_pupil: PupilAnchor | None = None
    right_pupil: PupilAnchor | None = None


class Crop(BaseModel):
    """A rectangle in fractions of the original upload."""

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    w: float = Field(gt=0.0, le=1.0)
    h: float = Field(gt=0.0, le=1.0)


class CreationUpdate(BaseModel):
    """Omitted means unchanged. `crop` and `roll` together are the framing:
    one sent alone keeps the other's current value."""

    face_type: FaceType | None = None
    crop: Crop | None = None
    # The tilt to remove, in degrees (analysis.roll measures it): positive
    # when the photo's eye line slopes down to the image's right.
    roll: float | None = Field(default=None, ge=-45.0, le=45.0)


class BackgroundRequest(BaseModel):
    mode: Literal["remove", "keep"]


class ChooseRequest(BaseModel):
    choice: str = Field(min_length=1, max_length=32)


class PreviewRigRequest(BaseModel):
    # The anchors the marks were placed on (anchors.id from the creation).
    anchors_id: str = Field(min_length=1, max_length=64)
    marks: CreationMarks | None = None


class FinishRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    anchors_id: str = Field(min_length=1, max_length=64)
    # Omitted (or partial) means the marks detect opened on, for the regions
    # left out. Animals must send all of theirs.
    marks: CreationMarks | None = None


class StepOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    url: str
    width: int
    height: int
    # The step this image was made from; null for the original.
    from_: str | None = Field(default=None, alias="from")
    crop: dict | None = None
    roll: float | None = None


class JobError(BaseModel):
    code: str
    detail: str


class JobProgress(BaseModel):
    fraction: float
    label: str | None = None


class JobOut(BaseModel):
    id: str
    step: Literal["ingest", "background", "detect", "finish"]
    state: Literal["queued", "running", "done", "failed", "interrupted"]
    error: JobError | None = None
    started_at: str
    # Live, while the job is queued or running in this process.
    progress: JobProgress | None = None
    # POST /retry would run it again.
    retryable: bool = False


class Validation(BaseModel):
    ok: bool
    reasons: list[FitReason] = Field(default_factory=list)
    warnings: list[JobError] = Field(default_factory=list)
    detected: bool
    one_click: bool


class AnchorsOut(BaseModel):
    id: str
    # The step whose pixels the marks are in ("original" or "framed").
    image: str | None
    image_size: list[int]
    detected: bool
    marks: dict
    validation: Validation


class BackgroundOffer(BaseModel):
    available: bool
    reason: str | None = None


class CreationOut(BaseModel):
    id: str
    face_type: FaceType | None
    status: CreationStatusName
    revision: int
    current: str | None
    steps: list[StepOut]
    analysis: dict | None = None
    anchors: AnchorsOut | None = None
    job: JobOut | None = None
    avatar_id: str | None = None
    background_removal: BackgroundOffer
    created_at: datetime
    updated_at: datetime


class PreviewRigOut(BaseModel):
    rig: dict
    reasons: list[FitReason] = Field(default_factory=list)


class FinishOut(BaseModel):
    avatar_id: str
    creation: CreationOut
