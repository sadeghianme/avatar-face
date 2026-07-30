from __future__ import annotations

from pydantic import BaseModel, Field


class ProviderOut(BaseModel):
    name: str
    display_name: str


class VoiceOut(BaseModel):
    id: str
    name: str
    locale: str
    gender: str


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    provider: str = "offline"
    voice: str = "offline-warm"
    locale: str = "en-US"


class CueOut(BaseModel):
    t: int
    viseme: str
    # How fully to reach the shape (unstressed syllables reduce). Optional so
    # an older widget bundle that ignores it still animates correctly.
    a: float = 1.0


class SynthesizeResponse(BaseModel):
    audio_b64: str
    audio_mime: str
    duration_ms: int
    cues: list[CueOut]
    cached: bool
