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
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services import imagegen, performance_kit as pk, photo_adjust

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
    pixels, and a detector that knows every answer the fake provider made."""

    def __init__(self, reference: pk.ReferenceMotion):
        self.reference = reference
        self.base_image = base_photo()
        self.base_png = png(self.base_image)
        self.base_points = to_base(reference.rest)
        self.truth = {shape: to_base(reference.poses[shape]) for shape in pk.SHAPES}
        self.known: dict[str, np.ndarray] = {}
        self.detect_calls = 0

    def detect(self, image: Image.Image) -> np.ndarray | None:
        self.detect_calls += 1
        points = self.known.get(image_key(image))
        return None if points is None else points.copy()

    def remember(self, image: Image.Image, points: np.ndarray) -> None:
        self.known[image_key(image)] = np.asarray(points, dtype=np.float64)

    def box_for(self, payload: bytes) -> tuple[float, float, float, float]:
        """Which rectangle of the base a payload shows: the face crop is a
        CROP_SIZE square, the head crop is not."""
        with Image.open(io.BytesIO(payload)) as sent:
            size = sent.size
        if size == (photo_adjust.CROP_SIZE, photo_adjust.CROP_SIZE):
            x0, y0, side = photo_adjust.face_crop_box(self.base_points)
            return x0, y0, x0 + side, y0 + side
        return tuple(float(int(round(v))) for v in
                     photo_adjust.head_crop_box(BASE_SIZE, self.base_points))

    def answer_points(self, shape_points: np.ndarray, box, answer_size) -> np.ndarray:
        x0, y0, x1, y1 = box
        scale = np.array([answer_size[0] / (x1 - x0), answer_size[1] / (y1 - y0)])
        return (shape_points - np.array([x0, y0])) * scale


def shape_of(prompt: str) -> str:
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
    it was sent, marked per shape, and tells the Scene where the shape's
    landmarks are in it. `behaviour[shape]` may be an exception to raise
    (every time, or a list consumed call by call), "slow" (sleeps past any
    timeout), or a function (points) -> points altering the landmarks, or
    (image, points) -> (image, points) altering both."""

    def __init__(self, scene: Scene, behaviour: dict | None = None, *, teeth_edge=0.07, delay=0.0):
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
            # One pixel per shape, so every answer is a different image.
            answer.putpixel((0, 0), (pk.SHAPES.index(shape) * 20, 0, 0))
            points = self.scene.answer_points(self.scene.truth[shape], box, answer.size)
            if shape == "ee" and self.teeth_edge is not None:
                answer = paint_teeth(answer, points, self.teeth_edge)
            if callable(action):
                altered = action(answer, points) if action.__code__.co_argcount == 2 else action(points)
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


def test_the_ee_prompt_asks_for_the_upper_teeth():
    """EE doubles as the teeth photo, so it must show them."""
    assert "UPPER FRONT TEETH CLEARLY VISIBLE" in pk.pose_prompt("ee")
    assert "tongue" in pk.pose_prompt("th") and "lower lip" in pk.pose_prompt("fv")


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


def test_the_head_crop_is_photo_adjusts_fallback_crop(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "oo", kind=pk.HEAD_CROP)
    assert request.kind == pk.HEAD_CROP
    expected = photo_adjust.head_crop_box(BASE_SIZE, scene.base_points)
    assert request.box == tuple(float(int(round(v))) for v in expected)
    with Image.open(io.BytesIO(request.payload)) as sent:
        width, height = sent.size
    assert width / height == pytest.approx((request.box[2] - request.box[0])
                                           / (request.box[3] - request.box[1]), rel=0.01)


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
    return pk.register_answer(png(answer), request, pk._base_image(scene.base_png),
                              scene.base_points, frame, scene.detect)


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


@pytest.mark.parametrize("alter", [
    lambda p: (p - 512) * 1.2 + 512,
    lambda p: rotate(p, 6),
], ids=["zoomed", "tilted"])
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


def test_no_face_a_broken_image_and_a_mirror_are_refused(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "aa")
    frame = pk.ManifestFrame.from_base(scene.base_points, BASE_SIZE, scene.reference)
    base = pk._base_image(scene.base_png)
    unknown = png(Image.new("RGB", (1024, 1024), (1, 2, 3)))
    result = pk.register_answer(unknown, request, base, scene.base_points, frame, scene.detect)
    assert result.reason["code"] == "no_face_in_result"
    broken = pk.register_answer(b"not an image", request, base, scene.base_points, frame, scene.detect)
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
    matrix = 0.6 * np.array([[math.cos(angle), -math.sin(angle)],
                             [math.sin(angle), math.cos(angle)]])

    def place(points):
        return points * REFERENCE_SIZE @ matrix.T + [40, 90]

    moved = pk.retarget_reference_pose("oh", place(reference.rest), reference)
    assert np.allclose(moved, place(reference.poses["oh"]), atol=1e-6)


