"""English grapheme-to-phoneme conversion, no dependencies, no data files.

Lip-sync was driven straight off spelling: every letter mapped to a mouth
shape. "the" became t-h-e — three unrelated shapes for a word that is two
sounds, /D AH/ — and "knight" mimed a hard k. Nothing in the face matched
what was being said, which is what read as random motion.

This converts spelling to ARPABET phonemes instead, so the mouth is driven by
pronunciation. Three layers, in order of precedence:

  1. An exception lexicon for words English spelling simply lies about
     ("said", "one", "women", "colonel"-class irregulars).
  2. Suffix peeling, which is where naive rule sets fail: "hoping" and
     "hopping" differ only in a doubled consonant that was never pronounced,
     so the stem spelling has to be RESTORED before the rules run (see
     `_restore`). The suffix itself is then realised by voicing —
     -ed is /T/ in "asked", /D/ in "played", /IH D/ in "wanted".
  3. A context-sensitive rule table, longest-match-first, where each rule may
     require a regex on the text to its left and right. That context is what
     lets one letter behave differently in "cat" and "city", "go" and "gem".

Deliberately dependency-free: a pronunciation dictionary (CMUdict is ~3.5MB)
would be more accurate on rare words, but this has to run per-request inside
the API container and be small enough to ship. Rules cover regular English
well and the lexicon absorbs the common irregulars; unknown proper nouns fall
back to rules, which is the same thing a reader does on first sight.

The package, by layer:

    lexicon  the phoneme inventory and the exception lexicon (layer 1)
    rules    the context-sensitive rule table (layer 3)
    engine   the rules applied, suffix peeling and stem restoring (layer
             2), and the public conversions
    stress   which vowels are stressed, for derived pronunciations

Everything is re-exported here, so `g2p.X` keeps working.
"""

from __future__ import annotations

from app.services.tts.g2p.engine import (
    _TOKEN,
    _VOW,
    _engine,
    _has_vowel,
    _peel,
    _restore,
    _spans,
    _suffix,
    text_to_phonemes,
    word_to_pairs,
    word_to_phonemes,
)
from app.services.tts.g2p.lexicon import (
    _SIBILANTS,
    _VOICED_CONS,
    CONSONANT_PHONEMES,
    LEXICON,
    LEXICON_RAW,
    PHONEMES,
    VOWEL_PHONEMES,
)
from app.services.tts.g2p.rules import (
    _R,
    _RULES,
    CE,
    CEO,
    LSUF,
    MAGIC,
    Out,
    Rule,
    _s_end,
)
from app.services.tts.g2p.stress import (
    _ALWAYS_REDUCED,
    _NEUTRAL_SUFFIXES,
    _STRESS_PULLING_SUFFIXES,
    _UNSTRESSED_PREFIXES,
    _count_orthographic_syllables,
    _primary_vowel_index,
    word_to_phonemes_stressed,
)

__all__ = [
    "_ALWAYS_REDUCED",
    "CE",
    "CEO",
    "CONSONANT_PHONEMES",
    "_count_orthographic_syllables",
    "_engine",
    "_has_vowel",
    "LEXICON",
    "LEXICON_RAW",
    "LSUF",
    "MAGIC",
    "_NEUTRAL_SUFFIXES",
    "Out",
    "_peel",
    "PHONEMES",
    "_primary_vowel_index",
    "_R",
    "_restore",
    "Rule",
    "_RULES",
    "_s_end",
    "_SIBILANTS",
    "_spans",
    "_STRESS_PULLING_SUFFIXES",
    "_suffix",
    "text_to_phonemes",
    "_TOKEN",
    "_UNSTRESSED_PREFIXES",
    "_VOICED_CONS",
    "_VOW",
    "VOWEL_PHONEMES",
    "word_to_pairs",
    "word_to_phonemes",
    "word_to_phonemes_stressed",
]
