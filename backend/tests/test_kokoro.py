"""Kokoro local TTS: registration, graceful absence, and cue alignment."""

import pytest

from app.services.tts.base import SynthesisResult
from app.services.tts.kokoro import DEFAULT_VOICE, VOICES, KokoroTTSProvider


def test_absent_model_files_mean_unconfigured(monkeypatch):
    """A dev checkout without the ~350MB download must still boot, with the
    provider simply invisible rather than raising on import or on listing."""
    from app.core import config

    settings = config.get_settings()
    monkeypatch.setattr(settings, "kokoro_model_path", "/nope/model.onnx", raising=False)
    monkeypatch.setattr(settings, "kokoro_voices_path", "/nope/voices.bin", raising=False)
    assert KokoroTTSProvider().is_configured() is False


def test_it_is_registered_among_the_providers():
    from app.services.tts import registry

    assert any(p.name == "kokoro" for p in registry._ALL_PROVIDERS)


async def test_voices_are_all_english_and_include_the_default():
    voices = await KokoroTTSProvider().voices()
    assert voices == VOICES
    assert any(v.id == DEFAULT_VOICE for v in voices)
    # Only languages the shipped phonemizer data covers are offered; a menu
    # promising languages that then fail is worse than a short menu.
    assert all(v.locale.startswith("en") for v in voices)


async def test_an_unknown_voice_falls_back_rather_than_failing(monkeypatch):
    """Voice ids travel in embed snippets pasted on customer sites. A stale
    one must degrade to the default, never 500 a visitor's page."""
    captured = {}

    def fake_render(text, voice_id, lang):
        captured["voice"] = voice_id
        captured["lang"] = lang
        return b"RIFF0000WAVE", 1000

    monkeypatch.setattr("app.services.tts.kokoro._render", fake_render)
    provider = KokoroTTSProvider()
    result = await provider.synthesize("hello", "no-such-voice", "en-US")
    assert captured["voice"] == DEFAULT_VOICE
    assert isinstance(result, SynthesisResult)


async def test_british_voices_phonemize_as_british(monkeypatch):
    """en-gb vs en-us changes the phonemization; a British voice reading
    American phonemes is the accent slipping mid-sentence."""
    captured = {}

    monkeypatch.setattr(
        "app.services.tts.kokoro._render",
        lambda text, voice_id, lang: (captured.update(lang=lang) or (b"RIFF", 500)),
    )
    provider = KokoroTTSProvider()
    await provider.synthesize("hello", "bf_emma", "en-GB")
    assert captured["lang"] == "en-gb"
    await provider.synthesize("hello", "am_michael", "en-US")
    assert captured["lang"] == "en-us"


async def test_cues_span_the_measured_audio(monkeypatch):
    """The mouth is driven by these cues; if they do not reach the end of the
    audio the avatar stops moving while the voice is still talking."""
    monkeypatch.setattr(
        "app.services.tts.kokoro._render", lambda text, voice_id, lang: (b"RIFF", 4000)
    )
    result = await KokoroTTSProvider().synthesize(
        "Hello there, this is a test of the local voice.", DEFAULT_VOICE, "en-US"
    )
    assert result.duration_ms == 4000
    assert result.cues[0]["t"] == 0
    assert result.cues[-1]["viseme"] == "sil"
    assert abs(result.cues[-1]["t"] - 4000) < 400
