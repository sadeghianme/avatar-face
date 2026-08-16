"""Manual rig fit correction."""
from tests.conftest import create_org, create_ready_avatar, register_and_login


async def _rig(client, headers, org_id, avatar_id):
    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()
    return (await client.get(detail["rig_url"])).json()


def _mouth_center(rig):
    pts = [rig["points"][i] for i in rig["mouth_indices"]]
    return (
        sum(p[0] for p in pts) / len(pts),
        sum(p[1] for p in pts) / len(pts),
    )


def _mouth_width(rig):
    xs = [rig["points"][i][0] for i in rig["mouth_indices"]]
    return max(xs) - min(xs)


async def test_rig_adjust_moves_and_scales_mouth(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    before = await _rig(client, headers, org_id, avatar_id)
    bx, by = _mouth_center(before)
    bw = _mouth_width(before)

    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/rig-adjust",
        json={"mouth_dx": 12, "mouth_dy": 30, "mouth_scale": 1.5},
        headers=headers,
    )
    assert response.status_code == 200, response.text

    after = await _rig(client, headers, org_id, avatar_id)
    ax, ay = _mouth_center(after)
    assert abs(ax - (bx + 12)) < 1
    assert abs(ay - (by + 30)) < 1
    assert abs(_mouth_width(after) - bw * 1.5) < 1
    # Non-mouth points untouched.
    assert after["points"][10] == before["points"][10]


async def test_rig_adjust_moves_eyes(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    before = await _rig(client, headers, org_id, avatar_id)

    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/rig-adjust",
        json={"left_eye_dx": -8, "left_eye_dy": 5},
        headers=headers,
    )
    assert response.status_code == 200
    after = await _rig(client, headers, org_id, avatar_id)
    assert abs(after["points"][468][0] - (before["points"][468][0] - 8)) < 1e-6
    assert abs(after["points"][468][1] - (before["points"][468][1] + 5)) < 1e-6
    # Right eye untouched.
    assert after["points"][473] == before["points"][473]


async def test_rig_adjust_validates_scale(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/rig-adjust",
        json={"mouth_scale": 99},
        headers=headers,
    )
    assert response.status_code == 422


async def test_rig_adjust_rejects_3d(client, monkeypatch):
    """Landmark nudging is a 2D-mesh operation; a GLB has no mesh to nudge."""
    from app.models import Avatar, AvatarKind
    from app.db import get_session_factory
    from sqlalchemy import select

    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    photo_id = await create_ready_avatar(client, headers, org_id)

    # Turn it into a model3d row directly: importing a real GLB would need a
    # network fetch, and what is under test is the kind check.
    async with get_session_factory()() as db:
        avatar = (
            await db.execute(select(Avatar).where(Avatar.id == photo_id))
        ).scalar_one()
        avatar.kind = AvatarKind.model3d
        await db.commit()

    response = await client.post(
        f"/orgs/{org_id}/avatars/{photo_id}/rig-adjust",
        json={"mouth_dy": 5},
        headers=headers,
    )
    assert response.status_code == 409
