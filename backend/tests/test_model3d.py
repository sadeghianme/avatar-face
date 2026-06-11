"""3D (GLB) avatar support."""
import json
import struct

import pytest

from app.services.model3d import build_model_rig, extract_morph_targets, parse_glb_json
from tests.conftest import create_org, register_and_login


def make_glb(gltf: dict) -> bytes:
    """Assemble a minimal valid GLB container around a glTF JSON dict."""
    payload = json.dumps(gltf).encode()
    payload += b" " * (-len(payload) % 4)  # 4-byte alignment
    header = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(payload))
    chunk = struct.pack("<I4s", len(payload), b"JSON") + payload
    return header + chunk


RPM_LIKE_GLTF = {
    "asset": {"version": "2.0"},
    "nodes": [{"name": "Head"}, {"name": "Neck"}],
    "meshes": [
        {
            "name": "Wolf3D_Head",
            "extras": {
                "targetNames": [
                    "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
                    "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
                    "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
                    "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp",
                ]
            },
            "primitives": [],
        }
    ],
}


def test_parse_glb_roundtrip():
    gltf = parse_glb_json(make_glb(RPM_LIKE_GLTF))
    assert gltf["asset"]["version"] == "2.0"


def test_parse_glb_rejects_garbage():
    with pytest.raises(ValueError):
        parse_glb_json(b"not a glb at all")


def test_extract_morph_targets():
    morphs = extract_morph_targets(RPM_LIKE_GLTF)
    assert "viseme_aa" in morphs
    assert "eyeBlinkLeft" in morphs


def test_build_model_rig_capabilities():
    rig = build_model_rig(make_glb(RPM_LIKE_GLTF))
    assert rig["kind"] == "model3d"
    assert rig["can_lipsync"] is True
    assert rig["can_blink"] is True
    assert len(rig["viseme_morphs"]) == 15


def test_build_model_rig_no_morphs():
    rig = build_model_rig(make_glb({"asset": {"version": "2.0"}, "meshes": []}))
    assert rig["can_lipsync"] is False
    assert rig["lipsync_mode"] is None


def test_build_model_rig_arkit_mode():
    """Models with raw ARKit blendshapes (no viseme_*) still lip-sync."""
    gltf = {
        "asset": {"version": "2.0"},
        "meshes": [
            {
                "extras": {
                    "targetNames": [
                        "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker",
                        "eyeBlinkLeft", "eyeBlinkRight",
                    ]
                },
                "primitives": [],
            }
        ],
    }
    rig = build_model_rig(make_glb(gltf))
    assert rig["lipsync_mode"] == "arkit"
    assert rig["can_lipsync"] is True
    assert rig["can_blink"] is True


async def _upload_glb(client, headers, org_id) -> str:
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Rpm", "content_type": "model/gltf-binary"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["avatar"]["kind"] == "model3d"
    put = await client.put(
        body["upload_url"],
        content=make_glb(RPM_LIKE_GLTF),
        headers={"Content-Type": "model/gltf-binary"},
    )
    assert put.status_code == 200
    confirm = await client.post(
        f"/orgs/{org_id}/avatars/{body['avatar']['id']}/uploaded", headers=headers
    )
    assert confirm.status_code == 200, confirm.text
    return body["avatar"]["id"]


async def test_glb_upload_pipeline(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await _upload_glb(client, headers, org_id)

    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()
    assert detail["status"] == "ready", detail
    assert detail["kind"] == "model3d"
    assert detail["model_url"]

    rig = (await client.get(detail["rig_url"])).json()
    assert rig["kind"] == "model3d"
    assert rig["can_lipsync"] is True


async def test_invalid_glb_fails_gracefully(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Bad", "content_type": "model/gltf-binary"},
        headers=headers,
    )
    body = created.json()
    await client.put(
        body["upload_url"], content=b"junk", headers={"Content-Type": "model/gltf-binary"}
    )
    await client.post(
        f"/orgs/{org_id}/avatars/{body['avatar']['id']}/uploaded", headers=headers
    )
    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{body['avatar']['id']}", headers=headers)
    ).json()
    assert detail["status"] == "failed"
    assert detail["error"]


async def test_from_url_rejects_unknown_host(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars/from-url",
        json={"url": "https://evil.example.com/model.glb"},
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["code"] == "model_host_not_allowed"


async def test_from_url_rejects_http(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars/from-url",
        json={"url": "http://models.readyplayer.me/abc.glb"},
        headers=headers,
    )
    assert response.status_code == 422


async def test_embed_returns_model_url_for_3d(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await _upload_glb(client, headers, org_id)
    key = (
        await client.post(
            f"/orgs/{org_id}/api-keys", json={"name": "k"}, headers=headers
        )
    ).json()["plaintext"]
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "model3d"
    assert body["model_url"].startswith("http://testserver/")
