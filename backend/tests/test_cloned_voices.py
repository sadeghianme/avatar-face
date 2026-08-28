"""Cloned voices: uploaded audio served from the speech cache."""

import io
import json
import wave

import pytest

from tests.conftest import create_org, register_and_login


def _wav(seconds: float = 1.0, rate: int = 24000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * int(rate * seconds))
    return buffer.getvalue()


async def _upload(client, headers, org_id, name, text, consent="true", audio=None):
    return await client.post(
        f"/orgs/{org_id}/cloned-voices/{name}/lines",
        headers=headers,
        data={"text": text, "locale": "en-US", "consent": consent},
        files={"audio": ("line.wav", audio or _wav(), "audio/wav")},
    )


@pytest.fixture
async def org(client):
    headers = await register_and_login(client, "cloner")
    return headers, await create_org(client, headers)


async def test_upload_without_consent_is_refused(client, org):
    headers, org_id = org
    response = await _upload(client, headers, org_id, "sarah", "Hello", consent="false")
    assert response.status_code == 422
    assert response.json()["code"] == "consent_required"


async def test_an_uploaded_line_becomes_a_cache_hit(client, org):
    """The whole design: uploading IS seeding the cache, so playback uses
    the same path as any cached synthesis."""
    from app.services.tts.cloned import PROVIDER_NAME, scoped_voice_id
    from app.services.tts.registry import cache_key, synthesize_cached
    from app.db import get_session_factory

    headers, org_id = org
    assert (await _upload(client, headers, org_id, "sarah", "Hello there")).status_code == 200

    voice = scoped_voice_id(org_id, "sarah")
    async with get_session_factory()() as db:
        result, cached = await synthesize_cached(db, PROVIDER_NAME, voice, "en-US", "Hello there")
    assert cached is True
    assert result.audio_mime == "audio/wav"
    assert result.duration_ms > 0
    # Cues are generated server-side, so the uploader never supplies them.
    assert result.cues and result.cues[0]["t"] == 0
    assert result.cues[-1]["viseme"] == "sil"
    assert cache_key(PROVIDER_NAME, voice, "en-US", "Hello there")


async def test_a_line_that_was_never_uploaded_is_a_clean_404(client, org):
    """A miss must be actionable, not a 500 — the caller falls back to a
    server voice rather than substituting a different person's voice."""
    from app.core.errors import NotFound404
    from app.services.tts.cloned import ClonedTTSProvider

    with pytest.raises(NotFound404) as caught:
        await ClonedTTSProvider().synthesize("never uploaded", "org:sarah", "en-US")
    assert caught.value.code == "cloned_line_missing"


async def test_non_wav_audio_is_rejected(client, org):
    """Duration drives the viseme track; a file we cannot measure would give
    a mouth that stops moving while the voice keeps talking."""
    headers, org_id = org
    response = await _upload(client, headers, org_id, "sarah", "Hi", audio=b"not audio at all")
    assert response.status_code == 422
    assert response.json()["code"] == "not_a_wav"


async def test_voices_are_scoped_to_the_organisation(client, org):
    """The cache is global. Two orgs that both cloned 'sarah' must not read
    each other's audio — or each other's scripts."""
    headers, org_id = org
    await _upload(client, headers, org_id, "sarah", "Our secret roadmap line")

    other_headers = await register_and_login(client, "stranger")
    other_org = await create_org(client, other_headers, name="Other")
    listed = (
        await client.get(f"/orgs/{other_org}/cloned-voices", headers=other_headers)
    ).json()
    assert listed == []

    from app.services.tts.cloned import scoped_voice_id

    assert scoped_voice_id(org_id, "sarah") != scoped_voice_id(other_org, "sarah")


async def test_re_uploading_a_line_replaces_it(client, org):
    """Re-rendering after a model upgrade must not double the row count."""
    headers, org_id = org
    await _upload(client, headers, org_id, "sarah", "Same line")
    second = await _upload(client, headers, org_id, "sarah", "Same line", audio=_wav(2.0))
    assert second.json()["lines"] == 1
    assert second.json()["total_ms"] > 1500


async def test_deleting_a_voice_removes_every_line(client, org):
    """A takedown path for a likeness has to actually delete the audio."""
    headers, org_id = org
    await _upload(client, headers, org_id, "sarah", "One")
    await _upload(client, headers, org_id, "sarah", "Two")
    assert (await client.get(f"/orgs/{org_id}/cloned-voices", headers=headers)).json()[0]["lines"] == 2

    response = await client.delete(f"/orgs/{org_id}/cloned-voices/sarah", headers=headers)
    assert response.status_code == 204
    assert (await client.get(f"/orgs/{org_id}/cloned-voices", headers=headers)).json() == []


async def test_cloned_never_appears_in_the_global_provider_list(client):
    """It is per-org; a global entry would be empty for everyone."""
    providers = {p["name"] for p in (await client.get("/tts/providers")).json()}
    assert "cloned" not in providers


async def test_a_missing_line_renders_on_demand_where_hardware_allows(monkeypatch):
    """A cloned voice should be a voice, not a soundboard: on a machine that
    can render, asking for an unrecorded line produces it."""
    from app.services import local_render
    from app.services.tts import cloned as cloned_module
    from app.services.tts.cloned import ClonedTTSProvider

    monkeypatch.setattr(
        local_render, "_probe_result", {"available": True, "device": "mps", "reason": None}
    )
    monkeypatch.setattr(cloned_module, "_reference_for", lambda voice: _ref())

    async def fake_render(reference, text):
        assert reference == b"REFERENCE"
        return _wav(), 1000

    monkeypatch.setattr(local_render, "render_text", fake_render)
    result = await ClonedTTSProvider().synthesize("brand new line", "org:sarah", "en-US")
    assert result.duration_ms == 1000
    assert result.cues and result.cues[-1]["viseme"] == "sil"


async def _ref():
    return b"REFERENCE"


async def test_a_missing_line_still_fails_where_it_cannot_render(monkeypatch):
    """On the CPU-only server, substituting a different voice for someone's
    cloned likeness would be worse than failing."""
    from app.core.errors import NotFound404
    from app.services import local_render
    from app.services.tts.cloned import ClonedTTSProvider

    monkeypatch.setattr(
        local_render,
        "_probe_result",
        {"available": False, "device": None, "reason": "no accelerator"},
    )
    with pytest.raises(NotFound404) as caught:
        await ClonedTTSProvider().synthesize("nope", "org:sarah", "en-US")
    assert caught.value.code == "cloned_line_missing"
