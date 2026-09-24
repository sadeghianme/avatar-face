"""AI adjust's local half: what is sent, and how the answer is put back.

No provider is called here. The "answer" is built by the test from the very
crop that would have been sent, changed in known ways, so every assertion
is about what the paste does with it: only the eye and lip regions change,
they land where the photo's eyes and lips are, colour and grain are matched,
and the checks reject what must not be offered.

MediaPipe is replaced by a detector that knows where the test put the face
(`FaceFinder`): the face template in a box on the photo, and the same
points carried through the crop transform on the crop.
"""

import io
import math

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services import face_template, landmarks, photo_adjust as pa
from app.services.photo_adjust import (
    CROP_SIZE,
    EYE_IMAGE_LEFT,
    EYE_IMAGE_RIGHT,
    LIPS,
    AdjustSkipped,
)

WIDTH, HEIGHT = 400, 500
FACE_BOX = (0.3 * WIDTH, 0.2 * HEIGHT, 0.7 * WIDTH, 0.7 * HEIGHT)


def png(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def noisy_photo(seed: int = 3) -> Image.Image:
    """Skin-coloured with photo-like grain, so grain matching has something
    to match and every pixel is distinguishable."""
    rng = np.random.default_rng(seed)
    base = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float64)
    base[:] = (196, 150, 122)
    base += rng.normal(0, 6, size=base.shape)
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def smooth_photo() -> Image.Image:
    """Low-frequency content only: resampling it twice changes little, so
    a misaligned paste shows as a large error and an aligned one does not."""
    y, x = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float64)
    r = 150 + 50 * np.sin(x / 37.0) * np.cos(y / 53.0)
    g = 120 + 40 * np.cos(x / 41.0 + y / 71.0)
    b = 100 + 30 * np.sin((x + y) / 47.0)
    return Image.fromarray(np.clip(np.stack((r, g, b), -1), 0, 255).astype(np.uint8))


def face_points(box=FACE_BOX) -> np.ndarray:
    return face_template.place(box)


def crop_points(points: np.ndarray, box) -> np.ndarray:
    x0, y0, side = box
    return (points - np.array([x0, y0])) * (CROP_SIZE / side)


class FaceFinder:
    """landmarks.detect for images whose faces the test placed: by size."""

    def __init__(self, monkeypatch):
        self.by_size: dict[tuple[int, int], np.ndarray] = {}
        self.calls = 0
        monkeypatch.setattr(landmarks, "detect", self.detect)

    def detect(self, image):
        self.calls += 1
        points = self.by_size.get(image.size)
        if points is None:
            return None
        return landmarks.FaceLandmarks(points=points, z=np.zeros(len(points)))


@pytest.fixture
def finder(monkeypatch):
    return FaceFinder(monkeypatch)


