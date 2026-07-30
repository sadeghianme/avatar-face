"""Hand-placed anchors over the API, including the test-before-save path."""
from tests.conftest import create_org, create_ready_avatar, register_and_login


# A plausible hand-marking: the mouth nudged and slightly widened. Free 2D
# points, so the corners need not be level with each other.
MOUTH_MARKS = {
    "mouth": {
        "left": {"x": 180, "y": 305},
        "right": {"x": 260, "y": 300},
        "top": {"x": 220, "y": 288},
        "bottom": {"x": 220, "y": 318},
        "center": {"x": 220, "y": 303},
    }
}


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
        marks = body["anchors"][region]
        assert marks is not None, region
        # Free 2D points, so each carries its own x AND y.
        for edge in ("left", "right", "top", "bottom"):
            assert set(marks[edge]) == {"x", "y"}, (region, edge)
        assert marks["right"]["x"] > marks["left"]["x"], region
        assert marks["bottom"]["y"] > marks["top"]["y"], region
    assert "center" in body["anchors"]["mouth"]
    assert len(body["image_size"]) == 2


async def test_preview_does_not_persist(client):
    """The whole point of Test: nothing is written until Save."""
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    before = await _rig(client, headers, org_id, avatar_id)

    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/rig-fit",
        json={**MOUTH_MARKS, "persist": False},
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
    payload = MOUTH_MARKS

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


async def test_omitted_regions_are_only_carried_not_transformed(client):
    """A user fixing only the mouth should not have to re-state the eyes.

    They are not frozen, though — the correction is a warp with a falloff, and
    that continuity is what stops the mesh tearing at the region boundary. The
    eyes should be carried a little at most, never independently moved.
    """
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    before = await _rig(client, headers, org_id, avatar_id)

    body = (
        await client.post(
            f"/orgs/{org_id}/avatars/{avatar_id}/rig-fit",
            json=MOUTH_MARKS,
            headers=headers,
        )
    ).json()["rig"]

    from app.services.rig_fit import LEFT_EYE_INDICES

    def moved(i):
        return (
            (body["points"][i][0] - before["points"][i][0]) ** 2
            + (body["points"][i][1] - before["points"][i][1]) ** 2
        ) ** 0.5

    mouth_moved = max(moved(i) for i in before["mouth_indices"])
    eye_moved = max(moved(i) for i in LEFT_EYE_INDICES if i < len(before["points"]))
    assert mouth_moved > 1.0, "the marked region should actually move"
    assert eye_moved < mouth_moved * 0.1, f"eyes dragged {eye_moved:.1f}px"


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
