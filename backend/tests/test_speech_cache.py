"""The speech cache (N3): every line in storage as MP3, a small row each,
evicted least recently used first past its caps; nothing left in the
database's own pages, so neither it nor its backups carry audio.
"""

import io
import json
import sqlite3
import subprocess
import sys
import threading
import wave
from contextlib import closing
from datetime import UTC, timedelta
from pathlib import Path

import numpy as np
import pytest
import soundfile
from sqlalchemy import func, select

from app.core.config import get_settings
from app.db import get_session_factory
from app.models import LegacySpeechCache, SpeechClip, utcnow
from app.services.storage import get_storage
from app.services.tts import registry, speech_cache, speech_codec
from app.services.tts.base import SynthesisResult, cache_key
from app.services.tts.stream import pcm_packet
from tests.conftest import create_org, register_and_login

BACKEND = Path(__file__).resolve().parents[1]
CUES = [{"t": 0, "viseme": "aa", "a": 1.0}, {"t": 500, "viseme": "sil", "a": 1.0}]


def _wav(seconds: float = 1.0, rate: int = 24000, click_at: int | None = None) -> bytes:
    """Speech-like noise, with a click at `click_at` (a sample index)."""
    rng = np.random.default_rng(7)
    samples = (rng.standard_normal(int(rate * seconds)) * 2000).astype(np.int16)
    if click_at is not None:
        samples[click_at : click_at + 4] = 32000
    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(samples.tobytes())
    return out.getvalue()


def _result(audio: bytes | None = None, mime: str = "audio/wav") -> SynthesisResult:
    return SynthesisResult(audio=audio or _wav(), audio_mime=mime, duration_ms=1000, cues=CUES)


async def _row(db, key: str) -> SpeechClip | None:
    return (
        await db.execute(select(SpeechClip).where(SpeechClip.cache_key == key))
    ).scalar_one_or_none()


async def _inline_audio(db, key: str) -> bytes | None:
    return (
        await db.execute(select(SpeechClip.audio).where(SpeechClip.cache_key == key))
    ).scalar_one()


# --- The recording -----------------------------------------------------------


def test_a_wav_is_stored_as_mp3_that_starts_on_the_same_sample():
    """The cues are timed against the WAV: the MP3 must decode to exactly
    its samples (the LAME header's delay and padding honoured), or every
    mouth would move before its sound."""
    rate, click = 24000, 36000  # 1.5 s
    source = _wav(seconds=4, rate=rate, click_at=click)
    encoded, mime = speech_cache.encode(source, "audio/wav")
    assert mime == "audio/mpeg"
    assert len(encoded) < len(source) / 4
    decoded, decoded_rate = soundfile.read(io.BytesIO(encoded), dtype="int16")
    assert decoded_rate == rate
    assert len(decoded) == 4 * rate
    assert abs(int(np.argmax(np.abs(decoded))) - click) <= 2


def test_audio_that_is_not_wav_is_stored_as_it_came():
    assert speech_cache.encode(b"ID3fake", "audio/mpeg") == (b"ID3fake", "audio/mpeg")


def test_a_wav_mp3_cannot_carry_is_kept_as_wav():
    """96 kHz is beyond MPEG audio: the original is kept, not lost."""
    source = _wav(seconds=0.5, rate=96000)
    assert speech_cache.encode(source, "audio/wav") == (source, "audio/wav")


def test_an_mp3_that_would_not_start_on_time_is_refused(monkeypatch):
    class Info:
        frames = 1  # what a decoder that ignored the LAME header reports

    monkeypatch.setattr(soundfile, "info", lambda _file: Info())
    source = _wav(seconds=0.5)
    assert speech_cache.encode(source, "audio/wav") == (source, "audio/wav")


def test_pcm_comes_back_with_every_sample():
    source = _wav(seconds=2)
    encoded, mime = speech_cache.encode(source, "audio/wav")
    back = speech_codec.as_wav(encoded, mime)
    with wave.open(io.BytesIO(back)) as handle:
        assert (handle.getframerate(), handle.getnchannels(), handle.getsampwidth()) == (
            24000,
            1,
            2,
        )
        assert handle.getnframes() == 2 * 24000
    assert speech_codec.as_wav(source, "audio/wav") is source


