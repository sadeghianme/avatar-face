"""head3d: the 3D head built from one picture and its landmarks.

Pure geometry on synthetic faces (no MediaPipe, no node), the GLB writer
read back, and the whole build on a synthetic subject. The node bake runs
only where node and the embed fixture rig are available.
"""

from __future__ import annotations

import json
import shutil
import struct
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services.head3d import geometry as G
from app.services.head3d import texture as X
from app.services.head3d import topology as T
from app.services.head3d.bake import BAKED_SYMMETRIC, validate
from app.services.head3d.build import HeadSubject, build_head, interior_for
from app.services.head3d.gltf import GlbBuilder, read_accessor, read_glb
from app.services.rig import VISEME_BLENDSHAPES, build_rig

REPO = Path(__file__).resolve().parents[2]
HUMAN_RIG = REPO / "embed/src/__tests__/fixtures/human-rig.json"

# --- Synthetic subjects -----------------------------------------------------------


def canonical_face(size: int = 512) -> tuple[np.ndarray, np.ndarray]:
    """The canonical face placed in a picture: (points (478, 2) px,
    MediaPipe-style z (478,) px, negative toward the camera)."""
    shape = T.canonical_shape()
    xy = shape[:, :2]
    span = xy[:, 0].max() - xy[:, 0].min()
    scale = size * 0.5 / span
    points = np.column_stack((size / 2 + xy[:, 0] * scale, size * 0.5 - xy[:, 1] * scale))
    z = -shape[:, 2] * scale
    points = np.vstack(
        (
            points,
            np.tile(points[[468 - 1]], (10, 1)) if False else np.repeat(points[[133]], 10, axis=0),
        )
    )
    z = np.concatenate((z, np.full(10, z[133])))
    return points, z


def cut_out_picture(size: int = 512) -> Image.Image:
    """A head-and-shoulders silhouette on transparency: a disc for the head,
    a block for the body, a gradient inside so sampling positions matter."""
    y, x = np.mgrid[0:size, 0:size]
    head = ((x - size / 2) ** 2 + (y - size * 0.45) ** 2) < (size * 0.36) ** 2
    body = (y > size * 0.72) & (np.abs(x - size / 2) < size * 0.42)
    alpha = (head | body).astype(np.float32)
    rgb = np.stack((x / size, y / size, np.full_like(x, 0.5, dtype=np.float64)), axis=-1)
    return X.to_image(np.concatenate((rgb, alpha[..., None]), axis=-1))


def synthetic_bake(points: np.ndarray) -> dict:
    """A bake with a jaw that drops the lower lip and the chin, a stretch
    that widens, a blink that lowers the lids, every other target still."""
    n = T.NUM_LANDMARKS
    zero = {"at": 1.0, "dx": [0.0] * n, "dy": [0.0] * n}
    targets = {name: json.loads(json.dumps(zero)) for name in BAKED_SYMMETRIC}
    for row in T.LOWER_LIP_ROWS:
        for i in row:
            targets["jawOpen"]["dy"][i] = 20.0
    targets["jawOpen"]["dy"][T.CHIN] = 14.0
    for i in T.LIP_CORNERS:
        targets["mouthStretch"]["dx"][i] = 8.0 if points[i, 0] > points[:, 0].mean() else -8.0
    for i in (159, 386):
        targets["eyeBlink"]["dy"][i] = 6.0
    visemes = {}
    for viseme, weights in VISEME_BLENDSHAPES.items():
        dx = np.zeros(n)
        dy = np.zeros(n)
        for key, w in weights.items():
            if key in targets:
                dx += np.array(targets[key]["dx"]) * w
                dy += np.array(targets[key]["dy"]) * w
        visemes[viseme] = {"at": 1.0, "dx": dx.tolist(), "dy": dy.tolist()}
    return {
        "version": 1,
        "image_size": [512, 512],
        "profile": None,
        "scale": 1.0,
        "targets": targets,
        "visemes": visemes,
        "fidelity": {},
    }


@pytest.fixture(scope="module")
def face():
    points, z = canonical_face()
    return points, z


@pytest.fixture(scope="module")
def frame(face):
    return G.face_frame(face[0])


@pytest.fixture(scope="module")
def model(face, frame):
    points, z = face
    relief, _ = G.calibrate_depth(points, z)
    pivot = G.head_pivot(points, relief)
    scale = G.model_scale(frame)
    return G.to_model(points, relief, pivot, scale), pivot, scale


# --- Topology -------------------------------------------------------------------


def test_the_canonical_mesh_is_mediapipes():
    assert T.canonical_shape().shape == (468, 3)
    assert T.canonical_uv().shape == (468, 2)
    assert T.canonical_triangles().shape == (898, 3)
    assert T.mouth_fill_triangles().shape == (18, 3)
    assert T.face_triangles().shape == (880, 3)
    # Every face triangle is one of the canonical ones and none closes the mouth.
    inner = set(T.INNER_LIP_RING)
    assert all(not inner.issuperset(tri.tolist()) for tri in T.face_triangles())


