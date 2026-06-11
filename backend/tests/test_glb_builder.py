"""In-house photo -> talking 3D face GLB generation."""
from app.services.glb_builder import build_face_glb
from app.services.model3d import build_model_rig, extract_morph_targets, parse_glb_json
from tests.conftest import create_org, create_ready_avatar, register_and_login, sample_png


def test_generated_glb_is_valid():
    glb = build_face_glb(sample_png())
    gltf = parse_glb_json(glb)
    assert gltf["asset"]["version"] == "2.0"
    assert gltf["meshes"][0]["primitives"][0]["targets"]


def test_generated_glb_has_visemes_and_blinks():
    rig = build_model_rig(build_face_glb(sample_png()))
    assert rig["lipsync_mode"] == "visemes"
    assert rig["can_lipsync"] is True
    assert rig["can_blink"] is True
    assert len(rig["viseme_morphs"]) == 15


def test_generated_glb_morph_count_matches_names():
    glb = build_face_glb(sample_png())
    gltf = parse_glb_json(glb)
    primitive = gltf["meshes"][0]["primitives"][0]
    names = extract_morph_targets(gltf)
    assert len(primitive["targets"]) == len(gltf["meshes"][0]["extras"]["targetNames"])
    assert len(names) == 17  # 15 visemes + 2 blinks


def test_generated_glb_geometry_sane():
    glb = build_face_glb(sample_png())
    gltf = parse_glb_json(glb)
    pos_accessor = gltf["accessors"][
        gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"]
    ]
    assert pos_accessor["count"] == 478
    # Scaled to ~16cm face width, centered near origin.
    assert abs(pos_accessor["max"][0] - 0.08) < 0.20
    assert pos_accessor["min"][2] <= 0 <= pos_accessor["max"][2] + 1e-6


async def test_generate_3d_endpoint(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    photo_id = await create_ready_avatar(client, headers, org_id)

    response = await client.post(
        f"/orgs/{org_id}/avatars/{photo_id}/generate-3d", headers=headers
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["kind"] == "model3d"
    assert body["name"].endswith("3D")

    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{body['id']}", headers=headers)
    ).json()
    assert detail["status"] == "ready", detail
    assert detail["model_url"]
    rig = (await client.get(detail["rig_url"])).json()
    assert rig["lipsync_mode"] == "visemes"


async def test_generate_3d_rejects_3d_source(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    photo_id = await create_ready_avatar(client, headers, org_id)
    created = (
        await client.post(
            f"/orgs/{org_id}/avatars/{photo_id}/generate-3d", headers=headers
        )
    ).json()
    response = await client.post(
        f"/orgs/{org_id}/avatars/{created['id']}/generate-3d", headers=headers
    )
    assert response.status_code == 422
    assert response.json()["code"] == "not_a_photo"
