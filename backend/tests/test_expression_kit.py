"""The expression pictures, made: prompts, the checks, the source's skin,
the manifest and the orchestrator (services.expression_kit).

No provider and no MediaPipe: `ExpressionScene` is test_performance_kit's
Scene with the five expressions' landmarks as truth (each a signature of
the trial's measures: brows, lids, the mouth's corners), and `FakeEditor`
answers each edit with the crop it was sent, telling the scene where the
expression's landmarks are in it.
"""

from __future__ import annotations

import asyncio
import io

import numpy as np
import pytest
from PIL import Image

from app.core.config import get_settings
from app.services import expression_kit, imagegen
from app.services import performance_kit as pk
from app.services.expression_kit import build, fidelity, manifest, prompts, reached
from app.services.expression_kit.build import build_expressions, to_request
from tests.test_performance_kit import Scene, png

NAMES = expression_kit.EXPRESSIONS
FACE_WIDTH = (234, 454)
BROWS_LEFT = [70, 63, 105, 66, 107]
BROWS_RIGHT = [336, 296, 334, 293, 300]


def _face(points: np.ndarray) -> float:
    return float(np.linalg.norm(points[454] - points[234]))


def expression_points(base: np.ndarray, name: str, amount: float = 1.0) -> np.ndarray:
    """Where `name` puts the face's landmarks: the trial's signatures."""
    face = _face(base)
    moved = base.copy()

    def up(ids, by):
        moved[ids, 1] -= by * face * amount

    def lids(scale):
        for top, bottom in ((159, 145), (386, 374)):
            gap = moved[bottom, 1] - moved[top, 1]
            moved[bottom, 1] -= gap * (1 - scale) * amount

    if name == "happy":
        up([61, 291], 0.02)
        lids(0.75)
        moved[14, 1] += 0.03 * face * amount  # the lips part over the teeth
    elif name == "surprised":
        up(BROWS_LEFT + BROWS_RIGHT, 0.025)
    elif name == "concerned":
        up([107, 66, 336, 296], 0.012)
        up([70, 63, 300, 293], -0.005)
        up([61, 291], -0.01)
    elif name == "thinking":
        up(BROWS_RIGHT, 0.022)
        up(BROWS_LEFT, -0.004)
    elif name == "serious":
        up([107, 66, 336, 296], -0.015)
        up([70, 63, 300, 293], -0.01)
        up([61, 291], -0.01)
    return moved


class ExpressionScene(Scene):
    def __init__(self, reference: pk.ReferenceMotion):
        super().__init__(reference)
        self.truth = {name: expression_points(self.base_points, name) for name in NAMES}
        # The detector's own view of the base photo: the confirmed points.
        self.remember(self.base_image, self.base_points)


def name_of(prompt: str) -> str:
    return next(name for name in NAMES if prompts.EXPRESSION_PROMPTS[name] in prompt)


class FakeEditor:
    """imagegen.edit_image's contract without a network. `behaviour[name]`:
    an exception (or a list consumed call by call), or a function altering
    (image, points) or points."""

    def __init__(self, scene: ExpressionScene, behaviour: dict | None = None):
        self.scene = scene
        self.behaviour = dict(behaviour or {})
        self.requests: list[str] = []

    async def __call__(self, prompt: str, payload: bytes, mime: str):
        name = name_of(prompt)
        self.requests.append(name)
        action = self.behaviour.get(name)
        if isinstance(action, list):
            action = action.pop(0) if action else None
        if isinstance(action, BaseException):
            raise action
        box = self.scene.box_for(payload)
        with Image.open(io.BytesIO(payload)) as sent:
            answer = sent.convert("RGB")
        answer.putpixel((0, 0), (NAMES.index(name) * 40, 0, 0))
        points = self.scene.answer_points(self.scene.truth[name], box, answer.size)
        if callable(action):
            altered = action(answer, points) if action.__code__.co_argcount == 2 else action(points)
            if isinstance(altered, tuple):
                answer, points = altered
            else:
                points = altered
        self.scene.remember(answer, points)
        return imagegen.Generated(png(answer), "image/png", "fake-image-model")


