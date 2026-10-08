"""The shapes of the JSON this application stores and passes around.

The columns that carry the core of the product are JSON: a creation's steps,
anchors, job and AI budget; an avatar's published snapshot, mouth, scene and
disclosure; the rig file beside it. Typed as plain `dict` they were opaque to
the type checker, which is where most of the logic lives. These TypedDicts
say what each holds, so pyright checks the code that builds and reads them.

Types only: nothing here validates at run time, and rows written before a
key existed still lack it (those keys are NotRequired, and readers use
`.get`). Values that would be Python keywords as keys use the functional
TypedDict form (StepItem's "from").
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

# --- Small shared pieces ---------------------------------------------------------


class Note(TypedDict):
    """A reason with a machine-readable code: an error, a warning, why a
    shape or a candidate was refused."""

    code: str
    detail: str


class Point(TypedDict):
    x: float
    y: float


class CropRect(TypedDict):
    """A rectangle in fractions of the image."""

    x: float
    y: float
    w: float
    h: float


# --- Marks (services.anchor_fit) ----------------------------------------------------


class RegionMarksRecord(TypedDict):
    left: Point
    right: Point
    top: Point
    bottom: Point
    center: NotRequired[Point]
    upper_left: NotRequired[Point]
    upper_right: NotRequired[Point]
    lower_right: NotRequired[Point]
    lower_left: NotRequired[Point]


class PupilMarksRecord(TypedDict):
    center: Point
    rim: Point


class Marks(TypedDict, total=False):
    """The owner's marks; only what is marked is present."""

    head: RegionMarksRecord
    left_eye: RegionMarksRecord
    right_eye: RegionMarksRecord
    mouth: RegionMarksRecord
    mouth_line: list[Point]
    chin: Point
    left_pupil: PupilMarksRecord
    right_pupil: PupilMarksRecord
    # On a rig's saved marks: who placed them ("owner").
    source: str


# --- A creation's photo check (services.photo_analysis) -----------------------------


class FaceMeasures(TypedDict):
    eye_aspect: list[float]
    gaze: float | None
    mouth_gap: float
    nose_offset: float
    yaw: float


class FaceState(TypedDict):
    eyes_closed: bool
    eyes_half_closed: bool
    gaze_off_camera: bool
    mouth_open: bool
    teeth_showing: bool
    head_turned: bool
    measures: FaceMeasures


class Recommendation(TypedDict):
    mode: Literal["none", "touchup", "regenerate"]
    reasons: list[str]


class StepCheck(TypedDict):
    """An image's photo check, as kept on each step (steps.step_check)."""

    detector: Literal["mediapipe"] | None
    detected: bool
    face_box: list[float] | None
    roll: float | None
    face_state: FaceState | None
    checks: list[Note]
    # By line: "human", "animal", "cartoon".
    recommendations: dict[str, Recommendation]


class SuggestedFraming(TypedDict):
    crop: CropRect
    roll: float


class CreationAnalysis(TypedDict):
    """Creation.analysis: the upload's check, without its recommendations."""

    image_size: list[int]
    detector: Literal["mediapipe"] | None
    detected: bool
    face_box: list[float] | None
    roll: float | None
    face_state: FaceState | None
    checks: list[Note]
    suggested_face_type: Literal["human"] | None
    suggested_framing: SuggestedFraming | None


# --- Creation.steps -------------------------------------------------------------------


# What the four-step wizard asks first (also the API's: schemas.creation).
AvatarModel = Literal["human", "animal"]
AvatarLook = Literal["realistic", "animation", "cartoon"]
PlanSource = Literal["upload", "generate"]


class Plan(TypedDict):
    """The four-step wizard's plan (services.wizard.plan)."""

    model: AvatarModel
    look: AvatarLook
    source: PlanSource
    description: str | None


class BeforeStylise(TypedDict):
    face_type: str | None
    background: Literal["remove", "keep"] | None


class GeneratedRecord(TypedDict):
    model: str
    style: str
    provider: NotRequired[str]
    source_avatar_id: str | None


class AdjustChecks(TypedDict, total=False):
    detected: bool
    fit_ok: bool
    skin_delta_e: float


class StepAdjust(TypedDict):
    mode: Literal["touchup", "stylise", "regenerate", "generate"]
    style: str | None
    model: str | None
    generated_eyes: bool
    rejected: Note | None
    checks: AdjustChecks
    look: NotRequired[str]
    instruction: NotRequired[str | None]


