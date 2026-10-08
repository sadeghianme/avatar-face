from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase, utcnow


class SpeechClip(TimestampedBase):
    """One synthesised line in the speech cache (services.tts.speech_cache).

    The row is the index; the audio is a file in storage (`audio_key`, MP3),
    so the database and its backups carry a few hundred bytes per line, not
    the recording. Keyed on sha256(provider, voice, locale, text[, version]).

    `audio` holds a recording only until it is moved to storage: a cloned
    voice's line carried over from the old table by migration 028, which
    services.tts.speech_cache.drain moves out at startup.
    """

    __tablename__ = "speech_clips"
    __table_args__ = (
        # Eviction walks the unpinned lines least recently used first.
        Index("ix_speech_clips_pinned_last_used", "pinned", "last_used_at"),
    )

    cache_key: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    voice: Mapped[str] = mapped_column(String(128), nullable=False)
    locale: Mapped[str] = mapped_column(String(16), nullable=False)
    char_count: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    cues_json: Mapped[str] = mapped_column(Text, nullable=False)
    audio_mime: Mapped[str] = mapped_column(String(64), nullable=False)
    # Where the recording is in storage; null only while `audio` holds it.
    audio_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    audio: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    # The recording's size in storage: what the caps below are counted in.
    size_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # The organization whose request made it (what its share of the cache
    # is counted against); null when the caller named none.
    org_id: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    # Never evicted: a cloned voice's line, which cannot be made again here.
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_used_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class LegacySpeechCache(TimestampedBase):
    """The speech cache before migration 028: the recording inline, as WAV.

    Emptied by that migration (a cloned voice's lines moved to speech_clips)
    and kept, empty, so that a release from before can still be rolled back
    to: it reads and writes this table. Anything such a release wrote is
    drained into speech_clips by the next one (services.tts.speech_cache).
    A later migration drops it.
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
