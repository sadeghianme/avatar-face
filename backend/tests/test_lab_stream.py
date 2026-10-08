import asyncio
import base64
import io
import json
import threading
import wave

import pytest

from app.services.tts import lab_timing
from app.services.tts.stream import pcm_packet, phrase_batch_size, speech_phrases
from tests.conftest import create_org, register_and_login


def wav_audio(samples=2400, channels=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\0\0" * samples * channels)
    return out.getvalue()


@pytest.mark.parametrize(
    "text",
    [
        "Peter bought a blue paper bag. Five very vivid flowers. We see two little boats. Please pause. Now say, oo, ee, ah.",
        "Dr. Smith paid 3.14 dollars. " * 8,
        "سلام، این یک آزمایش است. " * 12,
        "こんにちは。これはテストです。" * 15,
        "Words without punctuation " * 20,
        "x" * 600,
        "One. Two. Three. " * 30,
        "  \n Hello!  ",
    ],
)
def test_phrases_preserve_every_character(text):
    phrases = speech_phrases(text)
    assert "".join(phrases) == text
    assert all(p.strip() for p in phrases)
    if " " in text and len(text) > 80:
        assert len(phrases[0]) <= 73


def test_first_phrase_prefers_natural_boundary():
    text = "Peter bought a blue paper bag. " + "We have more to say about these bags. " * 5
    assert speech_phrases(text)[0].endswith(". ")
    assert len(speech_phrases(text)[0]) < 73
    assert not any(p.strip().endswith("Dr.") for p in speech_phrases("Dr. Smith " * 20))


def test_phrase_lookahead_adapts_to_actual_server_speed_and_buffer():
    phrases = ["a" * 54, "b" * 61, "c" * 54]
    assert phrase_batch_size(phrases, 10, None) == 1
    assert phrase_batch_size(phrases, 3.6, 0.055) == 1
    assert phrase_batch_size(phrases, 3.6, 0.020) == 2
    assert phrase_batch_size(phrases, 20, 0.055) == 2  # 120-char cap
    assert phrase_batch_size(phrases, 0.2, 0.001) == 1


def test_pcm_packet_uses_sample_offsets_and_exact_bytes():
    packet = pcm_packet(wav_audio(2401), 2, 4802, [{"t": 0, "viseme": "aa"}], [])
    assert packet["start_sample"] == 4802
    assert packet["sample_count"] == 2401
    assert len(base64.b64decode(packet["pcm_b64"])) == 4802
    with pytest.raises(ValueError):
        pcm_packet(wav_audio(channels=2), 0, 0, [], [])


async def setup_stream(client, monkeypatch):
    monkeypatch.setattr(lab_timing, "configured", lambda: True)
    calls = []

    async def fake(text, voice):
        calls.append(text)
        return (
            wav_audio(),
            100,
            [{"t": 0, "viseme": "PP"}, {"t": 100, "viseme": "sil"}],
            [{"t": 0, "viseme": "aa"}],
        )

    monkeypatch.setattr(lab_timing, "synthesize_native", fake)
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    return f"/orgs/{org}/lab/lip-sync/stream", headers, org, calls


async def test_ordered_stream_offsets_usage_and_no_avatar_writes(client, monkeypatch):
    path, headers, org, calls = await setup_stream(client, monkeypatch)
    text = "Peter bought a blue paper bag. " * 5
    response = await client.post(path, headers=headers, json={"text": text})
    assert response.status_code == 200
    assert response.headers["x-accel-buffering"] == "no"
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[0]["mode"] == "native_phrases"
    packets = events[1:-1]
    assert len(packets) > 1
    assert [p["sequence"] for p in packets] == list(range(len(packets)))
    assert [p["start_sample"] for p in packets] == [2400 * i for i in range(len(packets))]
    assert events[-1]["type"] == "done"
    assert events[-1]["total_samples"] == 2400 * len(packets)
    assert "".join(calls) == text
    assert (await client.get(f"/orgs/{org}/avatars", headers=headers)).json() == []
    from app.db import get_session_factory
    from app.services.usage import chars_used_this_month

    async with get_session_factory()() as session:
        assert await chars_used_this_month(session, org) == len(text)


async def test_stream_auth_validation_and_usage_before_inference(client, monkeypatch):
    path, headers, org, calls = await setup_stream(client, monkeypatch)
    assert (await client.post(path, json={"text": "Hello"})).status_code == 401
    other = await register_and_login(client, "other")
    assert (await client.post(path, headers=other, json={"text": "Hello"})).status_code == 404
    for text in ("  ", "x" * 601):
        assert (await client.post(path, headers=headers, json={"text": text})).status_code == 422
    assert not calls
    assert (
        await client.post(path, headers=headers, json={"text": "hello " * 100})
    ).status_code == 200
    count = len(calls)
    assert (
        await client.post(path, headers=headers, json={"text": "hello " * 100})
    ).status_code == 429
    assert len(calls) == count


async def test_partial_failure_is_terminal_and_slot_is_released(client, monkeypatch):
    path, headers, _, calls = await setup_stream(client, monkeypatch)
    original = lab_timing.synthesize_native

    async def fail_second(text, voice):
        if calls:
            raise ValueError("private model details must not be exposed")
        return await original(text, voice)

    monkeypatch.setattr(lab_timing, "synthesize_native", fail_second)
    response = await client.post(
        path, headers=headers, json={"text": "A long enough first sentence. " * 8}
    )
    events = [json.loads(line) for line in response.text.splitlines()]
    assert [e["type"] for e in events] == ["start", "chunk", "error"]
    assert "private model" not in response.text
    monkeypatch.setattr(lab_timing, "synthesize_native", original)
    assert (await client.post(path, headers=headers, json={"text": "Hello"})).status_code == 200


async def test_fallback_is_explicit(client, monkeypatch):
    path, headers, _, _ = await setup_stream(client, monkeypatch)
    response = await client.post(
        path,
        headers=headers,
        json={"text": "Hello", "provider": "offline", "voice": "offline-warm"},
    )
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[0]["mode"] == "buffered_provider"
    assert events[1]["timing_source"] == "existing_provider"
    assert [e["type"] for e in events] == ["start", "recording", "done"]


async def test_cancelling_inference_keeps_slot_until_worker_finishes(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def render(text, voice):
        calls.append(text)
        entered.set()
        release.wait(3)
        return text

    monkeypatch.setattr(lab_timing, "_render", render)
    monkeypatch.setattr(lab_timing, "_semaphore", asyncio.Semaphore(1))
    first = asyncio.create_task(lab_timing.synthesize_native("first", "voice"))
    assert await asyncio.to_thread(entered.wait, 2)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(lab_timing.synthesize_native("second", "voice"))
    await asyncio.sleep(0.02)
    assert calls == ["first"]
    release.set()
    assert await second == "second"
