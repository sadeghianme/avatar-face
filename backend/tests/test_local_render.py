"""In-process rendering: the button appears only where the hardware is."""

import pytest

from tests.conftest import create_org, register_and_login


async def test_capability_is_honest_about_this_machine(client):
    """Whatever it answers must match what a render attempt would find —
    the UI shows or hides the button on this alone."""
    headers = await register_and_login(client, "capprobe")
    org_id = await create_org(client, headers)
    response = await client.get(
        f"/orgs/{org_id}/clone-jobs/render-capability", headers=headers
    )
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["available"], bool)
    if not body["available"]:
        assert body["reason"]  # the UI needs something to say


async def test_render_refuses_cleanly_when_unavailable(client, monkeypatch):
    """On the CPU-only server this must be a 409 with a reason, never a 500
    from a missing import."""
    from app.services import local_render

    monkeypatch.setattr(
        local_render,
        "_probe_result",
        {"available": False, "device": None, "reason": "no accelerator"},
    )
    headers = await register_and_login(client, "caprender")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/clone-jobs/nope/render", headers=headers
    )
    assert response.status_code == 409
    assert response.json()["code"] == "render_unavailable"


async def test_render_claims_synchronously_so_double_clicks_are_safe(client, monkeypatch):
    """Two clicks must not start two renders of the same job."""
    import io
    import json
    import wave

    from app.services import local_render

    monkeypatch.setattr(
        local_render, "_probe_result", {"available": True, "device": "mps", "reason": None}
    )
    started = []
    monkeypatch.setattr(local_render, "render_job", lambda org, job: started.append(job))

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(16000)
        handle.writeframes(b"\x00\x00" * 16000 * 8)

    headers = await register_and_login(client, "capdouble")
    org_id = await create_org(client, headers)
    job = (
        await client.post(
            f"/orgs/{org_id}/clone-jobs",
            headers=headers,
            data={"name": "v", "locale": "en-US", "lines": json.dumps(["Hi"]), "consent": "true"},
            files={"reference": ("r.wav", buffer.getvalue(), "audio/wav")},
        )
    ).json()

    first = await client.post(f"/orgs/{org_id}/clone-jobs/{job['id']}/render", headers=headers)
    second = await client.post(f"/orgs/{org_id}/clone-jobs/{job['id']}/render", headers=headers)
    assert first.status_code == 202
    assert second.status_code == 409  # already processing
    assert len(started) == 1