def test_a_thicker_lower_lip_moves_further_and_the_upper_lip_does_not(reference):
    base = reference.rest * REFERENCE_SIZE
    thick = base.copy()
    # The lower lip's outer edge and everything below it drop: the lower lip
    # is 30% taller than the Reference's, the upper lip unchanged.
    lower_height = float(np.linalg.norm(base[14] - base[17]))
    below = base[:, 1] > base[17, 1] - 1e-9
    thick[below, 1] += 0.3 * lower_height
    reference_move = reference.poses["aa"] * REFERENCE_SIZE - base
    move = pk.retarget_reference_pose("aa", thick, reference) - thick
    # The chin is well below the seam: vertical movement scaled by 1.3.
    assert move[152, 1] == pytest.approx(reference_move[152, 1] * 1.3, rel=0.02)
    # The upper lip's centre is above it: unchanged.
    assert move[0, 1] == pytest.approx(reference_move[0, 1], rel=0.02)
    # Horizontal movement follows the (unchanged) mouth width.
    assert move[61, 0] == pytest.approx(reference_move[61, 0], rel=1e-6)


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


def test_an_implausible_lip_height_is_bounded(reference):
    base = reference.rest * REFERENCE_SIZE
    flat = base.copy()
    flat[0] = flat[13] + [0, -1e-3]  # an upper lip of no height at all
    reference_move = reference.poses["aa"] * REFERENCE_SIZE - base
    move = pk.retarget_reference_pose("aa", flat, reference) - flat
    # The upper lip's outer edge, well above the seam: all upper-lip scale.
    ratio = move[0, 1] / reference_move[0, 1]
    assert ratio == pytest.approx(pk.LIP_SCALE_RANGE[0], rel=0.05)


# --- 6. Profile fit ------------------------------------------------------------------------------------


def reference_fit(reference, reference_manifest, *, with_teeth=True, shapes=("ee", "aa")):
    size = REFERENCE_SIZE
    ee_source = next(p for p in reference_manifest["poses"] if p["id"] == "ee")["source"]
    teeth = None
    if with_teeth:
        teeth = pk.TeethPhoto(Image.open(REFERENCE_DIR / "performance-ee.webp").convert("RGB"),
                              np.asarray(ee_source) * size)
    generated = {s: reference.poses[s] * size for s in shapes}
    return pk.fit_profile(reference.rest * size, generated, reference, teeth)


def test_the_fit_reproduces_the_references_hand_tuned_teeth_position(reference, reference_manifest):
    """The Reference's teethY was tuned by hand to 0.016
    (frontend/src/features/lab/reference-avatar.ts). Fitted from its own EE
    photo it comes out at 0.0159: the edge shows 0.0675 EE mouth widths
    below the inner upper lip, the EE mouth is 1.050 rest widths wide, and
    the renderer seats the edge 0.055 below the rest seam."""
    fit = reference_fit(reference, reference_manifest)
    assert fit.profile["teethY"] == pytest.approx(0.016, abs=0.002)
    assert fit.measurements["incisal_below_lip"] == pytest.approx(0.0675, abs=0.002)
    # Its EE mouth is 5% wider than at rest, so its teeth are drawn 5%
    # larger than the teeth photo's own mouth width would make them. (The
    # hand value, 1.00, was set for a different teeth photo.)
    assert fit.profile["teethScale"] == pytest.approx(1.05, abs=0.01)
    # Its AA is the Reference's AA: the default jaw range, exactly.
    assert fit.profile["jawRange"] == pytest.approx(0.85, abs=1e-4)
    assert fit.reasons == []


def test_without_a_teeth_photo_the_geometric_teeth_keep_the_references_proportion(
    reference, reference_manifest
):
    fit = reference_fit(reference, reference_manifest, with_teeth=False, shapes=("aa",))
    assert fit.profile["teethScale"] == pytest.approx(1.0, abs=1e-4)
    assert fit.profile["teethY"] == 0.0
    assert [r["code"] for r in fit.reasons] == ["ee_not_generated"]


