"""Text to IPA, for every language that is not English.

espeak-ng is a speech synthesiser, but the only part used here is its
grapheme-to-phoneme front end: `-q` suppresses the audio and `--ipa` prints
the pronunciation. That front end covers around a hundred languages, which is
the entire reason this exists — the alternative is hand-writing a rule table
per language, which does not scale past the languages the author speaks.

Called as a subprocess rather than through a binding. The binding options wrap
the same binary, add a dependency that has to track its ABI, and buy nothing
here: an utterance costs ONE process (`words_to_ipa`), alongside speech
synthesis that takes orders of magnitude longer.

One process per utterance, not per word. A word per process was what this
did first, and it let five thousand characters of French on the public
/embed/v1/cues route spawn a thousand processes in a row. The words go to
espeak as one text, each its own clause ("un, deux, trois"), and espeak
prints one line per clause; a word alone in its clause is phonemised exactly
as it is on its own, which is what the per-word calls relied on. Should the
lines ever not pair up with the words (a run of thousands of characters
without a space can fill espeak's clause buffer and break in two), the batch
is split in half and each half tried again, so one odd word costs a few
more processes rather than a wrong mouth for every word after it.

Everything here BLOCKS: it waits on a process. Callers on the event loop go
through a thread (timing.on_planner_thread; the TTS providers' own). At most `MAX_CONCURRENT`
processes run at once, whichever threads ask.

Absence is normal, not an error. Development machines mostly do not have
espeak-ng, so a missing binary falls back to the character path rather than
failing the request — the avatar still speaks, just less precisely.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from collections.abc import Iterable
from functools import lru_cache

logger = logging.getLogger("liveface.espeak")

BINARY = "espeak-ng"

# Generous next to synthesis, tight enough that a wedged subprocess cannot
# hold a request open. Per process; a whole utterance gets `BATCH_DEADLINE`.
TIMEOUT_SECONDS = 5
BATCH_DEADLINE_SECONDS = 8

# What joins the words: a comma ends espeak's clause, so each word is
# phonemised alone and printed on a line of its own.
CLAUSE_SEPARATOR = ", "

# Bytes of words per process. Linux refuses a single argument over 128 KiB;
# this keeps far below it (a 5,000-character text is one process, a text in
# a four-byte script two or three).
MAX_BATCH_BYTES = 16_000

# Processes at once across every thread. Two keeps a burst of requests from
# taking every core away from speech synthesis.
MAX_CONCURRENT = 2

# Words remembered, per voice. A website avatar says the same greeting over
# and over, and a word's IPA depends only on the word and the language.
CACHE_SIZE = 8192

_slots = threading.BoundedSemaphore(MAX_CONCURRENT)

# espeak takes a language subtag, not a full locale: "fr", not "fr-FR". A few
# need the region to pick the right variety.
_VOICE_OVERRIDES = {
    "pt-br": "pt-br",
    "zh-tw": "zh-yue",
    "en-gb": "en-gb",
}


class _Cache:
    """A thread-safe LRU of (voice, word) -> IPA (None: espeak had nothing)."""

    def __init__(self, size: int):
        self.size = size
        self._items: OrderedDict[tuple[str, str], str | None] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: tuple[str, str]) -> tuple[bool, str | None]:
        with self._lock:
            if key not in self._items:
                return False, None
            self._items.move_to_end(key)
            return True, self._items[key]

    def put(self, key: tuple[str, str], value: str | None) -> None:
        with self._lock:
            self._items[key] = value
            self._items.move_to_end(key)
            while len(self._items) > self.size:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def __len__(self) -> int:
        return len(self._items)


_cache = _Cache(CACHE_SIZE)


@lru_cache(maxsize=1)
def available() -> bool:
    return shutil.which(BINARY) is not None


def voice_for(locale: str) -> str:
    tag = locale.lower().replace("_", "-")
    return _VOICE_OVERRIDES.get(tag, tag.split("-")[0])


class _Failed(Exception):
    """espeak could not run, or rejected the voice: no word gets an answer."""


def _run(voice: str, text: str, timeout: float) -> list[str]:
    """espeak's output lines for `text` (one per clause), or _Failed."""
    with _slots:
        try:
            result = subprocess.run(
                [BINARY, "-q", "--ipa=1", "-v", voice, "--", text],
                capture_output=True,
                timeout=max(0.1, timeout),
                check=False,
                # Never a shell: the text is user input, and building a command
                # line out of it is how you get a shell injection.
                shell=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            logger.warning("espeak-ng failed for voice %s: %s", voice, exc)
            raise _Failed from exc
    if result.returncode != 0:
        # Unknown language is the common case and is not worth a stack trace.
        logger.info("espeak-ng rejected voice %s: %s", voice, result.stderr[:200])
        raise _Failed
    out = result.stdout.decode("utf-8", "replace")
    return out[:-1].split("\n") if out.endswith("\n") else out.split("\n")


def _batches(words: list[str]) -> Iterable[list[str]]:
    batch: list[str] = []
    size = 0
    for word in words:
        cost = len(word.encode()) + len(CLAUSE_SEPARATOR)
        if batch and size + cost > MAX_BATCH_BYTES:
            yield batch
            batch, size = [], 0
        batch.append(word)
        size += cost
    if batch:
        yield batch


def _phonemise(voice: str, words: list[str], deadline: float, found: dict[str, str | None]) -> None:
    """IPA for every word in `words` into `found`, splitting on a mismatch."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _Failed
    lines = _run(voice, CLAUSE_SEPARATOR.join(words), min(TIMEOUT_SECONDS, remaining))
    if len(words) == 1:
        # Alone, every line is this word's (a long run may span clauses).
        ipa = " ".join(line.strip() for line in lines if line.strip())
        found[words[0]] = ipa or None
        return
    if len(lines) == len(words):
        for word, line in zip(words, lines):
            found[word] = line.strip() or None
        return
    logger.info(
        "espeak-ng printed %d lines for %d words (voice %s); splitting the batch",
        len(lines),
        len(words),
        voice,
    )
    middle = len(words) // 2
    _phonemise(voice, words[:middle], deadline, found)
    _phonemise(voice, words[middle:], deadline, found)


def words_to_ipa(words: Iterable[str], locale: str) -> dict[str, str | None]:
    """IPA for each distinct word (None where espeak-ng cannot help).

    Words already known come from the cache; the rest cost one espeak
    process for the lot (see the module docstring). Blocks: call it from a
    thread when on the event loop.
    """
    voice = voice_for(locale)
    found: dict[str, str | None] = {}
    missing: list[str] = []
    for word in dict.fromkeys(words):
        if not word.strip():
            found[word] = None
            continue
        hit, ipa = _cache.get((voice, word))
        if hit:
            found[word] = ipa
        else:
            missing.append(word)
    if not missing:
        return found
    if not available():
        return found | dict.fromkeys(missing)

    learned: dict[str, str | None] = {}
    deadline = time.monotonic() + BATCH_DEADLINE_SECONDS
    try:
        for batch in _batches(missing):
            _phonemise(voice, batch, deadline, learned)
    except _Failed:
        # Words phonemised before the failure keep their answer; the rest
        # take the character path, uncached, so a later request retries.
        pass
    for word, ipa in learned.items():
        _cache.put((voice, word), ipa)
    return found | dict.fromkeys(missing) | learned


def text_to_ipa(text: str, locale: str) -> str | None:
    """IPA for `text` on its own, or None if espeak-ng cannot help."""
    return words_to_ipa([text], locale).get(text)


@lru_cache(maxsize=256)
def supports(locale: str) -> bool:
    """Whether this locale can be phonemised right now.

    Asks espeak rather than consulting a list, so the answer reflects what is
    actually installed instead of what was true when the list was written.
    """
    if not available():
        return False
    return text_to_ipa("test", locale) is not None


def clear_cache() -> None:
    """Forget every remembered word and locale answer (tests)."""
    _cache.clear()
    supports.cache_clear()
