"""Request and response shapes of the creation wizard (api.creations)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.avatar import (
    AnchorMarks,
    AnchorPoint,
    FaceType,
    FitReason,
    HeadAnchorMarks,
    PupilAnchor,
)

CreationStatusName = Literal["draft", "finishing", "finished", "expired"]


class CreationMarks(BaseModel):
    """Marks in the scheme of the creation's line, in the pixels of the
    image they were placed on (see RigFit, which this mirrors without its
    persist flag). Every region is optional: one left out keeps the marking
    detect opened it on."""

    head: HeadAnchorMarks | None = None
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


AdjustMode = Literal["touchup", "stylise", "regenerate"]
GenerationStyle = Literal["photoreal", "illustrated", "anime", "render3d"]


class AdjustRequest(BaseModel):
    """One AI adjust round on the current image. A cut-out is sent on a flat
    neutral grey, never with the background that was removed."""

    mode: AdjustMode
    # Stylise only: the look to give the person.
    style: GenerationStyle | None = None
    # A third_party_ai consent naming google, by this user (POST /consents).
    consent_id: str = Field(min_length=1, max_length=64)
    # How many candidates to ask for (each is a paid call).
    count: int = Field(default=2, ge=1, le=2)


class DetectRequest(BaseModel):
    """Omitted body: the line's detector only (MediaPipe, else the template)."""

    # Ask the vision model for the points where the detector cannot see
    # (animals; animations MediaPipe finds nothing on). Needs a consent.
    use_ai: bool = False
    consent_id: str | None = Field(default=None, max_length=64)


class GenerateCreationRequest(BaseModel):
    """A creation whose original is made by the image model."""

    face_type: FaceType
    style: GenerationStyle = "photoreal"
    # What to make, in the owner's words (appended to the style prompt).
    prompt: str = Field(default="", max_length=300)
    # Start from one of the org's photo avatars (image to image). Sends that
    # photo to Google, so it needs a third_party_ai consent.
    source_avatar_id: str | None = Field(default=None, max_length=32)
    consent_id: str | None = Field(default=None, max_length=64)


class ChooseRequest(BaseModel):
    # A step id: "original", "framed", "cutout", "adjusted:N", "cutout:N".
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
    # The statement `CreationOut.statement` names, recorded by this user for
    # this creation (POST /consents with its creation_id). Required when
    # that is not null.
    consent_id: str | None = Field(default=None, max_length=64)


class RetryRequest(BaseModel):
    """Optional: a third_party_ai consent by the member retrying, for a job
    that sends pixels out (adjust, AI points, generation from a photo). The
    consent the job was started with is someone's statement, and may not be
    the retrying member's."""

    consent_id: str | None = Field(default=None, max_length=64)


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
    # AI adjust candidates ("adjusted:N"): {mode, style, model,
    # generated_eyes, rejected: {code, detail} | null, checks}. A rejected
    # candidate is shown with its reason and cannot be chosen;
    # generated_eyes means the eyes are the model's invention (the photo's
    # were closed) and must be labelled so.
    adjust: dict | None = None
    # A generated original: {model, style, provider}.
    generated: dict | None = None
    # Transparent around the subject: a background removal's output
    # ("cutout", "cutout:N"), or a touch-up made from one.
    cutout: bool = False


class JobError(BaseModel):
    code: str
    detail: str


class JobProgress(BaseModel):
    fraction: float
    label: str | None = None


class JobOut(BaseModel):
    id: str
    step: Literal["ingest", "generate", "adjust", "background", "detect", "finish"]
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
    # Where the opening marks came from: "mediapipe" (a detection),
    # "template" (a guess) or "ai" (the vision model's points, a pre-fill
    # the owner still confirms part by part). Null on anchors made before
    # this was recorded.
    source: Literal["mediapipe", "template", "ai"] | None = None
    # The step whose pixels the marks are in ("original" or "framed").
    image: str | None
    image_size: list[int]
    detected: bool
    marks: dict
    validation: Validation


class BackgroundOffer(BaseModel):
    available: bool
    reason: str | None = None


class AdjustCandidateOut(BaseModel):
    # The step holding the image, or null when there is no image to show
    # (a safety refusal, a provider error, a result with no face to paste).
    step: str | None
    ok: bool
    reason: JobError | None = None
    generated_eyes: bool = False


class AdjustRoundOut(BaseModel):
    mode: str
    style: str | None = None
    source: str
    candidates: list[AdjustCandidateOut]
    # The monthly image limit stopped the round before every candidate.
    limit_reached: bool = False


class AiOut(BaseModel):
    """The creation's AI step: what is offered, what is left, what happened."""

    # False when an owner or admin has turned third-party AI off.
    enabled: bool
    # Adjust modes this line offers (empty until the line is known).
    modes: list[str]
    # The mode analysis.recommendation recommends for the current image, to
    # pre-select ([] when the photo needs nothing: AI stays available, and
    # nothing paid is pushed).
    suggested: list[str]
    adjust_rounds_left: int
    ai_detections_left: int
    last_round: AdjustRoundOut | None = None


class CreationOut(BaseModel):
    id: str
    face_type: FaceType | None
    status: CreationStatusName
    revision: int
    current: str | None
    steps: list[StepOut]
    # The upload's analysis (what step 1 pre-fills: suggested_face_type,
    # suggested_framing, and the original's face_state and checks), plus
    # `recommendation`: {image, mode: "touchup" | "regenerate" | "none",
    # reasons: [check codes]} for the CURRENT image on the creation's line,
    # recomputed with every change of image; null until the line is known.
    analysis: dict | None = None
    anchors: AnchorsOut | None = None
    job: JobOut | None = None
    avatar_id: str | None = None
    background_removal: BackgroundOffer
    # The owner's step 2 answer: "remove", "keep", or null (not answered, or
    # asked again after a change of line). Choosing an opaque AI result
    # follows "remove" by cutting it out.
    background: Literal["remove", "keep"] | None = None
    ai: AiOut
    # The uploader's statement finishing needs (a consent scope, recorded
    # with this creation's id), or null: "depiction" for a person's photo
    # (whatever line it is on now, a stylised one included), and
    # "generated_face" for a face the image model made from words.
    statement: Literal["depiction", "generated_face"] | None = None
    created_at: datetime
    updated_at: datetime


class PreviewRigOut(BaseModel):
    rig: dict
    reasons: list[FitReason] = Field(default_factory=list)


class FinishOut(BaseModel):
    avatar_id: str
    creation: CreationOut