class PrepareRecord(TypedDict):
    """What made a version in the four-step wizard (also ai_usage.last_prepare)."""

    mode: Literal["ai", "change", "generate", "original"]
    look: str
    instruction: str | None
    step: str
    cut: NotRequired[bool]


class FitReasonRecord(TypedDict):
    code: str
    detail: str
    count: int | None


class AnchorValidation(TypedDict):
    ok: bool
    reasons: list[FitReasonRecord]
    warnings: list[Note]
    detected: bool
    one_click: bool


class FoundAnchors(TypedDict):
    """What finding a face on one image gives (services.anchors)."""

    image_size: list[int]
    detected: bool
    base: list[list[float]]
    marks: Marks
    validation: AnchorValidation


class CreationAnchors(FoundAnchors):
    """Creation.anchors: found anchors, bound to the pixel frame they were
    placed on."""

    id: str
    frame: str | None
    face_type: str
    source: NotRequired[Literal["mediapipe", "template", "ai"]]


StepItem = TypedDict(
    "StepItem",
    {
        "key": str,
        "width": int,
        "height": int,
        # The step this image was made from; None only for "original".
        "from": str | None,
        "check": NotRequired[StepCheck | None],
        "cutout": NotRequired[bool],
        "crop": NotRequired[CropRect],
        "roll": NotRequired[float],
        "generated": NotRequired[GeneratedRecord],
        "adjust": NotRequired[StepAdjust],
        # services.wizard.plan KEPT_RECORD / KEPT_ANCHORS.
        "prepare": NotRequired[PrepareRecord],
        "anchors": NotRequired[CreationAnchors],
    },
)


class CreationSteps(TypedDict):
    """Creation.steps: every image the wizard made, by step id."""

    current: str | None
    items: dict[str, StepItem]
    plan: NotRequired[Plan]
    name: NotRequired[str | None]
    background: NotRequired[Literal["remove", "keep"]]
    before_stylise: NotRequired[BeforeStylise]


# --- Creation.job ---------------------------------------------------------------------

JobState = Literal["queued", "running", "done", "failed", "interrupted"]


class JobRecord(TypedDict):
    """Creation.job: the last job's state transitions (services.creations.records)."""

    id: str
    step: str
    state: JobState
    error: Note | None
    started_at: str
    # What a retry needs; gone once the job is done. Its keys depend on the step.
    params: NotRequired[dict]


# --- Creation.ai_usage ----------------------------------------------------------------


class VisionCacheEntry(TypedDict):
    sha256: str | None
    face_type: str
    model: str
    points: dict[str, list[float]]


class AdjustCandidate(TypedDict):
    step: str | None
    ok: bool
    reason: Note | None
    generated_eyes: bool


class AdjustRound(TypedDict):
    mode: str
    style: str | None
    source: str | None
    candidates: list[AdjustCandidate]
    limit_reached: bool


class AiUsage(TypedDict):
    """Creation.ai_usage, with every counter (records.ai_usage_of fills them)."""

    adjust_rounds: int
    detections: int
    next_adjusted: int
    vision_cache: list[VisionCacheEntry]
    prepare_rounds: int
    free_clears: int
    auto_adjusted: NotRequired[list[str]]
    last_round: NotRequired[AdjustRound]
    last_prepare: NotRequired[PrepareRecord]


# --- An avatar's disclosure and voice ---------------------------------------------------


class AiTeethEntry(TypedDict):
    model: str | None


class AiShapesEntry(TypedDict):
    model: str | None
    generated: int


class AiEdited(TypedDict):
    """Avatar.ai_edited: what an AI made or changed (services.disclosure)."""

    mode: str
    model: str | None
    teeth: NotRequired[AiTeethEntry]
    mouth_shapes: NotRequired[AiShapesEntry]


class Disclosure(TypedDict):
    ai_edited: AiEdited | None
    line: str


class VoiceChoice(TypedDict):
    provider: str
    voice: str
    locale: str


# --- Avatar.mouth_config (services.mouth) ------------------------------------------------


class ProfileValues(TypedDict, total=False):
    teethScale: float
    teethY: float
    warmth: float
    lipProjection: float
    jawRange: float


class CharacterSettings(TypedDict):
    style: Literal["character", "classic"]
    teeth: Literal["upper", "none"]
    tongue: bool
    jaw: float