def test_the_face_has_the_oval_and_the_mouth_as_its_only_edges():
    from collections import Counter

    edges = Counter()
    for a, b, c in T.face_triangles():
        for e in ((a, b), (b, c), (c, a)):
            edges[tuple(sorted((int(e[0]), int(e[1]))))] += 1
    boundary = {v for e, n in edges.items() if n == 1 for v in e}
    assert boundary == set(T.FACE_OVAL) | set(T.INNER_LIP_RING)


def test_neighbours_follow_the_triangles():
    neighbours = T.vertex_neighbours()
    assert len(neighbours) == T.NUM_LANDMARKS
    assert all(len(neighbours[i]) == 0 for i in range(468, 478))
    assert 338 in neighbours[10] and 10 in neighbours[338]


# --- Depth, frame, spaces -----------------------------------------------------------


def test_depth_is_calibrated_to_the_nose_protrusion(face):
    points, z = face
    frame = G.face_frame(points)
    relief, scale = G.calibrate_depth(points, z * 3.7)  # whatever MediaPipe's scale was
    cheek = relief[T.CHEEK_LANDMARKS].mean()
    assert cheek == pytest.approx(0.0, abs=1e-9)
    assert relief[T.NOSE_TIP] - cheek == pytest.approx(G.NOSE_PROTRUSION * frame.width)
    assert relief[T.EAR_LEFT] < relief[T.NOSE_TIP]  # the ears are behind the nose
    assert scale > 0


def test_a_flat_face_is_refused(face):
    points, z = face
    with pytest.raises(ValueError):
        G.calibrate_depth(points, np.zeros_like(z))


def test_smoothing_touches_the_oval_only(face):
    points, z = face
    relief, _ = G.calibrate_depth(points, z)
    noisy = relief.copy()
    rng = np.random.default_rng(1)
    noisy[T.FACE_OVAL] += rng.normal(0, 8.0, len(T.FACE_OVAL))
    smooth = G.smooth_oval_depth(noisy)
    oval_error_before = np.abs(noisy[T.FACE_OVAL] - relief[T.FACE_OVAL]).mean()
    oval_error_after = np.abs(smooth[T.FACE_OVAL] - relief[T.FACE_OVAL]).mean()
    assert oval_error_after < oval_error_before * 0.7
    # No bias: the rim stays where it was on average, it does not creep forward.
    assert abs(smooth[T.FACE_OVAL].mean() - relief[T.FACE_OVAL].mean()) < 1.0
    untouched = [i for i in range(468) if i not in set(T.FACE_OVAL)]
    assert np.array_equal(smooth[untouched], noisy[untouched])
    assert smooth[T.NOSE_TIP] == noisy[T.NOSE_TIP]


def test_the_head_frame_is_metres_about_the_ears(face, frame, model):
    points, z = face
    positions, pivot, scale = model
    ears = positions[[T.EAR_LEFT, T.EAR_RIGHT]]
    assert np.allclose(ears.mean(axis=0), 0.0, atol=1e-9)
    assert abs(ears[1, 0] - ears[0, 0]) == pytest.approx(G.FACE_WIDTH_M)
    assert positions[T.FOREHEAD, 1] > 0 > positions[T.CHIN, 1]  # y up
    assert positions[T.NOSE_TIP, 2] > positions[T.EAR_LEFT, 2]  # z toward the camera
    back = G.to_image(positions, pivot, scale)
    assert np.allclose(back, points, atol=1e-9)


# --- The skull ---------------------------------------------------------------------


def test_the_skull_fits_the_face_and_the_hair(face, frame, model):
    positions, pivot, scale = model
    forehead = positions[T.FOREHEAD, 1]
    face_h = frame.height * scale
    fit = G.fit_skull(positions, frame, scale, hair_top_y=0.0)  # hair to the picture's top edge
    assert fit.b_top == pytest.approx(
        min(
            max((frame.ear_y - 0.0) * scale, forehead + G.CROWN_ABOVE_FOREHEAD[0] * face_h),
            forehead + G.CROWN_ABOVE_FOREHEAD[1] * face_h,
        )
    )
    tall = G.fit_skull(positions, frame, scale, hair_top_y=-5000.0)  # hair far above the picture
    assert tall.b_top == pytest.approx(forehead + G.CROWN_ABOVE_FOREHEAD[1] * face_h)  # clamped
    assert fit.b_bottom == pytest.approx(-positions[T.CHIN, 1])
    assert fit.a_x == pytest.approx(G.HEAD_BREADTH * G.FACE_WIDTH_M / 2)
    assert np.all(fit.k >= 1.0)  # nothing pulls in without a silhouette; the face edge may push out
    assert np.allclose(fit.equator[:, 2], 0.0)
    no_hair = G.fit_skull(positions, frame, scale, None)
    assert no_hair.b_top == pytest.approx(forehead + 0.4 * face_h)