@pytest.fixture(scope="module")
def reference() -> pk.ReferenceMotion:
    return pk.load_reference()


@pytest.fixture
def scene(reference) -> ExpressionScene:
    return ExpressionScene(reference)


def make(scene: ExpressionScene, editor, **kwargs):
    kwargs.setdefault("detect", scene.detect)
    kwargs.setdefault("reference", scene.reference)
    kwargs.setdefault("kit_id", "test-expressions")
    return build_expressions(scene.base_png, scene.base_points, editor, **kwargs)


# --- Prompts --------------------------------------------------------------------------


def test_every_prompt_asks_for_its_expression_and_keeps_the_rest():
    for name in NAMES:
        prompt = prompts.expression_prompt(name)
        assert prompts.EXPRESSION_PROMPTS[name] in prompt
        assert prompt.endswith(prompts.KEEP)
        assert "exactly as old as in the original" in prompt
        assert "own medium" in prompt
    with pytest.raises(KeyError):
        prompts.expression_prompt("bored")


# --- What the expression moved -----------------------------------------------------------


@pytest.mark.parametrize("name", NAMES)
def test_each_expression_is_recognised_by_its_signature(scene, name):
    base = scene.base_points
    values = reached.measures(expression_points(base, name), base)
    assert reached.expression_reached(name, values) is None
    neutral = reached.measures(base, base)
    assert reached.expression_reached(name, neutral) is not None, name


def test_a_frown_is_not_concern_nor_thinking_and_a_smile_is_not_serious(scene):
    base = scene.base_points
    frown = reached.measures(expression_points(base, "serious"), base)
    assert "frown" in reached.expression_reached("concerned", frown)
    assert reached.expression_reached("thinking", frown)
    smile = reached.measures(expression_points(base, "happy"), base)
    assert reached.expression_reached("serious", smile)
    lifted = reached.measures(expression_points(base, "concerned"), base)
    assert "not down" in reached.expression_reached("serious", lifted)
    level = expression_points(base, "serious")
    level[[70, 63, 300, 293], 1] += 0.02 * _face(base)
    assert "slant" in reached.expression_reached("serious", reached.measures(level, base))


def test_a_smile_with_unnarrowed_eyes_and_concern_with_a_smile_are_refused(scene):
    base = scene.base_points
    mouth_only = base.copy()
    mouth_only[[61, 291], 1] -= 0.02 * _face(base)
    assert "eyes kept" in reached.expression_reached("happy", reached.measures(mouth_only, base))
    smiling_concern = expression_points(base, "concerned")
    smiling_concern[[61, 291], 1] -= 0.03 * _face(base)
    assert "corners rose" in reached.expression_reached(
        "concerned", reached.measures(smiling_concern, base)
    )
    with pytest.raises(ValueError):
        reached.expression_reached("bored", reached.measures(base, base))


def test_only_a_happy_picture_with_parted_lips_is_a_pause_smile(scene):
    base = scene.base_points
    happy = reached.measures(expression_points(base, "happy"), base)
    assert reached.shows_smile("happy", happy)
    assert not reached.shows_smile("surprised", happy)
    closed = expression_points(base, "happy")
    closed[14] = base[14]
    assert not reached.shows_smile("happy", reached.measures(closed, base))


# --- The source's skin -------------------------------------------------------------------


