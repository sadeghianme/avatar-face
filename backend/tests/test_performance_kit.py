"""The performance kit: the Reference's mouth kit, made from a person's photo.

No provider and no MediaPipe are used here. The "person" is the Reference
itself, drawn at half size on a synthetic skin-coloured photo: its rig gives
the base points and its registered poses the ground truth of every shape,
so what the kit measures can be compared with what is known. The fake
provider answers with the very crop the kit sent (so skin and light match),
marked per shape, and the fake detector knows where the test put that
shape's landmarks in it (`Scene`). Answers are then altered in known ways to
exercise every guard.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services import imagegen, photo_adjust
from app.services import performance_kit as pk
from app.services.performance_kit.kit import Finished, finish
from app.services.performance_kit.profile import profile_defaults
from app.services.performance_kit.requests import load_base_image

REPO = Path(__file__).resolve().parents[2]
REFERENCE_DIR = REPO / "frontend/public/lab/reference"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
REFERENCE_SIZE = 1254  # the Reference portrait's side, in pixels

# The synthetic base photo: the Reference face at this scale, placed here.
SCALE = 0.5
OFFSET = np.array([30.0, 60.0])
BASE_SIZE = (700, 780)
SKIN = (196, 150, 122)


@pytest.fixture(scope="module")
def reference() -> pk.ReferenceMotion:
    return pk.load_reference()


@pytest.fixture(scope="module")
def reference_manifest() -> dict:
    return json.loads((REFERENCE_DIR / "performance.json").read_text())


def to_base(normalised: np.ndarray) -> np.ndarray:
    return np.asarray(normalised) * REFERENCE_SIZE * SCALE + OFFSET


def png(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def base_photo(seed: int = 5) -> Image.Image:
    rng = np.random.default_rng(seed)
    pixels = np.zeros((BASE_SIZE[1], BASE_SIZE[0], 3), dtype=np.float64)
    pixels[:] = SKIN
    pixels += rng.normal(0, 4, size=pixels.shape)
    return Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8))


def image_key(image: Image.Image) -> str:
    return hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()


class Scene:
    """The test's world: the base photo, the truth of every shape in base
    pixels (and of the teeth photo: the Reference's EE, its lips drawn back
    and parted), and a detector that knows every answer the fake provider
    made."""

    def __init__(self, reference: pk.ReferenceMotion):
        self.reference = reference
        self.base_image = base_photo()
        self.base_png = png(self.base_image)
        self.base_points = to_base(reference.rest)
        self.truth = {shape: to_base(reference.poses[shape]) for shape in pk.SHAPES}
        self.truth[pk.TEETH] = self.truth["ee"]
        self.known: dict[str, np.ndarray] = {}
        self.detect_calls = 0

    def detect(self, image: Image.Image) -> np.ndarray | None:
        self.detect_calls += 1
        points = self.known.get(image_key(image))
        return None if points is None else points.copy()

    def remember(self, image: Image.Image, points: np.ndarray) -> None:
        self.known[image_key(image)] = np.asarray(points, dtype=np.float64)

    def box_for(self, payload: bytes) -> tuple[float, float, float, float]:
        """Which square of the base a payload shows: the face crop is
        CROP_SIZE across, the head crop (at the photo's own resolution)
        smaller in every scene here."""
        with Image.open(io.BytesIO(payload)) as sent:
            size = sent.size
        if size == (photo_adjust.CROP_SIZE, photo_adjust.CROP_SIZE):
            x0, y0, side = photo_adjust.face_crop_box(self.base_points)
        else:
            x0, y0, side = pk.head_square(self.base_image.size, self.base_points)
        return x0, y0, x0 + side, y0 + side

    def answer_points(self, shape_points: np.ndarray, box, answer_size) -> np.ndarray:
        x0, y0, x1, y1 = box
        scale = np.array([answer_size[0] / (x1 - x0), answer_size[1] / (y1 - y0)])
        return (shape_points - np.array([x0, y0])) * scale


def shape_of(prompt: str) -> str:
    if prompt == pk.teeth_prompt():
        return pk.TEETH
    return next(shape for shape in pk.SHAPES if pk.POSE_PROMPTS[shape] in prompt)


def paint_teeth(image: Image.Image, points: np.ndarray, edge: float) -> Image.Image:
    """A dark mouth inside the inner lip ring with an upper row of teeth
    down to `edge` mouth widths below the inner upper lip (13)."""
    image = image.copy()
    draw = ImageDraw.Draw(image)
    ring = [tuple(p) for p in points[pk.INNER_LIP_RING].tolist()]
    draw.polygon(ring, fill=(46, 22, 24))
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).polygon(ring, fill=255)
    width = float(np.linalg.norm(points[291] - points[61]))
    top = points[13][1] - width * 0.2
    bottom = points[13][1] + edge * width
    teeth = Image.new("L", image.size, 0)
    ImageDraw.Draw(teeth).rectangle((points[61][0], top, points[291][0], bottom), fill=255)
    both = Image.fromarray(np.minimum(np.asarray(mask), np.asarray(teeth)))
    image.paste((236, 234, 226), mask=both)
    return image


class FakeProvider:
    """imagegen.edit_image's contract without a network: returns the crop
    it was sent, marked per request, and tells the Scene where the shape's
    landmarks are in it. `behaviour[shape]` (a shape, or pk.TEETH) may be an
    exception to raise (every time, or a list consumed call by call), "slow"
    (sleeps past any timeout), or a function (points) -> points altering the
    landmarks, or (image, points) -> (image, points) altering both.

    The teeth photo shows upper teeth down to `teeth_edge` mouth widths
    below its inner upper lip: by default 0.12, full crowns like the
    Reference's teeth photo (oral-detail-v3 shows 0.14), which the embed
    accepts; the Reference's own EE shows only 0.07, tips it refuses."""

    def __init__(self, scene: Scene, behaviour: dict | None = None, *, teeth_edge=0.12, delay=0.0):
        self.scene = scene
        self.behaviour = dict(behaviour or {})
        self.teeth_edge = teeth_edge
        self.delay = delay
        self.requests: list[tuple[str, str]] = []
        self.in_flight = 0
        self.most_in_flight = 0

    async def __call__(self, prompt: str, payload: bytes, mime: str):
        assert mime == "image/jpeg"
        shape = shape_of(prompt)
        self.requests.append((shape, hashlib.sha256(prompt.encode() + payload).hexdigest()))
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
            action = self.behaviour.get(shape)
            if isinstance(action, list):
                action = action.pop(0) if action else None
            if action == "slow":
                await asyncio.sleep(10)
            if isinstance(action, BaseException):
                raise action
            box = self.scene.box_for(payload)
            with Image.open(io.BytesIO(payload)) as sent:
                answer = sent.convert("RGB")
            # One pixel per request, so every answer is a different image.
            answer.putpixel((0, 0), ((pk.SHAPES + (pk.TEETH,)).index(shape) * 20, 0, 0))
            points = self.scene.answer_points(self.scene.truth[shape], box, answer.size)
            if shape == pk.TEETH and self.teeth_edge is not None:
                answer = paint_teeth(answer, points, self.teeth_edge)
            if callable(action):
                altered = (
                    action(answer, points) if action.__code__.co_argcount == 2 else action(points)
                )
                if isinstance(altered, tuple):
                    answer, points = altered
                else:
                    points = altered
            self.scene.remember(answer, points)
            return imagegen.Generated(png(answer), "image/png", "fake-image-model")
        finally:
            self.in_flight -= 1


@pytest.fixture
def scene(reference) -> Scene:
    return Scene(reference)


def kit(scene: Scene, provider, **kwargs):
    kwargs.setdefault("detect", scene.detect)
    kwargs.setdefault("reference", scene.reference)
    kwargs.setdefault("kit_id", "test-kit")
    return pk.build_kit(scene.base_png, scene.base_points, provider, **kwargs)


# --- The Reference is rebuilt exactly -----------------------------------------------------


def _script():
    import scripts.build_reference_performance as script

    return script


def test_the_reference_manifest_rebuilds_byte_for_byte():
    """The registration moved into performance_kit; the Reference builder
    must still write the identical performance.json. MediaPipe's own
    full-precision detections of the six pose masters are recorded in the
    fixture (the manifest stores them rounded), so this runs anywhere."""
    recorded = np.load(FIXTURES / "reference_pose_detections.npz")

    def detect(image: str) -> np.ndarray:
        name = image.removeprefix("performance-").removesuffix(".png")
        return recorded[f"{name}_points"] / recorded[f"{name}_size"]

    manifest = _script().build_manifest(detect)
    rebuilt = json.dumps(manifest, separators=(",", ":"))
    assert rebuilt == (REFERENCE_DIR / "performance.json").read_text()


@pytest.mark.skipif(
    not os.environ.get("LIVEFACE_FACE_MODEL"),
    reason="set LIVEFACE_FACE_MODEL to a face_landmarker.task to detect the masters for real",
)
def test_the_reference_manifest_rebuilds_from_the_masters(monkeypatch):
    """The same with MediaPipe on the pose masters (assets/reference-performance)."""
    from app.core.config import get_settings
    from app.services.rig import landmarks_from_image

    script = _script()
    monkeypatch.setattr(get_settings(), "rig_model_path", os.environ["LIVEFACE_FACE_MODEL"])

    def detect(image: str) -> np.ndarray:
        points, _, size, detected = landmarks_from_image((script.MASTERS / image).read_bytes())
        assert detected
        return np.asarray(points) / np.asarray(size)

    rebuilt = json.dumps(script.build_manifest(detect), separators=(",", ":"))
    assert rebuilt == (REFERENCE_DIR / "performance.json").read_text()


def test_the_shared_registration_is_the_reference_builders_arithmetic():
    """The builder's registration before it moved, verbatim: bit-identical
    results on arbitrary faces, not merely close ones."""

    def original(source, target):
        a, b = source[pk.ANCHORS], target[pk.ANCHORS]
        ac, bc = a.mean(axis=0), b.mean(axis=0)
        u, singular, vt = np.linalg.svd((a - ac).T @ (b - bc))
        rotation = u @ vt
        scale = singular.sum() / np.square(a - ac).sum()
        return (source - ac) @ rotation * scale + bc

    rng = np.random.default_rng(1)
    for _ in range(20):
        source, target = rng.random((478, 2)), rng.random((478, 2))
        try:
            expected = original(source, target)
            actual = pk.register(source, target)
        except pk.MirroredPose:
            continue
        assert np.array_equal(actual, expected)


def test_a_mirrored_pose_is_refused(reference):
    mirrored = reference.rest.copy()
    mirrored[:, 0] = 1 - mirrored[:, 0]
    with pytest.raises(pk.MirroredPose):
        pk.register(mirrored, reference.rest)


# --- 1. Prompts ------------------------------------------------------------------------------


def test_there_is_one_versioned_prompt_per_shape():
    assert set(pk.POSE_PROMPTS) == set(pk.SHAPES)
    assert pk.PROMPTS_VERSION.startswith("pose-prompts@")
    prompts = [pk.pose_prompt(shape) for shape in pk.SHAPES]
    assert len(set(prompts)) == len(prompts)
    for prompt in prompts:
        # Same person, framing and light; only the mouth and jaw change.
        assert "Change ONLY the mouth, lips, teeth, tongue and jaw" in prompt
        for kept in ("identity", "head position", "framing", "lighting", "background"):
            assert kept in prompt


def test_the_ee_is_speech_and_the_teeth_are_asked_for_on_their_own():
    """EE is the "ee" of speech: the full crowns a teeth photo needs lift
    the upper lip far above it. The teeth photo is its own request, with
    the recipe of the photo the Reference renders its teeth from."""
    from app.services import mouth_photo

    assert "at most the biting edges of the upper front teeth" in pk.pose_prompt("ee")
    assert "CLEARLY VISIBLE" not in pk.pose_prompt("ee")
    assert pk.request_prompt(pk.TEETH) == pk.teeth_prompt() == mouth_photo.TEETH_PROMPT
    assert "ENTIRE upper front teeth" in pk.teeth_prompt()
    assert pk.request_prompt("aa") == pk.pose_prompt("aa")
    assert "tongue" in pk.pose_prompt("th") and "lower lip" in pk.pose_prompt("fv")


def test_the_prompts_say_what_real_gemini_got_wrong():
    """The first run on real Gemini (fictional faces): AA yawn-wide, TH's
    tongue far out, F/V ambiguous; the second: OO a pout, F/V open over the
    teeth. The wording that answers each, under a new recipe version, so a
    stored kit says which words made it."""
    assert pk.PROMPTS_VERSION == "pose-prompts@4"
    assert "moderately open, as in normal conversation, not a yawn or a shout" in (
        pk.pose_prompt("aa")
    )
    assert "only the very tip of the tongue, barely visible between the front teeth" in (
        pk.pose_prompt("th")
    )
    assert "the lower lip drawn up and tucked lightly under the upper front teeth" in (
        pk.pose_prompt("fv")
    )
    assert "a clearly open, round hole, not a kiss, a whistle or a pout" in pk.pose_prompt("oo")


# --- 2. Request preparation -----------------------------------------------------------------


def test_the_face_crop_is_ai_adjusts_crop_with_its_way_back(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "aa")
    assert request.kind == pk.FACE_CROP and request.mime == "image/jpeg"
    assert request.prompt == pk.pose_prompt("aa")
    with Image.open(io.BytesIO(request.payload)) as sent:
        assert sent.size == (photo_adjust.CROP_SIZE, photo_adjust.CROP_SIZE)
    x0, y0, side = photo_adjust.face_crop_box(scene.base_points)
    assert request.box == pytest.approx((x0, y0, x0 + side, y0 + side))
    # A landmark carried into the crop's pixels comes back where it was.
    inside = scene.answer_points(scene.base_points, request.box, (1024, 1024))
    matrix = request.to_base((1024, 1024))
    back = inside @ matrix[:, :2].T + matrix[:, 2]
    assert np.allclose(back, scene.base_points)


def test_the_head_crop_is_photo_adjusts_fallback_crop_made_square(scene):
    """The head box is 6:7 (here clipped by the photo's bottom edge), a
    shape the model does not answer in: it is padded to a square about its
    centre, like the face crop, and sent at the photo's own resolution."""
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "oo", kind=pk.HEAD_CROP)
    assert request.kind == pk.HEAD_CROP
    x0, y0, x1, y1 = (
        float(int(round(v))) for v in photo_adjust.head_crop_box(BASE_SIZE, scene.base_points)
    )
    assert (x1 - x0) / (y1 - y0) != pytest.approx(1.0, abs=0.02), "the box itself is not square"
    side = max(x1 - x0, y1 - y0)
    assert request.box == pytest.approx(
        ((x0 + x1 - side) / 2, (y0 + y1 - side) / 2, (x0 + x1 + side) / 2, (y0 + y1 + side) / 2)
    )
    assert request.aspect == pytest.approx(1.0)
    with Image.open(io.BytesIO(request.payload)) as sent:
        assert sent.size == (round(side), round(side))
    # Where the square reaches past the photo it shows the photo's own edge,
    # as the face crop does, not a black band.
    with Image.open(io.BytesIO(request.payload)) as sent:
        corner = np.asarray(sent.convert("RGB"))[-4:, :4].mean(axis=(0, 1))
    assert np.abs(corner - np.array(SKIN)).max() < 20


