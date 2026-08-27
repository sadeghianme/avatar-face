"""Language resolution: pick the language, get the best voice for it."""

import pytest

from app.services.tts.languages import BY_LOCALE, LANGUAGES, PROVIDER_ORDER, resolve


def test_persian_is_offered():
    """The gap that started this: espeak has always phonemized Persian, so
    the mouth moved correctly while no voice existed to speak it."""
    assert "fa-IR" in BY_LOCALE


def test_every_language_carries_a_sample_in_its_own_script():
    """Pressing Speak on Persian must demonstrate Persian. An English
    sentence read by a Persian voice is what makes a language picker feel
    broken even when it works."""
    for language in LANGUAGES:
        assert language.sample.strip()
        assert language.native_name.strip()
    # Spot-check that non-Latin languages really carry non-Latin samples.
    assert any("؀" <= ch <= "ۿ" for ch in BY_LOCALE["fa-IR"].sample)
    assert any("Ѐ" <= ch <= "ӿ" for ch in BY_LOCALE["ru-RU"].sample)
    assert any("ऀ" <= ch <= "ॿ" for ch in BY_LOCALE["hi-IN"].sample)


def test_quality_order_puts_kokoro_first():
    """Both are self-hosted and free, so the only tiebreak is quality —
    and it must be decided once here, not separately in the dashboard, the
    widget and the share page."""
    assert PROVIDER_ORDER.index("kokoro") < PROVIDER_ORDER.index("piper")


async def test_resolve_prefers_kokoro_when_both_can_speak(monkeypatch):
    from app.services.tts.base import Voice

    class Fake:
        def __init__(self, name, locale):
            self.name = name
            self._locale = locale

        def is_configured(self):
            return True

        async def voices(self):
            return [Voice(id=f"{self.name}_v", name="v", locale=self._locale)]

    monkeypatch.setattr(
        "app.services.tts.registry._ALL_PROVIDERS",
        [Fake("piper", "de-DE"), Fake("kokoro", "de-DE")],
    )
    assert await resolve("de-DE") == ("kokoro", "kokoro_v")


async def test_resolve_falls_back_to_the_bare_language(monkeypatch):
    """A request for de-AT must reach the German voice rather than silence
    over a region tag."""
    from app.services.tts.base import Voice

    class Fake:
        name = "piper"

        def is_configured(self):
            return True

        async def voices(self):
            return [Voice(id="de", name="German", locale="de-DE")]

    monkeypatch.setattr("app.services.tts.registry._ALL_PROVIDERS", [Fake()])
    assert await resolve("de-AT") == ("piper", "de")


async def test_unspeakable_language_resolves_to_nothing(monkeypatch):
    """Callers need a clear 'no voice' so they can fall back to browser
    speech, which still lip-syncs correctly."""
    monkeypatch.setattr("app.services.tts.registry._ALL_PROVIDERS", [])
    assert await resolve("sw-KE") is None


async def test_the_endpoint_lists_only_speakable_languages(client):
    response = await client.get("/tts/languages")
    assert response.status_code == 200
    for entry in response.json():
        assert entry["provider"] and entry["voice"]
        assert entry["sample"] and entry["native_name"]
