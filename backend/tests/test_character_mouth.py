"""The character mouth's settings and which look an avatar has.

The look is the draft rig's render profile (embed KindProfile), written by a
fit; what the owner chooses here is `style` ("character": the line's current
profile, or "classic": the one the line had before) and how the mouth is set.
A rig fitted before the character mouth keeps its look until its owner fits it
again or chooses.
"""

import json

from app.services.mouth import character_style, clean_character, public_view
from tests.test_rig_fit_api import _anchors, _fit, _rig, _setup

CHARACTER = {"style": "character", "teeth": "none", "tongue": False, "jaw": 1.3}


def test_settings_are_clamped_and_unknown_keys_dropped():
    assert clean_character({"style": "weird", "teeth": "fangs", "tongue": "yes", "jaw": 9, "x": 1}) == {
        "style": "character", "teeth": "upper", "tongue": True, "jaw": 1.6,
    }
    assert clean_character({"jaw": 0})["jaw"] == 0.5
    assert clean_character({"jaw": float("nan")})["jaw"] == 1.0
    assert clean_character({"jaw": True})["jaw"] == 1.0
    assert clean_character(None) is None
    assert clean_character("x") is None


def test_the_owner_is_told_their_settings_and_the_style_defaults_to_the_character_mouth():
    raw = json.dumps({"renderer": "classic", "profile": {}, "character": CHARACTER})
    assert public_view(raw)["character"] == CHARACTER
    assert public_view(json.dumps({"renderer": "classic", "profile": {}}))["character"] is None
    assert character_style(None) == "character"
    assert character_style(json.dumps({"renderer": "classic", "character": {"style": "classic"}})) == "classic"


async def test_an_animation_and_an_animal_fit_with_the_character_mouth_by_default(client):
    for who, face_type, profile in (("pet1", "animal", "animal@2"), ("toon1", "cartoon", "toon@1")):
        headers, _, _, base = await _setup(client, who, face_type)
        await _fit(client, headers, base, await _anchors(client, headers, base), True)
        assert (await _rig(client, headers, base))["render_profile"] == profile
        assert (await client.get(base, headers=headers)).json()["render_profile"] == profile


async def test_choosing_the_classic_mouth_moves_the_draft_rig_back_and_choosing_again_forward(client):
    headers, _, _, base = await _setup(client, "pet2", "animal")
    await _fit(client, headers, base, await _anchors(client, headers, base), True)

    response = await client.patch(base, json={"character": {"style": "classic"}}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["render_profile"] == "animal@1"
    assert response.json()["mouth"]["character"]["style"] == "classic"
    assert (await _rig(client, headers, base))["render_profile"] == "animal@1"
    # A fit made meanwhile keeps the owner's choice.
    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    assert (await _rig(client, headers, base))["render_profile"] == "animal@1"

    response = await client.patch(base, json={"character": {"style": "character", "jaw": 1.2}}, headers=headers)
    assert response.json()["render_profile"] == "animal@2"
    assert (await _rig(client, headers, base))["render_profile"] == "animal@2"


async def test_an_animation_that_chooses_classic_has_no_profile_at_all(client):
    headers, _, _, base = await _setup(client, "toon2", "cartoon")
    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    await client.patch(base, json={"character": {"style": "classic"}}, headers=headers)
    assert "render_profile" not in await _rig(client, headers, base)
    await client.patch(base, json={"character": {"style": "character"}}, headers=headers)
    assert (await _rig(client, headers, base))["render_profile"] == "toon@1"


async def test_a_human_has_no_character_mouth(client):
    headers, _, _, base = await _setup(client, "alice2")
    response = await client.patch(base, json={"character": {"style": "character"}}, headers=headers)
    assert response.status_code == 422
    assert response.json()["code"] == "character_not_for_face_type"


async def test_ranges_are_enforced_by_the_api(client):
    headers, _, _, base = await _setup(client, "pet3", "animal")
    for body in ({"jaw": 9}, {"jaw": 0.1}, {"teeth": "fangs"}, {"style": "other"}):
        response = await client.patch(base, json={"character": body}, headers=headers)
        assert response.status_code == 422, body


async def test_settings_reach_visitors_only_when_published(client):
    headers, _, _, base = await _setup(client, "pet4", "animal")
    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    await client.post(f"{base}/publish", headers=headers)
    token = (await client.post(f"{base}/share", headers=headers)).json()["share_token"]
    assert (await client.get(f"/public/v1/avatars/{token}")).json()["mouth"] is None

    await client.patch(base, json={"character": CHARACTER}, headers=headers)
    # Not yet: it is a draft change, and the Publish bar says so.
    assert (await client.get(base, headers=headers)).json()["unpublished"] is True
    assert (await client.get(f"/public/v1/avatars/{token}")).json()["mouth"] is None

    await client.post(f"{base}/publish", headers=headers)
    public = (await client.get(f"/public/v1/avatars/{token}")).json()
    assert public["mouth"] == {"renderer": "classic", "character": CHARACTER}
    assert (await client.get(public["rig_url"])).json()["render_profile"] == "animal@2"


async def test_an_avatar_fitted_before_keeps_its_look_until_it_chooses(client):
    """The migration rule: nothing live changes by itself. A rig that names
    animal@1 keeps it through an unrelated edit, and gets animal@2 when its
    owner fits it again or chooses the character mouth."""
    headers, _, _, base = await _setup(client, "pet5", "animal")
    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    detail = (await client.get(base, headers=headers)).json()
    from urllib.parse import unquote, urlparse

    from app.services.storage import get_storage

    storage = get_storage()
    key = unquote(urlparse(detail["rig_url"]).path.split("/storage/", 1)[1])
    rig = json.loads(await storage.get_bytes(key))
    rig["render_profile"] = "animal@1"
    await storage.put_bytes(key, json.dumps(rig).encode(), "application/json")

    await client.patch(base, json={"name": "Rex"}, headers=headers)
    assert (await _rig(client, headers, base))["render_profile"] == "animal@1"
    assert (await client.get(base, headers=headers)).json()["render_profile"] == "animal@1"

    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    assert (await _rig(client, headers, base))["render_profile"] == "animal@2"
