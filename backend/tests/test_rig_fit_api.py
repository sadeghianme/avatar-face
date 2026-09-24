"""Hand-placed anchors over the API: preview, save, refusal, and the lines.

Tests run without a landmark model, so every face here is undetected: the
human rigs start from the synthetic mesh (stock art depends on it) and are
fitted from the face template, the animals and cartoons start from the
template itself.
"""

import json

import numpy as np

from app.services.anchor_fit import fit_base_key, fit_base_record
from app.services.storage import get_storage
from tests.conftest import create_org, create_ready_avatar, register_and_login, sample_png
from tests.test_anchor_fit import human_rig, old_panel_anchors


async def _setup(client, who: str, face_type: str = "human"):
    headers = await register_and_login(client, who)
    org_id = await create_org(client, headers)
    if face_type == "human":
        avatar_id = await create_ready_avatar(client, headers, org_id)
    else:
        created = (
            await client.post(
                f"/orgs/{org_id}/avatars",
                json={"name": "Pet", "content_type": "image/png", "face_type": face_type},
                headers=headers,
            )
        ).json()
        await client.put(
            created["upload_url"], content=sample_png(), headers={"content-type": "image/png"}
        )
        avatar_id = created["avatar"]["id"]
        await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/uploaded", headers=headers)
    return headers, org_id, avatar_id, f"/orgs/{org_id}/avatars/{avatar_id}"


async def _rig(client, headers, base) -> dict:
    detail = (await client.get(base, headers=headers)).json()
    return (await client.get(detail["rig_url"])).json()