def test_the_source_skin_detail_and_colour_come_back(scene):
    """An answer the model redrew darker and grainier: the skin's colour and
    its fine detail come back to the source's; outside the face nothing is
    touched."""
    source = scene.base_image.crop((0, 0, 700, 700))
    points = scene.base_points.copy()
    rng = np.random.default_rng(1)
    drawn = np.asarray(source, dtype=np.float64) * 0.9 + rng.normal(0, 9, (700, 700, 3))
    answer = Image.fromarray(np.clip(drawn, 0, 255).astype(np.uint8))
    kept = np.asarray(fidelity.keep_skin(source, points, answer, points), dtype=np.float64)
    original = np.asarray(source, dtype=np.float64)
    nose = points[6].astype(int)
    patch = (slice(nose[1] - 20, nose[1] + 20), slice(nose[0] - 20, nose[0] + 20))
    before = np.abs(drawn[patch].mean(axis=(0, 1)) - original[patch].mean(axis=(0, 1))).max()
    after = np.abs(kept[patch].mean(axis=(0, 1)) - original[patch].mean(axis=(0, 1))).max()
    assert after < before / 3

    def grain(pixels):
        return float(np.mean([pixels[patch][..., c].std() for c in range(3)]))

    assert grain(kept) < grain(drawn) * 0.7
    untouched = np.asarray(answer, dtype=np.float64)[:5, :5]
    assert np.abs(kept[:5, :5] - untouched).max() <= 1


def test_keep_skin_resizes_a_source_of_another_size_and_leaves_a_tiny_face(scene):
    source = scene.base_image
    points = scene.base_points
    answer = source.resize((350, 390))
    kept = fidelity.keep_skin(source, points, answer, points * 0.5)
    assert kept.size == (350, 390)
    tiny = points * 0.01
    assert fidelity.keep_skin(source, points, answer, tiny).size == answer.size


def test_lab_round_trips():
    rgb = np.array([[[10, 200, 30], [255, 255, 255], [0, 0, 0], [196, 150, 122]]], float)
    assert np.allclose(fidelity.lab_to_rgb(fidelity.rgb_to_lab(rgb)), rgb, atol=0.6)


# --- The manifest --------------------------------------------------------------------------


def _entries(scene):
    base = scene.base_points
    return {
        name: manifest.ExpressionEntry((1024, 1024), base * 1.3, expression_points(base, name))
        for name in ("happy", "serious")
    }


def test_the_manifest_holds_what_was_made(scene):
    made = manifest.build_manifest(
        scene.base_points, (700, 780), _entries(scene), kit_id="k1", model="m"
    )
    assert manifest.is_expressions_manifest(made)
    assert list(made["expressions"]) == ["happy", "serious"]
    assert made["image_size"] == [700, 780] and made["kit"] == "k1"
    assert made["recipe"]["model"] == "m"
    assert made["recipe"]["prompts_version"] == expression_kit.PROMPTS_VERSION
    with pytest.raises(ValueError):
        manifest.build_manifest(scene.base_points, (1, 1), {}, kit_id="not ok!", model=None)


@pytest.mark.parametrize(
    "broken",
    [
        None,
        {"version": 2},
        {"kind": "other"},
        {"base": [[0, 0]]},
        {"expressions": {"bored": {}}},
        {"expressions": []},
        {"expressions": {"happy": {"uv": [], "targets": [], "size": [1, 1]}}},
    ],
)
def test_a_broken_manifest_is_not_one(scene, broken):
    made = manifest.build_manifest(
        scene.base_points, (700, 780), _entries(scene), kit_id="k1", model="m"
    )
    if broken is None:
        made["expressions"]["happy"]["size"] = [0, 10]
    else:
        made.update(broken)
    assert not manifest.is_expressions_manifest(made)
    assert not manifest.is_expressions_manifest("nope")
    with pytest.raises(ValueError):
        manifest.rebase(made, scene.base_points)