def test_the_skull_never_leaves_the_silhouette(face, frame, model):
    positions, pivot, scale = model
    # A silhouette just outside the face at the sides and well inside the
    # ellipse's crown: the top columns are pulled in, the sides stay.
    reach = np.full(len(T.FACE_OVAL), 0.08)
    fit = G.fit_skull(positions, frame, scale, None, silhouette=reach)
    radius = np.linalg.norm(fit.equator[:, :2], axis=1)
    oval_r = np.einsum("ij,ij->i", fit.oval[:, :2], fit.equator[:, :2] / radius[:, None])
    floor = oval_r * G.EQUATOR_PAST_OVAL
    assert np.all(radius <= np.maximum(reach - G.SILHOUETTE_MARGIN * G.FACE_WIDTH_M, floor) + 1e-9)
    assert np.all(radius >= floor - 1e-9)  # never inside the face edge
    assert np.any(fit.k < 1.0)
    free = G.fit_skull(positions, frame, scale, None)
    free_r = np.linalg.norm(free.equator[:, :2], axis=1)
    assert np.all(free_r >= floor - 1e-9)  # the generic ellipse clears the face edge too
    top = T.FACE_OVAL.index(T.FOREHEAD)
    assert fit.k[top] < 1.0
    back = G.back_ring(fit, 0.5)
    assert np.linalg.norm(back[top, :2]) < np.linalg.norm(
        G.back_ring(free, 0.5)[top, :2]
    )  # the back follows the pull


def test_the_skull_mesh_starts_at_the_face_edge_and_faces_outward(face, frame, model):
    positions, pivot, scale = model
    fit = G.fit_skull(positions, frame, scale, None)
    skull = G.skull_mesh(fit)
    columns = len(T.FACE_OVAL) + 1
    rings = G.SKIRT_RINGS + G.BACK_RINGS
    assert len(skull.positions) == columns * rings + 1
    assert np.allclose(skull.positions[: columns - 1], positions[T.FACE_OVAL], atol=1e-6)
    assert np.allclose(
        skull.positions[columns - 1], positions[T.FACE_OVAL[0]], atol=1e-6
    )  # the wrap column
    assert skull.skirt_share[0] == 1.0 and skull.skirt_share[columns * G.SKIRT_RINGS] == 0.0
    assert skull.column[-1] == -1 and skull.s[-1] == 1.0
    p = skull.positions.astype(float)
    tri = skull.triangles.astype(int)
    normals = np.cross(p[tri[:, 1]] - p[tri[:, 0]], p[tri[:, 2]] - p[tri[:, 0]])
    outward = (p[tri[:, 0]] + p[tri[:, 1]] + p[tri[:, 2]]) / 3 - np.array((0, 0, -0.4 * fit.c))
    assert np.all(np.einsum("ij,ij->i", normals, outward) > 0)
    assert skull.uvs[:, 0].min() == 0.0 and skull.uvs[:columns, 0].max() == 1.0


def test_the_skirt_follows_the_face_edge_by_its_share(face, frame, model):
    positions, pivot, scale = model
    skull = G.skull_mesh(G.fit_skull(positions, frame, scale, None))
    delta = np.zeros((T.NUM_LANDMARKS, 3))
    delta[T.CHIN] = (0, -0.01, -0.003)
    morph = G.skirt_morph(skull, delta)
    chin_column = T.FACE_OVAL.index(T.CHIN)
    columns = len(T.FACE_OVAL) + 1
    assert np.allclose(morph[chin_column], delta[T.CHIN])
    assert np.allclose(
        morph[columns * G.SKIRT_RINGS + chin_column], 0.0
    )  # the equator stands still
    assert np.allclose(morph[columns * (G.SKIRT_RINGS + 1) :], 0.0)  # the back too
    assert np.count_nonzero(morph.any(axis=1)) == G.SKIRT_RINGS  # only the chin's column moves


# --- Neck and cards ---------------------------------------------------------------


def test_the_neck_sits_behind_the_hair_card(face, frame, model):
    positions, pivot, scale = model
    card_z = -0.01
    neck = G.neck_mesh(positions, frame, scale, card_z)
    assert neck.positions[:, 2].max() <= card_z - G.NECK_BEHIND_CARD * G.FACE_WIDTH_M + 1e-6
    assert neck.positions[:, 1].max() > positions[T.CHIN, 1] > neck.positions[:, 1].min()
    assert len(neck.triangles) == 2 * G.NECK_SEGMENTS * 3