# --- Through synthesize_cached -----------------------------------------------


async def test_a_spoken_line_lives_in_storage_not_in_the_database(app):
    async with get_session_factory()() as db:
        first, cached = await registry.synthesize_cached(
            db, "offline", "offline-warm", "en-US", "Hello there.", org_id="org-a"
        )
        assert not cached
        key = cache_key("offline", "offline-warm", "en-US", "Hello there.")
        row = await _row(db, key)
        assert row is not None
        assert await _inline_audio(db, key) is None
        assert row.audio_key and row.audio_key.startswith(f"speech/{key[:2]}/{key}-")
        assert row.audio_mime == "audio/mpeg" and row.org_id == "org-a" and not row.pinned
        stored = await get_storage().get_bytes(row.audio_key)
        assert stored == first.audio and row.size_bytes == len(stored)
        assert soundfile.info(io.BytesIO(stored)).format == "MP3"

        again, cached = await registry.synthesize_cached(
            db, "offline", "offline-warm", "en-US", "Hello there.", org_id="org-b"
        )
    # The same bytes the first time and every time after, and the cues.
    assert cached and again.audio == first.audio and again.cues == first.cues
    assert again.audio_mime == "audio/mpeg" and again.duration_ms == first.duration_ms


async def test_the_phrase_stream_gets_samples_hit_or_miss(app):
    async with get_session_factory()() as db:
        miss, cached = await registry.synthesize_cached(
            db, "offline", "offline-warm", "en-US", "Stream me.", pcm=True
        )
        assert not cached and miss.audio_mime == "audio/wav"
        hit, cached = await registry.synthesize_cached(
            db, "offline", "offline-warm", "en-US", "Stream me.", pcm=True
        )
    assert cached and hit.audio_mime == "audio/wav"
    with wave.open(io.BytesIO(miss.audio)) as a, wave.open(io.BytesIO(hit.audio)) as b:
        assert (a.getnframes(), a.getframerate()) == (b.getnframes(), b.getframerate())


async def test_a_cached_kokoro_phrase_still_makes_a_stream_packet(app, monkeypatch):
    """The packet reads mono 24 kHz PCM16, which a hit must give back."""
    from app.services.tts import kokoro

    async def speak(self, text, voice, locale):
        return _result(_wav(seconds=0.5))

    monkeypatch.setattr(kokoro.KokoroTTSProvider, "is_configured", lambda self: True)
    monkeypatch.setattr(kokoro.KokoroTTSProvider, "synthesize", speak)
    async with get_session_factory()() as db:
        for expect_cached in (False, True):
            result, cached = await registry.synthesize_cached(
                db, "kokoro", "af_heart", "en-US", "A phrase.", pcm=True
            )
            assert cached is expect_cached
            packet = pcm_packet(result.audio, 0, 0, result.cues, result.cues)
            assert packet["sample_count"] == 12000


async def test_a_line_whose_file_is_gone_is_made_again(app):
    async with get_session_factory()() as db:
        await registry.synthesize_cached(db, "offline", "offline-warm", "en-US", "Gone.")
        key = cache_key("offline", "offline-warm", "en-US", "Gone.")
        row = await _row(db, key)
        assert row is not None
        old_file = row.audio_key
        assert old_file is not None
        await get_storage().delete(old_file)
        db.expunge_all()

        _, cached = await registry.synthesize_cached(
            db, "offline", "offline-warm", "en-US", "Gone."
        )
        assert not cached
        row = await _row(db, key)
    assert row is not None and row.audio_key != old_file