def test_the_teeth_are_asked_for_on_the_same_face_crop(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, pk.TEETH)
    aa = pk.prepare_pose_request(scene.base_png, scene.base_points, "aa")
    assert request.prompt == pk.teeth_prompt() and request.shape == pk.TEETH
    assert request.box == aa.box and request.payload == aa.payload


def test_no_head_crop_when_it_would_be_the_whole_photo(reference):
    """The face fills the picture: the crop is the same picture, and asking
    again would be asking the same thing."""
    points = reference.rest * 300 - np.array([20.0, 70.0])
    photo = png(Image.new("RGB", (220, 260), SKIN))
    assert pk.prepare_pose_request(photo, points, "aa", kind=pk.HEAD_CROP) is None


def test_malformed_points_are_refused(scene):
    with pytest.raises(ValueError):
        pk.prepare_pose_request(scene.base_png, scene.base_points[:400], "aa")
    bad = scene.base_points.copy()
    bad[3, 0] = np.nan
    with pytest.raises(ValueError):
        pk.prepare_pose_request(scene.base_png, bad, "aa")
    with pytest.raises(ValueError):
        pk.prepare_pose_request(scene.base_png, scene.base_points, "zz")


# --- 3. Registration ------------------------------------------------------------------------------


def registered(scene: Scene, shape: str, alter=None, image_alter=None) -> pk.PoseRegistration:
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, shape)
    with Image.open(io.BytesIO(request.payload)) as sent:
        answer = sent.convert("RGB")
    points = scene.answer_points(scene.truth[shape], request.box, answer.size)
    if alter is not None:
        points = alter(points)
    if image_alter is not None:
        answer = image_alter(answer)
    scene.remember(answer, points)
    frame = pk.ManifestFrame.from_base(scene.base_points, BASE_SIZE, scene.reference)
    return pk.register_answer(
        png(answer),
        request,
        load_base_image(scene.base_png),
        scene.base_points,
        frame,
        scene.detect,
    )


@pytest.mark.parametrize("shape", pk.SHAPES)
def test_a_faithful_answer_registers_onto_the_base(scene, reference_manifest, shape):
    result = registered(scene, shape)
    assert result.ok, result.reason
    # The truth was registered onto this face already: nothing moves again.
    assert np.allclose(result.targets, scene.truth[shape], atol=1e-6)
    # The frame makes this face the Reference's size, so the RMS is the
    # Reference's own, whatever the photo's framing.
    recorded = next(p for p in reference_manifest["poses"] if p["id"] == shape)
    assert result.rms == pytest.approx(recorded["registration_rms"], abs=2e-6)
    assert result.checks["skin_delta_e"] < 1.0


def test_a_small_zoom_and_shift_by_the_model_is_registered_away(scene):
    centre = np.array([512.0, 512.0])
    result = registered(scene, "ee", alter=lambda p: (p - centre) * 1.05 + centre + [9, -6])
    assert result.ok, result.reason
    assert np.allclose(result.targets, scene.truth["ee"], atol=1e-6)
    assert result.checks["scale"] == pytest.approx(1 / 1.05, abs=1e-3)


def rotate(points: np.ndarray, degrees: float, centre=(512.0, 512.0)) -> np.ndarray:
    angle = math.radians(degrees)
    matrix = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    return (points - centre) @ matrix.T + centre


@pytest.mark.parametrize(
    "alter",
    [
        lambda p: (p - 512) * 1.2 + 512,
        lambda p: rotate(p, 6),
    ],
    ids=["zoomed", "tilted"],
)
def test_a_head_the_model_zoomed_or_tilted_is_refused(scene, alter):
    result = registered(scene, "aa", alter=alter)
    assert result.reason["code"] == "head_moved"
    assert result.targets is None


def face_width_in_answer(points: np.ndarray) -> float:
    return float(np.linalg.norm(points[454] - points[234]))


def test_anchors_that_do_not_line_up_are_refused(scene):
    def shake(points):
        points = points.copy()
        rng = np.random.default_rng(7)
        points[pk.ANCHORS] += rng.normal(0, 0.03, size=(8, 2)) * face_width_in_answer(points)
        return points

    result = registered(scene, "aa", alter=shake)
    assert result.reason["code"] == "registration"
    assert result.checks["rms"] > pk.MAX_REGISTRATION_RMS


def test_a_moved_nose_is_refused(scene):
    def nose(points):
        points = points.copy()
        points[[1, 4, 5, 45, 275]] += [0, 0.05 * face_width_in_answer(points)]
        return points

    assert registered(scene, "oo", alter=nose).reason["code"] == "nose_moved"


def test_moved_eyes_are_refused(scene):
    lids = [i for i in pk.EYE_GUARD if i not in pk.ANCHORS]

    def eyes(points):
        points = points.copy()
        points[lids] += [0, 0.03 * face_width_in_answer(points)]
        return points

    assert registered(scene, "oh", alter=eyes).reason["code"] == "eyes_moved"


def test_a_turned_head_is_refused(scene):
    def turn(points):
        points = points.copy()
        half = face_width_in_answer(points) / 2
        points[234] -= [0.4 * half, 0]
        return points

    result = registered(scene, "th", alter=turn)
    assert result.reason["code"] == "head_turned"


def test_relit_skin_is_refused(scene):
    def relight(image):
        pixels = np.asarray(image, dtype=np.float64) * [0.7, 0.85, 1.25]
        return Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8))

    result = registered(scene, "fv", image_alter=relight)
    assert result.reason["code"] == "skin_tone_changed"
    assert result.checks["skin_delta_e"] > pk.MAX_POSE_SKIN_DELTA_E


def test_an_answer_that_did_not_make_the_shape_is_refused(scene):
    """The model returned the closed rest mouth when asked for AA."""
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "aa")

    def closed(points):
        return scene.answer_points(scene.base_points, request.box, (1024, 1024))

    result = registered(scene, "aa", alter=closed)
    assert result.reason["code"] == "pose_not_reached"
    assert "AA" in result.reason["detail"]


# What an over-acting model still keeps where it was: the eyes and the nose
# (the Reference's own shapes move them a hair, which the guards allow once,
# not two and a half times over).
_STILL = sorted(set(pk.NOSE_GUARD) | set(pk.EYE_GUARD) | set(pk.ANCHORS))


def acting(scene: Scene, shape: str, factor: float) -> np.ndarray:
    """The truth of `shape`, its mouth and jaw moved from rest `factor`
    times as far: a model that over- or under-acts it."""
    moved = scene.truth[shape] - scene.base_points
    scaled = scene.base_points + factor * moved
    scaled[_STILL] = scene.truth[shape][_STILL]
    return scaled


def test_the_references_openings_are_the_bundled_motions(reference):
    measured = pk.reference_openings(reference)
    for shape, opening in pk.REFERENCE_OPENINGS.items():
        assert measured[shape] == pytest.approx(opening, abs=1e-3), shape
    assert pk.POSE_LIMITS["th"]["max_opening"] == round(2.0 * pk.REFERENCE_OPENINGS["th"], 3)
    assert pk.POSE_LIMITS["aa"]["max_opening"] == round(1.4 * pk.REFERENCE_OPENINGS["aa"], 3)
    assert pk.POSE_LIMITS["aa"]["min_opening"] == round(0.6 * pk.REFERENCE_OPENINGS["aa"], 3)