def test_a_card_is_a_quad_over_its_box_facing_the_camera(model):
    positions, pivot, scale = model
    card = G.card_mesh((10, 20, 110, 220), -0.05, pivot, scale)
    assert card.positions.shape == (4, 3) and np.allclose(card.positions[:, 2], -0.05)
    assert np.allclose(
        G.to_image(card.positions, pivot, scale), [(10, 20), (110, 20), (110, 220), (10, 220)]
    )
    p = card.positions.astype(float)
    for a, b, c in card.triangles:
        assert np.cross(p[b] - p[a], p[c] - p[a])[2] > 0


def test_the_head_box_is_the_2d_engines(frame):
    x0, y0, x1, y1 = G.head_box(frame, (512, 512))
    bx0, by0, bx1, by1 = frame.box
    assert x0 == pytest.approx(max(0, bx0 - (bx1 - bx0) * G.HEAD_BOX_SIDE))
    assert y1 == pytest.approx(min(512, by1 + (by1 - by0) * G.HEAD_BOX_BELOW))


# --- Morph rules ----------------------------------------------------------------------


def test_sides_split_a_symmetric_target_into_a_whole(face, frame):
    points, _ = face
    left = G.side_weights(points, frame)
    assert left[T.EAR_RIGHT] == pytest.approx(1.0)  # image right is the subject's left
    assert left[T.EAR_LEFT] == pytest.approx(0.0)
    delta = np.random.default_rng(0).normal(size=(T.NUM_LANDMARKS, 3))
    a, b = G.split_sides(delta, left)
    assert np.allclose(a + b, delta)


def test_the_jaw_moves_back_as_it_drops(face, frame):
    points, _ = face
    dy = np.zeros(T.NUM_LANDMARKS)
    dy[T.CHIN] = 10.0  # image px, down
    delta = G.morph_delta("jawOpen", np.zeros(T.NUM_LANDMARKS), dy, points, frame, 0.001)
    assert delta[T.CHIN, 1] == pytest.approx(-0.01)
    assert delta[T.CHIN, 2] == pytest.approx(-G.JAW_BACK * 0.01)
    assert np.allclose(delta[T.FOREHEAD], 0.0)


def test_a_pucker_brings_the_lips_forward_and_a_smile_pulls_the_corners_back(face, frame):
    points, _ = face
    zero = np.zeros(T.NUM_LANDMARKS)
    pucker = G.morph_delta("mouthPucker", zero, zero, points, frame, 0.001)
    assert pucker[T.UPPER_INNER_LIP, 2] > pucker[T.MOUTH_LEFT, 2] > 0
    assert pucker[T.FOREHEAD, 2] == 0.0
    dx = np.zeros(T.NUM_LANDMARKS)
    dx[T.MOUTH_RIGHT] = 5.0
    smile = G.morph_delta("mouthSmile", dx, zero, points, frame, 0.001)
    assert smile[T.MOUTH_RIGHT, 2] == pytest.approx(-G.CORNER_RECESS * 0.005)


def test_a_viseme_shape_takes_the_rules_by_its_weights(face, frame):
    points, _ = face
    zero = np.zeros(T.NUM_LANDMARKS)
    dy = zero.copy()
    dy[T.CHIN] = 10.0
    shape = G.viseme_delta(zero, dy, {"jawOpen": 0.5, "mouthPucker": 0.5}, points, frame, 0.001)
    assert shape[T.CHIN, 2] == pytest.approx(
        -G.JAW_BACK * 0.01
        + 0.5
        * G.LIP_PROTRUSION["mouthPucker"]
        * frame.mouth_width
        * 0.001
        * G.lip_forward_weights(points, frame)[T.CHIN]
    )
    assert shape[T.UPPER_INNER_LIP, 2] > 0


# --- The surface and the mouth interior ----------------------------------------------------


def test_the_surface_is_found_under_a_point(model):
    positions, _, _ = model
    at_vertex = G.surface_depth(positions, positions[[T.NOSE_TIP], :2])
    assert at_vertex[0] == pytest.approx(positions[T.NOSE_TIP, 2], abs=1e-6)
    a, b, c = T.face_triangles()[0]
    centre = positions[[a, b, c]].mean(axis=0)
    assert G.surface_depth(positions, centre[None, :2])[0] == pytest.approx(centre[2], abs=1e-6)
    far = np.array([[10.0, 10.0]])
    indices, weights = G.surface_weights(positions, far)
    assert weights[0].tolist() == [1.0, 0.0, 0.0]  # the nearest vertex alone


def test_the_mouth_interior_hides_behind_the_face(model):
    positions, _, _ = model
    for teeth, tongue, names in (
        ("both", True, {"Cavity", "TeethUpper", "TeethLower", "Tongue"}),
        ("upper", True, {"Cavity", "TeethUpper", "Tongue"}),
        ("none", False, {"Cavity"}),
    ):
        parts = G.mouth_interior(positions, teeth, tongue)
        assert {p.name for p in parts} == names
        for part in parts:
            depth = G.surface_depth(positions, part.mesh.positions[:, :2])
            assert np.all(part.mesh.positions[:, 2] < depth + 1e-9), part.name
    with pytest.raises(ValueError):
        G.mouth_interior(positions, "lower", True)


