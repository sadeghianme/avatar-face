"""Stress: which vowels of a derived pronunciation are stressed, so an
unstressed one is rendered as the small mouth it is spoken with."""

from __future__ import annotations

import re

from app.services.tts.g2p.engine import word_to_phonemes
from app.services.tts.g2p.lexicon import VOWEL_PHONEMES

# Every vowel matters twice over for lip-sync: an unstressed vowel in English
# is usually reduced to schwa, and schwa is a small relaxed mouth, while a
# stressed vowel is a wide one. Marking every vowel stressed gives a face that
# gapes on every syllable — "market" as MAR-KET rather than MAR-kit. CMUdict
# carries stress digits; derived pronunciations have to infer them.
#
# The heuristic below is the standard English approximation: default to the
# first syllable (English content words are overwhelmingly trochaic), move
# right past an unstressed prefix, and let stress-fixing suffixes pull the
# accent onto the syllable before them. It is wrong on some words — no rule
# set gets English stress fully right — but every vowel it marks unstressed is
# one that would otherwise have been rendered as a full open mouth.

_UNSTRESSED_PREFIXES = (
    "a",
    "be",
    "com",
    "con",
    "de",
    "dis",
    "em",
    "en",
    "ex",
    "im",
    "in",
    "ob",
    "per",
    "pre",
    "pro",
    "re",
    "sub",
    "sur",
    "to",
    "un",
)
# Suffixes that pull primary stress onto the syllable immediately before them
# ("PHOtograph" -> "photOGraphy", "NAtion" -> "naTIOnal" -> "naTIOnality").
_STRESS_PULLING_SUFFIXES = (
    "tion",
    "sion",
    "cian",
    "cial",
    "tial",
    "cious",
    "tious",
    "ity",
    "ity",
    "ic",
    "ics",
    "ical",
    "ially",
    "ially",
    "ious",
    "eous",
    "uous",
    "graphy",
    "logy",
    "nomy",
    "cracy",
    "ety",
    "ify",
    "itive",
    "ative",
)
# Suffixes that are themselves never stressed, so they must not attract it.
_NEUTRAL_SUFFIXES = ("ing", "ed", "es", "s", "ly", "ness", "ment", "less", "ful", "er", "est")


def _primary_vowel_index(word: str, vowel_count: int) -> int:
    """Which vowel phoneme (0-based among vowels) carries primary stress."""
    if vowel_count <= 1:
        return 0
    w = word.lower()
    for suffix in _STRESS_PULLING_SUFFIXES:
        if w.endswith(suffix) and len(w) > len(suffix) + 1:
            # The syllable before the suffix. Count vowels the suffix contains
            # and step back past them.
            stem = w[: -len(suffix)]
            stem_vowels = _count_orthographic_syllables(stem)
            return max(0, min(vowel_count - 1, stem_vowels - 1))
    for prefix in _UNSTRESSED_PREFIXES:
        if w.startswith(prefix) and len(w) > len(prefix) + 2:
            return min(1, vowel_count - 1)
    return 0


def _count_orthographic_syllables(word: str) -> int:
    """Rough syllable count from spelling — only used to locate stress."""
    groups = re.findall(r"[aeiouy]+", word.lower())
    count = len(groups)
    if word.lower().endswith("e") and count > 1:
        count -= 1  # silent final e
    return max(1, count)


# Function words are unstressed in connected speech regardless of their shape:
# "the" is /DH AH0/, never /DH AH1/. They are also the most frequent words in
# any sentence, so getting them wrong means gaping on every third word.
_ALWAYS_REDUCED = frozenset(
    """
a an the of to and but or nor for from as at by in on with was were is are am
be been than that them us his her your our their some it its
""".split()
)


def word_to_phonemes_stressed(word: str) -> list[str]:
    """Phonemes with CMUdict-style stress digits on the vowels.

    Digits are what let the viseme planner tell schwa from a full vowel, which
    is the single largest visual difference in the whole pipeline.
    """
    phonemes = word_to_phonemes(word)
    vowel_positions = [i for i, p in enumerate(phonemes) if p in VOWEL_PHONEMES]
    if not vowel_positions:
        return phonemes
    if word.lower().strip("'") in _ALWAYS_REDUCED:
        return [p + "0" if p in VOWEL_PHONEMES else p for p in phonemes]
    primary = _primary_vowel_index(word, len(vowel_positions))
    out = list(phonemes)
    for rank, position in enumerate(vowel_positions):
        out[position] = phonemes[position] + ("1" if rank == primary else "0")
    return out