async def test_a_line_is_kept_while_its_file_may_only_be_unreachable(app, monkeypatch):
    """A storage error is not a missing file: forgetting the row would leave
    the file to no one. And a cloned line is never forgotten."""
    async with get_session_factory()() as db:
        await registry.synthesize_cached(db, "offline", "offline-warm", "en-US", "Flaky.")
        key = cache_key("offline", "offline-warm", "en-US", "Flaky.")
        storage = get_storage()

        async def unreachable(self, _key):
            raise TimeoutError("storage is slow")

        monkeypatch.setattr(type(storage), "get_bytes", unreachable)
        assert await speech_cache.get(db, key) is None
        assert await _row(db, key) is not None

        row = await _row(db, key)
        assert row is not None
        row.pinned = True
        await db.commit()
        await storage.delete(row.audio_key)  # type: ignore[arg-type]
        assert await speech_cache.get(db, key) is None
        assert await _row(db, key) is not None


async def test_last_use_is_recorded_at_most_hourly(app):
    async with get_session_factory()() as db:
        await registry.synthesize_cached(db, "offline", "offline-warm", "en-US", "Touch.")
        key = cache_key("offline", "offline-warm", "en-US", "Touch.")
        row = await _row(db, key)
        assert row is not None
        long_ago = utcnow() - timedelta(days=3)
        row.last_used_at = long_ago
        await db.commit()

        assert await speech_cache.get(db, key) is not None
        touched = (await _row(db, key)).last_used_at  # type: ignore[union-attr]
        # SQLite hands the timestamp back without its zone: it is UTC.
        assert touched.replace(tzinfo=UTC) > long_ago + timedelta(days=2)

        assert await speech_cache.get(db, key) is not None
        assert (await _row(db, key)).last_used_at == touched  # type: ignore[union-attr]


async def test_two_requests_making_one_line_keep_one_file(app, monkeypatch):
    """The second to commit finds the first's row: it keeps that one and
    removes its own file, rather than failing the request."""
    storage = get_storage()
    real_put = type(storage).put_bytes
    key = cache_key("offline", "offline-warm", "en-US", "Race.")
    async with get_session_factory()() as db:
        await speech_cache.put(
            db,
            cache_key=key,
            provider="offline",
            voice="offline-warm",
            locale="en-US",
            text="Race.",
            result=_result(),
            org_id="first",
        )
        first = await _row(db, key)
        assert first is not None
        first_file = first.audio_key

        written: list[str] = []

        async def spying_put(self, file_key, data, content_type):
            written.append(file_key)
            await real_put(self, file_key, data, content_type)

        monkeypatch.setattr(type(storage), "put_bytes", spying_put)
        db.expunge_all()
        await speech_cache.put(
            db,
            cache_key=key,
            provider="offline",
            voice="offline-warm",
            locale="en-US",
            text="Race.",
            result=_result(),
            org_id="second",
        )
        kept = await _row(db, key)
    assert kept is not None and kept.org_id == "first" and kept.audio_key == first_file
    assert written and not await storage.exists(written[0])
    assert await storage.exists(first_file)  # type: ignore[arg-type]


async def test_the_encoding_runs_off_the_loop(app, monkeypatch):
    threads: list[threading.Thread] = []
    real = speech_cache.encode

    def spy(*args, **kwargs):
        threads.append(threading.current_thread())
        return real(*args, **kwargs)

    monkeypatch.setattr(speech_cache, "encode", spy)
    async with get_session_factory()() as db:
        await registry.synthesize_cached(db, "offline", "offline-warm", "en-US", "Off loop.")
    assert threads and all(t is not threading.main_thread() for t in threads)


# --- Eviction ----------------------------------------------------------------


async def _seed(
    db, name: str, *, org: str | None, size: int, days_ago: float, pinned: bool = False
) -> str:
    """A line with a file of `size` bytes, last used `days_ago` days ago."""
    key = cache_key("offline", "v", "en-US", name)
    file_key = speech_cache.storage_key(key, "audio/mpeg")
    await get_storage().put_bytes(file_key, b"x" * size, "audio/mpeg")
    db.add(
        SpeechClip(
            cache_key=key,
            provider="cloned" if pinned else "offline",
            voice="v",
            locale="en-US",
            char_count=1,
            duration_ms=100,
            cues_json=json.dumps(CUES),
            audio_mime="audio/mpeg",
            audio_key=file_key,
            size_bytes=size,
            org_id=org,
            pinned=pinned,
            last_used_at=utcnow() - timedelta(days=days_ago),
        )
    )
    await db.commit()
    return name