def test_a_mouth_wide_for_its_face_gets_smaller_geometric_teeth(reference):
    base = reference.rest * REFERENCE_SIZE
    wide = base.copy()
    centre = (base[61] + base[291]) / 2
    lips = pk.OUTER_LIP_RING + pk.INNER_LIP_RING
    wide[lips, 0] = centre[0] + (base[lips, 0] - centre[0]) * 1.1
    fit = pk.fit_profile(wide, {}, reference, None)
    assert fit.profile["teethScale"] == pytest.approx(1 / 1.1, abs=1e-3)


def test_the_fit_measures_the_teeth_in_the_photo(scene):
    """Synthetic EE with the biting edge painted 0.07 mouth widths below the
    inner upper lip."""
    photo = paint_teeth(Image.new("RGB", (800, 800), SKIN), scene.truth["ee"], 0.07)
    offset, columns = pk.upper_incisal_offset(photo, scene.truth["ee"])
    assert offset == pytest.approx(0.07, abs=0.004)
    assert columns >= pk.MIN_INCISAL_COLUMNS


def test_an_ee_photo_without_teeth_keeps_the_defaults_with_the_reason(scene):
    closed = Image.new("RGB", (800, 800), SKIN)
    ImageDraw.Draw(closed).polygon([tuple(p) for p in scene.truth["ee"][pk.INNER_LIP_RING]],
                                   fill=(46, 22, 24))
    fit = pk.fit_profile(scene.base_points, {"ee": scene.truth["ee"]}, scene.reference,
                         pk.TeethPhoto(closed, scene.truth["ee"]))
    assert fit.profile["teethY"] == 0.0
    codes = {r["field"]: r["code"] for r in fit.reasons}
    assert codes["teethY"] == "no_teeth_visible"
    assert codes["jawRange"] == "aa_not_generated"


def test_fitted_values_are_clamped_with_a_reason(scene):
    wide_open = scene.truth["aa"].copy()
    wide_open[14] += [0, 200]
    fit = pk.fit_profile(scene.base_points, {"aa": wide_open}, scene.reference, None)
    assert fit.profile["jawRange"] == 1.1
    assert {"field": "jawRange", "code": "clamped"}.items() <= next(
        r for r in fit.reasons if r["field"] == "jawRange").items()


# --- 4. Manifest -----------------------------------------------------------------------------------------


def manifest_for(scene: Scene, generated=("aa", "ee", "oo")) -> dict:
    poses = {}
    for shape in pk.SHAPES:
        if shape in generated:
            poses[shape] = pk.PoseEntry(scene.truth[shape], pk.GENERATED, 0.0015,
                                        scene.truth[shape] / np.asarray(BASE_SIZE))
        else:
            poses[shape] = pk.PoseEntry(
                pk.retarget_reference_pose(shape, scene.base_points, scene.reference),
                pk.RETARGETED)
    return pk.build_manifest(scene.base_points, BASE_SIZE, poses, scene.reference,
                             kit_id="contract-fixture", jaw_range=0.85)


def test_the_manifest_is_the_reference_format_with_its_version_2_fields(scene, reference_manifest):
    manifest = manifest_for(scene)
    assert manifest["version"] == 2
    assert manifest["character"] == "avatar-v1:contract-fixture"
    assert [p["id"] for p in manifest["poses"]] == list(pk.POSES)
    assert [p["provenance"] for p in manifest["poses"]] == [
        "base", "generated", "generated", "generated", "retargeted", "retargeted", "retargeted"]
    assert manifest["poses"][4]["registration_rms"] is None
    assert manifest["poses"][4]["source"] is None
    assert manifest["poses"][1]["registration_rms"] == 0.0015
    assert all(p["image"] is None for p in manifest["poses"])
    for pose in manifest["poses"]:
        assert len(pose["points"]) == 478
    assert manifest["inner_ring"] == reference_manifest["inner_ring"]
    assert manifest["outer_ring"] == reference_manifest["outer_ring"]
    assert manifest["jaw_range"] == 0.85
    assert manifest["kit"] == {"version": pk.KIT_VERSION, "prompts": pk.PROMPTS_VERSION,
                               "reference": "lab-reference-v1"}
    # This face is the Reference at half size: in manifest units it is the
    # Reference again, levelled (the Reference leans 0.3 degrees).
    assert manifest["mouth_width"] == pytest.approx(reference_manifest["mouth_width"], rel=1e-3)
    assert manifest["center"] == pytest.approx(reference_manifest["center"], abs=1e-3)
    rest = np.asarray(manifest["poses"][0]["points"])
    assert rest[291, 1] == pytest.approx(rest[61, 1], abs=1e-7)
    triangles = np.asarray(manifest["triangles"])
    assert triangles.min() >= 0 and triangles.max() < 478 and 100 < len(triangles) < 2000


