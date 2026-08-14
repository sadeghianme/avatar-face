"""Viseme keyframes: alignment, and the checks that reject a bad frame."""

import io

import numpy as np
from PIL import Image

from app.services.visemeframes import STABLE_LANDMARKS, _similarity, build_frame


def test_similarity_recovers_a_known_transform():
    """The whole feature rests on this: a generated face comes back shifted
    and slightly rescaled, and the mouth patch must land where the mouth is."""
    rng = np.random.default_rng(0)
    src = rng.uniform(0, 200, size=(8, 2))
    angle = 0.12
    rot = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    dst = (1.07 * (rot @ src.T).T) + np.array([13.0, -7.0])

    scale, fitted_rot, offset = _similarity([tuple(p) for p in src], [tuple(p) for p in dst])
    assert abs(scale - 1.07) < 1e-6
    assert np.allclose(fitted_rot, rot, atol=1e-6)
    assert np.allclose(offset, [13.0, -7.0], atol=1e-6)


def _mesh(offset=(0.0, 0.0), scale=1.0):
    """A 478-point mesh whose stable landmarks sit at known places."""
    points = np.zeros((478, 2), dtype=np.float64)
    rng = np.random.default_rng(1)
    points[:] = rng.uniform(40, 160, size=(478, 2))
    anchors = {33: (60, 80), 133: (90, 80), 263: (140, 80), 362: (110, 80),
               168: (100, 70), 6: (100, 85), 197: (100, 95), 195: (100, 105)}
    for index, (x, y) in anchors.items():
        points[index] = (x * scale + offset[0], y * scale + offset[1])
    return points


def test_a_frame_shifted_too_far_is_rejected(monkeypatch):
    """A model that returns a differently-framed picture is not a mouth
    change, and blending it would jerk the mouth across the face."""
    from app.services import visemeframes

    base = _mesh()
    moved = _mesh(offset=(90.0, 0.0))  # way beyond MAX_ALIGN_SHIFT of 200px
    monkeypatch.setattr(
        visemeframes, "landmarks_from_image", lambda data: (moved, None, (200, 200), True),
        raising=False,
    )
    import app.services.rig as rig_module

    monkeypatch.setattr(
        rig_module, "landmarks_from_image", lambda data: (moved, None, (200, 200), True)
    )

    buf = io.BytesIO()
    Image.new("RGB", (200, 200), (120, 100, 90)).save(buf, format="PNG")
    assert build_frame(buf.getvalue(), base, (200, 200)) is None


def test_an_undetected_face_is_rejected(monkeypatch):
    import app.services.rig as rig_module

    base = _mesh()
    monkeypatch.setattr(
        rig_module, "landmarks_from_image", lambda data: (base, None, (200, 200), False)
    )
    buf = io.BytesIO()
    Image.new("RGB", (200, 200), (120, 100, 90)).save(buf, format="PNG")
    assert build_frame(buf.getvalue(), base, (200, 200)) is None


def test_an_aligned_frame_yields_a_patch_on_the_mouth(monkeypatch):
    import app.services.rig as rig_module

    base = _mesh()
    # Same face, nudged a few pixels — the realistic case.
    got = _mesh(offset=(4.0, -3.0))
    monkeypatch.setattr(
        rig_module, "landmarks_from_image", lambda data: (got, None, (200, 200), True)
    )
    buf = io.BytesIO()
    Image.new("RGB", (200, 200), (120, 100, 90)).save(buf, format="PNG")

    built = build_frame(buf.getvalue(), base, (200, 200))
    assert built is not None
    png, box = built
    assert box["w"] > 8 and box["h"] > 8
    # The patch must be a real image of the stated size.
    patch = Image.open(io.BytesIO(png))
    assert patch.size == (box["w"], box["h"])


def test_stable_landmarks_exclude_the_mouth():
    """If a mouth point crept into the fit, changing the mouth would drag the
    alignment toward it and every frame would sit slightly wrong."""
    from app.services.rig import MOUTH_INDICES

    assert not set(STABLE_LANDMARKS) & set(MOUTH_INDICES)


async def test_generate_raw_returns_image_bytes(monkeypatch):
    """A field-name slip here is invisible until it has already spent money:
    the provider call succeeds and is billed, then unpacking the response
    raises. Cheap to assert, so assert it."""
    from app.services import imagegen

    monkeypatch.setattr(
        imagegen, "_request", lambda *a, **k: _generated(), raising=True
    )
    out = await imagegen.generate_raw("prompt")
    assert out == b"PNGDATA"


async def _generated():
    from app.services.imagegen import Generated

    return Generated(b"PNGDATA", "image/png")


def test_a_differently_sized_generation_is_not_read_as_reframing(monkeypatch):
    """Providers answer at their own resolution. Treating that ratio as a
    framing change rejected every real frame — the whole feature produced
    nothing until the landmarks were normalised to the base photo first."""
    import app.services.rig as rig_module

    base = _mesh()  # in a 200x200 photo
    half = _mesh(scale=0.5)  # same face, returned at 100x100
    monkeypatch.setattr(
        rig_module, "landmarks_from_image", lambda data: (half, None, (100, 100), True)
    )
    buf = io.BytesIO()
    Image.new("RGB", (100, 100), (120, 100, 90)).save(buf, format="PNG")

    built = build_frame(buf.getvalue(), base, (200, 200))
    assert built is not None, "a rescaled generation is the same face, not a new framing"
