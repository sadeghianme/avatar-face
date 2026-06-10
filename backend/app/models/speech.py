from __future__ import annotations

from sqlalchemy import Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class SpeechCache(TimestampedBase):
    """Synthesized speech keyed on sha256(provider, voice, locale, text).

    Audio is small (seconds of compressed speech) so it lives inline in the
    row; viseme cues are stored as JSON text.
    """

    __tablename__ = "speech_cache"

    cache_key: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    voice: Mapped[str] = mapped_column(String(128), nullable=False)
    locale: Mapped[str] = mapped_column(String(16), nullable=False)
    char_count: Mapped[int] = mapped_column(Integer, nullable=False)
    audio_mime: Mapped[str] = mapped_column(String(64), nullable=False)
    audio: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    cues_json: Mapped[str] = mapped_column(Text, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