async def _left(db) -> set[str]:
    rows = (await db.execute(select(SpeechClip.cache_key))).scalars().all()
    names = {cache_key("offline", "v", "en-US", n): n for n in _NAMES}
    return {names[key] for key in rows}


_NAMES = [f"a{i}" for i in range(6)] + [f"b{i}" for i in range(3)] + ["pin", "old", "n0", "n1"]


@pytest.fixture
def caps(monkeypatch):
    def set_caps(org: int = 0, total: int = 0, idle_days: int = 0):
        settings = get_settings()
        monkeypatch.setattr(settings, "speech_cache_org_max_bytes", org)
        monkeypatch.setattr(settings, "speech_cache_max_bytes", total)
        monkeypatch.setattr(settings, "speech_cache_max_idle_days", idle_days)

    return set_caps


async def test_an_org_over_its_cap_loses_its_least_recently_used_lines(app, caps):
    caps(org=300)
    async with get_session_factory()() as db:
        for i in range(5):  # a0 is the oldest
            await _seed(db, f"a{i}", org="A", size=100, days_ago=5 - i)
        for i in range(2):
            await _seed(db, f"b{i}", org="B", size=100, days_ago=10)
        # Pinned: never evicted, and not counted against the cap.
        await _seed(db, "pin", org="A", size=10_000, days_ago=30, pinned=True)
        files = dict((await db.execute(select(SpeechClip.cache_key, SpeechClip.audio_key))).all())
        evicted = await speech_cache.evict(db)
        left = await _left(db)
    # 500 bytes against a 300 cap: down to 90% of it, oldest first.
    assert evicted.over_org_cap == 3
    assert left == {"a3", "a4", "b0", "b1", "pin"}
    storage = get_storage()
    for name in ("a0", "a1", "a2"):
        assert not await storage.exists(files[cache_key("offline", "v", "en-US", name)])
    assert await storage.exists(files[cache_key("offline", "v", "en-US", "a3")])


async def test_the_whole_cache_over_its_cap_loses_the_least_recently_used(app, caps):
    caps(total=500)
    async with get_session_factory()() as db:
        for i in range(3):
            await _seed(db, f"a{i}", org="A", size=100, days_ago=i * 2 + 1)  # a0 newest
        for i in range(3):
            await _seed(db, f"b{i}", org="B", size=100, days_ago=i * 2 + 2)
        await _seed(db, "pin", org=None, size=10_000, days_ago=99, pinned=True)
        evicted = await speech_cache.evict(db)
        left = await _left(db)
    # 600 against 500: to 450 or less, whichever organization they belong to.
    assert evicted.over_total_cap == 2
    assert left == {"a0", "b0", "a1", "b1", "pin"}


async def test_lines_nobody_asked_for_in_a_while_go(app, caps):
    caps(idle_days=30)
    async with get_session_factory()() as db:
        await _seed(db, "old", org="A", size=10, days_ago=31)
        await _seed(db, "n0", org="A", size=10, days_ago=29)
        await _seed(db, "pin", org="A", size=10, days_ago=400, pinned=True)
        evicted = await speech_cache.evict(db)
        left = await _left(db)
    assert evicted.idle == 1
    assert left == {"n0", "pin"}


async def test_within_its_caps_nothing_goes(app, caps):
    caps(org=10_000, total=10_000, idle_days=30)
    async with get_session_factory()() as db:
        await _seed(db, "n0", org="A", size=100, days_ago=1)
        await _seed(db, "n1", org=None, size=100, days_ago=2)
        evicted = await speech_cache.evict(db)
        assert evicted.total == 0
        assert await _left(db) == {"n0", "n1"}


