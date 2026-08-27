"""Clone jobs: the queue between the dashboard recorder and the worker."""

import io
import json
import wave

import pytest

from tests.conftest import create_org, register_and_login


def _wav(seconds: float = 8.0) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buffer.getvalue()


async def _create(client, headers, org_id, name="mine", consent="true", lines=None):
    return await client.post(
        f"/orgs/{org_id}/clone-jobs",
        headers=headers,
        data={
            "name": name,
            "locale": "en-US",
            "lines": json.dumps(lines or ["Hello there", "Goodbye now"]),
            "consent": consent,
        },
        files={"reference": ("ref.wav", _wav(), "audio/wav")},
    )


@pytest.fixture
async def org(client):
    headers = await register_and_login(client, "recorder")
    return headers, await create_org(client, headers)


async def test_consent_is_checked_before_any_audio_is_stored(client, org):
    headers, org_id = org
    response = await _create(client, headers, org_id, consent="false")
    assert response.status_code == 422
    assert response.json()["code"] == "consent_required"
    assert (await client.get(f"/orgs/{org_id}/clone-jobs", headers=headers)).json() == []


async def test_the_full_worker_round_trip(client, org):
    """Create -> claim -> progress -> complete, as the UI and worker do it."""
    headers, org_id = org
    created = (await _create(client, headers, org_id)).json()
    assert created["status"] == "pending"

    claimed = (
        await client.post(f"/orgs/{org_id}/clone-jobs/claim", headers=headers)
    ).json()
    assert claimed["id"] == created["id"]
    assert claimed["status"] == "processing"
    # The worker needs the recording; nothing else on the job carries audio.
    assert claimed["reference_url"]

    await client.post(
        f"/orgs/{org_id}/clone-jobs/{created['id']}/progress",
        headers=headers,
        json={"done_lines": 1},
    )
    listed = (await client.get(f"/orgs/{org_id}/clone-jobs", headers=headers)).json()
    assert listed[0]["done_lines"] == 1  # what the UI's progress bar reads

    done = (
        await client.post(f"/orgs/{org_id}/clone-jobs/{created['id']}/complete", headers=headers)
    ).json()
    assert done["status"] == "done"
    assert done["done_lines"] == 2


async def test_an_empty_queue_is_a_404_not_an_error(client, org):
    headers, org_id = org
    response = await client.post(f"/orgs/{org_id}/clone-jobs/claim", headers=headers)
    assert response.status_code == 404
    assert response.json()["code"] == "queue_empty"


async def test_a_failed_job_carries_its_reason_to_the_ui(client, org):
    headers, org_id = org
    created = (await _create(client, headers, org_id)).json()
    await client.post(f"/orgs/{org_id}/clone-jobs/claim", headers=headers)
    await client.post(
        f"/orgs/{org_id}/clone-jobs/{created['id']}/fail",
        headers=headers,
        json={"error": "CUDA out of memory"},
    )
    listed = (await client.get(f"/orgs/{org_id}/clone-jobs", headers=headers)).json()
    assert listed[0]["status"] == "failed"
    assert "CUDA" in listed[0]["error"]


async def test_a_dead_workers_claim_expires(client, org, monkeypatch):
    """A worker that claimed a job and was closed must not wedge the queue."""
    from app.services import clonejobs

    headers, org_id = org
    created = (await _create(client, headers, org_id)).json()
    assert (await client.post(f"/orgs/{org_id}/clone-jobs/claim", headers=headers)).status_code == 200
    # Second claim while fresh: nothing to take.
    assert (await client.post(f"/orgs/{org_id}/clone-jobs/claim", headers=headers)).status_code == 404
    # After the timeout, the same job is claimable again.
    monkeypatch.setattr(clonejobs, "CLAIM_TIMEOUT_SECONDS", 0)
    reclaimed = await client.post(f"/orgs/{org_id}/clone-jobs/claim", headers=headers)
    assert reclaimed.status_code == 200
    assert reclaimed.json()["id"] == created["id"]


async def test_jobs_are_org_scoped(client, org):
    headers, org_id = org
    await _create(client, headers, org_id)
    other = await register_and_login(client, "someoneelse")
    other_org = await create_org(client, other, name="Other")
    assert (await client.get(f"/orgs/{other_org}/clone-jobs", headers=other)).json() == []
    assert (
        await client.post(f"/orgs/{other_org}/clone-jobs/claim", headers=other)
    ).status_code == 404


async def test_deleting_a_job_removes_it_and_its_recording(client, org):
    from app.services.clonejobs import reference_key
    from app.services.storage import get_storage

    headers, org_id = org
    created = (await _create(client, headers, org_id)).json()
    assert await get_storage().exists(reference_key(org_id, created["id"]))
    response = await client.delete(
        f"/orgs/{org_id}/clone-jobs/{created['id']}", headers=headers
    )
    assert response.status_code == 204
    assert (await client.get(f"/orgs/{org_id}/clone-jobs", headers=headers)).json() == []
    # The recording is a likeness; deleting the job must delete it too.
    assert not await get_storage().exists(reference_key(org_id, created["id"]))