def test_the_frame_maps_base_pixels_to_manifest_units(scene):
    manifest = manifest_for(scene)
    frame = np.asarray(manifest["frame"]["to_manifest"])
    assert manifest["frame"]["image_size"] == list(BASE_SIZE)
    mapped = scene.truth["aa"] @ frame[:, :2].T + frame[:, 2]
    assert np.allclose(mapped, manifest["poses"][1]["points"], atol=1e-6)


def test_a_bad_kit_id_or_a_missing_shape_is_refused(scene):
    entry = pk.PoseEntry(scene.base_points, pk.RETARGETED)
    poses = {shape: entry for shape in pk.SHAPES}
    for bad in ("", "a/b", "x" * 65, "with space"):
        with pytest.raises(ValueError):
            pk.build_manifest(scene.base_points, BASE_SIZE, poses, scene.reference,
                              kit_id=bad, jaw_range=0.85)
    del poses["th"]
    with pytest.raises(ValueError):
        pk.build_manifest(scene.base_points, BASE_SIZE, poses, scene.reference,
                          kit_id="ok", jaw_range=0.85)


EMBED_FIXTURE = REPO / "embed/src/mouth/__tests__/fixtures/avatar-motion.json"


def test_the_embed_contract_fixture_is_what_the_builder_writes(scene):
    """embed/src/mouth/__tests__ loads this file through the embed's
    validator and renders it; this keeps it equal to what the backend
    actually builds. Regenerate with LIVEFACE_WRITE_FIXTURES=1."""
    written = json.dumps(manifest_for(scene), separators=(",", ":"))
    if os.environ.get("LIVEFACE_WRITE_FIXTURES") == "1":
        EMBED_FIXTURE.write_text(written)
    assert EMBED_FIXTURE.read_text() == written


# --- 7. build_kit --------------------------------------------------------------------------------------


async def test_a_kit_from_faithful_answers(scene):
    progress: list[tuple[float, str]] = []
    provider = FakeProvider(scene, delay=0.01)
    result = await kit(scene, provider, on_progress=lambda f, m: progress.append((f, m)))

    assert result.calls == 6 and result.billed_calls == 6
    assert sorted(shape for shape, _ in provider.requests) == sorted(pk.SHAPES)
    assert all(r["status"] == "ok" and r["outcome"] == "generated" for r in result.report.values())
    assert [p["provenance"] for p in result.manifest["poses"][1:]] == ["generated"] * 6
    assert result.manifest["character"] == "avatar-v1:test-kit"
    assert all(entry["model"] == "fake-image-model" for entry in result.call_log)
    # The fit: the painted edge 0.07 EE widths below the lip, the EE 1.05
    # rest widths wide, less the 0.055 seat.
    assert result.profile["teethY"] == pytest.approx(0.07 * 1.0502 - 0.055, abs=0.004)
    assert result.profile["jawRange"] == pytest.approx(0.85, abs=1e-3)
    assert result.manifest["jaw_range"] == result.profile["jawRange"]
    # The EE answer is handed on as the teeth photo, with its own rig.
    teeth = result.teeth_source
    assert teeth is not None
    with Image.open(io.BytesIO(teeth.png)) as photo:
        assert list(photo.size) == teeth.rig["image_size"] == [1024, 1024]
    assert len(teeth.rig["points"]) == 478 and teeth.rig["inner_lip_ring"] == pk.INNER_LIP_RING
    # Progress only moves forward and ends at 1.
    fractions = [f for f, _ in progress]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0


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
    assert result.calls == result.billed_calls == 8


async def test_a_refusal_is_not_retried_when_the_head_crop_is_the_whole_photo(reference):
    scene = Scene(reference)
    # The face fills the photo: no smaller picture to ask with.
    scene.base_points = reference.rest * 300 - np.array([20.0, 70.0])
    scene.truth = {s: reference.poses[s] * 300 - np.array([20.0, 70.0]) for s in pk.SHAPES}
    scene.base_image = Image.new("RGB", (220, 260), SKIN)
    scene.base_png = png(scene.base_image)
    provider = FakeProvider(scene, {s: imagegen.ImageGenRefused("SAFETY") for s in pk.SHAPES})
    result = await kit(scene, provider)
    assert result.calls == 6
    assert all(r["attempts"] == [pk.FACE_CROP] for r in result.report.values())