async def test_a_sweep_that_fails_never_raises(app, monkeypatch):
    async def broken(_db, batch=0):
        raise RuntimeError("storage is down")

    monkeypatch.setattr(speech_cache, "drain", broken)
    moved, evicted = await speech_cache.sweep()
    assert moved == 0 and evicted.total == 0


# --- Cloned voices: pinned, and taken down with their files ------------------


async def test_a_cloned_line_is_pinned_and_its_takedown_deletes_its_file(client, caps):
    caps(org=1, total=1, idle_days=1)
    headers = await register_and_login(client, "cloner")
    org_id = await create_org(client, headers)
    uploaded = await client.post(
        f"/orgs/{org_id}/cloned-voices/sarah/lines",
        headers=headers,
        data={"text": "Hello there", "locale": "en-US", "consent": "true"},
        files={"audio": ("line.wav", _wav(), "audio/wav")},
    )
    assert uploaded.status_code == 200, uploaded.text
    async with get_session_factory()() as db:
        row = (await db.execute(select(SpeechClip))).scalar_one()
        assert row.pinned and row.org_id == org_id and row.audio_mime == "audio/mpeg"
        file_key = row.audio_key
        assert (await speech_cache.evict(db, utcnow() + timedelta(days=30))).total == 0

    deleted = await client.delete(f"/orgs/{org_id}/cloned-voices/sarah", headers=headers)
    assert deleted.status_code in (200, 204), deleted.text
    assert not await get_storage().exists(file_key)  # type: ignore[arg-type]
    async with get_session_factory()() as db:
        assert (await db.execute(select(func.count()).select_from(SpeechClip))).scalar_one() == 0


# --- Draining what is left in the database -----------------------------------


async def test_the_old_table_and_inline_recordings_are_drained_to_storage(app):
    async with get_session_factory()() as db:
        for provider, voice, text in (
            ("kokoro", "af_heart", "a cache line"),  # made again on request: dropped
            ("cloned", "org9:sarah", "a cloned line"),  # cannot be: moved
        ):
            db.add(
                LegacySpeechCache(
                    cache_key=cache_key(provider, voice, "en-US", text),
                    provider=provider,
                    voice=voice,
                    locale="en-US",
                    char_count=len(text),
                    audio_mime="audio/wav",
                    audio=_wav(),
                    cues_json=json.dumps(CUES),
                    duration_ms=1000,
                )
            )
        # What migration 028 carries over: the recording still inline.
        inline_key = cache_key("cloned", "org9:mark", "en-US", "inline")
        db.add(
            SpeechClip(
                cache_key=inline_key,
                provider="cloned",
                voice="org9:mark",
                locale="en-US",
                char_count=6,
                duration_ms=1000,
                cues_json=json.dumps(CUES),
                audio_mime="audio/wav",
                audio_key=None,
                audio=_wav(),
                size_bytes=48044,
                org_id="org9",
                pinned=True,
                last_used_at=utcnow(),
            )
        )
        await db.commit()
        # Served while still inline.
        served = await speech_cache.get(db, inline_key)
        assert served is not None and served.audio_mime == "audio/wav"

        moved = await speech_cache.drain(db)
        db.expunge_all()
        assert moved == 2
        assert (
            await db.execute(select(func.count()).select_from(LegacySpeechCache))
        ).scalar_one() == 0
        rows = (await db.execute(select(SpeechClip).order_by(SpeechClip.voice))).scalars().all()
        assert [(r.voice, r.org_id, r.pinned) for r in rows] == [
            ("org9:mark", "org9", True),
            ("org9:sarah", "org9", True),
        ]
        for row in rows:
            assert row.audio_key and row.audio_mime == "audio/mpeg"
            assert await _inline_audio(db, row.cache_key) is None
            stored = await get_storage().get_bytes(row.audio_key)
            assert row.size_bytes == len(stored) < 48044
        assert await speech_cache.drain(db) == 0  # nothing left