def test_a_kit_follows_new_marks_and_a_crop_and_refuses_another_face(scene):
    base = scene.base_points
    made = manifest.build_manifest(base, (700, 780), _entries(scene), kit_id="k1", model=None)
    remarked = base.copy()
    remarked[61] += [3.0, -2.0]
    moved = manifest.rebase(made, remarked)
    old = np.asarray(made["expressions"]["happy"]["targets"])
    new = np.asarray(moved["expressions"]["happy"]["targets"])
    assert np.allclose(new[61] - old[61], [3.0, -2.0], atol=0.11)
    assert np.allclose(new[100], old[100], atol=0.11)
    assert moved["expressions"]["happy"]["uv"] == made["expressions"]["happy"]["uv"]
    cropped = manifest.rebase(made, base - [40.0, 25.0], (600, 700))
    assert cropped["image_size"] == [600, 700]
    assert np.allclose(
        np.asarray(cropped["expressions"]["serious"]["targets"]) + [40.0, 25.0],
        made["expressions"]["serious"]["targets"],
        atol=0.11,
    )
    other = base.copy()
    other[:240] *= 1.6
    with pytest.raises(ValueError):
        manifest.rebase(made, other)


# --- Made ----------------------------------------------------------------------------------


async def test_all_five_are_made_registered_and_kept_to_the_source(scene):
    editor = FakeEditor(scene)
    progress = []
    result = await make(scene, editor, on_progress=lambda *a: progress.append(a))
    assert sorted(editor.requests) == sorted(NAMES)
    assert result.calls == result.billed_calls == 5
    assert result.model == "fake-image-model" and result.base_detected
    assert [r["status"] for r in result.report.values()] == ["ok"] * 5
    assert set(result.made) == set(NAMES)
    assert result.manifest and manifest.is_expressions_manifest(result.manifest)
    happy = result.manifest["expressions"]["happy"]
    assert happy["smile"] is True and result.manifest["expressions"]["serious"]["smile"] is False
    # Each target is the confirmed point plus what the answer moved.
    targets = np.asarray(happy["targets"])
    assert np.allclose(targets, scene.truth["happy"], atol=0.2)
    for made in result.made.values():
        with Image.open(io.BytesIO(made.picture)) as picture:
            assert picture.format == "WEBP" and picture.size == (1024, 1024)
    assert [p[2] for p in progress] == [1, 2, 3, 4, 5]
    checks = result.report["thinking"]["checks"]
    assert checks["measures"]["brow_asymmetry"] > 0.012 and checks["rms"] < 0.007


async def test_an_async_progress_callback_is_awaited(scene):
    seen = []

    async def progress(*args):
        seen.append(args[2])

    await make(scene, FakeEditor(scene), names=("happy",), on_progress=progress)
    assert seen == [1]


async def test_a_refusal_is_asked_once_more_on_the_head_crop_then_given_up(scene):
    editor = FakeEditor(
        scene,
        {
            "happy": imagegen.ImageGenRefused("SAFETY"),
            "surprised": [imagegen.ImageGenRefused("SAFETY"), None],
        },
    )
    result = await make(scene, editor)
    assert result.report["happy"]["status"] == "failed"
    assert result.report["happy"]["reason"]["code"] == "safety_refused"
    assert result.report["happy"]["attempts"] == ["face_crop", "head_crop"]
    assert result.report["surprised"]["status"] == "ok"
    assert result.calls == 7 and "happy" not in result.manifest["expressions"]


async def test_an_expression_not_reached_or_drifted_is_left_out(scene):
    # Concern asked, a frown drawn: its brows lowered, not lifted.
    scene.truth["concerned"] = expression_points(scene.base_points, "serious")
    # Thinking drawn with the nose moved (the head turned).
    turned = scene.truth["thinking"].copy()
    turned[[1, 4, 5]] += [0.08 * _face(scene.base_points), 0]
    scene.truth["thinking"] = turned
    result = await make(scene, FakeEditor(scene))
    concerned = result.report["concerned"]
    assert concerned["status"] == "failed"
    assert concerned["reason"]["code"] == "expression_not_reached"
    assert "frown" in concerned["reason"]["detail"]
    assert result.report["thinking"]["reason"]["code"] in {"nose_moved", "head_turned"}
    assert set(result.made) == {"happy", "surprised", "serious"}
    assert set(result.manifest["expressions"]) == {"happy", "surprised", "serious"}


