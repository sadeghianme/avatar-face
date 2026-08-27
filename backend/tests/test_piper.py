"""Piper: the languages Kokoro cannot speak, Persian first."""

import pytest

from app.services.tts.piper import CATALOGUE, PiperTTSProvider


def test_persian_is_covered():
    """The reason this provider exists: Kokoro has no Persian, and espeak —
    which drives our lip-sync — has had it all along."""
    locales = {locale for _, _, locale in CATALOGUE.values()}
    assert "fa-IR" in locales


def test_it_covers_languages_kokoro_does_not():
    """Overlap would be wasted disk: Piper is here for the gap."""
    from app.services.tts.kokoro import VOICES as KOKORO_VOICES

    kokoro_langs = {v.locale.split("-")[0] for v in KOKORO_VOICES}
    piper_langs = {locale.split("-")[0] for _, _, locale in CATALOGUE.values()}
    assert not (piper_langs & kokoro_langs)


def test_no_voices_on_disk_means_unconfigured(monkeypatch):
    """An image built without the ~500MB of voices must boot and simply not
    advertise this provider."""
    from app.core import config

    monkeypatch.setattr(config.get_settings(), "piper_voices_dir", None, raising=False)
    assert PiperTTSProvider().is_configured() is False


async def test_only_installed_voices_are_advertised(monkeypatch, tmp_path):
    """Advertising a voice whose file is absent turns a menu entry into a
    500 for whoever picks it."""
    from app.core import config

    stem = CATALOGUE["fa_amir"][0]
    (tmp_path / f"{stem}.onnx").write_bytes(b"not a real model")
    monkeypatch.setattr(config.get_settings(), "piper_voices_dir", str(tmp_path), raising=False)

    provider = PiperTTSProvider()
    assert provider.is_configured() is True
    voices = await provider.voices()
    assert [v.id for v in voices] == ["fa_amir"]
    assert voices[0].locale == "fa-IR"


async def test_an_unknown_voice_prefers_the_requested_locale(monkeypatch, tmp_path):
    """Voice ids live in embed snippets on customer sites; a stale one must
    degrade to something that speaks the right language, never 500."""
    from app.core import config

    for key in ("fa_amir", "de_thorsten"):
        (tmp_path / f"{CATALOGUE[key][0]}.onnx").write_bytes(b"stub")
    monkeypatch.setattr(config.get_settings(), "piper_voices_dir", str(tmp_path), raising=False)

    captured = {}
    monkeypatch.setattr(
        "app.services.tts.piper._render",
        lambda text, stem: (captured.update(stem=stem) or (b"RIFF", 1000)),
    )
    await PiperTTSProvider().synthesize("hallo", "no-such-voice", "de-DE")
    assert captured["stem"] == CATALOGUE["de_thorsten"][0]


async def test_cues_use_the_voice_language_not_the_callers(monkeypatch, tmp_path):
    """The audio was phonemized in the voice's language; deriving visemes in
    a different one drifts the mouth from the sound."""
    from app.core import config
    from app.services.tts import piper as piper_module

    (tmp_path / f"{CATALOGUE['fa_amir'][0]}.onnx").write_bytes(b"stub")
    monkeypatch.setattr(config.get_settings(), "piper_voices_dir", str(tmp_path), raising=False)
    monkeypatch.setattr(piper_module, "_render", lambda text, stem: (b"RIFF", 2000))

    seen = {}
    real = piper_module.cues_from_text
    monkeypatch.setattr(
        piper_module,
        "cues_from_text",
        lambda text, duration, locale: (seen.update(locale=locale) or real(text, duration, locale)),
    )
    # Caller claims en-US; the Persian voice's own locale must win.
    await PiperTTSProvider().synthesize("سلام", "fa_amir", "en-US")
    assert seen["locale"] == "fa-IR"
