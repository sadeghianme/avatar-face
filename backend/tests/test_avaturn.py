"""Avaturn 3D: the session flow, and what happens without a token."""

import pytest

from tests.conftest import create_org, register_and_login


async def test_session_is_refused_without_a_token(client):
    """Unconfigured must be a clear 409, not a 500 from a None Authorization."""
    headers = await register_and_login(client, "no3d")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars/avaturn-session", headers=headers
    )
    assert response.status_code == 409
    assert response.json()["code"] == "avaturn_unavailable"


async def test_session_returns_only_the_editor_url(client, monkeypatch):
    """The API token must never reach the browser — only the session URL."""
    from app.services import avaturn

    calls: list[tuple[str, dict | None]] = []

    async def fake_post(path, payload=None):
        calls.append((path, payload))
        if path.endswith("/users/new"):
            return {"id": "USER1"}
        return {"url": "https://editor.avaturn.me/s/abc", "id": "SESSION1"}

    monkeypatch.setattr(avaturn, "api_token", lambda: "secret-token")
    monkeypatch.setattr(avaturn, "_post", fake_post)

    headers = await register_and_login(client, "has3d")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars/avaturn-session", headers=headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["url"] == "https://editor.avaturn.me/s/abc"
    assert "secret-token" not in response.text
    # A throwaway user per session: reusing one would show every customer
    # the avatars built by the others.
    assert calls[0][0].endswith("/users/new")
    assert calls[1][1] == {"user_id": "USER1", "config": {"type": "create"}}


async def test_avaturn_hosts_are_importable():
    """The editor hands back a GLB on these hosts; from-url must accept them."""
    from app.core.config import get_settings

    hosts = {h.lower() for h in get_settings().model_url_hosts}
    assert "api.avaturn.me" in hosts
    assert "assets.avaturn.me" in hosts