def test_interior_parts_follow_the_face_as_they_should(model):
    positions, _, _ = model
    parts = {p.name: p for p in G.mouth_interior(positions, "both", True)}
    targets = {
        "jawOpen": np.zeros((T.NUM_LANDMARKS, 3)),
        "viseme_aa": np.zeros((T.NUM_LANDMARKS, 3)),
    }
    targets["jawOpen"][:, 1] = -0.004
    targets["jawOpen"][T.CHIN] = (0, -0.01, -0.003)
    cavity = dict(G.interior_morphs(parts["Cavity"], targets))
    assert set(cavity) == set(targets)
    assert np.allclose(cavity["jawOpen"][:, 1], -0.004) or np.all(
        cavity["jawOpen"][:, 1] <= -0.004 + 1e-9
    )
    lower = dict(G.interior_morphs(parts["TeethLower"], targets))
    assert list(lower) == ["jawOpen"]
    assert np.allclose(lower["jawOpen"], np.array((0, -0.01, -0.003)) * G.LOWER_TEETH_JAW_SHARE)
    assert G.interior_morphs(parts["TeethUpper"], targets) == []
    tongue = dict(G.interior_morphs(parts["Tongue"], targets))
    assert np.allclose(tongue["jawOpen"], np.array((0, -0.01, -0.003)) * G.TONGUE_JAW_SHARE)


# --- Textures -----------------------------------------------------------------------------


def test_the_cut_out_tells_its_hair_and_silhouette(face, frame, model):
    picture = X.to_array(cut_out_picture())
    assert X.is_cut_out(picture)
    assert not X.is_cut_out(np.ones((8, 8, 4), dtype=np.float32))
    top = X.hair_top(picture, frame)
    assert top == pytest.approx(512 * 0.45 - 512 * 0.36, abs=2)
    positions, pivot, scale = model
    reach = X.silhouette_reach(picture, positions, frame, pivot, scale)
    assert reach is not None and reach.shape == (36,)
    assert np.all(reach > 0)
    assert (
        X.silhouette_reach(np.ones((8, 8, 4), dtype=np.float32), positions, frame, pivot, scale)
        is None
    )


def test_the_skull_texture_projects_the_picture(face, frame, model):
    picture = X.to_array(cut_out_picture())
    positions, pivot, scale = model
    fit = G.fit_skull(
        positions,
        frame,
        scale,
        X.hair_top(picture, frame),
        X.silhouette_reach(picture, positions, frame, pivot, scale),
    )
    image = X.skull_texture(picture, fit, pivot, scale, size=(72, 32))
    assert image.size == (72, 32) and image.mode == "RGB"
    data = np.asarray(image)
    assert data[:12].mean() > 20  # the skirt rows are the picture, not black
    assert data[-1].mean() < data[0].mean()  # the back is darker than the face edge


