"""TTS provider abstraction.

Every provider returns SynthesisResult with viseme cues normalized to the 15
Oculus visemes, regardless of what the upstream API natively emits.
"""
from __future__ import annotations

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


class TTSProvider:
    name: str = "base"
    display_name: str = "Base"

    def is_configured(self) -> bool:
        raise NotImplementedError

    async def voices(self) -> list[Voice]:
        raise NotImplementedError

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        raise NotImplementedError
