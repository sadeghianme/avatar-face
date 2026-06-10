import base64
import wave
import io

from tests.conftest import create_org, register_and_login


async def test_providers_lists_offline_only_when_unconfigured(client):
    response = await client.get("/tts/providers")
    assert response.status_code == 200
    names = [p["name"] for p in response.json()]
    assert names == ["offline"]


async def test_offline_voices(client):
    response = await client.get("/tts/providers/offline/voices")
    assert response.status_code == 200
    assert len(response.json()) >= 2


async def test_unknown_provider_404(client):
    response = await client.get("/tts/providers/nope/voices")
    assert response.status_code == 404


async def test_unconfigured_provider_422(client):
    response = await client.get("/tts/providers/elevenlabs/voices")
    assert response.status_code == 422
    assert response.json()["code"] == "provider_not_configured"


async def _synthesize(client, headers, org_id, text="Hello world"):
    return await client.post(
        f"/tts/orgs/{org_id}/synthesize",
        json={"text": text, "provider": "offline", "voice": "offline-warm"},
        headers=headers,
    )


async def test_synthesize_returns_audio_and_cues(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await _synthesize(client, headers, org_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["audio_mime"] == "audio/wav"
    assert body["duration_ms"] > 0
    assert body["cached"] is False

    audio = base64.b64decode(body["audio_b64"])
    with wave.open(io.BytesIO(audio)) as wav:
        assert wav.getnframes() > 0

    cues = body["cues"]
    assert cues[0]["t"] == 0
    assert cues[-1]["viseme"] == "sil"
    assert any(c["viseme"] != "sil" for c in cues)
    assert all(cues[i]["t"] <= cues[i + 1]["t"] for i in range(len(cues) - 1))


async def test_synthesize_cache_hit(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    first = await _synthesize(client, headers, org_id, "Cache me")
    second = await _synthesize(client, headers, org_id, "Cache me")
    assert first.json()["cached"] is False
    assert second.json()["cached"] is True
    assert first.json()["audio_b64"] == second.json()["audio_b64"]


async def test_cache_key_distinguishes_voice(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    warm = await client.post(
        f"/tts/orgs/{org_id}/synthesize",
        json={"text": "Same text", "provider": "offline", "voice": "offline-warm"},
        headers=headers,
    )
    bright = await client.post(
        f"/tts/orgs/{org_id}/synthesize",
        json={"text": "Same text", "provider": "offline", "voice": "offline-bright"},
        headers=headers,
    )
    assert bright.json()["cached"] is False
    assert warm.json()["audio_b64"] != bright.json()["audio_b64"]


async def test_synthesize_requires_membership(client):
    alice = await register_and_login(client, "alice")
    bob = await register_and_login(client, "bob")
    org_id = await create_org(client, alice)
    response = await _synthesize(client, bob, org_id)
    assert response.status_code == 404


async def test_empty_text_rejected(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await _synthesize(client, headers, org_id, "")
    assert response.status_code == 422
