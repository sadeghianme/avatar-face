"""The Kokoro provider speaks with the timestamped model and its own timings.

No model is loaded here: the timed render is faked, as every provider is in
tests. What is pinned is the provider's choice of path, the cues it serves,
its fallbacks, and the speech cache keeping the two kinds of recording
apart.
"""

from __future__ import annotations

import asyncio
import io
import wave

import pytest

from app.services.tts import kokoro, lab_timing, registry
from app.services.tts.kokoro import DEFAULT_VOICE, KokoroTTSProvider
from app.services.tts.lab_timing import PhoneSpan


def _wav(ms: int) -> bytes:
    """Silent mono 24 kHz PCM16, as the models write it."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * (24 * ms))
    return out.getvalue()


# "pa" with a pause after it: the model says the p starts at 120 ms.
SPANS = [PhoneSpan("p", 0.12, 0.18), PhoneSpan("a", 0.18, 0.42)]


@pytest.fixture
def timed(monkeypatch):
    """The timestamped model installed, answering with SPANS."""
    calls: list[tuple] = []

    def render_timed(text, voice_id, lang):
        calls.append((text, voice_id, lang))
        return _wav(1000), 1000, list(SPANS)

    monkeypatch.setattr(lab_timing, "configured", lambda: True)
    monkeypatch.setattr(lab_timing, "render_timed", render_timed)
    monkeypatch.setattr(kokoro, "original_configured", lambda: True)

    def original(*_args):
        raise AssertionError("the original model must not be used")

    monkeypatch.setattr(kokoro, "render", original)
    return calls


async def test_native_cues_come_from_the_models_own_spans(timed):
    result = await KokoroTTSProvider().synthesize("pa", "bf_emma", "en-GB")
    assert timed == [("pa", "bf_emma", "en-gb")]
    assert result.duration_ms == 1000
    # Where the model put the sound, not where a stretched table would.
    assert next(c["t"] for c in result.cues if c["viseme"] == "PP") == 120
    assert next(c["t"] for c in result.cues if c["viseme"] == "aa") == 180
    assert {"t": 420, "viseme": "sil", "a": 1.0} in result.cues
    assert result.cues[-1] == {"t": 1000, "viseme": "sil", "a": 1.0}
    assert result.cacheable


async def test_unusable_timings_keep_the_audio_and_fit_the_cues(monkeypatch, timed):
    """An unmapped phoneme is a timing problem, not an audio problem: the
    same recording is served, timed the stretched way."""
    monkeypatch.setattr(
        lab_timing, "render_timed", lambda *_: (_wav(800), 800, [PhoneSpan("Ж", 0, 0.2)])
    )
    result = await KokoroTTSProvider().synthesize("hello there", DEFAULT_VOICE, "en-US")
    assert result.duration_ms == 800
    assert result.cues[0]["t"] == 0 and result.cues[-1]["viseme"] == "sil"
    assert result.cacheable


async def test_a_failing_timed_model_falls_back_to_the_original(monkeypatch):
    def broken(*_args):
        raise RuntimeError("session failed")

    used: list[str] = []
    monkeypatch.setattr(lab_timing, "configured", lambda: True)
    monkeypatch.setattr(lab_timing, "render_timed", broken)
    monkeypatch.setattr(kokoro, "original_configured", lambda: True)
    monkeypatch.setattr(kokoro, "render", lambda text, v, lang: used.append(v) or (_wav(900), 900))
    result = await KokoroTTSProvider().synthesize("hello", DEFAULT_VOICE, "en-US")
    assert used == [DEFAULT_VOICE]
    assert result.duration_ms == 900
    # Keyed as native, made the old way: never kept.
    assert result.cacheable is False


async def test_without_the_original_model_a_timed_failure_is_an_error(monkeypatch):
    def broken(*_args):
        raise RuntimeError("session failed")

    monkeypatch.setattr(lab_timing, "configured", lambda: True)
    monkeypatch.setattr(lab_timing, "render_timed", broken)
    monkeypatch.setattr(kokoro, "original_configured", lambda: False)
    assert KokoroTTSProvider().is_configured()
    with pytest.raises(RuntimeError):
        await KokoroTTSProvider().synthesize("hello", DEFAULT_VOICE, "en-US")


async def test_the_switch_turns_native_timing_off(monkeypatch, timed):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "kokoro_native_timing", False)
    monkeypatch.setattr(kokoro, "render", lambda *_: (_wav(700), 700))
    result = await KokoroTTSProvider().synthesize("hello", DEFAULT_VOICE, "en-US")
    assert timed == []
    assert result.duration_ms == 700
    assert KokoroTTSProvider().cache_version() == ""


async def test_no_timed_model_means_the_original_path(monkeypatch):
    monkeypatch.setattr(lab_timing, "configured", lambda: False)
    monkeypatch.setattr(kokoro, "render", lambda *_: (_wav(600), 600))
    result = await KokoroTTSProvider().synthesize("hello", DEFAULT_VOICE, "en-US")
    assert result.duration_ms == 600
    assert result.cacheable
    assert KokoroTTSProvider().cache_version() == ""


def test_cache_keys_keep_native_and_stretched_recordings_apart():
    plain = registry.cache_key("kokoro", "af_heart", "en-US", "Hello")
    # Unchanged for every provider without a version: no existing row moves.
    assert plain == registry.cache_key("kokoro", "af_heart", "en-US", "Hello", "")
    assert plain != registry.cache_key(
        "kokoro", "af_heart", "en-US", "Hello", kokoro.NATIVE_CACHE_VERSION
    )


async def test_a_stretched_row_is_never_served_once_native_timing_is_on(app, monkeypatch):
    """A recording cached before native timing (stretched cues) stays in the
    table, but the native key does not find it: the text is spoken again."""
    from app.db import get_session_factory
    from app.services.tts import speech_cache
    from app.services.tts.base import SynthesisResult

    monkeypatch.setattr(kokoro, "original_configured", lambda: True)
    async with get_session_factory()() as db:
        await speech_cache.put(
            db,
            cache_key=registry.cache_key("kokoro", DEFAULT_VOICE, "en-US", "pa"),
            provider="kokoro",
            voice=DEFAULT_VOICE,
            locale="en-US",
            text="pa",
            result=SynthesisResult(
                audio=_wav(1000),
                audio_mime="audio/wav",
                duration_ms=1000,
                cues=[{"t": 0, "viseme": "sil"}, {"t": 999, "viseme": "sil"}],
            ),
            org_id=None,
        )

        monkeypatch.setattr(lab_timing, "configured", lambda: False)
        _, cached = await registry.synthesize_cached(db, "kokoro", DEFAULT_VOICE, "en-US", "pa")
        assert cached  # the old path still finds its own row

        monkeypatch.setattr(lab_timing, "configured", lambda: True)
        monkeypatch.setattr(lab_timing, "render_timed", lambda *_: (_wav(1000), 1000, list(SPANS)))
        result, cached = await registry.synthesize_cached(
            db, "kokoro", DEFAULT_VOICE, "en-US", "pa"
        )
        assert not cached
        assert any(c["viseme"] == "PP" for c in result.cues)
        # And the native recording is cached under its own key.
        _, cached = await registry.synthesize_cached(db, "kokoro", DEFAULT_VOICE, "en-US", "pa")
        assert cached


async def test_a_fallback_recording_is_not_cached(app, monkeypatch):
    from app.db import get_session_factory

    def broken(*_args):
        raise RuntimeError("session failed")

    monkeypatch.setattr(lab_timing, "configured", lambda: True)
    monkeypatch.setattr(lab_timing, "render_timed", broken)
    monkeypatch.setattr(kokoro, "original_configured", lambda: True)
    monkeypatch.setattr(kokoro, "render", lambda *_: (_wav(500), 500))
    async with get_session_factory()() as db:
        _, cached = await registry.synthesize_cached(db, "kokoro", DEFAULT_VOICE, "en-US", "hi")
        _, again = await registry.synthesize_cached(db, "kokoro", DEFAULT_VOICE, "en-US", "hi")
    assert not cached and not again


async def test_streamed_phrases_are_timed_natively_too(client, monkeypatch, timed):
    """The phrase stream synthesizes each phrase through the provider, so
    every packet's cues are the model's."""
    import json

    from tests.conftest import create_org, register_and_login

    headers = await register_and_login(client, "streamer")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/tts/orgs/{org_id}/stream",
        json={"text": "pa", "provider": "kokoro", "voice": DEFAULT_VOICE, "locale": "en-US"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    lines = [json.loads(line) for line in response.text.splitlines() if line]
    chunk = next(line for line in lines if line["type"] == "chunk")
    assert next(c["t"] for c in chunk["cues"] if c["viseme"] == "PP") == 120


# --- text no model can speak ------------------------------------------------------------


@pytest.mark.parametrize(
    "error",
    [
        "Nothing to synthesize, '...' produced no phonemes",
        "No phonemes of '…' are in the model vocabulary",
    ],
)
async def test_text_no_model_can_speak_is_the_callers_error(timed, monkeypatch, error):
    """Both models share the phonemizer and the vocabulary, so the original
    would fail the same way, after loading a second ~1 GB session for the
    life of the process while every other synthesis waits: it is refused
    at once, and the original model is never touched (`timed` makes it
    raise if it is)."""
    from app.core.errors import Validation422

    def unspeakable(text, voice_id, lang):
        raise ValueError(error)

    monkeypatch.setattr(lab_timing, "render_timed", unspeakable)
    with pytest.raises(Validation422) as refused:
        await KokoroTTSProvider().synthesize("...", DEFAULT_VOICE, "en-US")
    assert refused.value.code == "nothing_to_speak"
    # The semaphore was given back: the next synthesis is not held.
    monkeypatch.setattr(lab_timing, "render_timed", lambda *_: (_wav(1000), 1000, list(SPANS)))
    result = await asyncio.wait_for(KokoroTTSProvider().synthesize("pa", DEFAULT_VOICE, "en-US"), 1)
    assert result.duration_ms == 1000


async def test_a_model_that_cannot_time_its_speech_still_falls_back(monkeypatch):
    """A ValueError of the model's own (an export without durations) is a
    model failure: the original model may speak where this one cannot."""

    def no_durations(*_args):
        raise ValueError("Lab model/runtime does not expose phoneme durations")

    used: list[str] = []
    monkeypatch.setattr(lab_timing, "configured", lambda: True)
    monkeypatch.setattr(lab_timing, "render_timed", no_durations)
    monkeypatch.setattr(kokoro, "original_configured", lambda: True)
    monkeypatch.setattr(kokoro, "render", lambda text, v, lang: used.append(v) or (_wav(900), 900))
    result = await KokoroTTSProvider().synthesize("hello", DEFAULT_VOICE, "en-US")
    assert used == [DEFAULT_VOICE] and result.cacheable is False


async def test_the_original_model_refuses_unspeakable_text_the_same_way(monkeypatch):
    from app.core.errors import Validation422

    def unspeakable(*_args):
        raise ValueError("Nothing to synthesize, '' produced no phonemes")

    monkeypatch.setattr(lab_timing, "configured", lambda: False)
    monkeypatch.setattr(kokoro, "render", unspeakable)
    with pytest.raises(Validation422) as refused:
        await KokoroTTSProvider().synthesize("?!", DEFAULT_VOICE, "en-US")
    assert refused.value.code == "nothing_to_speak"


async def test_unspeakable_text_is_a_422_over_the_api(client, monkeypatch):
    from tests.conftest import create_org, register_and_login

    def unspeakable(*_args):
        raise ValueError("Nothing to synthesize, '...' produced no phonemes")

    monkeypatch.setattr(lab_timing, "configured", lambda: True)
    monkeypatch.setattr(lab_timing, "render_timed", unspeakable)
    monkeypatch.setattr(kokoro, "original_configured", lambda: True)
    headers = await register_and_login(client, "silent")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/tts/orgs/{org_id}/synthesize",
        json={"text": "...", "provider": "kokoro", "voice": DEFAULT_VOICE, "locale": "en-US"},
        headers=headers,
    )
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "nothing_to_speak"
