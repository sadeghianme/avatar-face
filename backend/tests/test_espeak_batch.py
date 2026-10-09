"""espeak-ng is called once per utterance, not once per word.

A fake binary stands in for espeak-ng (most machines running these tests do
not have it): it prints one line per clause, as the real one does with
`-q --ipa`, and counts how often it was started.
"""

from __future__ import annotations

import subprocess

import pytest

from app.services.tts import espeak
from app.services.tts.ipa import collapse_repeats, ipa_to_visemes
from app.services.tts.timing import plan_utterance


class FakeEspeak:
    """`espeak-ng -q --ipa=1 -v VOICE -- TEXT`: one line per clause."""

    def __init__(self, split_longer_than: int | None = None):
        self.calls: list[str] = []
        self.split_longer_than = split_longer_than
        self.fail_with: BaseException | None = None
        self.returncode = 0

    @staticmethod
    def ipa(word: str) -> str:
        return word.lower()

    def __call__(self, args, **kwargs):
        assert kwargs.get("shell") is False, "user text must never reach a shell"
        assert args[:3] == ["espeak-ng", "-q", "--ipa=1"]
        text = args[args.index("--") + 1]
        self.calls.append(text)
        if self.fail_with is not None:
            raise self.fail_with
        lines = []
        for clause in text.split(espeak.CLAUSE_SEPARATOR):
            ipa = self.ipa(clause)
            if self.split_longer_than and len(clause) > self.split_longer_than:
                # A clause espeak broke in two: the lines no longer pair up.
                half = len(ipa) // 2
                lines += [" " + ipa[:half], " " + ipa[half:]]
            else:
                lines.append(" " + ipa)
        out = "".join(line + "\n" for line in lines).encode()
        return subprocess.CompletedProcess(args, self.returncode, out, b"")


@pytest.fixture
def fake(monkeypatch):
    fake = FakeEspeak()
    monkeypatch.setattr(espeak, "available", lambda: True)
    monkeypatch.setattr(espeak.subprocess, "run", fake)
    espeak.clear_cache()
    yield fake
    espeak.clear_cache()


def _word(i: int) -> str:
    """A distinct made-up word of letters only (the word pattern's unit)."""
    letters = ""
    while True:
        i, digit = divmod(i, 26)
        letters += chr(97 + digit)
        if not i:
            return "mo" + letters


def _french(n: int) -> str:
    return " ".join(_word(i) for i in range(n)) + "."


def test_a_long_text_is_one_process_not_one_per_word(fake):
    text = _french(300)
    plan_utterance("bonjour", "fr-FR")  # the locale probe ("test")
    fake.calls.clear()

    segments, marks = plan_utterance(text, "fr-FR")

    assert len(marks) == 300
    assert len(fake.calls) == 1, "every word in one espeak call"


def test_each_word_gets_its_own_clause_ipa(fake):
    segments, _ = plan_utterance("Bonjour tout le monde", "fr-FR")
    expected = []
    for word in ("bonjour", "tout", "le", "monde"):
        expected += collapse_repeats(ipa_to_visemes(word))
    visemes = [s.viseme for s in segments if s.viseme != "sil"]
    assert visemes == expected


def test_words_already_seen_cost_nothing(fake):
    plan_utterance("bonjour le monde", "fr-FR")
    fake.calls.clear()
    plan_utterance("le monde, bonjour", "fr-FR")
    assert fake.calls == []


def test_only_the_new_words_are_asked_for(fake):
    plan_utterance("bonjour le monde", "fr-FR")
    fake.calls.clear()
    plan_utterance("bonjour la lune", "fr-FR")
    assert fake.calls == ["la, lune"]


def test_lines_that_do_not_pair_up_split_the_batch(fake):
    """A word espeak breaks over two lines must not shift every later word."""
    fake.split_longer_than = 12
    long_word = "anticonstitutionnellement"
    found = espeak.words_to_ipa(["un", "deux", long_word, "trois", "quatre"], "fr-FR")
    assert found == {
        "un": "un",
        "deux": "deux",
        long_word: long_word[: len(long_word) // 2] + " " + long_word[len(long_word) // 2 :],
        "trois": "trois",
        "quatre": "quatre",
    }
    # Bisected, not one process per word from the start.
    assert 1 < len(fake.calls) < 10


def test_a_failed_process_falls_back_and_is_not_remembered(fake):
    fake.fail_with = subprocess.TimeoutExpired("espeak-ng", 5)
    assert espeak.words_to_ipa(["bonjour"], "fr-FR") == {"bonjour": None}
    fake.fail_with = None
    assert espeak.words_to_ipa(["bonjour"], "fr-FR") == {"bonjour": "bonjour"}


def test_a_rejected_voice_gives_no_answers(fake):
    fake.returncode = 1
    assert espeak.words_to_ipa(["salut", "toi"], "xx-XX") == {"salut": None, "toi": None}


def test_an_unsupported_locale_takes_the_character_path(fake):
    fake.returncode = 1
    segments, marks = plan_utterance("salut toi", "xx-XX")
    assert segments and marks


def test_a_huge_text_is_a_few_processes(fake, monkeypatch):
    monkeypatch.setattr(espeak, "MAX_BATCH_BYTES", 200)
    words = [_word(i) + "abcdefg" for i in range(100)]  # ~1,100 bytes
    found = espeak.words_to_ipa(words, "fr-FR")
    assert all(found[w] == w for w in words)
    # ~1,400 bytes with separators, in 200-byte batches.
    assert 5 <= len(fake.calls) <= 9


def test_without_espeak_nothing_is_started(monkeypatch):
    calls = []
    monkeypatch.setattr(espeak, "available", lambda: False)
    monkeypatch.setattr(espeak.subprocess, "run", lambda *a, **k: calls.append(a))
    espeak.clear_cache()
    assert espeak.words_to_ipa(["bonjour"], "fr-FR") == {"bonjour": None}
    assert calls == []
    espeak.clear_cache()


def test_the_cache_is_bounded(fake):
    """Past CACHE_SIZE words the least recently used is forgotten: asked for
    again, it costs a call; the most recent costs nothing."""
    words = [_word(i) for i in range(espeak.CACHE_SIZE + 1)]
    espeak.words_to_ipa(words, "fr-FR")
    fake.calls.clear()
    espeak.words_to_ipa([words[-1]], "fr-FR")
    assert fake.calls == []
    espeak.words_to_ipa([words[0]], "fr-FR")
    assert fake.calls == [words[0]]
