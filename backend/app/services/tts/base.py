"""TTS provider abstraction.

Every provider returns SynthesisResult with viseme cues normalized to the 15
Oculus visemes, regardless of what the upstream API natively emits.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field


@dataclass
class Voice:
    id: str
    name: str
    locale: str
    gender: str = "neutral"


@dataclass
class SynthesisResult:
    audio: bytes
    audio_mime: str
    duration_ms: int
    # [{"t": ms, "viseme": "aa"}, ...] always starting at t=0, ending at "sil"
    cues: list[dict] = field(default_factory=list)
    # False: serve this result, but keep it out of the speech cache (a
    # fallback made while the provider's usual path was failing).
    cacheable: bool = True


class TTSProvider:
    name: str = "base"
    display_name: str = "Base"
    # Whether this provider belongs in a generic provider list. Cloned
    # voices are per-organisation rows, so a global listing would show an
    # empty entry to everyone and leak nothing useful to anyone.
    listed: bool = True

    def is_configured(self) -> bool:
        raise NotImplementedError

    async def voices(self) -> list[Voice]:
        raise NotImplementedError

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        raise NotImplementedError

    def cache_version(self) -> str:
        """Part of the speech cache key, changed when what this provider
        returns for the same text changes meaning (new timing, new model),
        so an old row is never served as a new one. Empty for most."""
        return ""


def cache_key(provider: str, voice: str, locale: str, text: str, version: str = "") -> str:
    """The speech cache row for this text. `version` is the provider's
    cache_version(); empty keeps the key every older row was stored under."""
    parts = (provider, voice, locale, text) + ((version,) if version else ())
    payload = "\x1f".join(parts)
    return hashlib.sha256(payload.encode()).hexdigest()
