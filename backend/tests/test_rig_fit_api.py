"""Hand-placed anchors over the API, including the test-before-save path."""
from tests.conftest import create_org, create_ready_avatar, register_and_login


async def _rig(client, headers, org_id, avatar_id):
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    return (await client.get(detail["rig_url"])).json()


def _mouth_box(rig):
    xs = [rig["points"][i][0] for i in rig["mouth_indices"]]
    ys = [rig["points"][i][1] for i in rig["mouth_indices"]]
    return min(xs), max(xs), min(ys), max(ys)


async def test_anchors_describe_the_current_detection(client):
    """The UI opens its handles on these, so a good detection means the user
    drags nothing."""
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    response = await client.get(
        f"/orgs/{org_id}/avatars/{avatar_id}/rig-anchors", headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    for region in ("head", "left_eye", "right_eye", "mouth"):
        box = body["anchors"][region]
        assert box is not None, region
        assert box["right"] > box["left"] and box["bottom"] > box["top"], region
    assert body["anchors"]["mouth_center"] is not None
    assert len(body["image_size"]) == 2


async def test_preview_does_not_persist(client):
    """The whole point of Test: nothing is written until Save."""
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    before = await _rig(client, headers, org_id, avatar_id)

    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/rig-fit",
        json={"mouth": {"left": 10, "right": 60, "top": 20, "bottom": 40}, "persist": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["persisted"] is False
    # The returned rig IS corrected...
    assert _mouth_box(body["rig"]) != _mouth_box(before)
    # ...but the stored one is untouched.
    assert (await _rig(client, headers, org_id, avatar_id))["points"] == before["points"]


async def test_saved_rig_matches_what_was_previewed(client):
    """The preview must not be able to disagree with the result — they are
    produced by the same call with one flag flipped."""
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    payload = {"mouth": {"left": 10, "right": 60, "top": 20, "bottom": 40}}

    previewed = (
        await client.post(
            f"/orgs/{org_id}/avatars/{avatar_id}/rig-fit",
            json={**payload, "persist": False},
            headers=headers,
        )
    ).json()["rig"]
    saved = (
        await client.post(
            f"/orgs/{org_id}/avatars/{avatar_id}/rig-fit",
            json={**payload, "persist": True},
            headers=headers,
        )
    ).json()
    assert saved["persisted"] is True
    assert saved["rig"]["points"] == previewed["points"]
    assert (await _rig(client, headers, org_id, avatar_id))["points"] == previewed["points"]


async def test_omitted_regions_are_untouched(client):
    """A user fixing only the mouth should not have to re-state the eyes."""
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    before = await _rig(client, headers, org_id, avatar_id)

    body = (
        await client.post(
            f"/orgs/{org_id}/avatars/{avatar_id}/rig-fit",
            json={"mouth": {"left": 10, "right": 60, "top": 20, "bottom": 40}},
            headers=headers,
        )
    ).json()["rig"]

    from app.services.rig_fit import LEFT_EYE_INDICES

    for i in LEFT_EYE_INDICES:
        if i < len(before["points"]):
            assert body["points"][i] == before["points"][i]


async def test_requires_membership(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    intruder = await register_and_login(client, "mallory")

    for method, path in (
        ("get", f"/orgs/{org_id}/avatars/{avatar_id}/rig-anchors"),
        ("post", f"/orgs/{org_id}/avatars/{avatar_id}/rig-fit"),
    ):
        call = getattr(client, method)
        response = await (call(path, json={}, headers=intruder) if method == "post"
                          else call(path, headers=intruder))
        assert response.status_code in (403, 404), (path, response.status_code)
