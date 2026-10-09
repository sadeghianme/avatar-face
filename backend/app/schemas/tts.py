from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.published import Absent, absent_when_none


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
    # Optional, no default in the schema: the generated clients send it only
    # when they mean it (a default would make it a required key there).
    word_marks: bool | Absent = Field(
        default=None,
        description="Also answer each word's start time (`word_marks`): what places "
        "a text's expressions on the voice. Absent or false, the answer has no such key.",
    )


class WordMark(BaseModel):
    """Where a word starts: its first character in the text, and its time, ms."""

    char: int
    t: int


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
    word_marks: list[WordMark] | Absent = absent_when_none(
        "Each word's start in the audio, ms, when the request asked for them."
    )