async def test_the_eyes_may_move_for_an_expression(scene):
    """The mouth kit's eye guard refuses moved lids; an expression moves
    them, so it is not applied."""
    wide = expression_points(scene.base_points, "surprised")
    upper_lids = [157, 158, 159, 160, 161, 246, 384, 385, 386, 387, 388, 398]
    wide[upper_lids, 1] -= 0.06 * _face(scene.base_points)
    scene.truth["surprised"] = wide
    result = await make(scene, FakeEditor(scene), names=("surprised",))
    assert result.report["surprised"]["status"] == "ok"
    assert result.report["surprised"]["checks"]["eyes"] > pk.MAX_EYE_SHIFT


async def test_no_provider_makes_nothing_and_sends_nothing_more(scene):
    editor = FakeEditor(scene, {"happy": imagegen.ImageGenUnavailable("off")})
    result = await make(scene, editor, names=("happy",))
    assert result.manifest is None and result.made == {} and result.calls == 0
    assert result.report["happy"]["outcome"] == "unavailable"


async def test_a_timeout_and_a_provider_error_are_reported(scene):
    editor = FakeEditor(
        scene, {"happy": TimeoutError(), "serious": RuntimeError("image generation failed (500)")}
    )
    result = await make(scene, editor, names=("happy", "serious"))
    assert result.report["happy"]["outcome"] == "timeout"
    assert result.report["serious"]["outcome"] == "provider_error"


async def test_a_check_that_breaks_is_a_check_not_passed(scene, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("broken check")

    monkeypatch.setattr(build, "register_face", broken)
    result = await make(scene, FakeEditor(scene), names=("happy",))
    assert result.report["happy"]["reason"]["code"] == "check_failed"


async def test_a_failure_outside_the_calls_is_kit_failed(scene):
    def explode(*args):
        raise RuntimeError("progress broke")

    with pytest.raises(pk.KitFailed) as failed:
        await make(scene, FakeEditor(scene), names=("happy",), on_progress=explode)
    assert failed.value.calls == 1


async def test_unknown_names_and_no_detector_are_refused_before_any_call(scene, monkeypatch):
    with pytest.raises(ValueError):
        await make(scene, FakeEditor(scene), names=("bored",))
    monkeypatch.setattr(get_settings(), "rig_model_path", "")
    editor = FakeEditor(scene)
    with pytest.raises(pk.KitUnavailable):
        await build_expressions(scene.base_png, scene.base_points, editor, detect=None)
    assert editor.requests == []


def test_to_request_maps_base_pixels_into_the_sent_picture():
    request = pk.PoseRequest("happy", "face_crop", "p", b"", "image/jpeg", (10, 20, 110, 120))
    assert np.allclose(to_request(np.array([[60.0, 70.0]]), request, (200, 200)), [[100, 100]])


async def test_concurrency_is_bounded(scene):
    in_flight = 0
    most = 0
    editor = FakeEditor(scene)

    async def slow(prompt, payload, mime):
        nonlocal in_flight, most
        in_flight += 1
        most = max(most, in_flight)
        await asyncio.sleep(0.01)
        try:
            return await editor(prompt, payload, mime)
        finally:
            in_flight -= 1

    await make(scene, slow, concurrency=2)
    assert most == 2


def test_uv_follows_the_owners_corrected_marks():
    """A mark the owner moved from the detection samples the picture where
    the corrected feature is: through the registration, not at the
    detector's landmark."""
    rng = np.random.default_rng(2)
    answer = rng.uniform(100, 900, size=(478, 2))
    registered = answer * 0.5 + [30.0, 40.0]  # answer px to base px
    confirmed = registered.copy()
    confirmed[70] += [6.0, -4.0]
    targets = confirmed + (registered - registered)
    uv = build.picture_uv(answer, registered, targets)
    assert np.allclose(uv[10], answer[10], atol=1e-6)
    assert np.allclose(uv[70], answer[70] + [12.0, -8.0], atol=1e-6)