def _decode(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGB")


def _paint_hulls(image: Image.Image, polygons, colour) -> Image.Image:
    from scipy.spatial import ConvexHull

    out = image.copy()
    draw = ImageDraw.Draw(out)
    for pts in polygons:
        hull = pts[ConvexHull(pts).vertices]
        draw.polygon([tuple(p) for p in hull.tolist()], fill=colour)
    return out


def _region_mask(points: np.ndarray, pad: float) -> np.ndarray:
    """Pixels within `pad` of the eye and lip hulls (the only ones a paste
    may touch)."""
    from scipy.ndimage import distance_transform_edt

    hull = pa._hull_mask((HEIGHT, WIDTH), [points[EYE_IMAGE_LEFT], points[EYE_IMAGE_RIGHT],
                                            points[LIPS]])
    return distance_transform_edt(~hull) <= pad


def _paste_reach(points: np.ndarray) -> float:
    """How far from the eye and lip hulls a paste may reach, with margin:
    the larger of the two regions' dilation and feather."""
    eye_width = float(np.ptp(points[EYE_IMAGE_LEFT][:, 0]))
    mouth_width = float(np.ptp(points[LIPS][:, 0]))
    return 1.6 * max(
        (pa.EYE_DILATE + pa.EYE_FEATHER) * eye_width,
        (pa.LIP_DILATE + pa.LIP_FEATHER) * mouth_width,
    ) + 3


# --- what is sent ----------------------------------------------------------------


def test_a_touchup_sends_a_square_face_crop_at_1024(finder):
    points = face_points()
    finder.by_size[(WIDTH, HEIGHT)] = points
    prepared = pa.prepare(png(noisy_photo()), pa.TOUCHUP, "human")

    assert prepared.mime == "image/jpeg"
    sent = _decode(prepared.payload)
    assert sent.size == (CROP_SIZE, CROP_SIZE)
    x0, y0, side = prepared.crop
    face_w, face_h = FACE_BOX[2] - FACE_BOX[0], FACE_BOX[3] - FACE_BOX[1]
    assert side == pytest.approx(pa.CROP_SCALE * max(face_w, face_h))
    # Centred on the face.
    assert x0 + side / 2 == pytest.approx((FACE_BOX[0] + FACE_BOX[2]) / 2)
    assert y0 + side / 2 == pytest.approx((FACE_BOX[1] + FACE_BOX[3]) / 2)
    assert prepared.prompt == pa.TOUCHUP_PROMPT
    assert "NOTHING else" in prepared.prompt
    assert prepared.generated_eyes is False


def test_a_crop_past_the_edge_is_filled_with_the_photos_own_edge():
    image = Image.new("RGB", (100, 100), (200, 40, 40))
    crop = pa.crop_face(image, (-50.0, -50.0, 200.0))
    corner = np.asarray(crop)[:20, :20].reshape(-1, 3)
    # Edge pixels repeated, never a black band.
    assert (corner == (200, 40, 40)).all()


def test_a_turned_head_is_skipped_before_anything_is_sent(finder):
    points = face_points().copy()
    half = (points[pa.FACE_RIGHT][0] - points[pa.FACE_LEFT][0]) / 2
    points[pa.NOSE_TIP, 0] += 0.5 * half
    finder.by_size[(WIDTH, HEIGHT)] = points
    with pytest.raises(AdjustSkipped) as skipped:
        pa.prepare(png(noisy_photo()), pa.TOUCHUP, "human")
    assert skipped.value.code == "face_turned"


def test_no_face_means_no_touchup(finder):
    with pytest.raises(AdjustSkipped) as skipped:
        pa.prepare(png(noisy_photo()), pa.TOUCHUP, "human")
    assert skipped.value.code == "no_face_for_touchup"


def test_no_detector_means_no_touchup(monkeypatch):
    def unavailable(image):
        raise landmarks.LandmarkerUnavailable("no model")

    monkeypatch.setattr(landmarks, "detect", unavailable)
    with pytest.raises(AdjustSkipped) as skipped:
        pa.prepare(png(noisy_photo()), pa.TOUCHUP, "human")
    assert skipped.value.code == "landmarks_unavailable"


def test_closed_eyes_are_flagged_as_generated(finder):
    from app.services.photo_analysis import EYE_CLOSED_EAR, EYE_HALF_CLOSED_EAR
    from tests.test_photo_analysis import with_eyes

    # The photo check's threshold: half-closed eyes are not generated ones.
    assert not pa.eyes_closed(with_eyes(face_points(), EYE_HALF_CLOSED_EAR - 0.02))
    assert pa.eyes_closed(with_eyes(face_points(), EYE_CLOSED_EAR - 0.02, eyes=(0,)))
    points = with_eyes(face_points(), 0.02)
    finder.by_size[(WIDTH, HEIGHT)] = points
    prepared = pa.prepare(png(noisy_photo()), pa.TOUCHUP, "human")
    assert prepared.generated_eyes is True


def test_whole_image_modes_send_the_picture_opaque_and_shrunk():
    big = Image.new("RGBA", (2000, 1600), (0, 0, 0, 0))
    ImageDraw.Draw(big).ellipse((600, 300, 1400, 1300), fill=(180, 120, 90, 255))
    prepared = pa.prepare(png(big), pa.REGENERATE, "animal")
    sent = Image.open(io.BytesIO(prepared.payload))
    assert sent.format == "JPEG" and max(sent.size) == pa.SOURCE_MAX_EDGE
    # Transparent areas are shown on a flat neutral grey, never black (what
    # is under alpha 0) and never the background that was removed.
    assert all(abs(c - 128) <= 3 for c in sent.convert("RGB").getpixel((5, 5)))
    assert prepared.prompt == pa.REGENERATE_PROMPTS["animal"]
    assert "same animal" in prepared.prompt and "mouth closed" in prepared.prompt

    styled = pa.prepare(png(noisy_photo()), pa.STYLISE, "human", "anime")
    assert "anime" in styled.prompt


def test_every_line_has_a_regenerate_prompt_and_only_people_get_the_rest():
    assert set(pa.REGENERATE_PROMPTS) == {"human", "animal", "cartoon"}
    assert pa.MODES_BY_LINE["human"] == ("touchup", "stylise", "regenerate")
    assert pa.MODES_BY_LINE["animal"] == ("regenerate",)
    assert pa.MODES_BY_LINE["cartoon"] == ("regenerate",)
    for line, text in pa.REGENERATE_PROMPTS.items():
        assert "facing the camera" in text and "backdrop" in text, line


# --- geometry and colour ----------------------------------------------------------


def test_the_similarity_is_recovered_exactly():
    rng = np.random.default_rng(1)
    src = rng.uniform(0, 500, size=(30, 2))
    angle, scale, shift = math.radians(7.0), 0.83, np.array([12.0, -30.0])
    rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    dst = src @ (scale * rotation).T + shift
    matrix = pa.similarity_transform(src, dst)
    assert np.allclose(matrix[:, :2], scale * rotation, atol=1e-9)
    assert np.allclose(matrix[:, 2], shift, atol=1e-6)
    assert np.allclose(pa.apply(matrix, src), dst, atol=1e-6)


def test_alignment_ignores_a_few_moved_landmarks():
    points = face_points()
    moved = points.copy()
    moved[pa.STABLE[:2]] += 25.0  # a strand of hair over the brow, say
    matrix, residual = pa.align(moved, points)
    assert np.allclose(matrix[:, :2], np.eye(2), atol=0.02)
    assert residual < 1.0


def test_lab_round_trips():
    rng = np.random.default_rng(2)
    rgb = rng.integers(0, 256, size=(50, 3)).astype(np.float64)
    assert np.allclose(pa.lab_to_rgb(pa.rgb_to_lab(rgb)), rgb, atol=0.05)
    assert pa.rgb_to_lab(np.array([255.0, 255.0, 255.0]))[0] == pytest.approx(100.0, abs=0.01)


# --- the paste --------------------------------------------------------------------


def _answer_from_crop(source: Image.Image, points: np.ndarray, change) -> tuple[Image.Image, np.ndarray, tuple]:
    box = pa.face_crop_box(points)
    crop = pa.crop_face(source, box)
    return change(crop, crop_points(points, box)), crop_points(points, box), box


def test_only_the_eyes_and_lips_change_and_the_rest_is_the_original_to_the_bit():
    source = noisy_photo()
    points = face_points()

    def change(crop, pts):
        # The model "relit" everything and painted the eyes and lips blue.
        tinted = Image.fromarray(np.clip(np.asarray(crop, dtype=np.int16) + 25, 0, 255).astype(np.uint8))
        return _paint_hulls(tinted, [pts[EYE_IMAGE_LEFT], pts[EYE_IMAGE_RIGHT], pts[LIPS]], (20, 40, 230))

    answer, answer_points, _ = _answer_from_crop(source, points, change)
    result = pa.paste_back(source, points, answer, answer_points)

    assert result.size == source.size
    before, after = np.asarray(source), np.asarray(result)
    touched = _region_mask(points, pad=_paste_reach(points))
    # Outside the eye and lip regions: every pixel exactly the original.
    assert np.array_equal(before[~touched], after[~touched])
    # Inside: the new eyes and lips are there.
    for index in (468, 473, 13):
        x, y = np.round(points[index]).astype(int)
        assert after[y, x, 2] > before[y, x, 2] + 60, index


def test_the_answers_relighting_is_matched_away():
    source = noisy_photo()
    points = face_points()

    def brighter(crop, pts):
        return Image.fromarray(np.clip(np.asarray(crop, dtype=np.int16) + 40, 0, 255).astype(np.uint8))

    answer, answer_points, _ = _answer_from_crop(source, points, brighter)
    result = pa.paste_back(source, points, answer, answer_points)
    mask = _region_mask(points, pad=2)
    before = np.asarray(source, dtype=np.float64)[mask].mean(axis=0)
    after = np.asarray(result, dtype=np.float64)[mask].mean(axis=0)
    # 40 levels brighter in the answer; within a few after the colour match.
    assert np.abs(after - before).max() < 6


def test_a_clean_answer_gets_the_photos_grain():
    from scipy.ndimage import gaussian_filter

    source = noisy_photo()
    points = face_points()

    def smooth(crop, pts):
        arr = np.asarray(crop, dtype=np.float64)
        return Image.fromarray(gaussian_filter(arr, sigma=(3, 3, 0)).astype(np.uint8))

    answer, answer_points, _ = _answer_from_crop(source, points, smooth)
    result = pa.paste_back(source, points, answer, answer_points)
    x0, y0 = np.floor(points[EYE_IMAGE_LEFT].min(axis=0)).astype(int)
    x1, y1 = np.ceil(points[EYE_IMAGE_LEFT].max(axis=0)).astype(int)
    luma = np.asarray(result.convert("L"), dtype=np.float64)[y0:y1, x0:x1]
    source_luma = np.asarray(source.convert("L"), dtype=np.float64)[y0:y1, x0:x1]
    grain = (luma - gaussian_filter(luma, 1.0)).std()
    source_grain = (source_luma - gaussian_filter(source_luma, 1.0)).std()
    assert grain > 0.5 * source_grain


def test_an_answer_the_model_shifted_and_turned_is_put_back_in_place():
    """The model returns the face a little moved, scaled and rotated. The
    stable landmarks carry the answer back onto the photo's own face."""
    source = smooth_photo()
    points = face_points()
    box = pa.face_crop_box(points)
    crop = pa.crop_face(source, box)
    in_crop = crop_points(points, box)
    angle, scale = math.radians(3.0), 1.04
    centre = np.array([CROP_SIZE / 2, CROP_SIZE / 2])
    rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    forward = np.hstack((scale * rotation, (centre - scale * rotation @ centre + [9.0, -6.0])[:, None]))
    inverse = pa._invert(forward)
    moved = crop.transform(
        crop.size, Image.Transform.AFFINE, tuple(inverse.reshape(-1)),
        resample=Image.Resampling.BICUBIC,
    )
    result = pa.paste_back(source, points, moved, pa.apply(forward, in_crop))
    mask = _region_mask(points, pad=1)
    error = np.abs(np.asarray(result, dtype=np.float64) - np.asarray(source, dtype=np.float64))[mask]
    assert error.mean() < 4.0


def test_an_answer_with_a_different_face_is_not_pasted():
    source = noisy_photo()
    points = face_points()
    answer, answer_points, _ = _answer_from_crop(source, points, lambda crop, pts: crop)
    warped = answer_points.copy()
    warped[:, 0] *= 1.3  # stretched: no similarity maps it back
    with pytest.raises(AdjustSkipped) as skipped:
        pa.paste_back(source, points, answer, warped)
    assert skipped.value.code == "alignment_failed"


# --- checks on candidates ------------------------------------------------------------


def test_a_touchup_candidate_is_pasted_and_checked(finder):
    source = noisy_photo()
    points = face_points()
    finder.by_size[(WIDTH, HEIGHT)] = points
    prepared = pa.prepare(png(source), pa.TOUCHUP, "human")
    finder.by_size[(CROP_SIZE, CROP_SIZE)] = crop_points(points, prepared.crop)

    candidate = pa.finish_candidate(png(source), prepared, prepared.payload, pa.TOUCHUP, "human")
    assert candidate.rejected is None, candidate.rejected
    assert (candidate.width, candidate.height) == (WIDTH, HEIGHT)
    assert candidate.checks["detected"] and candidate.checks["fit_ok"]
    assert candidate.checks["skin_delta_e"] < 1.0


def test_a_touchup_answer_without_a_face_is_rejected_with_no_image(finder):
    source = noisy_photo()
    finder.by_size[(WIDTH, HEIGHT)] = face_points()
    prepared = pa.prepare(png(source), pa.TOUCHUP, "human")
    candidate = pa.finish_candidate(png(source), prepared, prepared.payload, pa.TOUCHUP, "human")
    assert candidate.png is None
    assert candidate.rejected["code"] == "no_face_in_result"


def test_an_unreadable_answer_is_rejected():
    prepared = pa.Prepared(prompt="p", payload=b"", mime="image/jpeg")
    candidate = pa.finish_candidate(png(noisy_photo()), prepared, b"not an image",
                                    pa.REGENERATE, "animal")
    assert candidate.png is None and candidate.rejected["code"] == "unreadable_result"


def test_a_regenerated_person_whose_skin_changed_is_rejected(finder):
    source = noisy_photo()
    finder.by_size[(WIDTH, HEIGHT)] = face_points()
    recoloured = Image.fromarray(
        np.clip(np.asarray(source, dtype=np.int16) * [0.6, 0.9, 1.4], 0, 255).astype(np.uint8)
    )
    prepared = pa.Prepared(prompt="p", payload=b"", mime="image/jpeg")
    candidate = pa.finish_candidate(png(source), prepared, png(recoloured), pa.REGENERATE, "human")
    assert candidate.png is not None, "shown, with its reason"
    assert candidate.rejected["code"] == "skin_tone_changed"
    assert candidate.checks["skin_delta_e"] > pa.MAX_SKIN_DELTA_E


def test_a_regenerated_person_with_the_same_skin_passes(finder):
    source = noisy_photo()
    finder.by_size[(WIDTH, HEIGHT)] = face_points()
    brighter = Image.fromarray(np.clip(np.asarray(source, dtype=np.int16) + 12, 0, 255).astype(np.uint8))
    prepared = pa.Prepared(prompt="p", payload=b"", mime="image/jpeg")
    candidate = pa.finish_candidate(png(source), prepared, png(brighter), pa.REGENERATE, "human")
    assert candidate.rejected is None, candidate.rejected


def test_a_result_without_a_face_is_rejected_for_people_and_animations(finder):
    prepared = pa.Prepared(prompt="p", payload=b"", mime="image/jpeg")
    faceless = png(Image.new("RGB", (300, 300), (90, 90, 90)))
    for mode, line in ((pa.REGENERATE, "human"), (pa.STYLISE, "human"), (pa.REGENERATE, "cartoon")):
        candidate = pa.finish_candidate(png(noisy_photo()), prepared, faceless, mode, line)
        assert candidate.rejected["code"] == "no_face_in_result", (mode, line)
        assert candidate.png is not None


def test_an_animal_result_needs_no_detection(finder):
    prepared = pa.Prepared(prompt="p", payload=b"", mime="image/jpeg")
    candidate = pa.finish_candidate(
        png(noisy_photo()), prepared, png(Image.new("RGB", (300, 300), (90, 60, 30))),
        pa.REGENERATE, "animal",
    )
    assert candidate.rejected is None
    assert finder.calls == 0


def test_a_stylised_result_is_checked_as_an_animation_without_the_skin_guard(finder):
    """A drawing changes the colours by design; what matters is that the
    animation line can rig it."""
    source = noisy_photo()
    finder.by_size[(WIDTH, HEIGHT)] = face_points()
    finder.by_size[(512, 640)] = face_template.place((150, 130, 360, 450))
    drawn = Image.new("RGB", (512, 640), (40, 200, 90))
    prepared = pa.Prepared(prompt="p", payload=b"", mime="image/jpeg")
    candidate = pa.finish_candidate(png(source), prepared, png(drawn), pa.STYLISE, "human")
    assert candidate.rejected is None, candidate.rejected
    assert "skin_delta_e" not in candidate.checks


def test_a_huge_result_is_stored_no_larger_than_an_upload():
    prepared = pa.Prepared(prompt="p", payload=b"", mime="image/jpeg")
    candidate = pa.finish_candidate(
        png(noisy_photo()), prepared, png(Image.new("RGB", (4096, 2048), (9, 9, 9))),
        pa.REGENERATE, "animal",
    )
    assert max(candidate.width, candidate.height) == pa.STORED_MAX_EDGE


def test_generation_prompts_state_the_rigs_needs_for_every_line():
    for line in ("human", "animal", "cartoon"):
        for has_source in (False, True):
            text = pa.generation_prompt("anime", line, "a red fox", has_source)
            assert "a red fox" in text
            assert "anime" in text
    assert "animal" in pa.generation_prompt("photoreal", "animal", "", False)
    assert "Redraw the character" in pa.generation_prompt("photoreal", "cartoon", "", True)


def test_a_transparent_photo_keeps_its_transparency_through_a_touchup(finder):
    source = noisy_photo().convert("RGBA")
    alpha = np.full((HEIGHT, WIDTH), 255, dtype=np.uint8)
    alpha[:, :30] = 0
    source.putalpha(Image.fromarray(alpha))
    points = face_points()
    finder.by_size[(WIDTH, HEIGHT)] = points
    prepared = pa.prepare(png(source), pa.TOUCHUP, "human")
    finder.by_size[(CROP_SIZE, CROP_SIZE)] = crop_points(points, prepared.crop)
    candidate = pa.finish_candidate(png(source), prepared, prepared.payload, pa.TOUCHUP, "human")
    result = Image.open(io.BytesIO(candidate.png))
    assert result.mode == "RGBA"
    assert np.array_equal(np.asarray(result.getchannel("A")), alpha)
    # And, as every transparent PNG we store, nothing hides under alpha 0.
    assert (np.asarray(result)[:, :30, :3] == 0).all()


def _cut_out(image: Image.Image, alpha: np.ndarray) -> Image.Image:
    """`image` as a stored cut-out: `alpha`, and RGB zeroed under alpha 0."""
    from app.services.photo_io import scrub_transparent

    rgba = image.convert("RGBA")
    rgba.putalpha(Image.fromarray(alpha))
    return scrub_transparent(rgba)


def test_a_cutout_is_touched_up_on_grey_and_stays_the_same_cutout(finder):
    """The model sees the person on grey; the eyes and lips go back into the
    cut-out's own pixels; the transparency is not touched."""
    # The left edge and a band down the right side are background (removed):
    # the band runs through the face's crop, so the model's view of it is
    # checked, but not through the eyes or the lips.
    alpha = np.full((HEIGHT, WIDTH), 255, dtype=np.uint8)
    alpha[:, :40] = 0
    alpha[:, 330:360] = 0
    alpha[:, 328:330] = 128  # a soft edge
    cut = _cut_out(noisy_photo(), alpha)
    points = face_points()
    finder.by_size[(WIDTH, HEIGHT)] = points

    prepared = pa.prepare(png(cut), pa.TOUCHUP, "human")
    sent = np.asarray(_decode(prepared.payload), dtype=np.int16)
    x0, y0, side = prepared.crop
    band = int((335 - x0) * CROP_SIZE / side), int((355 - x0) * CROP_SIZE / side)
    shown = sent[CROP_SIZE // 2 - 50: CROP_SIZE // 2 + 50, band[0]:band[1]]
    assert np.abs(shown - 128).max() <= 6, "the removed background is shown as flat grey"

    def paint(crop, pts):
        return _paint_hulls(crop, [pts[EYE_IMAGE_LEFT], pts[EYE_IMAGE_RIGHT], pts[LIPS]],
                            (20, 40, 230))

    answer = paint(_decode(prepared.payload), crop_points(points, prepared.crop))
    finder.by_size[(CROP_SIZE, CROP_SIZE)] = crop_points(points, prepared.crop)
    candidate = pa.finish_candidate(png(cut), prepared, png(answer), pa.TOUCHUP, "human")
    assert candidate.rejected is None and candidate.cutout is True
    result = Image.open(io.BytesIO(candidate.png))
    assert result.mode == "RGBA"
    assert np.array_equal(np.asarray(result.getchannel("A")), alpha), "alpha untouched"

    before, after = np.asarray(cut)[..., :3], np.asarray(result)[..., :3]
    touched = _region_mask(points, pad=_paste_reach(points))
    # Outside the eyes and lips: the cut-out's own pixels to the bit (not the
    # grey composite the model saw), soft edge included; zero under alpha 0.
    assert np.array_equal(before[~touched], after[~touched])
    assert (after[alpha == 0] == 0).all()
    for index in (468, 473, 13):
        x, y = np.round(points[index]).astype(int)
        assert after[y, x, 2] > before[y, x, 2] + 60, index


def test_a_regenerated_cutout_comes_back_opaque(finder):
    alpha = np.full((HEIGHT, WIDTH), 255, dtype=np.uint8)
    alpha[:, :60] = 0
    cut = _cut_out(noisy_photo(), alpha)
    prepared = pa.prepare(png(cut), pa.REGENERATE, "human")
    sent = np.asarray(_decode(prepared.payload), dtype=np.int16)
    assert np.abs(sent[:, :20] - 128).max() <= 6
    answer = png(noisy_photo(seed=9))
    candidate = pa.finish_candidate(png(cut), prepared, answer, pa.REGENERATE, "animal")
    assert candidate.cutout is False
    assert Image.open(io.BytesIO(candidate.png)).mode == "RGB"


# --- brows, jaw, resampling ------------------------------------------------------------


BIG_W, BIG_H = 1400, 1600
BIG_BOX = (300.0, 250.0, 1100.0, 1250.0)  # an 800 px face


def _hairy_brows(image: Image.Image, points: np.ndarray, seed: int = 5) -> Image.Image:
    """Eyebrows drawn as hair: short dark 1-2 px strokes inside each brow
    contour, the texture whose edges a plain standard deviation reads as
    heavy grain."""
    rng = np.random.default_rng(seed)
    out = image.copy()
    draw = ImageDraw.Draw(out)
    for contour in (pa.BROW_IMAGE_LEFT, pa.BROW_IMAGE_RIGHT):
        polygon = points[contour]
        mask = pa._polygon_mask((image.height, image.width), [polygon])
        ys, xs = np.nonzero(mask)
        for i in rng.choice(len(xs), size=len(xs) // 6, replace=False):
            x, y = int(xs[i]), int(ys[i])
            dx, dy = rng.integers(3, 9), rng.integers(-3, 2)
            draw.line((x, y, x + dx, y + dy), fill=tuple(int(v) for v in rng.integers(30, 70, 3)),
                      width=int(rng.integers(1, 3)))
    return out


def _skin_grain(image: Image.Image, points: np.ndarray, eye: list[int]) -> float:
    """High-pass standard deviation of the skin just below one eye: between
    the lower lid and the bottom of the paste's feather."""
    from scipy.ndimage import gaussian_filter

    luma = np.asarray(image.convert("L"), dtype=np.float64)
    pts = points[eye]
    width = float(np.ptp(pts[:, 0]))
    x0, x1 = int(pts[:, 0].min() + 0.2 * width), int(pts[:, 0].max() - 0.2 * width)
    y0 = int(pts[:, 1].max() + 0.05 * width)
    y1 = int(pts[:, 1].max() + 0.20 * width)
    detail = luma - gaussian_filter(luma, 1.0)
    return float(detail[y0:y1, x0:x1].std())


def test_hairy_brows_are_not_taken_for_grain_nor_pasted(finder):
    """An answer identical to what was sent must change (almost) nothing,
    even with textured brows at the edge of the eye regions: the grain is
    measured robustly, on skin, and nothing lands on a brow."""
    rng = np.random.default_rng(11)
    base = np.full((BIG_H, BIG_W, 3), (196, 150, 122), dtype=np.float64)
    base += rng.normal(0, 1.5, size=base.shape)  # a clean, modern phone photo
    points = face_template.place(BIG_BOX)
    source = _hairy_brows(Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)), points)
    finder.by_size[(BIG_W, BIG_H)] = points
    prepared = pa.prepare(png(source), pa.TOUCHUP, "human")
    finder.by_size[(CROP_SIZE, CROP_SIZE)] = crop_points(points, prepared.crop)

    candidate = pa.finish_candidate(png(source), prepared, prepared.payload, pa.TOUCHUP, "human")
    assert candidate.rejected is None, candidate.rejected
    result = Image.open(io.BytesIO(candidate.png)).convert("RGB")
    for eye in (EYE_IMAGE_LEFT, EYE_IMAGE_RIGHT):
        before, after = _skin_grain(source, points, eye), _skin_grain(result, points, eye)
        # A std-based estimate took the brow hairs for grain and added noise
        # four to eight times the photo's own here.
        assert after < 1.4 * before + 0.3, (before, after)
    brows = pa._polygon_mask(
        (BIG_H, BIG_W), [points[pa.BROW_IMAGE_LEFT], points[pa.BROW_IMAGE_RIGHT]]
    )
    assert np.array_equal(np.asarray(source)[brows], np.asarray(result)[brows])


def test_brows_the_answer_moved_are_neither_pasted_nor_measured():
    """Opening closed eyes often raises the brows. The raised brow must not
    come along (the photo's brow would then show twice), and its new place
    must not be measured as skin (the eye patch would be relit by it)."""
    source = noisy_photo()
    points = face_points()

    def raised(crop, pts):
        # The answer's brows, painted dark and moved up a tenth of an eye.
        eye_width = float(np.ptp(pts[EYE_IMAGE_LEFT][:, 0]))
        moved = pts.copy()
        for contour in (pa.BROW_IMAGE_LEFT, pa.BROW_IMAGE_RIGHT):
            moved[contour, 1] -= 0.1 * eye_width
        out = crop.copy()
        draw = ImageDraw.Draw(out)
        for contour in (pa.BROW_IMAGE_LEFT, pa.BROW_IMAGE_RIGHT):
            draw.polygon([tuple(p) for p in moved[contour].tolist()], fill=(40, 30, 25))
        raised.points = moved
        return out

    answer, _, (x0, y0, side) = _answer_from_crop(source, points, raised)
    result = pa.paste_back(source, points, answer, raised.points)
    before, after = np.asarray(source, dtype=np.float64), np.asarray(result, dtype=np.float64)
    in_photo = raised.points * (side / CROP_SIZE) + np.array([x0, y0])
    moved_brows = pa._polygon_mask(
        (HEIGHT, WIDTH), [in_photo[pa.BROW_IMAGE_LEFT], in_photo[pa.BROW_IMAGE_RIGHT]]
    )
    assert moved_brows.sum() > 50
    # None of the dark brow the answer drew is pasted.
    assert np.abs(after[moved_brows] - before[moved_brows]).max() < 1
    # And the eye patch keeps the photo's light.
    around = _region_mask(points, pad=2) & ~_region_mask(points, pad=0)
    assert abs(after[around].mean() - before[around].mean()) < 2.0


def test_the_lip_ring_measures_only_skin_inside_both_faces():
    """Where the ring crosses out of the face (neck, shadow, backdrop), the
    photo and the answer disagree for reasons that are not relighting; the
    colour offset must come from skin inside both faces."""
    size = 200
    # Both faces end just under the upper lip here (a raised answer jaw,
    # say): below that the photo shows a bright neck the answer does not.
    window_face = np.array([[5.0, 5.0], [195.0, 5.0], [195.0, 90.0], [5.0, 90.0]])
    source = np.full((size, size, 3), 150, dtype=np.uint8)
    source[90:, :] = 250
    answer = Image.new("RGB", (size, size), (150, 150, 150))
    lips = np.array([[70.0, 95.0], [130.0, 95.0], [130.0, 105.0], [70.0, 105.0]])
    out = source.copy()
    region = pa.Region("lips", lips, lips, pa.LIP_DILATE, pa.LIP_FEATHER,
                       within=(window_face, window_face))
    pa._paste_region(out, source, answer, np.hstack((np.eye(2), np.zeros((2, 1)))), region,
                     np.random.default_rng(0))
    # The middle of the lips: the answer's 150, not shifted toward the neck.
    assert abs(float(out[100, 100].mean()) - 150) < 3


def test_an_answer_whose_jaw_moved_is_not_pasted():
    source = noisy_photo()
    points = face_points()
    height = float(np.ptp(points[:, 1]))

    def dropped(by: float):
        answer, answer_points, box = _answer_from_crop(source, points, lambda crop, pts: crop)
        moved = answer_points.copy()
        # The chin rises: the lower oval moves up, in crop pixels.
        moved[pa.CHIN, 1] -= by * height * CROP_SIZE / box[2]
        return answer, moved

    answer, moved = dropped(0.06)
    with pytest.raises(AdjustSkipped) as skipped:
        pa.paste_back(source, points, answer, moved)
    assert skipped.value.code == "jaw_moved"
    # Parted lips closing move it far less, and are pasted.
    answer, moved = dropped(0.02)
    assert pa.paste_back(source, points, answer, moved).size == source.size


def _stripes(width: int, height: int) -> np.ndarray:
    """1 px horizontal lines, dark and light: detail finer than any shrink
    can keep, which must average out, not alias."""
    rows = np.where(np.arange(height) % 2 == 0, 20.0, 236.0)
    return np.repeat(rows[:, None], width, axis=1)


def test_a_shrunk_answer_is_averaged_not_aliased():
    """A small face: the 1024 px answer is shrunk more than twice onto the
    photo. Lashes and iris texture finer than the photo's pixels must blend
    to their average, not come out jagged at full contrast."""
    source = Image.new("RGB", (WIDTH, HEIGHT), (128, 128, 128))
    box = (160.0, 150.0, 240.0, 270.0)  # a 120 px tall face
    points = face_points(box)
    answer, answer_points, crop_box = _answer_from_crop(source, points, lambda crop, pts: crop)
    assert CROP_SIZE / crop_box[2] > 2
    arr = np.asarray(answer, dtype=np.float64).copy()
    lines = _stripes(CROP_SIZE, CROP_SIZE)
    eyes = pa._hull_mask((CROP_SIZE, CROP_SIZE), [answer_points[EYE_IMAGE_LEFT],
                                                   answer_points[EYE_IMAGE_RIGHT]])
    arr[eyes] = lines[eyes][:, None]
    striped = Image.fromarray(arr.astype(np.uint8))
    result = np.asarray(pa.paste_back(source, points, striped, answer_points).convert("L"),
                        dtype=np.float64)
    inside = pa._hull_mask((HEIGHT, WIDTH), [points[EYE_IMAGE_LEFT], points[EYE_IMAGE_RIGHT]])
    from scipy.ndimage import binary_erosion

    core = binary_erosion(inside, iterations=1)
    assert core.sum() > 20
    # Aliased, this measured a std of about 45 (values 20 to 150).
    assert result[core].std() < 8, result[core].std()


def test_a_large_face_is_cropped_without_aliasing():
    """A face wider than about 640 px makes a crop larger than the model's
    1024: the shrink must average 1 px strands, not turn them into moire."""
    image = Image.fromarray(_stripes(1800, 1800).astype(np.uint8)).convert("RGB")
    crop = np.asarray(pa.crop_face(image, (0.0, 0.0, 1800.0)).convert("L"), dtype=np.float64)
    assert crop.shape == (CROP_SIZE, CROP_SIZE)
    # A 4-tap bicubic shrink kept these at a std of about 55.
    assert crop[10:-10, 10:-10].std() < 5, crop.std()