# The first run on real Gemini (@1 prompts, two fictional faces), measured
# as the kit measures: each answer's lips parted this far beyond the
# portrait's, in its rest mouth widths. TH, F/V and EE came back 1.6 to 2.0
# times the Reference's, AA 2.2 to 2.5 times; all but AA passed before.
SPIKE_OPENINGS = [
    ("th", 0.362),
    ("th", 0.348),
    ("fv", 0.150),
    ("fv", 0.162),
    ("ee", 0.320),
    ("ee", 0.267),
    ("aa", 0.73),
    ("aa", 0.65),
]


# The second (@3 prompts, 2026-09-26, the demo portrait), as drawn: the
# model acted every shape about alike. EE also came back 0.96 of the
# smiling rest's width; OO and TH within their limits.
SECOND_RUN_OPENINGS = {"aa": 0.321, "ee": 0.113, "oo": 0.041, "oh": 0.413, "fv": 0.139, "th": 0.176}


@pytest.mark.parametrize("shape, opened", [s for s in SPIKE_OPENINGS if s[0] == "aa"])
def test_an_ah_the_model_overacted_is_refused_as_drawn(scene, shape, opened):
    """The AA sets the kit's size, so it is judged as drawn."""
    scene.truth[shape] = acting(scene, shape, opened / pk.REFERENCE_OPENINGS[shape])
    result = registered(scene, shape)
    assert result.checks["opening"] == pytest.approx(opened, abs=0.005)
    assert result.reason["code"] == "pose_not_reached"
    assert "1.4 times the Reference's" in result.reason["detail"]


@pytest.mark.parametrize("shape, opened", [s for s in SPIKE_OPENINGS if s[0] != "aa"])
def test_other_shapes_are_judged_at_the_kits_size_not_as_drawn(scene, shape, opened):
    """As drawn they are held only to what no speech sound reaches (twice
    the Reference's); normalize_amplitude judges them at the kit's size
    (test_the_first_real_answers_play_no_wider_than_speech)."""
    scene.truth[shape] = acting(scene, shape, opened / pk.REFERENCE_OPENINGS[shape])
    result = registered(scene, shape)
    assert result.checks["opening"] == pytest.approx(opened, abs=0.005)
    assert result.ok
    scene.truth[shape] = acting(scene, shape, 2.1)
    refused = registered(scene, shape)
    assert refused.reason["code"] == "pose_not_reached"
    assert "2.0 times the Reference's" in refused.reason["detail"]


def test_a_relaxed_ee_from_a_smiling_portrait_passes(scene):
    """A portrait that already smiles has little spread left for an "ee"."""

    def narrowed(width):
        def alter(points):
            points = points.copy()
            centre = (points[pk.MOUTH_LEFT] + points[pk.MOUTH_RIGHT]) / 2
            for corner in (pk.MOUTH_LEFT, pk.MOUTH_RIGHT):
                points[corner] = centre + (points[corner] - centre) * width
            return points

        return alter

    truth_width = registered(scene, "ee").checks["width"]
    relaxed = registered(scene, "ee", alter=narrowed(0.96 / truth_width))
    assert relaxed.checks["width"] == pytest.approx(0.96, abs=0.005)
    assert relaxed.ok
    rounded = registered(scene, "ee", alter=narrowed(0.92 / truth_width))
    assert rounded.reason["code"] == "pose_not_reached"
    assert "narrower than 0.94" in rounded.reason["detail"]


@pytest.mark.parametrize("factor", [1.25, 0.65])
def test_an_answer_within_its_sounds_range_passes(scene, factor):
    scene.truth["aa"] = acting(scene, "aa", factor)
    assert registered(scene, "aa").ok


def test_an_ah_too_small_to_scale_the_kit_by_is_refused(scene):
    """An AA opening 0.13 mouth widths (the Reference's is 0.29) would scale
    every other shape up 2.2 times (normalize_amplitude)."""
    scene.truth["aa"] = acting(scene, "aa", 0.13 / pk.REFERENCE_OPENINGS["aa"])
    result = registered(scene, "aa")
    assert result.reason["code"] == "pose_not_reached"
    assert result.checks["opening"] == pytest.approx(0.13, abs=0.005)


def test_lips_parted_at_rest_are_not_read_as_the_shapes_opening(reference):
    """A portrait kept with its lips parted: the answer's lips are the
    rest's gap further apart already. Only what the shape adds counts."""
    scene = Scene(reference)
    parted = parted_rest(scene.base_points, 0.08)
    scene.truth = {
        shape: parted + (points - scene.base_points) for shape, points in scene.truth.items()
    }
    scene.base_points = parted
    result = registered(scene, "ee")
    assert result.ok, result.reason
    assert result.checks["opening"] == pytest.approx(pk.REFERENCE_OPENINGS["ee"], abs=0.005)
    assert result.checks["gap"] == pytest.approx(pk.REFERENCE_OPENINGS["ee"] + 0.08, abs=0.01)


def parted_rest(points: np.ndarray, gap: float) -> np.ndarray:
    """`points` with the lower lip (its corners excepted) and everything
    below it dropped `gap` mouth widths: the lips parted at rest. (At the
    Reference's rest its inner lips cross: 13 sits a hair below 14.)"""
    parted = points.copy()
    width = float(np.linalg.norm(points[291] - points[61]))
    lower = set(pk.INNER_LIP_RING[1:10]) | set(pk.OUTER_LIP_RING[1:10])
    lower |= {i for i in range(478) if points[i][1] > points[17][1]}
    parted[sorted(lower), 1] += gap * width
    return parted


def test_a_teeth_answer_is_held_only_to_showing_the_teeth(scene):
    """The teeth photo is not a shape of speech: however far it opens, it
    is not played. Its lips must show the teeth, which a closed mouth does
    not."""
    wide = registered(scene, pk.TEETH, alter=None)
    assert wide.ok, wide.reason
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, pk.TEETH)

    def closed(points):
        return scene.answer_points(scene.base_points, request.box, (1024, 1024))

    shut = registered(scene, pk.TEETH, alter=closed)
    assert shut.reason["code"] == "pose_not_reached"
    assert "show the teeth" in shut.reason["detail"]


def test_no_face_a_broken_image_and_a_mirror_are_refused(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "aa")
    frame = pk.ManifestFrame.from_base(scene.base_points, BASE_SIZE, scene.reference)
    base = load_base_image(scene.base_png)
    unknown = png(Image.new("RGB", (1024, 1024), (1, 2, 3)))
    result = pk.register_answer(unknown, request, base, scene.base_points, frame, scene.detect)
    assert result.reason["code"] == "no_face_in_result"
    broken = pk.register_answer(
        b"not an image", request, base, scene.base_points, frame, scene.detect
    )
    assert broken.reason["code"] == "unreadable_result"

    def mirror(points):
        points = points.copy()
        points[:, 0] = 1024 - points[:, 0]
        return points

    assert registered(scene, "aa", alter=mirror).reason["code"] == "mirrored"


# --- 5. Retarget fallback ---------------------------------------------------------------------------


@pytest.mark.parametrize("shape", pk.SHAPES)
def test_retargeting_the_reference_onto_itself_is_the_reference(reference, shape):
    base = reference.rest * REFERENCE_SIZE
    moved = pk.retarget_reference_pose(shape, base, reference)
    assert np.allclose(moved, reference.poses[shape] * REFERENCE_SIZE, atol=1e-6)


