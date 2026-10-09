"""Provider registry + speech cache.

The offline provider is always available; real providers appear only when
their credentials are configured. Synthesis results are cached
(services.tts.speech_cache: the recording in storage as MP3, a row each in
speech_clips) keyed on sha256(provider, voice, locale, text).
"""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound404, Validation422
from app.services.tts import speech_cache, speech_codec
from app.services.tts.base import SynthesisResult, TTSProvider, cache_key
from app.services.tts.cloned import ClonedTTSProvider
from app.services.tts.kokoro import KokoroTTSProvider
from app.services.tts.offline import OfflineTTSProvider
from app.services.tts.piper import PiperTTSProvider
from app.services.tts.providers import (
    AzureTTSProvider,
    ElevenLabsTTSProvider,
    GoogleTTSProvider,
    OpenAITTSProvider,
)

_ALL_PROVIDERS: list[TTSProvider] = [
    OfflineTTSProvider(),
    ClonedTTSProvider(),
    KokoroTTSProvider(),
    PiperTTSProvider(),
    AzureTTSProvider(),
    ElevenLabsTTSProvider(),
    GoogleTTSProvider(),
    OpenAITTSProvider(),
]


def all_providers() -> list[TTSProvider]:
    """Every provider, configured or not, in registration order."""
    return list(_ALL_PROVIDERS)


def available_providers() -> list[TTSProvider]:
    return [p for p in _ALL_PROVIDERS if p.listed and p.is_configured()]


def get_provider(name: str) -> TTSProvider:
    for provider in _ALL_PROVIDERS:
        if provider.name == name:
            if not provider.is_configured():
                raise Validation422(
                    f"Provider '{name}' is not configured", code="provider_not_configured"
                )
            return provider
    raise NotFound404(f"Unknown TTS provider '{name}'", code="unknown_provider")


def _cache_version(provider_name: str) -> str:
    for provider in _ALL_PROVIDERS:
        if provider.name == provider_name:
            return provider.cache_version()
    return ""


async def synthesize_cached(
    db: AsyncSession,
    provider_name: str,
    voice: str,
    locale: str,
    text: str,
    *,
    org_id: str | None = None,
    pcm: bool = False,
) -> tuple[SynthesisResult, bool]:
    """Synthesize through the cache. Returns (result, was_cached).

    The audio is what the cache stores (MP3 for a provider's WAV), the same
    on the first request and every one after, unless `pcm`: then it is
    16-bit PCM WAV (the dashboard's phrase stream reads samples). `org_id`
    is the organization the line is counted against in the cache's
    per-organization cap.
    """
    key = cache_key(provider_name, voice, locale, text, _cache_version(provider_name))
    hit = await speech_cache.get(db, key)
    if hit is not None:
        if pcm:
            hit.audio = await asyncio.to_thread(speech_codec.as_wav, hit.audio, hit.audio_mime)
            hit.audio_mime = "audio/wav"
        return hit, True

    provider = get_provider(provider_name)
    result = await provider.synthesize(text, voice, locale)
    if not result.cacheable:
        return result, False
    stored = await speech_cache.put(
        db,
        cache_key=key,
        provider=provider_name,
        voice=voice,
        locale=locale,
        text=text,
        result=result,
        org_id=org_id,
    )
    return (result if pcm else stored), False
