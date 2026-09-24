"""Face types: animal support that cannot touch human quality."""

from app.services.rig import (
    ANIMAL_VISEME_BLENDSHAPES,
    VISEME_BLENDSHAPES,
    VISEME_PROFILES,
    build_rig,
    synthetic_face_mesh,
)
from tests.conftest import create_org, create_ready_avatar, register_and_login


def test_human_profile_is_the_original_table():
    """The guarantee: adding animal support changed no human number. If this
    fails, every existing avatar's mouth just moved."""
    assert VISEME_PROFILES["human"] is VISEME_BLENDSHAPES


def test_default_face_type_builds_the_human_rig():
    """Callers that never heard of face types must get what they always got."""
    points = synthetic_face_mesh(256, 256)
    assert build_rig(points, (256, 256))["visemes"] == VISEME_BLENDSHAPES


def test_animal_rig_uses_the_muzzle_table():
    points = synthetic_face_mesh(256, 256)
    rig = build_rig(points, (256, 256), face_type="animal")
    assert rig["visemes"] == ANIMAL_VISEME_BLENDSHAPES
    # Everything except the viseme table must be identical — face type is a
    # mouth-shape choice, not a different rig.
    human = build_rig(points, (256, 256))
    assert {k: v for k, v in rig.items() if k != "visemes"} == {
        k: v for k, v in human.items() if k != "visemes"
    }


def test_a_muzzle_does_not_pucker():
    """A snout has no lip rounding; driving one with pucker/funnel is what
    makes a talking animal look like a human mouth pasted on."""
    for shape in ANIMAL_VISEME_BLENDSHAPES.values():
        assert shape["mouthPucker"] == 0.0
        assert shape["mouthFunnel"] == 0.0
    # Vowels must still be told apart — by jaw, since not by lips.
    jaws = {v: ANIMAL_VISEME_BLENDSHAPES[v]["jawOpen"] for v in ("sil", "ou", "E", "oh", "aa")}
    assert jaws["sil"] < jaws["ou"] < jaws["E"] < jaws["oh"] < jaws["aa"]


def test_every_profile_covers_every_viseme():
    """A missing key renders as a closed mouth mid-word."""
    for name, table in VISEME_PROFILES.items():
        assert set(table) == set(VISEME_BLENDSHAPES), name
        for viseme, shape in table.items():
            assert set(shape) == set(VISEME_BLENDSHAPES[viseme]), (name, viseme)


async def test_avatars_default_to_human(client):
    headers = await register_and_login(client, "ftdefault")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["face_type"] == "human"


async def test_switching_to_animal_reprofiles_without_re_detecting(client):
    """Changing type must not re-run detection: that would discard a rig the
    user may have marked by hand for a setting about mouth shapes."""
    import json

    from app.services.storage import get_storage

    headers = await register_and_login(client, "ftswitch")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    before = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()

    storage = get_storage()
    rig_key = f"orgs/{org_id}/avatars/{avatar_id}/rig.json"
    points_before = json.loads(await storage.get_bytes(rig_key))["points"]

    updated = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}",
        json={"face_type": "animal"},
        headers=headers,
    )
    assert updated.json()["face_type"] == "animal"

    rig = json.loads(await storage.get_bytes(rig_key))
    assert rig["visemes"] == ANIMAL_VISEME_BLENDSHAPES
    assert rig["points"] == points_before  # landmarks untouched
    assert before["status"] == "ready"


async def _built(client, monkeypatch, who: str, face_type: str, detected: bool):
    """A first build with a stubbed detector; returns (rig, fit base)."""
    import json

    import numpy as np

    from app.core import config
    from app.services import rig as rig_module
    from app.services.anchor_fit import fit_base_key
    from app.services.storage import get_storage
    from tests.conftest import sample_png

    found = rig_module.synthetic_face_mesh(320, 400) + np.array([3.0, -2.0])
    monkeypatch.setattr(config.get_settings(), "rig_model_path", "/some/model.task", raising=False)
    monkeypatch.setattr(
        rig_module, "landmarks_from_image", lambda data: (found, None, (320, 400), detected)
    )
    headers = await register_and_login(client, who)
    org_id = await create_org(client, headers)
    created = (
        await client.post(
            f"/orgs/{org_id}/avatars",
            json={"name": "F", "content_type": "image/png", "face_type": face_type},
            headers=headers,
        )
    ).json()
    await client.put(
        created["upload_url"], content=sample_png(), headers={"content-type": "image/png"}
    )
    avatar_id = created["avatar"]["id"]
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/uploaded", headers=headers)
    storage = get_storage()
    rig = json.loads(await storage.get_bytes(f"orgs/{org_id}/avatars/{avatar_id}/rig.json"))
    base = json.loads(await storage.get_bytes(fit_base_key(org_id, avatar_id)))
    return rig, base, found


async def test_an_undetected_animal_or_cartoon_starts_from_the_template(client, monkeypatch):
    import numpy as np

    from app.services.rig import template_mesh

    for who, face_type in (("tmplanimal", "animal"), ("tmplcartoon", "cartoon")):
        rig, base, _ = await _built(client, monkeypatch, who, face_type, detected=False)
        assert np.allclose(rig["points"], template_mesh((320, 400)), atol=0.01)
        assert np.allclose(base["points"], template_mesh((320, 400)), atol=0.001)


async def test_an_undetected_human_keeps_the_synthetic_mesh_but_fits_from_the_template(
    client, monkeypatch
):
    """Stock portraits are drawn to the synthetic mesh; the fit needs a mesh
    whose indices mean what MediaPipe's mean, which the synthetic one's do not."""
    import numpy as np

    from app.services.rig import template_mesh

    rig, base, found = await _built(client, monkeypatch, "tmplhuman", "human", detected=False)
    assert np.allclose(rig["points"], found, atol=0.01)
    assert np.allclose(base["points"], template_mesh((320, 400)), atol=0.001)


async def test_a_detection_is_its_own_fit_base(client, monkeypatch):
    import numpy as np

    rig, base, found = await _built(client, monkeypatch, "detected", "animal", detected=True)
    assert np.allclose(rig["points"], found, atol=0.01)
    assert np.allclose(base["points"], found, atol=0.001)
    assert base["detected"] is True
