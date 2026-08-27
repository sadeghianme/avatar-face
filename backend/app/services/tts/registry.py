"""Provider registry + speech cache.

The offline provider is always available; real providers appear only when
their credentials are configured. Synthesis results are cached in the
speech_cache table keyed on sha256(provider, voice, locale, text).
"""
from __future__ import annotations

import hashlib
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound404, Validation422
from app.models import SpeechCache
from app.services.tts.base import SynthesisResult, TTSProvider
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


def cache_key(provider: str, voice: str, locale: str, text: str) -> str:
    payload = "\x1f".join((provider, voice, locale, text))
    return hashlib.sha256(payload.encode()).hexdigest()


async def synthesize_cached(
    db: AsyncSession, provider_name: str, voice: str, locale: str, text: str
) -> tuple[SynthesisResult, bool]:
    """Synthesize through the cache. Returns (result, was_cached)."""
    key = cache_key(provider_name, voice, locale, text)
    row = (
        await db.execute(select(SpeechCache).where(SpeechCache.cache_key == key))
    ).scalar_one_or_none()
    if row is not None:
        return (
            SynthesisResult(
                audio=row.audio,
                audio_mime=row.audio_mime,
                duration_ms=row.duration_ms,
                cues=json.loads(row.cues_json),
            ),
            True,
        )

    provider = get_provider(provider_name)
    result = await provider.synthesize(text, voice, locale)
    db.add(
        SpeechCache(
            cache_key=key,
            provider=provider_name,
            voice=voice,
            locale=locale,
            char_count=len(text),
            audio_mime=result.audio_mime,
            audio=result.audio,
            cues_json=json.dumps(result.cues),
            duration_ms=result.duration_ms,
        )
    )
    await db.commit()
    return result, False