# --- Migration 028 -----------------------------------------------------------

_ALEMBIC = """
from alembic import command
from alembic.config import Config
command.{action}(Config("alembic.ini"), "{target}")
"""


def _alembic(database: Path, action: str, target: str) -> None:
    import os

    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    result = subprocess.run(
        [sys.executable, "-c", _ALEMBIC.format(action=action, target=target)],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr[-3000:]


def test_028_moves_cloned_lines_and_drops_the_rest(tmp_path):
    database = tmp_path / "speech.sqlite3"
    _alembic(database, "upgrade", "027_scene")
    recording = _wav()
    with closing(sqlite3.connect(database)) as db:
        for index, (provider, voice) in enumerate(
            (
                ("kokoro", "af_heart"),
                ("piper", "fa_amir"),
                ("cloned", "org1:sarah"),
                ("cloned", "nameless"),
            )
        ):
            db.execute(
                "insert into speech_cache (id, created_at, updated_at, cache_key, provider, "
                "voice, locale, char_count, audio_mime, audio, cues_json, duration_ms) values "
                "(?, '2026-09-01 10:00:00', '2026-09-02 10:00:00', ?, ?, ?, 'en-US', 5, "
                "'audio/wav', ?, '[]', 1000)",
                (f"id{index}", f"key{index}", provider, voice, recording),
            )
        db.commit()

    _alembic(database, "upgrade", "head")
    with closing(sqlite3.connect(database)) as db:
        # Emptied, not dropped: the release before 028 reads and writes it,
        # so a rollback over this migration still serves speech.
        assert db.execute("select count(*) from speech_cache").fetchone() == (0,)
        rows = db.execute(
            "select id, provider, voice, org_id, pinned, size_bytes, length(audio), audio_key, "
            "last_used_at from speech_clips order by id"
        ).fetchall()
    assert rows == [
        (
            "id2",
            "cloned",
            "org1:sarah",
            "org1",
            1,
            len(recording),
            len(recording),
            None,
            "2026-09-02 10:00:00",
        ),
        (
            "id3",
            "cloned",
            "nameless",
            None,
            1,
            len(recording),
            len(recording),
            None,
            "2026-09-02 10:00:00",
        ),
    ]

    # A rollback to a release before 028 stamps the database back to 027
    # (docs/process.md, "Rollback"); that release writes the old table; the
    # next deploy runs 028 again and carries over only what is new.
    _alembic(database, "stamp", "027_scene")
    with closing(sqlite3.connect(database)) as db:
        db.execute(
            "insert into speech_cache (id, created_at, updated_at, cache_key, provider, "
            "voice, locale, char_count, audio_mime, audio, cues_json, duration_ms) values "
            "('id9', '2026-10-01 10:00:00', '2026-10-01 10:00:00', 'key9', 'cloned', "
            "'org1:mark', 'en-US', 5, 'audio/wav', ?, '[]', 1000)",
            (recording,),
        )
        db.execute(
            "insert into speech_cache (id, created_at, updated_at, cache_key, provider, "
            "voice, locale, char_count, audio_mime, audio, cues_json, duration_ms) values "
            "('id8', '2026-10-01 10:00:00', '2026-10-01 10:00:00', 'key8', 'kokoro', "
            "'af_heart', 'en-US', 5, 'audio/wav', ?, '[]', 1000)",
            (recording,),
        )
        db.commit()
    _alembic(database, "upgrade", "head")
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("select count(*) from speech_cache").fetchone() == (0,)
        assert db.execute("select id from speech_clips order by id").fetchall() == [
            ("id2",),
            ("id3",),
            ("id9",),
        ]

    _alembic(database, "downgrade", "027_scene")
    with closing(sqlite3.connect(database)) as db:
        back = db.execute("select id, provider from speech_cache order by id").fetchall()
        tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
    assert back == [("id2", "cloned"), ("id3", "cloned"), ("id9", "cloned")]
    assert "speech_clips" not in tables
    _alembic(database, "upgrade", "head")
