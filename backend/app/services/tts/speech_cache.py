"""The speech cache: every line spoken, in storage, with a small row each.

Saying a line again costs nothing, so every distinct (provider, voice,
locale, text) a widget, a share page or the dashboard speaks is kept. It used
to be kept as a WAV blob in the main SQLite database, with nothing ever
evicting it: at the default monthly character allowance that was about
0.3 GB of WAV per organization per month, copied again into every deploy's
backup. Now:

* **The recording is a file in storage** (`speech/<k[:2]>/<key>-<nonce>.mp3`),
  as MP3: VBR from libsndfile's LAME (soundfile, already a dependency), about
  a tenth of the WAV. libsndfile writes the LAME header that names the
  encoder's delay and padding, so Chromium, Safari (CoreAudio) and
  libsndfile decode it to exactly the WAV's samples: the cues, timed against
  the WAV, stay on time. `encode` checks that on every line and keeps the
  original when it does not hold. Every player takes `audio/mpeg` (the
  widget, the share page and the dashboard play `audio_mime` through an
  audio element); the dashboard's phrase stream wants PCM and asks for it
  (`as_wav`).
* **The row is the index**: key, cues, duration, mime, where the file is and
  how big, which organization's request made it, and when it was last used.
  The database and its backups carry a few hundred bytes a line.
* **Eviction** (`evict`, from the sweeper): lines unused for
  SPEECH_CACHE_MAX_IDLE_DAYS, then the least recently used past each
  organization's SPEECH_CACHE_ORG_MAX_BYTES, then past
  SPEECH_CACHE_MAX_BYTES in all, down to LOW_WATER of the cap so a sweep does
  not run at every line. A cloned voice's lines are pinned: uploaded or
  rendered on other hardware, they cannot be made again here, so they are
  never evicted and not counted against either cap.
* **The old table is drained** (`drain`, at startup and by the sweeper):
  whatever a rolled-back release wrote to `speech_cache`, and the cloned
  lines migration 028 carried over inline, are moved to storage.

Last use is recorded at most once an hour a line (TOUCH_RESOLUTION): a
write for every hit would be a SQLite commit on the widget's hottest path,
and eviction needs the order, not the second.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import ColumnElement, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db import get_session_factory
from app.models import LegacySpeechCache, SpeechClip, utcnow
from app.services.storage import STORAGE_ERRORS, Storage, get_storage
from app.services.tts.base import SynthesisResult

logger = logging.getLogger("liveface.speech_cache")

PREFIX = "speech/"
MP3 = "audio/mpeg"
WAV_MIMES = frozenset({"audio/wav", "audio/x-wav", "audio/wave"})
# Lines from these providers cannot be made again on this server.
PINNED_PROVIDERS = frozenset({"cloned"})
# Eviction brings a total over its cap down to this share of it.
LOW_WATER = 0.9
TOUCH_RESOLUTION = timedelta(hours=1)
# Rows deleted per statement; lines moved from the old table per pass.
DELETE_CHUNK = 500
DRAIN_BATCH = 200

_mp3_unavailable_logged = False


# --- The recording -----------------------------------------------------------


def encode(audio: bytes, mime: str, level: float | None = None) -> tuple[bytes, str]:
    """`audio` as the cache stores it: a WAV as MP3, anything else as it is.

    The MP3 is kept only if it decodes to exactly the WAV's samples (the
    LAME header's delay and padding honoured): otherwise the cues would be
    late by the encoder's delay, and the original is kept instead. CPU work:
    call it on a thread.
    """
    global _mp3_unavailable_logged
    if mime not in WAV_MIMES:
        return audio, mime
    import soundfile  # optional runtime (tests.test_layering.LAZY)

    level = get_settings().speech_cache_mp3_level if level is None else level
    try:
        samples, rate = soundfile.read(io.BytesIO(audio), dtype="int16")
        out = io.BytesIO()
        soundfile.write(
            out,
            samples,
            rate,
            format="MP3",
            subtype="MPEG_LAYER_III",
            compression_level=level,
            bitrate_mode="VARIABLE",
        )
        encoded = out.getvalue()
        decoded = soundfile.info(io.BytesIO(encoded)).frames
    except (soundfile.LibsndfileError, RuntimeError, ValueError, TypeError) as error:
        if not _mp3_unavailable_logged:
            _mp3_unavailable_logged = True
            logger.warning("speech is cached as it came, not as MP3: %s", error)
        return audio, mime
    if decoded != len(samples):
        logger.warning("an MP3 decoded to %d samples, not %d: kept as WAV", decoded, len(samples))
        return audio, mime
    return encoded, MP3


def as_wav(audio: bytes, mime: str) -> bytes:
    """`audio` as 16-bit PCM WAV, for a caller that reads samples (the
    dashboard's phrase stream). CPU work: call it on a thread."""
    if mime in WAV_MIMES:
        return audio
    import soundfile  # optional runtime (tests.test_layering.LAZY)

    samples, rate = soundfile.read(io.BytesIO(audio), dtype="int16")
    out = io.BytesIO()
    soundfile.write(out, samples, rate, format="WAV", subtype="PCM_16")
    return out.getvalue()


def storage_key(cache_key: str, mime: str) -> str:
    """Where a recording goes: new every time it is written, so a file is
    never replaced under a reader, and an eviction can only ever delete the
    file the row it removes named."""
    extension = "mp3" if mime == MP3 else "wav" if mime in WAV_MIMES else "bin"
    return f"{PREFIX}{cache_key[:2]}/{cache_key}-{uuid4().hex[:12]}.{extension}"


def _result(row: SpeechClip, audio: bytes) -> SynthesisResult:
    return SynthesisResult(
        audio=audio,
        audio_mime=row.audio_mime,
        duration_ms=row.duration_ms,
        cues=json.loads(row.cues_json),
    )


def _as_utc(moment: datetime) -> datetime:
    # SQLite hands timestamps back without their zone; they are UTC.
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


# --- Reading and writing -----------------------------------------------------


async def get(db: AsyncSession, cache_key: str) -> SynthesisResult | None:
    """The cached line, or None (a miss, which the caller makes again). A hit
    is recorded as a use; a line whose file cannot be read, see
    `_unreadable`."""
    row = (
        await db.execute(select(SpeechClip).where(SpeechClip.cache_key == cache_key))
    ).scalar_one_or_none()
    if row is None:
        return None
    if row.audio_key is None:
        # Carried over inline by migration 028, not yet moved (drain).
        audio = (
            await db.execute(select(SpeechClip.audio).where(SpeechClip.id == row.id))
        ).scalar_one()
        if audio is None:
            await _forget(db, row)
            return None
    else:
        try:
            audio = await get_storage().get_bytes(row.audio_key)
        except STORAGE_ERRORS:
            await _unreadable(db, row, row.audio_key)
            return None
    now = utcnow()
    if now - _as_utc(row.last_used_at) >= TOUCH_RESOLUTION:
        row.last_used_at = now
        await db.commit()
    return _result(row, audio)


async def _unreadable(db: AsyncSession, row: SpeechClip, key: str) -> None:
    """A line whose file could not be read. Forgotten when the file is gone,
    so that the line made again takes its place; kept when the file is still
    there (the storage's bad moment: forgetting it would leave the file to
    no one), and kept when it is pinned, which nothing here can make again."""
    try:
        gone = not await get_storage().exists(key)
    except STORAGE_ERRORS:
        gone = False
    if gone and not row.pinned:
        logger.warning("speech cache file %s is gone; the line is made again", key)
        await _forget(db, row)
    else:
        logger.error(
            "speech cache file %s could not be read (%s); its line is kept",
            key,
            "a cloned voice's" if row.pinned else "the file is still there",
        )


async def _forget(db: AsyncSession, row: SpeechClip) -> None:
    await db.execute(delete(SpeechClip).where(SpeechClip.id == row.id))
    await db.commit()


async def put(
    db: AsyncSession,
    *,
    cache_key: str,
    provider: str,
    voice: str,
    locale: str,
    text: str,
    result: SynthesisResult,
    org_id: str | None,
) -> SynthesisResult:
    """Store `result` under `cache_key` and return it as stored (MP3 for a
    WAV). Commits.

    A cloned voice's line replaces the one already there (uploaded again).
    Any other line is first come, first kept: it is only stored after a
    miss, so one already there was made by a request racing this one, and
    this copy's file is removed.
    """
    audio, mime = await asyncio.to_thread(encode, result.audio, result.audio_mime)
    storage = get_storage()
    key = storage_key(cache_key, mime)
    await storage.put_bytes(key, audio, mime)
    stored = SynthesisResult(
        audio=audio, audio_mime=mime, duration_ms=result.duration_ms, cues=result.cues
    )
    pinned = provider in PINNED_PROVIDERS
    fields = {
        "provider": provider,
        "voice": voice,
        "locale": locale,
        "char_count": len(text),
        "duration_ms": result.duration_ms,
        "cues_json": json.dumps(result.cues),
        "audio_mime": mime,
        "audio_key": key,
        "audio": None,
        "size_bytes": len(audio),
        "org_id": org_id,
        "pinned": pinned,
        "last_used_at": utcnow(),
    }
    if pinned:
        existing = (
            await db.execute(select(SpeechClip).where(SpeechClip.cache_key == cache_key))
        ).scalar_one_or_none()
        if existing is not None:
            replaced = existing.audio_key
            for field, value in fields.items():
                setattr(existing, field, value)
            await db.commit()
            if replaced and replaced != key:
                await _delete_files(storage, [replaced])
            return stored
    db.add(SpeechClip(cache_key=cache_key, **fields))
    try:
        await db.commit()
    except IntegrityError:
        # Two requests made the same line at once: theirs is in the table.
        await db.rollback()
        await _delete_files(storage, [key])
    return stored


async def _delete_files(storage: Storage, keys: list[str | None]) -> None:
    for key in keys:
        if not key:
            continue
        try:
            await storage.delete(key)
        except STORAGE_ERRORS:
            # Left behind, not fatal: a stray file costs space, never a wrong line.
            logger.warning("could not delete speech cache file %s", key)


async def delete_where(db: AsyncSession, *where: ColumnElement[bool]) -> int:
    """Delete the lines matching `where`, their files with them; the count."""
    rows = (await db.execute(select(SpeechClip.id, SpeechClip.audio_key).where(*where))).all()
    return await _delete_lines(db, [(row_id, key) for row_id, key in rows])


async def _delete_lines(db: AsyncSession, lines: list[tuple[str, str | None]]) -> int:
    """Delete these (id, file) lines, the files first; the count. Commits.

    Files first: a line read in between is a miss and is made again, where
    a row deleted first could leave a file that no row names."""
    if not lines:
        return 0
    await _delete_files(get_storage(), [key for _, key in lines])
    ids = [row_id for row_id, _ in lines]
    for start in range(0, len(ids), DELETE_CHUNK):
        chunk = ids[start : start + DELETE_CHUNK]
        await db.execute(delete(SpeechClip).where(SpeechClip.id.in_(chunk)))
    await db.commit()
    return len(ids)


# --- Eviction ----------------------------------------------------------------


@dataclass
class Evicted:
    idle: int = 0
    over_org_cap: int = 0
    over_total_cap: int = 0

    @property
    def total(self) -> int:
        return self.idle + self.over_org_cap + self.over_total_cap


EVICTABLE = SpeechClip.pinned.is_(False)


async def _least_recently_used(
    db: AsyncSession, excess: int, *where: ColumnElement[bool]
) -> list[tuple[str, str | None]]:
    """The least recently used unpinned lines matching `where`, as (id,
    file), whose sizes add up to at least `excess` bytes."""
    rows = (
        await db.execute(
            select(SpeechClip.id, SpeechClip.audio_key, SpeechClip.size_bytes)
            .where(EVICTABLE, *where)
            .order_by(SpeechClip.last_used_at, SpeechClip.id)
        )
    ).all()
    chosen: list[tuple[str, str | None]] = []
    freed = 0
    for row_id, key, size in rows:
        if freed >= excess:
            break
        chosen.append((row_id, key))
        freed += size
    return chosen


async def evict(db: AsyncSession, now: datetime | None = None) -> Evicted:
    """Bring the cache within its limits (module docstring); what went."""
    settings = get_settings()
    now = now or utcnow()
    evicted = Evicted()

    if settings.speech_cache_max_idle_days > 0:
        cutoff = now - timedelta(days=settings.speech_cache_max_idle_days)
        evicted.idle = await delete_where(db, EVICTABLE, SpeechClip.last_used_at < cutoff)

    cap = settings.speech_cache_org_max_bytes
    if cap > 0:
        over = (
            await db.execute(
                select(SpeechClip.org_id, func.sum(SpeechClip.size_bytes))
                .where(EVICTABLE)
                .group_by(SpeechClip.org_id)
                .having(func.sum(SpeechClip.size_bytes) > cap)
            )
        ).all()
        for org_id, total in over:
            same_org = (
                SpeechClip.org_id.is_(None) if org_id is None else SpeechClip.org_id == org_id
            )
            lines = await _least_recently_used(db, int(total - cap * LOW_WATER), same_org)
            evicted.over_org_cap += await _delete_lines(db, lines)

    cap = settings.speech_cache_max_bytes
    if cap > 0:
        total = (
            await db.execute(
                select(func.coalesce(func.sum(SpeechClip.size_bytes), 0)).where(EVICTABLE)
            )
        ).scalar_one()
        if total > cap:
            lines = await _least_recently_used(db, int(total - cap * LOW_WATER))
            evicted.over_total_cap = await _delete_lines(db, lines)
    return evicted


# --- The old table, and recordings still inline ------------------------------


async def drain(db: AsyncSession, batch: int = DRAIN_BATCH) -> int:
    """Move what is still in the database to storage; how many lines moved.

    The old table first: a line any provider can make again is dropped (it
    is a cache), a cloned voice's line is carried over. Then every line whose
    recording is inline is written to storage, one at a time (a recording
    can be megabytes), each committed on its own so that an interrupted
    drain loses nothing and the next resumes it.
    """
    old_cache = LegacySpeechCache.provider.not_in(PINNED_PROVIDERS)
    await db.execute(delete(LegacySpeechCache).where(old_cache))
    await db.commit()

    moved = 0
    legacy_ids = (await db.execute(select(LegacySpeechCache.id).limit(batch))).scalars().all()
    for line_id in legacy_ids:
        line = await db.get(LegacySpeechCache, line_id)
        if line is None:
            continue
        taken = (
            await db.execute(select(SpeechClip.id).where(SpeechClip.cache_key == line.cache_key))
        ).scalar_one_or_none()
        if taken is None:
            org_id, sep, _ = line.voice.partition(":")
            db.add(
                SpeechClip(
                    cache_key=line.cache_key,
                    provider=line.provider,
                    voice=line.voice,
                    locale=line.locale,
                    char_count=line.char_count,
                    duration_ms=line.duration_ms,
                    cues_json=line.cues_json,
                    audio_mime=line.audio_mime,
                    audio_key=None,
                    audio=line.audio,
                    size_bytes=len(line.audio),
                    org_id=org_id if sep and org_id else None,
                    pinned=True,
                    last_used_at=_as_utc(line.updated_at),
                )
            )
        await db.delete(line)
        await db.commit()
        db.expunge_all()

    storage = get_storage()
    inline_ids = (
        (await db.execute(select(SpeechClip.id).where(SpeechClip.audio.is_not(None)).limit(batch)))
        .scalars()
        .all()
    )
    for line_id in inline_ids:
        audio = (
            await db.execute(select(SpeechClip.audio).where(SpeechClip.id == line_id))
        ).scalar_one_or_none()
        clip = await db.get(SpeechClip, line_id)
        if clip is None or audio is None:
            continue
        encoded, mime = await asyncio.to_thread(encode, audio, clip.audio_mime)
        key = storage_key(clip.cache_key, mime)
        await storage.put_bytes(key, encoded, mime)
        clip.audio_key, clip.audio_mime, clip.size_bytes, clip.audio = (
            key,
            mime,
            len(encoded),
            None,
        )
        await db.commit()
        db.expunge_all()
        moved += 1
    return moved


async def sweep() -> tuple[int, Evicted]:
    """One pass, in its own session: drain, then evict. Never raises: the
    sweeper's next tick tries again."""
    try:
        async with get_session_factory()() as db:
            moved = await drain(db)
            evicted = await evict(db)
    except Exception:
        # Broad on purpose: periodic housekeeping must never take the API down.
        logger.exception("speech cache sweep failed")
        return 0, Evicted()
    if moved or evicted.total:
        logger.info(
            "speech cache: %d line(s) moved to storage; evicted %d idle, %d over an "
            "organization's cap, %d over the total cap",
            moved,
            evicted.idle,
            evicted.over_org_cap,
            evicted.over_total_cap,
        )
    return moved, evicted
