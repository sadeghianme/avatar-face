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

# The job shapes live in app.schemas.job (an avatar's mouth kit is a job
# too); imported here for this module's own models and its importers.
from app.schemas.job import JobCount, JobError, JobOut, JobProgress  # noqa: F401

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
    # Started by the wizard on its own, acting on `ai.auto_adjust`, not by
    # the owner's press: accepted only while that offer stands for the
    # current image (409 auto_adjust_not_applicable otherwise), and once per
    # photo, however it is cropped. The owner still chooses between the
    # result and their photo.
    auto: bool = False


class DetectRequest(BaseModel):
    """Omitted body: the line's detector only (MediaPipe, else the template)."""

    # Ask the vision model for the points where the detector cannot see
    # (animals; animations MediaPipe finds nothing on). Needs a consent.
    use_ai: bool = False
    consent_id: str | None = Field(default=None, max_length=64)


AvatarModel = Literal["human", "animal"]
AvatarLook = Literal["realistic", "animation", "cartoon"]


class GenerateCreationRequest(BaseModel):
    """A creation whose original is made by the image model.

    The four-step wizard sends `model` and `look` (services.wizard): the line
    follows from them, the prompt is the wizard's own, and the job also cuts
    the picture out and finds its face. Older clients send `face_type` and
    `style`, as before."""

    face_type: FaceType | None = None
    model: AvatarModel | None = None
    look: AvatarLook | None = None
    style: GenerationStyle = "photoreal"
    # What to make, in the owner's words (appended to the style prompt).
    prompt: str = Field(default="", max_length=300)
    # Start from one of the org's photo avatars (image to image). Sends that
    # photo to Google, so it needs a third_party_ai consent.
    source_avatar_id: str | None = Field(default=None, max_length=32)
    consent_id: str | None = Field(default=None, max_length=64)


class PrepareRequest(BaseModel):
    """Step 3 of the four-step wizard (services.wizard): a job.

    `ai` makes the upload in the plan's look; `change` edits the current AI
    picture with `instruction` (from the upload when there is none yet);
    `generate` makes a new picture from a generated creation's description
    (its Retry); `original` uses the photo itself, cut out, with no AI (a
    realistic upload only). The AI modes need a third_party_ai consent."""

    mode: Literal["ai", "change", "generate", "original"] = "ai"
    instruction: str | None = Field(default=None, max_length=300)
    consent_id: str | None = Field(default=None, max_length=64)
    # With `change`: the owner's Retry of their last change. It is made
    # again from the picture the last try was made from, not stacked on the
    # last result.
    again: bool = False
    # With `ai` or `generate`: "Remove this change", the plain picture again.
    # It gives its try back (up to wizard.FREE_CLEARS_PER_CREATION per
    # creation; after that it counts) but is still metered as an image call.
    clear: bool = False


class PlanOut(BaseModel):
    """What the owner chose on the four-step wizard's first two screens."""

    model: AvatarModel
    look: AvatarLook
    source: Literal["upload", "generate"]
    description: str | None = None


class ChooseRequest(BaseModel):
    # A step id: "original", "framed", "cutout", "adjusted:N", "cutout:N".
    choice: str = Field(min_length=1, max_length=32)


class VersionRequest(BaseModel):
    """Step 3 of the four-step wizard: go back to one of the pictures made.
    A version is "original" (the upload, or a generated character's first
    picture) or "adjusted:N" (an AI result); its cut-out is used when it
    has one."""

    version: str = Field(min_length=1, max_length=32)


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


class AutoAdjustOut(BaseModel):
    """A fix the wizard may start by itself: the current image of a person
    shows teeth between parted lips (the photographic mouth would paint them
    on the lips when it closes), and nothing else a touch-up would change,
    which a touch-up closes. The wizard starts it only with the member's own
    current third_party_ai consent (GET /consents/mine), sending `auto:
    true`; the result is offered, never chosen. Offered once per photo."""

    mode: Literal["touchup"]
    # The step it applies to, and the photo check's reasons (check codes).
    image: str
    reasons: list[str]


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
    # Set when the wizard should start a touch-up on its own (see
    # AutoAdjustOut); null otherwise, and once one was started for this image.
    auto_adjust: AutoAdjustOut | None = None
    # The four-step wizard's step 3: AI runs left, and what the last one
    # was ({mode, look, instruction, step, cut}: `cut` false when the
    # backdrop could not be taken off and the picture is kept whole).
    prepare_rounds_left: int = 0
    # "Remove this change" redos that still cost no try.
    free_clears_left: int = 0
    last_prepare: dict | None = None


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
    # The four-step wizard's plan; null for a creation the old wizard made.
    plan: PlanOut | None = None
    created_at: datetime
    updated_at: datetime


class PreviewRigOut(BaseModel):
    rig: dict
    reasons: list[FitReason] = Field(default_factory=list)


class FinishWarning(BaseModel):
    # "mouth_open" or "teeth_showing": the picture being finished still shows
    # it, so the avatar rests with its mouth open, or with its own teeth
    # painted on its lips. Not a refusal: the avatar is built anyway.
    code: str
    detail: str


class FinishOut(BaseModel):
    avatar_id: str
    creation: CreationOut
    warnings: list[FinishWarning] = Field(default_factory=list)
