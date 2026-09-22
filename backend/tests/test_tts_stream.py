"""Phrase streaming on the stable TTS API."""

import io
import json
import math
import struct
import wave

from app.services.tts.base import SynthesisResult
from tests.conftest import create_org, register_and_login


def _wav(ms: int, rate: int = 24000) -> bytes:
    frames = bytearray()
    for i in range(int(rate * ms / 1000)):
        frames += struct.pack("<h", int(8000 * math.sin(i * 0.05)))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(frames))
    return buffer.getvalue()


def _fake_kokoro(monkeypatch, calls: list[str]):
    """Stand in for Kokoro: one 300ms WAV per call, cues at 0 and the end."""
    from app.services.tts import registry

    real = registry.synthesize_cached

    async def fake(db, provider, voice, locale, text):
        if provider != "kokoro":
            return await real(db, provider, voice, locale, text)
        calls.append(text)
        ms = 300
        return SynthesisResult(
            audio=_wav(ms), audio_mime="audio/wav", duration_ms=ms,
            cues=[{"t": 0, "viseme": "aa", "a": 1.0}, {"t": ms, "viseme": "sil", "a": 1.0}],
        ), False

    from app.api import tts as tts_api

    monkeypatch.setattr(tts_api, "synthesize_cached", fake)


def _frames(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


async def _org(client):
    headers = await register_and_login(client, "streamer")
    return headers, await create_org(client, headers)


async def test_kokoro_streams_in_phrases_with_offsets_that_join(client, monkeypatch):
    headers, org_id = await _org(client)
    calls: list[str] = []
    _fake_kokoro(monkeypatch, calls)
    text = "The market opened higher today. Analysts were surprised, and said so. Then it fell."
    response = await client.post(
        f"/tts/orgs/{org_id}/stream", json={"text": text, "provider": "kokoro", "voice": "af_heart"}, headers=headers
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    frames = _frames(response.text)
    assert frames[0] == {"type": "start", "version": 1, "mode": "phrases"}
    chunks = [f for f in frames if f["type"] == "chunk"]
    assert len(chunks) >= 2, "a three-sentence script must stream in more than one phrase"
    # Every character reaches synthesis exactly once, in order.
    assert "".join(calls) == text
    # Sample offsets join end to end, and every chunk carries its own cues.
    offset = 0
    for i, chunk in enumerate(chunks):
        assert chunk["sequence"] == i
        assert chunk["start_sample"] == offset
        assert chunk["sample_rate"] == 24000
        assert chunk["cues"] and chunk["baseline_cues"]
        offset += chunk["sample_count"]
    done = frames[-1]
    assert done["type"] == "done"
    assert done["chunks"] == len(chunks)
    assert done["total_samples"] == offset


async def test_other_providers_get_one_recording_frame(client):
    headers, org_id = await _org(client)
    response = await client.post(
        f"/tts/orgs/{org_id}/stream",
        json={"text": "Hello there.", "provider": "offline", "voice": "offline-warm"},
        headers=headers,
    )
    frames = _frames(response.text)
    assert frames[0]["mode"] == "recording"
    recording = frames[1]
    assert recording["type"] == "recording"
    assert recording["audio_b64"] and recording["cues"]
    assert recording["timing_source"] == "existing_provider"
    assert frames[-1] == {"type": "done", "chunks": 0}


async def test_every_phrase_is_metered(client, monkeypatch):
    headers, org_id = await _org(client)
    calls: list[str] = []
    _fake_kokoro(monkeypatch, calls)
    text = "One sentence here. And a second one, clearly. Third."
    before = (await client.get(f"/orgs/{org_id}/usage", headers=headers)).json()
    await client.post(f"/tts/orgs/{org_id}/stream", json={"text": text, "provider": "kokoro", "voice": "af_heart"}, headers=headers)
    after = (await client.get(f"/orgs/{org_id}/usage", headers=headers)).json()
    assert after["chars_used"] - before["chars_used"] == len(text)


async def test_a_failing_phrase_is_reported_not_hidden(client, monkeypatch):
    headers, org_id = await _org(client)
    from app.api import tts as tts_api

    async def broken(db, provider, voice, locale, text):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(tts_api, "synthesize_cached", broken)
    response = await client.post(
        f"/tts/orgs/{org_id}/stream", json={"text": "Anything at all.", "provider": "kokoro", "voice": "af_heart"}, headers=headers
    )
    frames = _frames(response.text)
    assert frames[-1]["type"] == "error"
    assert frames[-1]["code"] == "speech_stream_failed"
    # The slot is released: a second stream is allowed.
    again = await client.post(
        f"/tts/orgs/{org_id}/stream", json={"text": "Anything at all.", "provider": "kokoro", "voice": "af_heart"}, headers=headers
    )
    assert again.status_code == 200


async def test_another_org_cannot_stream_on_your_account(client):
    headers, org_id = await _org(client)
    other = await register_and_login(client, "streamintruder")
    response = await client.post(
        f"/tts/orgs/{org_id}/stream", json={"text": "hi", "provider": "offline", "voice": "offline-warm"}, headers=other
    )
    assert response.status_code in (403, 404)