def test_retargeting_follows_the_face_through_any_similarity(reference):
    """A smaller, tilted, shifted copy of the Reference gets the Reference's
    pose, smaller, tilted and shifted the same way."""
    angle = math.radians(7)
    matrix = 0.6 * np.array(
        [[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]
    )

    def place(points):
        return points * REFERENCE_SIZE @ matrix.T + [40, 90]

    moved = pk.retarget_reference_pose("oh", place(reference.rest), reference)
    assert np.allclose(moved, place(reference.poses["oh"]), atol=1e-6)


def test_thicker_lips_move_as_far_as_the_references(reference):
    """How far a jaw drops is not set by how full the lips are: the lower
    lip 30% taller than the Reference's, every point still moves as the
    Reference's does (the mouth is as wide). Scaled by the lip heights, the
    chin used to drop 1.3 times as far as the bundled motion drops it."""
    base = reference.rest * REFERENCE_SIZE
    thick = base.copy()
    lower_height = float(np.linalg.norm(base[14] - base[17]))
    below = base[:, 1] > base[17, 1] - 1e-9
    thick[below, 1] += 0.3 * lower_height
    reference_move = reference.poses["aa"] * REFERENCE_SIZE - base
    move = pk.retarget_reference_pose("aa", thick, reference) - thick
    assert np.allclose(move, reference_move, atol=1e-6)


def test_a_wider_mouth_moves_its_corners_further(reference):
    base = reference.rest * REFERENCE_SIZE
    wide = base.copy()
    centre = (base[61] + base[291]) / 2
    wide[:, 0] = centre[0] + (base[:, 0] - centre[0]) * 1.2
    reference_move = reference.poses["oo"] * REFERENCE_SIZE - base
    move = pk.retarget_reference_pose("oo", wide, reference) - wide
    # (The Reference leans 0.3 degrees, so an image-horizontal stretch is
    # not quite a stretch along its mouth.)
    assert move[291, 0] == pytest.approx(reference_move[291, 0] * 1.2, rel=5e-3)


@pytest.mark.parametrize("shape", ["oh", "th", "aa"])
def test_on_another_face_a_retargeted_pose_plays_as_the_bundled_motion(reference, shape):
    """The engine plays the bundled motion on any face by its mouth width
    alone (ContinuousMouth: movement x neutral width / the template's). A
    kit's retargeted pose, on a face whose lips are 1.24 times the
    Reference's height for their width (the finish tests' face), opens as
    far: its displacement over its manifest's mouth width is the
    Reference's over the bundled one's. By the lips' heights, OH and TH
    opened 23% further than the bundled motion on the same face."""
    angle = math.radians(4)
    turn = 0.8 * np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    face = reference.rest * REFERENCE_SIZE @ turn.T + [60, 30]
    centre = (face[pk.MOUTH_LEFT] + face[pk.MOUTH_RIGHT]) / 2
    lips = pk.OUTER_LIP_RING + pk.INNER_LIP_RING
    face[lips] = centre + (face[lips] - centre) * [1.0, 1.24]
    poses = {
        s: pk.PoseEntry(pk.retarget_reference_pose(s, face, reference), pk.RETARGETED)
        for s in pk.SHAPES
    }
    manifest = pk.build_manifest(
        face, (1300, 1300), poses, reference, kit_id="other", jaw_range=0.85
    )
    bundled = json.loads((REPO / "embed/assets/mouth-motion.json").read_text())

    def gap(m: dict) -> float:
        points = {p["id"]: np.asarray(p["points"]) for p in m["poses"]}
        moved = points[shape][13] - points[shape][14]
        rest = points["rest"][13] - points["rest"][14]
        return (float(np.linalg.norm(moved)) - float(np.linalg.norm(rest))) / m["mouth_width"]

    assert gap(manifest) == pytest.approx(gap(bundled), rel=0.01)


# --- 6. Profile fit ------------------------------------------------------------------------------------


def reference_ee(reference_manifest) -> tuple[Image.Image, np.ndarray]:
    """The Reference's EE photo and its detected landmarks, in its pixels."""
    source = next(p for p in reference_manifest["poses"] if p["id"] == "ee")["source"]
    return (
        Image.open(REFERENCE_DIR / "performance-ee.webp").convert("RGB"),
        np.asarray(source) * REFERENCE_SIZE,
    )


def reference_teeth_photo() -> tuple[Image.Image, np.ndarray, np.ndarray]:
    """The photo the Reference renders its teeth from (oral-detail-v3), its
    landmarks, and the portrait's rig points it is registered onto."""
    rig = json.loads((REFERENCE_DIR / "oral-detail-v3.rig.json").read_text())
    portrait = json.loads((REFERENCE_DIR / "rig.json").read_text())
    return (
        Image.open(REFERENCE_DIR / "oral-detail-v3.webp").convert("RGB"),
        np.asarray(rig["points"], dtype=np.float64),
        np.asarray(portrait["points"], dtype=np.float64),
    )


def reference_fit(reference, reference_manifest, *, with_teeth=True):
    """The fit with the Reference's own EE photo as the teeth photo."""
    teeth = None
    if with_teeth:
        image, points = reference_ee(reference_manifest)
        teeth = pk.TeethPhoto(image, points, reference.poses["ee"] * REFERENCE_SIZE)
    return pk.fit_profile(reference.rest * REFERENCE_SIZE, teeth)


def test_the_fit_measures_the_references_teeth_photo_where_the_reference_draws_it():
    """The Reference renders oral-detail-v3 with teethY tuned by hand to
    0.016 (frontend/src/features/lab/reference-avatar.ts). Registered onto
    the portrait, that photo's arch ends 0.0467 rest mouth widths below the
    neutral seam, skull-fixed: its broad smile lifts the upper lip 0.117,
    and the arch ends 0.1445 of its (1.13 times wider) mouth below it. The
    as-drawn measure gives the hand value back, and not the 0.06 limit a
    lip-relative measure (0.1388 x 1.13 - 0.055 = 0.102) would clamp to;
    the profile draws it at the Reference's seat and size either way."""
    image, points, portrait = reference_teeth_photo()
    registered = pk.register(points, portrait)
    assert pk.registration_rms(registered, portrait) / REFERENCE_SIZE < 0.001
    fit = pk.fit_profile(portrait, pk.TeethPhoto(image, points, registered))
    assert fit.teeth_photo
    assert fit.measurements["teeth_photo"]["accepted"]
    assert fit.measurements["teeth_edge_below_seam"] == pytest.approx(0.0467, abs=0.001)
    assert fit.measurements["teeth_y_as_drawn"] == pytest.approx(0.016, abs=0.001)
    # Its smile is 13% wider than the neutral mouth: at their true size its
    # teeth would be drawn 13% larger; the Reference draws them at 1.00.
    assert fit.measurements["teeth_scale_as_drawn"] == pytest.approx(1.13, abs=0.01)
    assert fit.profile["teethY"] == pk.REFERENCE_TEETH_Y == 0.016
    assert fit.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE == 1.0
    # The jaw range is not the teeth's to fit: the default, the owner's.
    assert fit.profile["jawRange"] == 0.85
    assert fit.reasons == []


def test_the_references_own_ee_shows_too_little_crown_to_be_a_teeth_photo(
    reference, reference_manifest
):
    """Its EE shows the upper teeth 0.07 mouth widths deep: tips, which the
    embed's DentalOralSurface refuses (it needs 0.10 of central crown). So
    the standard teeth are drawn, seated as the Reference's, with the
    reason."""
    fit = reference_fit(reference, reference_manifest)
    assert not fit.teeth_photo
    assert fit.measurements["teeth_photo"]["crown_coverage"] == pytest.approx(0.070, abs=0.003)
    assert fit.profile["teethY"] == pk.REFERENCE_TEETH_Y
    assert fit.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE
    assert [(r["field"], r["code"]) for r in fit.reasons] == [("teethY", "teeth_photo_refused")]


def test_a_teeth_answer_like_the_references_ee_is_not_handed_on(reference, reference_manifest):
    """The teeth request answered with a photo like the Reference's own EE
    (tips only): the embed would refuse it, so it is not handed on, and why
    is said; the EE shape itself is another request, and stays."""
    image, points = reference_ee(reference_manifest)
    ee = reference.poses["ee"] * REFERENCE_SIZE
    teeth = pk.PoseRegistration(
        pk.TEETH,
        targets=ee,
        rms=0.0008,
        answer_points=points,
        answer_size=image.size,
        answer_image=image,
    )
    speech = pk.PoseRegistration(
        "ee",
        targets=ee,
        rms=0.0008,
        answer_points=points,
        answer_size=image.size,
        answer_image=image,
    )
    finished = finish(
        reference.rest * REFERENCE_SIZE,
        image.size,
        {"ee": speech, pk.TEETH: teeth},
        reference,
        "reference-ee",
    )
    assert finished.teeth is None
    assert finished.teeth_refused["code"] == "teeth_photo_refused"
    assert {r["field"]: r["code"] for r in finished.fit.reasons}["teethY"] == "teeth_photo_refused"
    assert finished.manifest["poses"][2]["provenance"] == "generated"


def test_without_a_teeth_photo_the_standard_teeth_are_seated_as_the_references(
    reference, reference_manifest
):
    """The standard teeth are the Reference's own teeth photo
    (scripts/build_standard_teeth.py): drawn where, and as large as, the
    Reference draws it, and the reason says why they are drawn."""
    fit = reference_fit(reference, reference_manifest, with_teeth=False)
    assert fit.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE == 1.0
    assert fit.profile["teethY"] == pk.REFERENCE_TEETH_Y == 0.016
    assert fit.profile == pk.for_standard_teeth(profile_defaults()[0])
    assert [r["code"] for r in fit.reasons] == ["no_teeth_photo"]
    why = {"code": "safety_refused", "detail": "declined"}
    told = pk.fit_profile(reference.rest * REFERENCE_SIZE, None, why)
    assert told.reasons == [{"field": "teethY", **why}]


@pytest.mark.parametrize("wider", [1.1, 1.5])
def test_the_standard_teeth_are_the_references_size_on_any_mouth(reference, wider):
    """The drawn teeth were sized by the Reference's mouth-to-face
    proportion over this face's (a mouth half again as wide for its face
    got them smaller than the profile allows, clamped). The standard teeth
    are a photo, which the embed draws in mouth widths as the Reference's
    is: the same size, and nothing to clamp."""
    base = reference.rest * REFERENCE_SIZE
    wide = base.copy()
    centre = (base[61] + base[291]) / 2
    lips = pk.OUTER_LIP_RING + pk.INNER_LIP_RING
    wide[lips, 0] = centre[0] + (base[lips, 0] - centre[0]) * wider
    fit = pk.fit_profile(wide, None)
    assert fit.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE
    assert fit.profile["teethY"] == pk.REFERENCE_TEETH_Y
    assert [r["field"] for r in fit.reasons] == ["teethY"]


def test_the_fit_measures_the_teeth_in_the_photo(scene):
    """Synthetic EE with the teeth painted down to 0.12 mouth widths below
    the inner upper lip: the arch the embed would extract ends there, and
    the registered EE puts it where the skull does: 0.12 of the EE's 1.05
    times wider mouth below its lip, which the EE lifts 0.048 above the
    neutral seam."""
    photo = paint_teeth(Image.new("RGB", (800, 800), SKIN), scene.truth["ee"], 0.12)
    fit = pk.fit_profile(
        scene.base_points, pk.TeethPhoto(photo, scene.truth["ee"], scene.truth["ee"])
    )
    assert fit.measurements["teeth_photo"]["upper_edge"] == pytest.approx(0.12, abs=0.004)
    assert fit.measurements["teeth_edge_below_seam"] == pytest.approx(
        0.12 * 1.0502 - 0.0476, abs=0.004
    )
    assert fit.measurements["teeth_y_as_drawn"] == pytest.approx(
        fit.measurements["teeth_edge_below_seam"] + pk.REFERENCE_TEETH_DROP - pk.UPPER_SEAT,
        abs=1e-4,
    )
    assert fit.profile["teethY"] == pk.REFERENCE_TEETH_Y


def test_an_ee_photo_without_teeth_leaves_the_standard_teeth_with_the_reason(scene):
    closed = Image.new("RGB", (800, 800), SKIN)
    ImageDraw.Draw(closed).polygon(
        [tuple(p) for p in scene.truth["ee"][pk.INNER_LIP_RING]], fill=(46, 22, 24)
    )
    fit = pk.fit_profile(
        scene.base_points, pk.TeethPhoto(closed, scene.truth["ee"], scene.truth["ee"])
    )
    assert fit.profile["teethY"] == pk.REFERENCE_TEETH_Y
    codes = {r["field"]: r["code"] for r in fit.reasons}
    assert codes == {"teethY": "no_teeth_visible"}


def test_an_ai_teeth_photo_is_drawn_at_the_references_seat_however_it_was_drawn(scene):
    """A teeth photo whose mouth, registered, is 1.4 times as wide as the
    rest's (the second real run's smile was 1.22) would draw its teeth past
    the profile's limits at their true size: it is drawn as the Reference's
    is, and where it would go is only measured."""
    ee = scene.truth["ee"]
    photo = paint_teeth(Image.new("RGB", (800, 800), SKIN), ee, 0.12)
    centre = (ee[pk.MOUTH_LEFT] + ee[pk.MOUTH_RIGHT]) / 2
    wide = ee.copy()
    wide[:, 0] = centre[0] + (ee[:, 0] - centre[0]) * 1.4
    fit = pk.fit_profile(scene.base_points, pk.TeethPhoto(photo, ee, wide))
    assert fit.teeth_photo
    assert fit.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE
    assert fit.profile["teethY"] == pk.REFERENCE_TEETH_Y
    assert fit.measurements["teeth_scale_as_drawn"] == pytest.approx(1.4 * 1.05, abs=0.02)
    assert not [r for r in fit.reasons if r["field"] in ("teethY", "teethScale")]


# --- 4. Manifest -----------------------------------------------------------------------------------------


def manifest_for(scene: Scene, generated=("aa", "ee", "oo")) -> dict:
    poses = {}
    for shape in pk.SHAPES:
        if shape in generated:
            poses[shape] = pk.PoseEntry(scene.truth[shape], pk.GENERATED, 0.0015)
        else:
            poses[shape] = pk.PoseEntry(
                pk.retarget_reference_pose(shape, scene.base_points, scene.reference), pk.RETARGETED
            )
    return pk.build_manifest(
        scene.base_points,
        BASE_SIZE,
        poses,
        scene.reference,
        kit_id="contract-fixture",
        jaw_range=0.85,
    )


def test_the_manifest_is_the_reference_format_with_its_version_2_fields(scene, reference_manifest):
    manifest = manifest_for(scene)
    assert manifest["version"] == 2
    assert manifest["character"] == "avatar-v1:contract-fixture"
    assert [p["id"] for p in manifest["poses"]] == list(pk.POSES)
    assert [p["provenance"] for p in manifest["poses"]] == [
        "base",
        "generated",
        "generated",
        "generated",
        "retargeted",
        "retargeted",
        "retargeted",
    ]
    assert manifest["poses"][4]["registration_rms"] is None
    assert manifest["poses"][1]["registration_rms"] == 0.0015
    # Nothing the engine does not read: no pose photos, and no answer
    # landmarks (half of every visitor's download, when they were kept).
    assert all(p["image"] is None and p["source"] is None for p in manifest["poses"])
    for pose in manifest["poses"]:
        assert len(pose["points"]) == 478
    assert manifest["inner_ring"] == reference_manifest["inner_ring"]
    assert manifest["outer_ring"] == reference_manifest["outer_ring"]
    assert manifest["jaw_range"] == 0.85
    assert manifest["kit"] == {
        "version": pk.KIT_VERSION,
        "prompts": pk.PROMPTS_VERSION,
        "reference": "lab-reference-v1",
    }
    # This face is the Reference at half size: in manifest units it is the
    # Reference again, levelled (the Reference leans 0.3 degrees).
    assert manifest["mouth_width"] == pytest.approx(reference_manifest["mouth_width"], rel=1e-3)
    assert manifest["center"] == pytest.approx(reference_manifest["center"], abs=1e-3)
    rest = np.asarray(manifest["poses"][0]["points"])
    assert rest[291, 1] == pytest.approx(rest[61, 1], abs=1e-5)
    triangles = np.asarray(manifest["triangles"])
    assert triangles.min() >= 0 and triangles.max() < 478 and 100 < len(triangles) < 2000


def test_the_manifest_is_small_for_what_every_visitor_downloads(scene):
    """Points to five decimals (1/15000 of a mouth width) and nothing the
    engine does not read: about half of what it was, raw and gzipped."""
    import gzip

    manifest = manifest_for(scene)
    for pose in manifest["poses"]:
        for x, y in pose["points"]:
            assert round(x, 5) == x and round(y, 5) == y
    raw = json.dumps(manifest, separators=(",", ":")).encode()
    assert len(raw) < 90_000 and len(gzip.compress(raw)) < 35_000


def test_the_frame_maps_base_pixels_to_manifest_units(scene):
    manifest = manifest_for(scene)
    frame = np.asarray(manifest["frame"]["to_manifest"])
    assert manifest["frame"]["image_size"] == list(BASE_SIZE)
    mapped = scene.truth["aa"] @ frame[:, :2].T + frame[:, 2]
    assert np.allclose(mapped, manifest["poses"][1]["points"], atol=1e-5)


def test_a_bad_kit_id_or_a_missing_shape_is_refused(scene):
    entry = pk.PoseEntry(scene.base_points, pk.RETARGETED)
    poses = dict.fromkeys(pk.SHAPES, entry)
    for bad in ("", "a/b", "x" * 65, "with space"):
        with pytest.raises(ValueError):
            pk.build_manifest(
                scene.base_points, BASE_SIZE, poses, scene.reference, kit_id=bad, jaw_range=0.85
            )
    del poses["th"]
    with pytest.raises(ValueError):
        pk.build_manifest(
            scene.base_points, BASE_SIZE, poses, scene.reference, kit_id="ok", jaw_range=0.85
        )


EMBED_FIXTURE = REPO / "embed/src/mouth/__tests__/fixtures/avatar-motion.json"


def fixture_as_built_today(path: Path) -> str:
    """An embed fixture, byte for byte, but for the pose prompts' version
    it records (`kit.prompts`): provenance the embed never reads. A new
    wording of the prompts changes nothing the embed loads, so it does not
    oblige the embed's fixtures to be rewritten; everything else must be
    what the builder writes. (LIVEFACE_WRITE_FIXTURES=1 rewrites them.)"""
    text = path.read_text()
    recorded = json.loads(text)["kit"]["prompts"]
    return text.replace(f'"prompts":"{recorded}"', f'"prompts":"{pk.PROMPTS_VERSION}"', 1)


def test_the_embed_contract_fixture_is_what_the_builder_writes(scene):
    """embed/src/mouth/__tests__ loads this file through the embed's
    validator and renders it; this keeps it equal to what the backend
    actually builds. Regenerate with LIVEFACE_WRITE_FIXTURES=1."""
    written = json.dumps(manifest_for(scene), separators=(",", ":"))
    if os.environ.get("LIVEFACE_WRITE_FIXTURES") == "1":
        EMBED_FIXTURE.write_text(written)
    assert fixture_as_built_today(EMBED_FIXTURE) == written


# --- The kit's own size ------------------------------------------------------------------------------


def displacement(manifest: dict, shape: str) -> np.ndarray:
    poses = {p["id"]: np.asarray(p["points"]) for p in manifest["poses"]}
    return (poses[shape] - poses["rest"]) / manifest["mouth_width"]


def fitted_kit(scene: Scene, amplitude: float = 1.25) -> Finished:
    """finish for a face that speaks like the Reference, but whose model
    moved every shape it made (AA, OO, F/V) `amplitude` times as far, and
    whose EE, OH and TH were not made (retargeted)."""
    registrations = {}
    for shape in ("aa", "oo", "fv"):
        targets = scene.base_points + amplitude * (scene.truth[shape] - scene.base_points)
        registrations[shape] = pk.PoseRegistration(
            shape, targets=targets, rms=0.0015, answer_points=targets, answer_size=BASE_SIZE
        )
    return finish(scene.base_points, BASE_SIZE, registrations, scene.reference, "fitted-fixture")


@pytest.mark.parametrize("amplitude", [0.75, 1.0, 1.25])
def test_the_persons_shapes_are_played_at_the_references_size(scene, amplitude):
    """How far an image model opens an "ah" is the model's choice (the
    first real answers went 1.35 to 2.5 times the Reference's): the AA sets
    the scale, and every shape the model made is moved from rest by it. So
    this face, whose model under- or over-acted every shape alike, plays
    each exactly as the Reference does, the retargeted ones included, and
    the manifest is true at the Reference's jaw range."""
    finished = fitted_kit(scene, amplitude)
    manifest = finished.manifest
    assert manifest["jaw_range"] == 0.85 == finished.fit.profile["jawRange"]
    assert finished.fit.measurements["amplitude"] == pytest.approx(1 / amplitude, abs=1e-3)
    bundled = pk.build_manifest(
        scene.base_points,
        BASE_SIZE,
        {s: pk.PoseEntry(scene.truth[s], pk.RETARGETED) for s in pk.SHAPES},
        scene.reference,
        kit_id="bundled",
        jaw_range=0.85,
    )
    for shape in pk.SHAPES:
        assert np.allclose(
            displacement(manifest, shape), displacement(bundled, shape), atol=2e-4
        ), shape
    assert finished.refused == {}


def test_a_shape_too_open_for_the_kits_own_ah_is_refused(scene):
    """TH opened 1.25 times the Reference's, within its own limit; but the
    AA opened only 0.8 times, so at the kit's size (x 1.25) the TH opens
    0.31 mouth widths, more than an "ah" does: every t, d, n and k would
    open like one. Refused, and retargeted."""
    registrations = {}
    for shape, factor in (("aa", 0.8), ("th", 1.25), ("oo", 0.8)):
        targets = acting(scene, shape, factor)
        registrations[shape] = pk.PoseRegistration(
            shape, targets=targets, rms=0.0015, answer_points=targets, answer_size=BASE_SIZE
        )
    finished = finish(scene.base_points, BASE_SIZE, registrations, scene.reference, "t")
    assert finished.refused["th"]["code"] == "pose_not_reached"
    assert "at the kit's size" in finished.refused["th"]["detail"]
    provenance = {p["id"]: p["provenance"] for p in finished.manifest["poses"]}
    assert provenance["th"] == "retargeted" and provenance["oo"] == "generated"


def test_lips_parted_at_rest_do_not_inflate_the_kits_size(reference):
    """A portrait with its lips parted 0.04 or 0.08 mouth widths, and an AA
    that moves exactly as the Reference's does: the AA's opening counts
    from the rest's, so nothing is scaled (measured from closed lips, the
    jaw range came out 0.969 and 1.086, and every retargeted shape was
    baked 1.14 and 1.28 times too large)."""
    for gap in (0.04, 0.08):
        scene = Scene(reference)
        rest = parted_rest(scene.base_points, gap)
        aa = rest + (scene.truth["aa"] - scene.base_points)
        registration = pk.PoseRegistration(
            "aa", targets=aa, rms=0.001, answer_points=aa, answer_size=BASE_SIZE
        )
        finished = finish(rest, BASE_SIZE, {"aa": registration}, reference, "parted")
        assert finished.fit.measurements["amplitude"] == pytest.approx(1.0, abs=2e-3), gap
        assert finished.manifest["jaw_range"] == 0.85


async def test_the_first_real_answers_play_no_wider_than_speech(scene):
    """The first run on real Gemini, replayed: TH, F/V, EE and AA opened
    1.6 to 2.5 times the Reference's (SPIKE_OPENINGS, one face's), OO and
    OH were faithful. Every over-open answer is refused and retargeted, so
    no shape plays wider than 1.4 times the Reference's own, and t, d, n
    and k (the TH shape) open as the Reference's do, not as "ah"."""
    for shape, opened in SPIKE_OPENINGS[::2]:
        scene.truth[shape] = acting(scene, shape, opened / pk.REFERENCE_OPENINGS[shape])
    result = await kit(scene, FakeProvider(scene))
    assert {s for s, r in result.report.items() if r["status"] == "ok"} == {"oo", "oh"}
    reference = pk.reference_openings(scene.reference)
    targets = manifest_targets(result)
    for shape in pk.SHAPES:
        played = pk.opening(targets[shape], targets["rest"])
        assert played <= pk.MAX_OVER_REFERENCE * reference[shape] + 1e-3, shape
    assert pk.opening(targets["th"], targets["rest"]) == pytest.approx(reference["th"], abs=2e-3)


async def test_the_second_real_run_is_the_persons_own_but_its_pout(scene):
    """The second run (@3 prompts), replayed: the model acted every shape
    about a tenth too far. Judged at the kit's size, five are the person's
    own; its OO, a pout that reads as "mm", is the Reference's. The AA
    plays exactly at the Reference's opening and nothing wider than
    MAX_OVER_REFERENCE times the Reference's."""
    for shape, opened in SECOND_RUN_OPENINGS.items():
        scene.truth[shape] = acting(scene, shape, opened / pk.REFERENCE_OPENINGS[shape])
    result = await kit(scene, FakeProvider(scene))
    assert {s for s, r in result.report.items() if r["status"] == "ok"} == set(pk.SHAPES) - {"oo"}
    assert "less than 0.06" in result.report["oo"]["reason"]["detail"]
    reference = pk.reference_openings(scene.reference)
    targets = manifest_targets(result)
    assert pk.opening(targets["aa"], targets["rest"]) == pytest.approx(reference["aa"], abs=2e-3)
    for shape in pk.SHAPES:
        played = pk.opening(targets[shape], targets["rest"])
        assert played <= pk.MAX_OVER_REFERENCE * reference[shape] + 1e-3, shape


EMBED_FITTED_FIXTURE = REPO / "embed/src/mouth/__tests__/fixtures/avatar-motion-fitted.json"


def test_the_embed_fitted_fixture_is_what_the_kit_writes(scene):
    """embed/src/mouth/__tests__/avatar-motion.test.ts plays this manifest
    (a model that over-acted AA, OO and F/V by a quarter, and EE, OH and TH
    retargeted) through the real ContinuousMouth next to the bundled
    motion. Regenerate with LIVEFACE_WRITE_FIXTURES=1."""
    manifest = fitted_kit(scene).manifest
    written = json.dumps(manifest, separators=(",", ":"))
    if os.environ.get("LIVEFACE_WRITE_FIXTURES") == "1":
        EMBED_FITTED_FIXTURE.write_text(written)
    assert fixture_as_built_today(EMBED_FITTED_FIXTURE) == written


# --- 7. build_kit --------------------------------------------------------------------------------------


async def test_a_kit_from_faithful_answers(scene):
    progress: list[tuple[float, str, int, int]] = []
    provider = FakeProvider(scene, delay=0.01)
    result = await kit(
        scene, provider, on_progress=lambda f, m, n, total: progress.append((f, m, n, total))
    )

    # Six shapes and the teeth photo, each asked for once.
    assert result.calls == 7 and result.billed_calls == 7
    assert sorted(shape for shape, _ in provider.requests) == sorted(pk.SHAPES + (pk.TEETH,))
    assert all(r["status"] == "ok" and r["outcome"] == "generated" for r in result.report.values())
    assert [p["provenance"] for p in result.manifest["poses"][1:]] == ["generated"] * 6
    assert result.manifest["character"] == "avatar-v1:test-kit"
    assert all(entry["model"] == "fake-image-model" for entry in result.call_log)
    # The teeth: drawn at the Reference's seat; as drawn, the painted edge
    # 0.12 photo widths below the photo's lip, its mouth 1.05 rest widths
    # wide, its lip lifted 0.048 above the neutral seam, plus the
    # Reference's allowance, less the 0.055 seat.
    assert result.profile_fit["teeth_photo"] is True
    assert result.teeth_report["status"] == "ok"
    assert result.profile["teethY"] == pk.REFERENCE_TEETH_Y
    assert result.profile_fit["measurements"]["teeth_y_as_drawn"] == pytest.approx(
        0.12 * 1.0502 - 0.0476 + pk.REFERENCE_TEETH_DROP - pk.UPPER_SEAT, abs=0.004
    )
    assert result.base_detected is False  # the Scene's detector knows only answers
    # Played at the Reference's size: its own AA is the Reference's.
    assert result.profile["jawRange"] == result.manifest["jaw_range"] == 0.85
    assert result.profile_fit["measurements"]["amplitude"] == pytest.approx(1.0, abs=1e-3)
    # The teeth answer is handed on as the teeth photo, with its own rig.
    teeth = result.teeth_source
    assert teeth is not None
    with Image.open(io.BytesIO(teeth.png)) as photo:
        assert list(photo.size) == teeth.rig["image_size"] == [1024, 1024]
    assert len(teeth.rig["points"]) == 478 and teeth.rig["inner_lip_ring"] == pk.INNER_LIP_RING
    # Progress only moves forward and ends at 1, counting the requests
    # settled out of the seven.
    fractions = [f for f, _, _, _ in progress]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    assert [n for _, _, n, _ in progress] == [0, 1, 2, 3, 4, 5, 6, 7, 7]
    assert {total for _, _, _, total in progress} == {7}


async def test_a_kit_for_teeth_it_keeps_asks_for_the_shapes_only(scene):
    """The owner's own teeth photo is kept: the teeth are not asked for."""
    provider = FakeProvider(scene)
    result = await kit(scene, provider, teeth=False)
    assert pk.TEETH not in [shape for shape, _ in provider.requests]
    assert result.calls == 6 and result.teeth_report is None and result.teeth_source is None


def corrected(reference, correct) -> tuple[Scene, np.ndarray]:
    """A Scene whose detector sees the Reference's face on the base photo,
    and whose confirmed points are that view with the owner's correction.
    The answers carry the detector's view of each shape, as a real
    detector's would. Returns the scene and the detector's base view."""
    scene = Scene(reference)
    detected = scene.base_points.copy()
    scene.remember(load_base_image(scene.base_png), detected)
    scene.base_points = correct(detected.copy())
    return scene, detected


def manifest_targets(result) -> dict[str, np.ndarray]:
    """Each pose of a kit's manifest, back in base pixels."""
    frame = np.asarray(result.manifest["frame"]["to_manifest"])
    back = np.linalg.inv(frame[:, :2])
    return {
        pose["id"]: (np.asarray(pose["points"]) - frame[:, 2]) @ back.T
        for pose in result.manifest["poses"]
    }


LEFT_EYE = pk.EYE_GUARD[:16]


async def test_the_owners_corrected_eye_marks_are_not_read_as_a_tilted_head(reference):
    """The owner moved one eye's marks 0.03 face widths. Two of the eight
    registration anchors are that eye's corners: registered onto the
    confirmed points, every answer would turn 2.9 degrees and slide its
    lips sideways. Registered onto the detector's own view of the base
    photo, nothing turns, and each shape's movement lands on the confirmed
    points."""

    def move_eye(points):
        face = float(np.linalg.norm(points[pk.FACE_RIGHT] - points[pk.FACE_LEFT]))
        points[LEFT_EYE] += [0.03 * face, 0.0]
        return points

    scene, detected = corrected(reference, move_eye)
    result = await kit(scene, FakeProvider(scene))
    assert result.base_detected is True
    assert all(r["status"] == "ok" for r in result.report.values())
    assert all(abs(r["checks"]["rotation"]) < 0.01 for r in result.report.values())
    targets = manifest_targets(result)
    assert np.allclose(targets["rest"], scene.base_points, atol=0.02)
    for shape in pk.SHAPES:
        # The confirmed points, moved exactly as the answer moved the face.
        expected = scene.base_points + (scene.truth[shape] - detected)
        assert np.allclose(targets[shape], expected, atol=0.02), shape
    # The lips move as photographed: no sideways slide.
    mouth = pk.OUTER_LIP_RING + pk.INNER_LIP_RING
    assert np.allclose(targets["aa"][mouth], scene.truth["aa"][mouth], atol=0.02)


async def test_the_owners_widened_mouth_marks_keep_every_shape(reference):
    """The owner widened the detected mouth by 8%. Measured against the
    confirmed points, every answer's corners would pull back and EE would
    be refused as too narrow; measured detector against detector, EE is
    as wide as asked and every corner moves from where the owner put it."""

    def widen(points):
        lips = pk.OUTER_LIP_RING + pk.INNER_LIP_RING
        centre = (points[pk.MOUTH_LEFT] + points[pk.MOUTH_RIGHT]) / 2
        points[lips, 0] = centre[0] + (points[lips, 0] - centre[0]) * 1.08
        return points

    scene, detected = corrected(reference, widen)
    result = await kit(scene, FakeProvider(scene))
    assert result.report["ee"]["status"] == "ok"
    assert result.report["ee"]["checks"]["width"] == pytest.approx(1.05, abs=0.01)
    targets = manifest_targets(result)
    # The wider marks make the same opening a smaller part of the mouth:
    # the kit's size follows, as the bundled motion's does (by the width).
    scale = result.profile_fit["measurements"]["amplitude"]
    assert scale == pytest.approx(1.08, abs=0.01)
    for shape in pk.SHAPES:
        expected = scene.base_points + scale * (scene.truth[shape] - detected)
        assert np.allclose(targets[shape], expected, atol=0.05), shape


async def test_a_base_detection_equal_to_the_confirmed_points_changes_nothing(reference):
    plain = Scene(reference)
    without = await kit(plain, FakeProvider(plain))
    scene, _ = corrected(reference, lambda points: points)
    with_detection = await kit(scene, FakeProvider(scene))
    assert with_detection.base_detected and not without.base_detected
    for a, b in zip(without.manifest["poses"], with_detection.manifest["poses"]):
        assert np.allclose(a["points"], b["points"], atol=1e-5)
    assert without.profile == with_detection.profile


async def test_a_base_detection_of_another_face_is_not_used(reference):
    """Far from every confirmed point (a detection that failed, or someone
    else in the photo): the confirmed points stand in for it."""
    scene, _ = corrected(reference, lambda points: points)
    face = float(np.linalg.norm(scene.base_points[pk.FACE_RIGHT] - scene.base_points[pk.FACE_LEFT]))
    scene.remember(load_base_image(scene.base_png), scene.base_points + [0.3 * face, 0.0])
    result = await kit(scene, FakeProvider(scene))
    assert result.base_detected is False
    assert all(r["status"] == "ok" for r in result.report.values())


async def test_no_more_than_concurrency_edits_are_in_flight(scene):
    provider = FakeProvider(scene, delay=0.05)
    await kit(scene, provider, concurrency=2)
    assert provider.most_in_flight == 2


async def test_a_refusal_is_asked_once_more_on_the_head_crop_and_never_again(scene):
    refused = imagegen.ImageGenRefused("SAFETY")
    provider = FakeProvider(scene, {"aa": [refused], "oo": [refused, refused]})
    result = await kit(scene, provider)

    # AA: refused on the face crop, made on the head crop.
    assert result.report["aa"]["status"] == "ok"
    assert result.report["aa"]["attempts"] == [pk.FACE_CROP, pk.HEAD_CROP]
    # OO: refused on both, then retargeted; not asked a third time.
    assert result.report["oo"]["status"] == "retargeted"
    assert result.report["oo"]["reason"]["code"] == "safety_refused"
    assert [s for s, _ in provider.requests].count("oo") == 2
    assert result.manifest["poses"][3]["provenance"] == "retargeted"
    # Every request was different; every one was answered, so billed.
    assert len({digest for _, digest in provider.requests}) == len(provider.requests)
    assert result.calls == result.billed_calls == 9


async def test_a_refusal_is_not_retried_when_the_head_crop_is_the_whole_photo(reference):
    scene = Scene(reference)
    # The face fills the photo: no smaller picture to ask with.
    scene.base_points = reference.rest * 300 - np.array([20.0, 70.0])
    scene.truth = {s: reference.poses[s] * 300 - np.array([20.0, 70.0]) for s in pk.SHAPES}
    scene.base_image = Image.new("RGB", (220, 260), SKIN)
    scene.base_png = png(scene.base_image)
    provider = FakeProvider(
        scene, {s: imagegen.ImageGenRefused("SAFETY") for s in pk.SHAPES + (pk.TEETH,)}
    )
    result = await kit(scene, provider)
    assert result.calls == 7
    assert all(r["attempts"] == [pk.FACE_CROP] for r in result.report.values())
    assert result.teeth_report["attempts"] == [pk.FACE_CROP]


@pytest.mark.parametrize(
    "error, outcome, billed",
    [
        (imagegen.ImageGenNoImage("NO_IMAGE"), "no_image", 6 + 1),
        (RuntimeError("image generation failed (500)"), "provider_error", 6),
    ],
)
async def test_a_failed_shape_is_retargeted_and_not_asked_again(scene, error, outcome, billed):
    provider = FakeProvider(scene, {"th": [error, error]})
    result = await kit(scene, provider)
    assert result.report["th"] == {
        **result.report["th"],
        "status": "retargeted",
        "outcome": outcome,
    }
    assert [s for s, _ in provider.requests].count("th") == 1
    assert result.calls == 7 and result.billed_calls == billed
    assert result.manifest["poses"][6]["provenance"] == "retargeted"


async def test_a_slow_answer_times_out_without_holding_the_others(scene):
    provider = FakeProvider(scene, {"fv": "slow"})
    result = await kit(scene, provider, per_call_timeout=0.3)
    assert result.report["fv"]["outcome"] == "timeout"
    assert result.report["fv"]["status"] == "retargeted"
    assert [s for s, _ in provider.requests].count("fv") == 1
    timed_out = next(entry for entry in result.call_log if entry["shape"] == "fv")
    assert timed_out["billed"] is None  # sent; whether it is billed is unknown
    assert sum(r["status"] == "ok" for r in result.report.values()) == 5


async def test_no_provider_gives_the_reference_retargeted_for_this_face(scene):
    provider = FakeProvider(scene, {s: imagegen.ImageGenUnavailable("no key") for s in pk.SHAPES})
    result = await kit(scene, provider)
    assert result.calls == 0 and result.billed_calls == 0 and result.call_log == []
    assert all(r["reason"]["code"] == "imagegen_unavailable" for r in result.report.values())
    assert [p["provenance"] for p in result.manifest["poses"][1:]] == ["retargeted"] * 6
    assert result.teeth_source is None
    assert result.profile["teethY"] == pk.REFERENCE_TEETH_Y and result.profile["jawRange"] == 0.85
    # This face is the Reference: retargeted, the poses are the Reference's.
    frame = np.asarray(result.manifest["frame"]["to_manifest"])
    expected = scene.truth["aa"] @ frame[:, :2].T + frame[:, 2]
    assert np.allclose(result.manifest["poses"][1]["points"], expected, atol=1e-5)


async def test_a_rejected_answer_is_retargeted_with_its_reason(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "aa")
    closed = scene.answer_points(scene.base_points, request.box, (1024, 1024))
    provider = FakeProvider(scene, {"aa": lambda points: closed})
    result = await kit(scene, provider)
    assert result.report["aa"]["status"] == "retargeted"
    assert result.report["aa"]["outcome"] == "rejected"
    assert result.report["aa"]["reason"]["code"] == "pose_not_reached"
    assert result.billed_calls == 7  # it was answered, so it was billed
    # No AA of the person's to scale by: the other shapes stay as made.
    reasons = {r["field"]: r["code"] for r in result.profile_fit["reasons"]}
    assert reasons["amplitude"] == "aa_not_generated"
    assert result.profile_fit["measurements"]["amplitude"] == 1.0


async def test_a_rejected_teeth_answer_leaves_no_teeth_photo(scene):
    provider = FakeProvider(scene, {pk.TEETH: lambda points: rotate(points, 8)})
    result = await kit(scene, provider)
    assert result.teeth_report["status"] == "failed"
    assert result.teeth_report["reason"]["code"] == "head_moved"
    assert result.teeth_source is None
    assert result.profile["teethY"] == pk.REFERENCE_TEETH_Y
    assert all(r["status"] == "ok" for r in result.report.values()), "the shapes are apart"


async def test_a_teeth_answer_without_visible_teeth_is_not_handed_on(scene):
    result = await kit(scene, FakeProvider(scene, teeth_edge=None))
    assert result.report["ee"]["status"] == "ok"
    assert result.teeth_source is None
    assert result.teeth_report["reason"]["code"] == "no_teeth_visible"
    reasons = {r["field"]: r["code"] for r in result.profile_fit["reasons"]}
    assert reasons["teethY"] == "no_teeth_visible"
    # The standard teeth, at the Reference's seat and size.
    assert result.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE


async def test_a_teeth_answer_showing_only_tips_is_not_handed_on(scene):
    """The Reference's own EE shows its teeth 0.07 deep. The embed would
    refuse such a photo and drop the avatar to the classic mouth, so it is
    not handed on, and the standard teeth are drawn instead."""
    result = await kit(scene, FakeProvider(scene, teeth_edge=0.07))
    assert result.teeth_source is None
    assert result.teeth_report == {**result.teeth_report, "status": "failed", "outcome": "rejected"}
    assert result.teeth_report["reason"]["code"] == "teeth_photo_refused"
    assert result.profile_fit["measurements"]["teeth_photo"]["crown_coverage"] < 0.10
    assert result.profile["teethY"] == pk.REFERENCE_TEETH_Y
    assert result.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE


async def test_a_teeth_answer_too_closed_to_show_them_is_rejected(scene):
    def nearly_closed(points):
        points = points.copy()
        width = float(np.linalg.norm(points[291] - points[61]))
        points[14] = points[13] + [0, 0.06 * width]
        return points

    result = await kit(scene, FakeProvider(scene, {pk.TEETH: nearly_closed}))
    assert result.teeth_source is None
    assert result.teeth_report["reason"]["code"] == "pose_not_reached"
    reasons = {r["field"]: r["code"] for r in result.profile_fit["reasons"]}
    assert reasons["teethY"] == "pose_not_reached"
    assert result.profile["teethScale"] == pk.REFERENCE_TEETH_SCALE


async def test_an_async_progress_callback_is_awaited(scene):
    seen = []

    async def progress(fraction, message, done, total):
        await asyncio.sleep(0)
        seen.append(fraction)

    await kit(scene, FakeProvider(scene), on_progress=progress)
    assert seen[-1] == 1.0 and len(seen) == 9


async def test_without_a_detector_nothing_is_sent(scene, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "rig_model_path", "")
    provider = FakeProvider(scene)
    with pytest.raises(pk.KitUnavailable) as raised:
        await pk.build_kit(scene.base_png, scene.base_points, provider, reference=scene.reference)
    assert raised.value.code == "landmarks_unavailable"
    assert provider.requests == []


async def test_malformed_base_points_are_refused_before_any_call(scene):
    provider = FakeProvider(scene)
    with pytest.raises(ValueError):
        await pk.build_kit(scene.base_png, scene.base_points[:10], provider, detect=scene.detect)
    assert provider.requests == []


async def test_a_generated_kit_uses_a_fresh_id_when_none_is_given(scene):
    first = await pk.build_kit(
        scene.base_png,
        scene.base_points,
        FakeProvider(scene),
        detect=scene.detect,
        reference=scene.reference,
    )
    assert first.manifest["character"].startswith("avatar-v1:")
    assert len(first.manifest["character"]) == len("avatar-v1:") + 32


# --- 8. What review found: the head crop's shape, the yaw's sign, checks, teardown, time, ids ---


async def test_an_answer_of_another_shape_is_refused_as_reframed(scene):
    """A model that keeps the head's proportions and reframes to an aspect
    of its own maps back with a scale per axis and could pass every guard
    with the mouth elsewhere: refused, and the shape retargeted."""

    def reframed(image, points):
        size = (896, 1024)
        scale = np.array([size[0] / image.width, size[1] / image.height])
        return image.resize(size), points * scale

    result = await kit(scene, FakeProvider(scene, {"oo": reframed}))
    assert result.report["oo"]["status"] == "retargeted"
    assert result.report["oo"]["reason"]["code"] == "aspect_changed"
    assert result.report["oo"]["checks"]["aspect"] == pytest.approx(0.875)
    assert result.billed_calls == 7, "answered, so billed"


def test_a_pixel_or_two_of_rounding_is_not_a_reframe(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "ee")
    with Image.open(io.BytesIO(request.payload)) as sent:
        answer = sent.convert("RGB").resize((1024, 1030))
    points = scene.answer_points(scene.truth["ee"], request.box, answer.size)
    scene.remember(answer, points)
    frame = pk.ManifestFrame.from_base(scene.base_points, BASE_SIZE, scene.reference)
    result = pk.register_answer(
        png(answer),
        request,
        load_base_image(scene.base_png),
        scene.base_points,
        frame,
        scene.detect,
    )
    assert result.ok, result.reason
    assert np.allclose(result.targets, scene.truth["ee"], atol=1e-6)


async def test_a_refused_face_crop_is_asked_again_on_a_square(scene):
    """The retry's picture is square too, and its answer registers."""
    refused = imagegen.ImageGenRefused("SAFETY")
    provider = FakeProvider(scene, {"aa": [refused]})
    result = await kit(scene, provider)
    assert result.report["aa"]["attempts"] == [pk.FACE_CROP, pk.HEAD_CROP]
    assert result.report["aa"]["status"] == "ok"
    assert result.report["aa"]["checks"]["aspect"] == pytest.approx(1.0)


def test_the_yaw_guard_knows_which_way_the_head_turned(scene):
    """The photo's nose sits 0.06 half-widths right of the cheeks' middle;
    the answer turned the head until it sits 0.06 to the left. Unsigned,
    both read 0.06 (photo_adjust.yaw_offset): "unchanged". Signed, they are
    0.12 apart. Only the cheek outline moved, so no other guard sees it."""
    half = abs(scene.base_points[454, 0] - scene.base_points[234, 0]) / 2
    base = scene.base_points.copy()
    base[[234, 454], 0] -= (0.06 - pk.signed_yaw(base)) * half
    scene.base_points = base
    assert pk.signed_yaw(base) == pytest.approx(0.06)

    def other_way(points):
        points = points.copy()
        answer_half = abs(points[454, 0] - points[234, 0]) / 2
        points[[234, 454], 0] += (pk.signed_yaw(points) + 0.06) * answer_half
        assert pk.signed_yaw(points) == pytest.approx(-0.06)
        assert photo_adjust.yaw_offset(points) == pytest.approx(photo_adjust.yaw_offset(base))
        return points

    result = registered(scene, "th", alter=other_way)
    assert result.reason["code"] == "head_turned"
    assert result.checks["yaw"] == pytest.approx(0.12, abs=1e-3)


async def test_a_check_that_breaks_is_a_rejected_answer_and_the_others_carry_on(scene, monkeypatch):
    real = pk.register_answer

    def breaks(answer, request, *args):
        if request.shape == "oo":
            raise RuntimeError("the detector crashed on this answer")
        return real(answer, request, *args)

    monkeypatch.setattr(pk.kit, "register_answer", breaks)
    result = await kit(scene, FakeProvider(scene))
    assert result.report["oo"]["status"] == "retargeted"
    assert result.report["oo"]["outcome"] == "rejected"
    assert result.report["oo"]["reason"]["code"] == "check_failed"
    assert sum(r["status"] == "ok" for r in result.report.values()) == 5
    assert result.calls == result.billed_calls == 7


async def test_an_unexpected_failure_cancels_the_calls_in_flight_and_accounts_for_them(scene):
    """Anything but a provider call failing (here the progress callback,
    once the first shape is in) tears the kit down: the calls still out are
    cancelled and awaited, nothing more is sent, and every call that went
    out is in the failure's log; a cancelled one may have been billed."""
    provider = FakeProvider(scene, {"ee": "slow", "oo": "slow"})

    def progress(fraction, message, done, total):
        if done == 1:
            raise RuntimeError("the job's progress store is gone")

    with pytest.raises(pk.KitFailed) as failed:
        await kit(scene, provider, on_progress=progress, concurrency=3)
    sent = len(provider.requests)
    await asyncio.sleep(0.05)
    assert len(provider.requests) == sent < 6, "nothing more was sent"
    assert provider.in_flight == 0, "the calls out were cancelled and awaited"
    assert isinstance(failed.value.__cause__, RuntimeError)
    log = failed.value.call_log
    assert failed.value.calls == len(log) == sent
    cancelled = sorted(c["shape"] for c in log if c["outcome"] == "cancelled")
    assert cancelled == ["ee", "oo"]
    assert all(c["billed"] is None for c in log if c["outcome"] == "cancelled")
    # Every other call was answered before the teardown: billed.
    assert failed.value.billed_calls == sent - len(cancelled)
    assert all(c["billed"] is True for c in log if c["outcome"] != "cancelled")


@pytest.mark.parametrize(
    "error, outcome, billed",
    [
        (httpx.ReadTimeout("no answer within imagegen's 90 s"), "timeout", None),
        (httpx.WriteTimeout("the upload stalled"), "timeout", None),
        (httpx.ConnectTimeout("never connected"), "provider_error", False),
    ],
)
async def test_the_providers_own_timeouts_are_classified_by_what_was_sent(
    scene, error, outcome, billed
):
    provider = FakeProvider(scene, {"fv": [error]})
    result = await kit(scene, provider)
    assert result.report["fv"]["outcome"] == outcome
    assert result.report["fv"]["status"] == "retargeted"
    assert next(c for c in result.call_log if c["shape"] == "fv")["billed"] is billed
    assert result.billed_calls == 6
    assert [s for s, _ in provider.requests].count("fv") == 1, "never asked again"


async def test_the_kits_bound_is_imagegens_own_timeout(scene, monkeypatch):
    monkeypatch.setattr(imagegen, "TIMEOUT_SECONDS", 0.2)
    result = await kit(scene, FakeProvider(scene, {"th": "slow"}))
    assert result.report["th"]["outcome"] == "timeout"


def test_what_was_billed_is_decided_in_one_place():
    assert pk.call_billing(None) is True
    assert pk.call_billing(imagegen.ImageGenRefused("SAFETY")) is True
    assert pk.call_billing(imagegen.ImageGenNoImage("NO_IMAGE")) is True
    assert pk.call_billing(TimeoutError()) is None
    assert pk.call_billing(httpx.ReadTimeout("slow")) is None
    assert pk.call_billing(asyncio.CancelledError()) is None
    assert pk.call_billing(httpx.ConnectTimeout("down")) is False
    assert pk.call_billing(imagegen.ImageGenUnavailable("no key")) is False
    assert pk.call_billing(RuntimeError("image generation failed (500)")) is False


async def test_a_stop_says_why_and_nothing_more_is_asked(scene):
    """The caller's edit function stops the kit (its limit, its switch):
    the shape and every one not yet asked are retargeted with its reason."""

    class LimitReached(imagegen.ImageGenUnavailable):
        code = "image_limit_reached"
        detail = "Monthly image generation limit reached (3/3)"

    provider = FakeProvider(scene, {"oh": LimitReached()})
    result = await kit(scene, provider, concurrency=1)
    assert [s for s, _ in provider.requests] == ["aa", "ee", "oo", "oh"]
    assert result.calls == result.billed_calls == 3, "the stopped call was never sent"
    for shape in ("oh", "fv", "th"):
        assert result.report[shape]["reason"] == {
            "code": "image_limit_reached",
            "detail": LimitReached.detail,
        }
    assert result.teeth_report["reason"]["code"] == "image_limit_reached"
    # Without a code of its own, it is imagegen's: no provider.
    assert pk.stop_reason(imagegen.ImageGenUnavailable("no key"))["code"] == "imagegen_unavailable"


@pytest.mark.parametrize("kit_id", ["Ärger", "キット", "١٢٣"])
def test_a_kit_id_is_ascii_as_the_embed_requires(scene, kit_id):
    """Letters and digits of other scripts pass str.isalnum; the embed's
    AVATAR_CHARACTER takes [A-Za-z0-9_-] only."""
    assert kit_id.isalnum()
    entry = pk.PoseEntry(scene.base_points, pk.RETARGETED)
    poses = dict.fromkeys(pk.SHAPES, entry)
    with pytest.raises(ValueError):
        pk.build_manifest(
            scene.base_points, BASE_SIZE, poses, scene.reference, kit_id=kit_id, jaw_range=0.85
        )
    made = pk.build_manifest(
        scene.base_points, BASE_SIZE, poses, scene.reference, kit_id="Kit_09-ok", jaw_range=0.85
    )
    assert made["character"] == "avatar-v1:Kit_09-ok"


def test_a_fit_for_a_teeth_photo_can_be_refitted_for_the_standard_teeth(scene):
    """Only the teeth values change, to what the fit gives a mouth without a
    teeth photo; the owner's jaw range and warmth stay."""
    fitted = {
        "teethY": 0.03,
        "teethScale": 1.12,
        "jawRange": 0.7,
        "warmth": 0.4,
        "lipProjection": 0.6,
    }
    refit = pk.for_standard_teeth(fitted)
    standard = pk.fit_profile(scene.base_points, None).profile
    assert refit == {**fitted, "teethY": standard["teethY"], "teethScale": standard["teethScale"]}
    assert (refit["teethY"], refit["teethScale"]) == (
        pk.REFERENCE_TEETH_Y,
        pk.REFERENCE_TEETH_SCALE,
    )


# --- 9. Re-confirmed points: the kit follows without AI ------------------------------------


def targets_of(manifest: dict) -> dict[str, np.ndarray]:
    to_base = pk.manifest_to_base(manifest)
    return {pose["id"]: to_base(pose["points"]) for pose in manifest["poses"]}


def assert_valid_avatar_motion(m: dict) -> None:
    """The embed's validateMotionManifest (version 2), in Python."""

    def finite(p) -> bool:
        return (
            isinstance(p, list)
            and len(p) == 2
            and all(isinstance(n, (int, float)) and math.isfinite(n) and abs(n) < 3 for n in p)
        )

    assert m["version"] == 2
    assert re.fullmatch(r"avatar-v1:[A-Za-z0-9_-]{1,64}", m["character"])
    assert [p["id"] for p in m["poses"]] == list(pk.POSES)
    assert finite(m["center"]) and 0.03 <= m["mouth_width"] <= 0.6
    assert 0.6 <= m["jaw_range"] <= 1.1 and 0 < len(m["triangles"]) <= 2000
    for i, pose in enumerate(m["poses"]):
        assert (i == 0) == (pose["provenance"] == "base")
        if pose["provenance"] == "retargeted":
            assert pose["registration_rms"] is None
        else:
            assert 0 <= pose["registration_rms"] <= 0.007
        assert pose["image"] is None
        assert pose["source"] is None or (
            len(pose["source"]) == 478 and all(finite(q) for q in pose["source"])
        )
        assert len(pose["points"]) == 478 and all(finite(q) for q in pose["points"])
    for triangle in m["triangles"]:
        assert len(set(triangle)) == 3 and all(0 <= n < 478 for n in triangle)
    for ring in (m["inner_ring"], m["outer_ring"]):
        assert 8 <= len(ring) <= 40 and len(set(ring)) == len(ring)


def test_rebasing_onto_the_same_points_is_the_identity(scene):
    manifest = manifest_for(scene)
    assert pk.rebase_manifest(manifest, scene.base_points, scene.reference) == manifest


@pytest.mark.parametrize("move", ["mouth", "eye", "whole"])
def test_a_moved_mark_keeps_every_poses_displacement(scene, move):
    """New rest = the re-confirmed points; each pose moves from it exactly
    as it moved from the old rest, in the picture's pixels."""
    manifest = manifest_for(scene)
    moved = scene.base_points.copy()
    if move == "mouth":
        moved[pk.MOUTH_LEFT] += [-3.0, 1.0]
        moved[pk.MOUTH_RIGHT] += [4.0, -2.0]
    elif move == "eye":
        moved[LEFT_EYE] += [2.5, 1.5]
    else:
        moved += [7.0, -5.0]
    rebased = pk.rebase_manifest(manifest, moved, scene.reference)
    old, new = targets_of(manifest), targets_of(rebased)
    assert np.allclose(new["rest"], moved, atol=0.01)
    for shape in pk.SHAPES:
        assert np.allclose(new[shape] - new["rest"], old[shape] - old["rest"], atol=0.01), shape
    # The same kit: its id, recipe, jaw range, provenance, registration.
    for key in ("character", "kit", "jaw_range", "inner_ring", "outer_ring"):
        assert rebased[key] == manifest[key]
    for before, after in zip(manifest["poses"], rebased["poses"]):
        for key in ("provenance", "registration_rms", "source", "image"):
            assert after[key] == before[key]
    assert rebased["frame"]["image_size"] == manifest["frame"]["image_size"]
    assert_valid_avatar_motion(rebased)


def test_a_crop_moves_the_kit_with_the_face(scene):
    """A crop cuts the same pixels at whole pixels: the face is the same,
    only elsewhere in a smaller picture. In manifest units nothing moves."""
    manifest = manifest_for(scene)
    left, top = 20, 25
    moved = scene.base_points - [left, top]
    size = (BASE_SIZE[0] - 60, BASE_SIZE[1] - 70)
    rebased = pk.rebase_manifest(manifest, moved, scene.reference, size)
    assert rebased["frame"]["image_size"] == list(size)
    for before, after in zip(manifest["poses"], rebased["poses"]):
        assert np.allclose(before["points"], after["points"], atol=2e-5)
    assert rebased["mouth_width"] == pytest.approx(manifest["mouth_width"], abs=1e-6)
    assert rebased["center"] == pytest.approx(manifest["center"], abs=1e-6)
    assert rebased["triangles"] == manifest["triangles"]
    # A crop at the corner moves no point, but the picture is another size.
    corner = pk.rebase_manifest(manifest, scene.base_points, scene.reference, size)
    assert corner["frame"]["image_size"] == list(size)


def test_a_rebase_keeps_the_recipe_that_made_the_poses(scene):
    manifest = manifest_for(scene)
    manifest["kit"] = {**manifest["kit"], "prompts": "pose-prompts@1"}
    moved = scene.base_points + [1.0, 0.0]
    assert pk.rebase_manifest(manifest, moved, scene.reference)["kit"]["prompts"] == (
        "pose-prompts@1"
    )


def test_only_a_kits_manifest_is_rebased(scene, reference_manifest):
    with pytest.raises(ValueError):
        pk.rebase_manifest(reference_manifest, scene.base_points, scene.reference)
    with pytest.raises(ValueError):
        pk.rebase_manifest(manifest_for(scene), scene.base_points[:10], scene.reference)


async def test_a_built_kit_is_a_valid_avatar_motion(scene):
    result = await kit(scene, FakeProvider(scene))
    assert_valid_avatar_motion(result.manifest)