def test_card_images_carry_complementary_alphas(face, frame):
    points, _ = face
    picture = X.to_array(cut_out_picture())
    box = G.head_box(frame, (512, 512))
    hair = np.asarray(X.hair_card_image(picture, frame, box, points[T.FACE_OVAL]))
    body, crop = X.body_card_image(picture, frame, box, points[T.FACE_OVAL])
    assert hair.shape[2] == 4 and body.mode == "RGBA"
    # Inside the face oval the hair card is clear; the body card too.
    cx, cy = int(points[T.NOSE_TIP, 0]), int(points[T.NOSE_TIP, 1])
    assert hair[cy - int(box[1]), cx - int(box[0]), 3] == 0
    body_a = np.asarray(body)[..., 3]
    assert body_a[cy - crop[1], cx - crop[0]] == 0
    # Over the body the body card is (nearly) opaque where the picture is:
    # the head box's neck feather reaches a little way down.
    assert body_a[-5, body_a.shape[1] // 2] >= 240
    # In the hair (inside the head disc, past the body card's wider hole),
    # the two cards add up to the picture.
    hx, hy = int(frame.centre_x), int(frame.forehead_y - frame.height * 0.2)
    total = int(hair[hy - int(box[1]), hx - int(box[0]), 3]) + int(
        body_a[hy - crop[1], hx - crop[0]]
    )
    assert abs(total - 255) <= 1


def test_teeth_textures_come_from_the_photograph(face):
    points, _ = face
    teeth = np.zeros((300, 400, 4), dtype=np.float32)
    teeth[..., :3] = 0.9
    teeth[..., 3] = 1.0
    scaled = points * np.array((400 / 512, 300 / 512))
    upper, lower = X.teeth_textures(teeth, scaled, size=(64, 24))
    assert upper.size == (64, 24) and lower.size == (64, 24)
    u = np.asarray(upper)
    assert u[12, 32, :3].tolist() == [230, 230, 230] and u[12, 32, 3] == 255
    assert u[12, 0, 3] < 40  # the ends fade
    flat = np.asarray(X.flat_teeth_texture(size=(64, 24)))
    assert flat[12, 32, 3] == 255 and flat[12, 0, 3] < 40


def test_cavity_and_tongue_take_the_lips_colour():
    lip = (0.6, 0.3, 0.3)
    image = np.asarray(X.cavity_texture(lip, (0.3, 0.46, 0.62), size=(4, 32))).astype(float)
    assert image[0, 0, 0] < image[-1, 0, 0]  # darker at the top
    assert image[-1, 0, 0] == pytest.approx(0.6 * 0.62 * 255, abs=2)
    assert X.tongue_colour(lip)[0] > lip[0] * 0.5


def test_textures_encode_in_the_formats_the_glb_takes():
    image = Image.new("RGBA", (8, 8), (10, 20, 30, 128))
    for fmt, mime in (("webp", "image/webp"), ("png", "image/png"), ("jpeg", "image/jpeg")):
        data, got = X.encode(image, fmt)
        assert got == mime and len(data) > 0
    with pytest.raises(ValueError):
        X.encode(image, "gif")


def test_flat_art_is_told_by_its_palette(frame):
    flat = np.zeros((512, 512, 4), dtype=np.float32)
    flat[..., :3] = (0.8, 0.6, 0.5)
    flat[..., 3] = 1
    assert X.is_flat_art(flat, frame)
    y, x = np.mgrid[0:512, 0:512]
    noisy = flat.copy()
    noisy[..., 0] = ((x * 37 + y * 11) % 97) / 97
    noisy[..., 1] = ((x * 13 + y * 29) % 89) / 89
    assert not X.is_flat_art(noisy, frame)


# --- The GLB writer ---------------------------------------------------------------------------


def test_the_writer_makes_a_glb_three_can_read_back():
    glb = GlbBuilder()
    image = glb.add_image(X.encode(Image.new("RGB", (4, 4), (255, 0, 0)), "png")[0], "image/png")
    webp = glb.add_image(
        X.encode(Image.new("RGBA", (4, 4), (0, 255, 0, 128)), "webp")[0], "image/webp"
    )
    material = glb.add_material("M", glb.add_texture(image))
    blend = glb.add_material(
        "B", glb.add_texture(webp), alpha_mode="BLEND", unlit=True, double_sided=True
    )
    positions = np.array([(0, 0, 0), (1, 0, 0), (0, 1, 0)], dtype=np.float32)
    uvs = np.zeros((3, 2), dtype=np.float32)
    tris = np.array([(0, 1, 2)])
    mesh = glb.add_mesh(
        "Tri",
        positions,
        uvs,
        tris,
        material,
        G.vertex_normals(positions, tris),
        [
            ("jawOpen", np.array([(0, -1, 0)] * 3, dtype=np.float32)),
            ("viseme_aa", np.zeros((3, 3))),
        ],
    )
    quad = glb.add_mesh("Quad", positions, uvs, tris, blend)
    child = glb.add_node("Face", mesh)
    head = glb.add_node("Head", children=[child], translation=(0, 0.1, 0))
    body = glb.add_node("Body", quad)
    data = glb.build([head, body], scene_extras={"liveface": {"kind": "head3d"}})

    magic, version, length = struct.unpack_from("<III", data, 0)
    assert (magic, version, length) == (0x46546C67, 2, len(data))
    doc, binary = read_glb(data)
    assert doc["asset"]["version"] == "2.0"
    assert doc["scenes"][0]["extras"]["liveface"]["kind"] == "head3d"
    assert [n["name"] for n in doc["nodes"]] == ["Face", "Head", "Body"]
    assert doc["nodes"][1]["children"] == [0] and doc["nodes"][1]["translation"] == [0, 0.1, 0]
    face = doc["meshes"][0]
    assert face["extras"]["targetNames"] == ["jawOpen", "viseme_aa"] and face["weights"] == [
        0.0,
        0.0,
    ]
    primitive = face["primitives"][0]
    position = doc["accessors"][primitive["attributes"]["POSITION"]]
    assert position["min"] == [0, 0, 0] and position["max"] == [1, 1, 0] and position["count"] == 3
    assert (
        doc["accessors"][primitive["indices"]]["componentType"] == 5123
    )  # uint16 for a small mesh
    assert np.array_equal(
        read_accessor(doc, binary, primitive["targets"][0]["POSITION"]),
        np.array([(0, -1, 0)] * 3, dtype=np.float32),
    )
    assert all(view["byteOffset"] % 4 == 0 for view in doc["bufferViews"])
    assert doc["buffers"][0]["byteLength"] == len(binary) or doc["buffers"][0]["byteLength"] <= len(
        binary
    )
    assert sorted(doc["extensionsUsed"]) == ["EXT_texture_webp", "KHR_materials_unlit"]
    assert doc["extensionsRequired"] == ["EXT_texture_webp"]
    assert doc["textures"][1]["extensions"]["EXT_texture_webp"]["source"] == webp
    assert (
        doc["materials"][1]["alphaMode"] == "BLEND" and doc["materials"][1]["doubleSided"] is True
    )
    assert "KHR_materials_unlit" in doc["materials"][1]["extensions"]


def test_the_writer_refuses_bad_meshes():
    glb = GlbBuilder()
    material = glb.add_material("M")
    positions = np.zeros((3, 3), dtype=np.float32)
    with pytest.raises(ValueError):
        glb.add_mesh("bad", positions, np.zeros((2, 2)), np.array([(0, 1, 2)]), material)
    with pytest.raises(ValueError):
        glb.add_mesh("bad", positions, np.zeros((3, 2)), np.array([(0, 1, 5)]), material)
    with pytest.raises(ValueError):
        glb.add_mesh(
            "bad",
            positions,
            np.zeros((3, 2)),
            np.array([(0, 1, 2)]),
            material,
            targets=[("x", np.zeros((2, 3)))],
        )
    with pytest.raises(ValueError):
        glb.add_image(b"GIF89a", "image/gif")
    with pytest.raises(ValueError):
        read_glb(b"not a glb at all")


# --- The build ------------------------------------------------------------------------------------


def subject_for(profile: str | None, look: str = "photo", teeth=None) -> HeadSubject:
    points, z = canonical_face()
    rig = build_rig(
        points,
        (512, 512),
        None,
        face_type="animal" if profile and profile.startswith("animal") else "human",
    )
    rig["render_profile"] = profile
    return HeadSubject(
        name="synthetic",
        picture=cut_out_picture(),
        points=points,
        z=z,
        rig=rig,
        bake=synthetic_bake(points),
        look=look,
        teeth=teeth,
    )


@pytest.mark.parametrize(
    "profile,teeth,tongue,shade",
    [
        (None, "both", True, "human"),
        ("toon@1", "upper", True, "toon"),
        ("animal@2", "none", True, "animal"),
    ],
)
def test_each_look_gets_its_interior(profile, teeth, tongue, shade):
    assert interior_for(profile) == (teeth, tongue, shade)


def test_the_build_is_a_whole_head():
    build = build_head(subject_for(None), texture_format="png")
    doc, binary = read_glb(build.glb)
    names = [n["name"] for n in doc["nodes"]]
    assert names == [
        "Cavity",
        "TeethUpper",
        "TeethLower",
        "Tongue",
        "Face",
        "Skull",
        "HairCard",
        "Head",
        "Neck",
        "Body",
    ]
    head = doc["nodes"][names.index("Head")]
    assert {doc["nodes"][c]["name"] for c in head["children"]} == {
        "Face",
        "Skull",
        "HairCard",
        "Cavity",
        "TeethUpper",
        "TeethLower",
        "Tongue",
    }
    assert doc["scenes"][0]["nodes"] == [
        names.index("Head"),
        names.index("Neck"),
        names.index("Body"),
    ]
    meshes = {m["name"]: m for m in doc["meshes"]}
    face = meshes["Face"]
    assert (
        doc["accessors"][face["primitives"][0]["attributes"]["POSITION"]]["count"]
        == T.NUM_LANDMARKS
    )
    expected = list(G.MORPH_NAMES) + [G.VISEME_MORPH_NAMES[v] for v in VISEME_BLENDSHAPES]
    assert face["extras"]["targetNames"] == expected
    assert meshes["Skull"]["extras"]["targetNames"] == expected
    assert meshes["Cavity"]["extras"]["targetNames"] == expected
    assert meshes["TeethLower"]["extras"]["targetNames"] == ["jawOpen"]
    assert "extras" not in meshes["TeethUpper"]
    # The jaw target drops the chin in the head frame and moves it back.
    jaw = read_accessor(doc, binary, face["primitives"][0]["targets"][0]["POSITION"])
    assert jaw[T.CHIN, 1] < 0 and jaw[T.CHIN, 2] < 0 and jaw[T.FOREHEAD].tolist() == [0, 0, 0]
    extras = doc["scenes"][0]["extras"]["liveface"]
    assert extras["kind"] == "head3d" and extras["look"] == "photo" and extras["profile"] is None
    assert extras["visemes"] == VISEME_BLENDSHAPES and extras["morphs"] == expected
    assert extras["frame"]["height"] > 0
    assert "EXT_texture_webp" not in doc.get("extensionsUsed", [])
    report = build.report
    assert report["draw_calls"] == 9 and report["glb_bytes"] == len(build.glb)
    assert set(report["timings_s"]) == {"landmarks", "face", "skull", "cards", "mouth", "write"}


def test_a_toon_is_flat_and_an_animal_has_no_teeth():
    toon = build_head(subject_for("toon@1", look="flat"))
    doc, _ = read_glb(toon.glb)
    names = [n["name"] for n in doc["nodes"]]
    assert "TeethUpper" in names and "TeethLower" not in names
    face_material = doc["materials"][
        [m for m in doc["meshes"] if m["name"] == "Face"][0]["primitives"][0]["material"]
    ]
    assert "KHR_materials_unlit" in face_material["extensions"]
    assert "EXT_texture_webp" in doc["extensionsRequired"]
    animal = build_head(subject_for("animal@2", look="render"))
    doc, _ = read_glb(animal.glb)
    names = [n["name"] for n in doc["nodes"]]
    assert "TeethUpper" not in names and "Tongue" in names
    assert doc["scenes"][0]["extras"]["liveface"]["profile"] == "animal@2"
    assert animal.report["draw_calls"] == 7


def test_the_build_refuses_an_unknown_look():
    with pytest.raises(ValueError):
        build_head(subject_for(None, look="oil painting"))


def test_a_bake_is_checked_before_it_is_used():
    points, _ = canonical_face()
    bake = synthetic_bake(points)
    assert validate(bake) is bake
    with pytest.raises(ValueError):
        validate({"version": 1, "targets": {}})
    broken = synthetic_bake(points)
    broken["targets"]["jawOpen"]["dx"] = [0.0]
    with pytest.raises(ValueError):
        validate(broken)
    no_visemes = synthetic_bake(points)
    no_visemes["visemes"] = {}
    with pytest.raises(ValueError):
        validate(no_visemes)


@pytest.mark.skipif(
    not shutil.which("node") or not HUMAN_RIG.exists(), reason="node and the embed fixture rig"
)
def test_the_node_bake_runs_on_a_real_rig():
    from app.services.head3d.bake import BakeUnavailable, bake_rig

    rig = json.loads(HUMAN_RIG.read_text())
    try:
        bake = bake_rig(rig)
    except BakeUnavailable as exc:
        pytest.skip(str(exc))
    assert set(bake["targets"]) == set(BAKED_SYMMETRIC)
    assert set(bake["visemes"]) == set(rig["visemes"])
    jaw = bake["targets"]["jawOpen"]
    assert jaw["dy"][T.LOWER_INNER_LIP] > 0 > -jaw["dy"][T.CHIN]  # the lip and the chin go down
    assert abs(jaw["dy"][T.FOREHEAD]) < 1e-6
    assert all(0 <= f["mean"] <= f["max"] for f in bake["fidelity"].values())


# --- The bake bundle ----------------------------------------------------------------


def _fake_embed(tmp_path: Path, monkeypatch, *, with_src: bool) -> Path:
    from app.services.head3d import bake as B

    embed = tmp_path / "embed"
    bundle = embed / "dist/head3d-bake.mjs"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("// bundle")
    if with_src:
        (embed / "src/engine").mkdir(parents=True)
        (embed / "scripts").mkdir()
        (embed / "scripts/head3d-bake.ts").write_text("// entry")
        (embed / "src/engine/deform.ts").write_text("// source")
    monkeypatch.setattr(B, "EMBED", embed)
    monkeypatch.setattr(B, "BUNDLE", bundle)
    monkeypatch.setattr(B, "ENTRY", embed / "scripts/head3d-bake.ts")
    monkeypatch.setattr(B, "ESBUILD", embed / "node_modules/.bin/esbuild")
    return bundle


def test_the_bundle_is_used_as_shipped_where_there_are_no_sources(tmp_path, monkeypatch):
    # The API image ships embed/dist only: nothing to compare against, and
    # an empty max() used to raise instead of using the bundle.
    from app.services.head3d.bake import ensure_bundle

    bundle = _fake_embed(tmp_path, monkeypatch, with_src=False)
    assert ensure_bundle() == bundle


def test_a_bundle_older_than_any_engine_source_is_stale(tmp_path, monkeypatch):
    # The bake drives the whole 2D engine, so a change anywhere under src/
    # (not only src/head3d/bake) must rebuild it; without esbuild that is
    # reported, never silently served stale.
    import os

    from app.services.head3d.bake import BakeUnavailable, ensure_bundle

    bundle = _fake_embed(tmp_path, monkeypatch, with_src=True)
    source = tmp_path / "embed/src/engine/deform.ts"
    os.utime(tmp_path / "embed/scripts/head3d-bake.ts", (500, 500))
    os.utime(bundle, (1_000, 1_000))
    os.utime(source, (2_000, 2_000))
    with pytest.raises(BakeUnavailable):
        ensure_bundle()
    os.utime(bundle, (3_000, 3_000))
    assert ensure_bundle() == bundle