@pytest.mark.parametrize("error, outcome, billed", [
    (imagegen.ImageGenNoImage("NO_IMAGE"), "no_image", 5 + 1),
    (RuntimeError("image generation failed (500)"), "provider_error", 5),
])
async def test_a_failed_shape_is_retargeted_and_not_asked_again(scene, error, outcome, billed):
    provider = FakeProvider(scene, {"th": [error, error]})
    result = await kit(scene, provider)
    assert result.report["th"] == {**result.report["th"], "status": "retargeted", "outcome": outcome}
    assert [s for s, _ in provider.requests].count("th") == 1
    assert result.calls == 6 and result.billed_calls == billed
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
    assert result.profile["teethY"] == 0.0 and result.profile["jawRange"] == 0.85
    # This face is the Reference: retargeted, the poses are the Reference's.
    frame = np.asarray(result.manifest["frame"]["to_manifest"])
    expected = scene.truth["aa"] @ frame[:, :2].T + frame[:, 2]
    assert np.allclose(result.manifest["poses"][1]["points"], expected, atol=1e-6)


async def test_a_rejected_answer_is_retargeted_with_its_reason(scene):
    request = pk.prepare_pose_request(scene.base_png, scene.base_points, "aa")
    closed = scene.answer_points(scene.base_points, request.box, (1024, 1024))
    provider = FakeProvider(scene, {"aa": lambda points: closed})
    result = await kit(scene, provider)
    assert result.report["aa"]["status"] == "retargeted"
    assert result.report["aa"]["outcome"] == "rejected"
    assert result.report["aa"]["reason"]["code"] == "pose_not_reached"
    assert result.billed_calls == 6  # it was answered, so it was billed
    reasons = {r["field"]: r["code"] for r in result.profile_fit["reasons"]}
    assert reasons["jawRange"] == "aa_not_generated"


async def test_a_rejected_ee_leaves_no_teeth_photo(scene):
    provider = FakeProvider(scene, {"ee": lambda points: rotate(points, 8)})
    result = await kit(scene, provider)
    assert result.report["ee"]["reason"]["code"] == "head_moved"
    assert result.teeth_source is None
    assert result.profile["teethY"] == 0.0


async def test_an_ee_without_visible_teeth_is_kept_but_is_not_the_teeth_photo(scene):
    result = await kit(scene, FakeProvider(scene, teeth_edge=None))
    assert result.report["ee"]["status"] == "ok"
    assert result.teeth_source is None
    reasons = {r["field"]: r["code"] for r in result.profile_fit["reasons"]}
    assert reasons["teethY"] == "no_teeth_visible"
    # The geometric teeth, sized for this face: the Reference's proportion.
    assert result.profile["teethScale"] == pytest.approx(1.0, abs=1e-3)


async def test_an_ee_too_closed_for_a_teeth_photo_fits_the_geometric_teeth(scene):
    def nearly_closed(points):
        points = points.copy()
        width = float(np.linalg.norm(points[291] - points[61]))
        points[14] = points[13] + [0, 0.06 * width]
        return points

    result = await kit(scene, FakeProvider(scene, {"ee": nearly_closed}))
    assert result.report["ee"]["status"] == "ok"
    assert result.teeth_source is None
    reasons = {r["field"]: r["code"] for r in result.profile_fit["reasons"]}
    assert reasons["teeth_source"] == "teeth_gap_small"
    assert reasons["teethY"] == "no_teeth_photo"
    assert result.profile["teethScale"] == pytest.approx(1.0, abs=1e-3)


async def test_an_async_progress_callback_is_awaited(scene):
    seen = []

    async def progress(fraction, message):
        await asyncio.sleep(0)
        seen.append(fraction)

    await kit(scene, FakeProvider(scene), on_progress=progress)
    assert seen[-1] == 1.0 and len(seen) == 8


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
    first = await pk.build_kit(scene.base_png, scene.base_points,
                               FakeProvider(scene), detect=scene.detect, reference=scene.reference)
    assert first.manifest["character"].startswith("avatar-v1:")
    assert len(first.manifest["character"]) == len("avatar-v1:") + 32
