import numpy as np

from app.services.rig import (
    INNER_LIP_RING,
    NUM_LANDMARKS,
    OCULUS_VISEMES,
    VISEME_BLENDSHAPES,
    build_rig,
    make_thumbnail,
    synthetic_face_mesh,
)
from tests.conftest import sample_png


def test_synthetic_mesh_shape():
    points = synthetic_face_mesh(400, 500)
    assert points.shape == (NUM_LANDMARKS, 2)
    assert np.all(np.isfinite(points))


def test_synthetic_mesh_inside_image():
    width, height = 400, 500
    points = synthetic_face_mesh(width, height)
    assert points[:, 0].min() >= 0 and points[:, 0].max() <= width
    assert points[:, 1].min() >= 0 and points[:, 1].max() <= height


def test_synthetic_mesh_deterministic():
    a = synthetic_face_mesh(400, 500)
    b = synthetic_face_mesh(400, 500)
    assert np.array_equal(a, b)


def test_inner_lip_ring_on_mouth():
    """The cavity clip paints across the face if the ring is misplaced."""
    points = synthetic_face_mesh(400, 500)
    ring = points[INNER_LIP_RING]
    face_cy = points[:, 1].mean()
    assert ring[:, 1].mean() > face_cy  # below face center
    # Tight cluster: ring extent well under face extent
    assert np.ptp(ring[:, 0]) < np.ptp(points[:, 0]) * 0.5
    assert np.ptp(ring[:, 1]) < np.ptp(points[:, 1]) * 0.2


def test_build_rig_triangulation():
    points = synthetic_face_mesh(400, 500)
    rig = build_rig(points, (400, 500))
    triangles = np.array(rig["triangles"])
    assert triangles.min() >= 0 and triangles.max() < NUM_LANDMARKS
    assert len(triangles) > 800  # Delaunay over 478 points


def test_rig_has_all_15_visemes():
    points = synthetic_face_mesh(400, 500)
    rig = build_rig(points, (400, 500))
    assert sorted(rig["visemes"]) == sorted(OCULUS_VISEMES)
    for weights in rig["visemes"].values():
        for value in weights.values():
            assert 0.0 <= value <= 1.0


def test_viseme_blendshapes_distinguish_open_closed():
    assert VISEME_BLENDSHAPES["aa"]["jawOpen"] > 0.7
    assert VISEME_BLENDSHAPES["PP"]["mouthClose"] > 0.7
    assert VISEME_BLENDSHAPES["ou"]["mouthPucker"] > 0.7
    assert VISEME_BLENDSHAPES["sil"]["jawOpen"] == 0.0


def test_thumbnail_max_256():
    from PIL import Image
    import io

    thumb = make_thumbnail(sample_png())
    img = Image.open(io.BytesIO(thumb))
    assert max(img.size) <= 256
    assert img.format == "JPEG"