async def _anchors(client, headers, base) -> dict:
    response = await client.get(f"{base}/rig-anchors", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["anchors"]


def _moved(value, dx: float = 0, dy: float = 0):
    """Every point of a marking, shifted."""
    if isinstance(value, dict):
        if "x" in value:
            return {"x": value["x"] + dx, "y": value["y"] + dy}
        return {k: _moved(v, dx, dy) for k, v in value.items()}
    return [_moved(v, dx, dy) for v in value]


async def _fit(client, headers, base, marks: dict, persist: bool):
    return await client.post(f"{base}/rig-fit", json={**marks, "persist": persist}, headers=headers)


async def test_a_human_opens_on_its_edges_and_pupils(client):
    headers, _, _, base = await _setup(client, "alice")
    response = await client.get(f"{base}/rig-anchors", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    anchors = body["anchors"]
    assert set(anchors) == {"head", "left_eye", "right_eye", "mouth", "left_pupil", "right_pupil"}
    for region in ("head", "left_eye", "right_eye", "mouth"):
        marks = anchors[region]
        assert marks["right"]["x"] > marks["left"]["x"], region
        assert marks["bottom"]["y"] > marks["top"]["y"], region
    assert "center" in anchors["mouth"]
    assert body["image_size"] == [320, 400]


async def test_an_animal_opens_on_a_mouth_line_and_a_chin(client):
    headers, _, _, base = await _setup(client, "dog", "animal")
    anchors = await _anchors(client, headers, base)
    assert set(anchors) == {"head", "left_eye", "right_eye", "mouth_line", "chin"}
    xs = [p["x"] for p in anchors["mouth_line"]]
    assert len(xs) == 5 and xs == sorted(xs)


async def test_a_cartoon_marks_a_mouth_line_and_pupils(client):
    headers, _, _, base = await _setup(client, "toon", "cartoon")
    anchors = await _anchors(client, headers, base)
    assert {"mouth_line", "chin", "left_pupil", "right_pupil"} <= set(anchors)
    assert "mouth" not in anchors


async def test_opening_and_saving_folds_nothing(client):
    """The commonest path: the handles open where the fit wants them."""
    for who, face_type in (("human1", "human"), ("animal1", "animal"), ("cartoon1", "cartoon")):
        headers, _, _, base = await _setup(client, who, face_type)
        response = await _fit(client, headers, base, await _anchors(client, headers, base), True)
        assert response.status_code == 200, (face_type, response.text)
        assert response.json()["reasons"] == []


async def test_preview_does_not_persist(client):
    headers, _, _, base = await _setup(client, "alice")
    before = await _rig(client, headers, base)
    anchors = await _anchors(client, headers, base)

    response = await _fit(client, headers, base, {"mouth": _moved(anchors["mouth"], dy=6)}, False)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["persisted"] is False
    assert body["reasons"] == []
    assert body["rig"]["points"] != before["points"]
    assert (await _rig(client, headers, base))["points"] == before["points"]


async def test_saved_rig_matches_what_was_previewed(client):
    """The preview must not be able to disagree with the result — they are
    produced by the same call with one flag flipped."""
    headers, _, _, base = await _setup(client, "alice")
    marks = {"mouth": _moved((await _anchors(client, headers, base))["mouth"], dx=4, dy=5)}

    previewed = (await _fit(client, headers, base, marks, False)).json()["rig"]
    saved = (await _fit(client, headers, base, marks, True)).json()
    assert saved["persisted"] is True
    assert saved["rig"]["points"] == previewed["points"]
    assert (await _rig(client, headers, base))["points"] == previewed["points"]


async def test_saving_the_same_marks_twice_stores_the_same_rig(client):
    headers, _, _, base = await _setup(client, "dog", "animal")
    marks = _moved(await _anchors(client, headers, base), dy=8)
    first = (await _fit(client, headers, base, marks, True)).json()["rig"]
    second = (await _fit(client, headers, base, marks, True)).json()["rig"]
    assert first == second


async def test_regions_left_out_keep_their_place(client):
    headers, _, _, base = await _setup(client, "alice")
    anchors = await _anchors(client, headers, base)
    lower = {"mouth": _moved(anchors["mouth"], dy=10)}
    body = (await _fit(client, headers, base, lower, False)).json()
    after = await _anchors(client, headers, base)  # nothing saved: still the base
    rig = body["rig"]
    corner = anchors["left_eye"]["left"]
    assert rig["points"][33] == [corner["x"], corner["y"]]
    assert after == anchors


async def test_a_fit_that_folds_is_refused_and_the_preview_says_why(client):
    headers, _, _, base = await _setup(client, "alice")
    before = await _rig(client, headers, base)
    anchors = await _anchors(client, headers, base)
    swapped = {"left_eye": anchors["right_eye"], "right_eye": anchors["left_eye"]}

    preview = await _fit(client, headers, base, swapped, False)
    assert preview.status_code == 200
    codes = {r["code"] for r in preview.json()["reasons"]}
    assert "eyes_out_of_order" in codes

    detail_before = (await client.get(base, headers=headers)).json()
    refused = await _fit(client, headers, base, swapped, True)
    assert refused.status_code == 422
    assert refused.json()["code"] == "fit_invalid"
    assert {r["code"] for r in refused.json()["reasons"]} == codes
    assert (await _rig(client, headers, base))["points"] == before["points"]
    detail_after = (await client.get(base, headers=headers)).json()
    assert detail_after["unpublished"] == detail_before["unpublished"]


async def test_a_human_mouth_is_not_marked_as_a_line(client):
    headers, _, _, base = await _setup(client, "alice")
    line = [{"x": 120 + 20 * i, "y": 250} for i in range(5)]
    response = await _fit(client, headers, base, {"mouth_line": line}, False)
    assert response.status_code == 422
    assert response.json()["code"] == "mouth_line_not_for_face_type"


async def test_a_mouth_line_has_five_points(client):
    headers, _, _, base = await _setup(client, "dog", "animal")
    response = await _fit(client, headers, base, {"mouth_line": [{"x": 100, "y": 250}] * 4}, False)
    assert response.status_code == 422


async def test_marks_outside_the_image_are_refused(client):
    headers, _, _, base = await _setup(client, "dog", "animal")
    anchors = await _anchors(client, headers, base)
    outside = {"chin": {"x": 160, "y": 401}, "head": anchors["head"]}
    response = await _fit(client, headers, base, outside, False)
    assert response.status_code == 422
    assert response.json()["code"] == "mark_outside_image"


async def test_marks_are_stored_as_the_owners_whatever_the_client_says(client):
    headers, _, _, base = await _setup(client, "dog", "animal")
    anchors = await _anchors(client, headers, base)
    response = await _fit(client, headers, base, {**anchors, "source": "detector"}, True)
    assert response.status_code == 200, response.text
    assert (await _rig(client, headers, base))["user_anchors"]["source"] == "owner"


async def test_an_animal_marked_the_old_way_is_saved_as_a_line(client):
    """A client that still sends a four-edge mouth for an animal keeps
    working; what is stored is the line's scheme."""
    headers, _, _, base = await _setup(client, "dog", "animal")
    line = (await _anchors(client, headers, base))["mouth_line"]
    mouth = {"left": line[0], "right": line[4], "top": _moved(line[2], dy=-6),
             "bottom": _moved(line[2], dy=6), "center": line[2]}
    response = await _fit(client, headers, base, {"mouth": mouth}, True)
    assert response.status_code == 200, response.text
    stored = (await _rig(client, headers, base))["user_anchors"]
    assert "mouth" not in stored
    assert stored["mouth_line"][0] == line[0] and stored["mouth_line"][2] == line[2]


async def test_an_animal_fit_reaches_visitors_with_the_muzzle_profile(client):
    """The profile rides in the published rig, so widget and share page get
    it with no wiring of their own — and only once the owner publishes."""
    headers, _, _, base = await _setup(client, "dog", "animal")
    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    assert (await _rig(client, headers, base))["render_profile"] == "animal@1"

    await client.post(f"{base}/publish", headers=headers)
    token = (await client.post(f"{base}/share", headers=headers)).json()["share_token"]
    public = (await client.get(f"/public/v1/avatars/{token}")).json()
    assert (await client.get(public["rig_url"])).json()["render_profile"] == "animal@1"


async def test_a_human_fit_has_no_render_profile(client):
    headers, _, _, base = await _setup(client, "alice")
    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    assert "render_profile" not in await _rig(client, headers, base)


async def test_switching_line_switches_the_profile(client):
    headers, _, _, base = await _setup(client, "dog", "animal")
    await _fit(client, headers, base, await _anchors(client, headers, base), True)
    await client.patch(base, json={"face_type": "human"}, headers=headers)
    assert "render_profile" not in await _rig(client, headers, base)
    await client.patch(base, json={"face_type": "animal"}, headers=headers)
    assert (await _rig(client, headers, base))["render_profile"] == "animal@1"


async def test_the_fit_base_is_kept_beside_the_rig(client):
    headers, org_id, avatar_id, base = await _setup(client, "dog", "animal")
    storage = get_storage()
    record = json.loads(await storage.get_bytes(fit_base_key(org_id, avatar_id)))
    assert len(record["points"]) == 478 and record["detected"] is False
    rig = await _rig(client, headers, base)
    assert "detected" not in rig and "fit_base" not in rig
    # The rig of an undetected animal IS its base, the template.
    for p, q in zip(rig["points"], record["points"]):
        assert abs(p[0] - q[0]) < 0.01 and abs(p[1] - q[1]) < 0.01


async def test_a_rig_without_a_base_gets_one_rebuilt(client):
    """Rigs built before bases were kept: rebuilt the way a first build
    makes one, and stored."""
    headers, org_id, avatar_id, base = await _setup(client, "dog", "animal")
    anchors = await _anchors(client, headers, base)
    with_base = (await _fit(client, headers, base, anchors, False)).json()["rig"]
    storage = get_storage()
    await storage.delete(fit_base_key(org_id, avatar_id))

    rebuilt = (await _fit(client, headers, base, anchors, False)).json()["rig"]
    assert rebuilt["points"] == with_base["points"]
    assert await storage.exists(fit_base_key(org_id, avatar_id))


async def test_a_crop_moves_the_base_with_the_rig(client):
    """Marks saved after a crop are fitted from the same mesh as before it:
    the same face marked in the cropped photo gives the same rig, moved."""
    headers, _, _, base = await _setup(client, "dog", "animal")
    marks = _moved(await _anchors(client, headers, base), dy=4)
    before = (await _fit(client, headers, base, marks, True)).json()["rig"]

    rect = {"x": 0.1, "y": 0.1, "width": 0.85, "height": 0.85}
    response = await client.post(f"{base}/crop", json=rect, headers=headers)
    assert response.status_code == 200, response.text
    left, top = (await _rig(client, headers, base))["crop_origin"]
    after = (await _fit(client, headers, base, _moved(marks, -left, -top), True)).json()["rig"]
    for p, q in zip(before["points"], after["points"]):
        assert abs(p[0] - left - q[0]) < 0.02 and abs(p[1] - top - q[1]) < 0.02

    await client.post(f"{base}/crop", json={"reset": True}, headers=headers)
    again = (await _fit(client, headers, base, marks, True)).json()["rig"]
    assert again["points"] == before["points"]


async def test_an_undo_across_a_crop_rebuilds_the_base(client):
    """Undo puts an older rig back without its base; the base that no
    longer matches is noticed and rebuilt, not misapplied."""
    headers, _, _, base = await _setup(client, "dog", "animal")
    marks = await _anchors(client, headers, base)
    before = (await _fit(client, headers, base, marks, False)).json()["rig"]
    rect = {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}
    await client.post(f"{base}/crop", json=rect, headers=headers)
    await client.post(f"{base}/undo", headers=headers)
    after = (await _fit(client, headers, base, marks, False)).json()["rig"]
    assert after["points"] == before["points"]


async def test_a_detected_face_marked_by_the_old_panel_reopens_and_resaves_unchanged(client):
    """Marks the old panel stored are bounding-box extremes, not landmarks.
    On a detected face the rig's own landmarks are read instead, so the
    handles open on them and saving them back leaves the face as it was."""
    headers, org_id, avatar_id, base = await _setup(client, "alice")
    storage = get_storage()
    # Tests have no landmark model: a detected portrait's rig stands in,
    # with the base a detection leaves beside it (the mesh it was built on).
    rig, _ = human_rig()
    rig["user_anchors"] = old_panel_anchors(rig)
    await storage.put_bytes(
        f"orgs/{org_id}/avatars/{avatar_id}/rig.json", json.dumps(rig).encode(), "application/json"
    )
    record = fit_base_record(np.array(rig["points"]), rig, detected=True)
    await storage.put_bytes(
        fit_base_key(org_id, avatar_id), json.dumps(record).encode(), "application/json"
    )

    anchors = await _anchors(client, headers, base)
    assert anchors["head"]["left"] == {"x": rig["points"][234][0], "y": rig["points"][234][1]}
    response = await _fit(client, headers, base, anchors, True)
    assert response.status_code == 200, response.text
    after = np.array((await _rig(client, headers, base))["points"])
    assert np.abs(after - np.array(rig["points"])).max() < 1.0


async def test_requires_membership(client):
    headers, _, _, base = await _setup(client, "alice")
    intruder = await register_and_login(client, "mallory")

    for method, path in (("get", f"{base}/rig-anchors"), ("post", f"{base}/rig-fit")):
        call = getattr(client, method)
        response = await (call(path, json={}, headers=intruder) if method == "post"
                          else call(path, headers=intruder))
        assert response.status_code in (403, 404), (path, response.status_code)


async def test_a_rig_whose_frame_the_photo_does_not_match_fits_from_itself(client):
    """Nothing rebuilt from the photo would line up with such a rig, so its
    own mesh is the base rather than a failure."""
    headers, org_id, avatar_id, base = await _setup(client, "dog", "animal")
    storage = get_storage()
    rig_key = f"orgs/{org_id}/avatars/{avatar_id}/rig.json"
    rig = json.loads(await storage.get_bytes(rig_key))
    rig["image_size"] = [640, 800]
    await storage.put_bytes(rig_key, json.dumps(rig).encode(), "application/json")
    await storage.delete(fit_base_key(org_id, avatar_id))

    anchors = await _anchors(client, headers, base)
    response = await _fit(client, headers, base, anchors, False)
    assert response.status_code == 200, response.text
    assert response.json()["reasons"] == []