class TeethNote(TypedDict):
    """A Note on why the AI's teeth photo was refused, with the check's own
    note (`reason`). Any TeethNote is a Note, so the records below take
    either."""

    code: str
    detail: str
    reason: NotRequired[Note | None]


class TeethRecord(TypedDict):
    """Where the teeth photo came from (`source`), or why there is none (`note`)."""

    source: Literal["ai", "upload"] | None
    model: NotRequired[str | None]
    note: NotRequired[Note | None]


class KitShape(TypedDict):
    provenance: Literal["generated", "retargeted"]
    outcome: str
    reason: Note | None
    attempts: list[str]


class KitTeeth(TypedDict):
    used: bool
    reason: Note | None


class KitRecord(TypedDict):
    """mouth_config["kit"]: what the mouth kit is made of (services.mouth_kit)."""

    id: str
    state: NotRequired[Literal["made", "dropped"]]
    made_at: str
    source: Literal["finish", "mouth_panel"]
    recipe: dict | None
    model: str | None
    shapes: dict[str, KitShape]
    generated: int
    retargeted: int
    teeth: KitTeeth
    fitted: NotRequired[dict[str, float]]
    fit_reasons: list[dict]
    calls: int
    billed_calls: int
    base_detected: bool
    rebased_at: str | None
    dropped: Note | None


class MouthConfig(TypedDict):
    renderer: Literal["classic", "continuous"]
    profile: ProfileValues
    character: NotRequired[CharacterSettings | None]
    oral_image_key: NotRequired[str]
    oral_rig_key: NotRequired[str]
    motion_key: NotRequired[str]
    teeth: NotRequired[TeethRecord]
    kit: NotRequired[KitRecord]


class OralUrls(TypedDict):
    image_url: str
    rig_url: str


# --- Avatar.scene_config (services.scene) -------------------------------------------------


class PanOffset(TypedDict):
    x: float
    y: float


SceneKind = Literal["transparent", "color", "image"]


class SceneBackground(TypedDict):
    kind: SceneKind
    color: NotRequired[str]
    image_key: NotRequired[str]


class SceneConfig(TypedDict):
    zoom: float
    pan: PanOffset
    background: SceneBackground


class OwnerSceneBackground(TypedDict):
    kind: str
    has_image: bool
    color: NotRequired[str]


class OwnerScene(TypedDict):
    """What the owner is told of a scene: never the picture's key."""

    zoom: float
    pan: PanOffset
    background: OwnerSceneBackground


class VisitorSceneBackground(TypedDict):
    kind: str
    color: NotRequired[str]
    image_url: NotRequired[str]


class VisitorScene(TypedDict):
    zoom: float
    pan: PanOffset
    background: VisitorSceneBackground


# --- Avatar.published_config (services.publishing) ----------------------------------------


class PublishedConfig(TypedDict):
    """The published snapshot: what visitors are served until the next Publish."""

    revision: int
    framing: str
    face_type: NotRequired[str]
    image_key: str
    rig_key: str | None
    thumbnail_key: str | None
    layer_keys: dict[str, str] | None
    published_at: str | None
    scene: NotRequired[SceneConfig | None]
    voice: NotRequired[VoiceChoice | None]
    mouth: NotRequired[MouthConfig | None]
    disclosure: NotRequired[Disclosure]


class PublishedView(TypedDict):
    """A published snapshot with presigned URLs: what embed and share serve."""

    framing: str
    # "human", "animal" or "cartoon": how the engine moves the head.
    face_type: str
    scene: VisitorScene | None
    voice: VoiceChoice | None
    mouth: dict | None
    rig_url: str
    thumbnail_url: str
    image_url: str
    layer_urls: dict[str, str] | None
    disclosure: Disclosure | None


# --- The rig file (services.rig) -------------------------------------------------------------


class Rig(TypedDict):
    """rig.json (v3): the mesh the engine animates."""

    version: int
    image_size: list[int]
    face_box: list[float]
    points: list[list[float]]
    triangles: list[list[int]]
    mouth_indices: list[int]
    inner_lip_ring: list[int]
    outer_lip_ring: list[int]
    visemes: dict[str, dict[str, float]]
    blendshapes: dict[str, float] | None
    user_anchors: NotRequired[Marks]
    render_profile: NotRequired[str]
    crop_origin: NotRequired[list[int]]


class FitBaseRecord(TypedDict):
    """fit-base.json beside the rig: the mesh every fit starts from."""

    version: int
    image_size: list[int]
    crop_origin: list[int] | None
    detected: bool
    points: list[list[float]]
