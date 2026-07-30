"""Grapheme-to-phoneme and viseme planning.

These are the cases where spelling lies about pronunciation — exactly the
words that made letter-driven lip-sync look wrong.
"""
from __future__ import annotations

import pytest

from app.services.tts.g2p import word_to_phonemes, word_to_phonemes_stressed
from app.services.tts.phonemes import plan


def visemes(word: str) -> list[str]:
    return [s["vis"] for s in plan(word_to_phonemes_stressed(word))]


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        # Silent letters: the whole point of not using spelling.
        ("knight", "N AY T"),
        ("lamb", "L AE M"),
        ("write", "R AY T"),
        ("island", "AY L AH N D"),
        # Irregulars from the lexicon.
        ("said", "S EH D"),
        ("one", "W AH N"),
        ("because", "B IH K AO Z"),
        # Suffix peeling has to restore the stem's spelling first, or
        # "hoping" and "hopping" collapse onto the same vowel.
        ("hoping", "HH OW P IH NG"),
        ("hopping", "HH AA P IH NG"),
        # -ed is three different sounds, chosen by the preceding voicing.
        ("asked", "AE S K T"),
        ("played", "P L EY D"),
        ("wanted", "W AA N T IH D"),
        # -s likewise.
        ("cats", "K AE T S"),
        ("dogs", "D AO G Z"),
        ("wishes", "W IH SH IH Z"),
        # Context-sensitive letters.
        ("cat", "K AE T"),
        ("city", "S IH T IY"),
        ("nation", "N EY SH AH N"),
        ("vision", "V IH ZH AH N"),
    ],
)
def test_pronunciation(word: str, expected: str) -> None:
    assert " ".join(word_to_phonemes(word)) == expected


def test_function_words_are_reduced() -> None:
    """Unstressed vowels are small mouths. Marking every vowel stressed makes
    the face gape on every syllable — most visibly on the commonest words."""
    assert word_to_phonemes_stressed("the") == ["DH", "AH0"]
    assert word_to_phonemes_stressed("of") == ["AH0", "V"]
    # Content words still carry a primary stress somewhere.
    assert "AA1" in word_to_phonemes_stressed("market")
    assert "AO1" in word_to_phonemes_stressed("because")


def test_h_takes_the_following_vowels_shape() -> None:
    """/h/ has no lip posture of its own — the lips are already in the vowel,
    so "who" is one continuous pucker rather than open-then-round."""
    assert visemes("who") == ["ou"]
    assert visemes("he") == ["ih"]


def test_yod_before_rounded_vowel_stays_rounded() -> None:
    """"you" spread-then-puckered would be a ~20Hz flip no face can make."""
    assert visemes("you") == ["ou"]


def test_intervocalic_t_is_a_flap_with_no_shape() -> None:
    assert "DD" not in visemes("better")


def test_bilabials_always_reach_a_closed_mouth() -> None:
    """If /p/ /b/ /m/ do not close, the face visibly is not saying the word."""
    for word in ("mama", "puppy", "bumble"):
        assert "PP" in visemes(word), word


def test_unknown_words_fall_back_to_rules_rather_than_failing() -> None:
    assert word_to_phonemes("zorblax")
    assert visemes("Kowalczyk")


# Broader regression corpus: regular spellings the rule table must keep
# getting right as rules are added for irregular ones.
CORPUS = [
    ("mad", "M AE D"),
    ("made", "M EY D"),
    ("hop", "HH AA P"),
    ("hope", "HH OW P"),
    ("stopped", "S T AA P T"),
    ("needed", "N IY D IH D"),
    ("boxes", "B AA K S IH Z"),
    ("cities", "S IH T IY Z"),
    ("tries", "T R AY Z"),
    ("making", "M EY K IH NG"),
    ("running", "R AH N IH NG"),
    ("think", "TH IH NG K"),
    ("thing", "TH IH NG"),
    ("bath", "B AE TH"),
    ("bathe", "B EY DH"),
    ("phone", "F OW N"),
    ("graph", "G R AE F"),
    ("night", "N AY T"),
    ("quick", "K W IH K"),
    ("chair", "CH EH R"),
    ("nice", "N AY S"),
    ("magic", "M AE JH IH K"),
    ("gym", "JH IH M"),
    ("happy", "HH AE P IY"),
    ("my", "M AY"),
    ("yellow", "Y EH L OW"),
    ("boy", "B OY"),
    ("house", "HH AW S"),
    ("book", "B UH K"),
    ("moon", "M UW N"),
    ("tree", "T R IY"),
    ("rain", "R EY N"),
    ("coin", "K OY N"),
    ("blue", "B L UW"),
    ("cute", "K Y UW T"),
    ("table", "T EY B AH L"),
    ("little", "L IH T AH L"),
    ("mission", "M IH SH AH N"),
    ("picture", "P IH K CH ER"),
    ("child", "CH AY L D"),
    ("cold", "K OW L D"),
    ("bird", "B ER D"),
    ("church", "CH ER CH"),
    ("judge", "JH AH JH"),
    ("sign", "S AY N"),
    ("exam", "IH G Z AE M"),
    ("music", "M Y UW Z IH K"),
]


@pytest.mark.parametrize(("word", "expected"), CORPUS)
def test_regular_spellings(word: str, expected: str) -> None:
    assert " ".join(word_to_phonemes(word)) == expected


def test_tongue_consonants_survive_planning() -> None:
    """They were being deleted wholesale: of 37 lingual phonemes in this text
    only 5 used to reach a segment, so "the little girl said" was mimed as an
    unbroken vowel smear with no consonant articulation at all."""
    text = (
        "The little girl said the answer was hidden in the middle of the tunnel. "
        "Nine dollars and a dime. That did not tell the whole tale."
    )
    lingual_visemes = {"TH", "DD", "nn"}
    wanted = kept = 0
    for word in (w.strip(".,") for w in text.split()):
        phones = word_to_phonemes_stressed(word)
        wanted += sum(1 for p in phones if p in ("T", "D", "N", "L", "NG", "TH", "DH"))
        kept += sum(1 for s in plan(phones) if s["vis"] in lingual_visemes)

    assert wanted >= 30, "test text should be lingual-heavy"
    assert kept / wanted > 0.8, f"only {kept}/{wanted} tongue consonants survived"


def test_lingual_floor_does_not_steal_from_vowels() -> None:
    """Linguals get their own short floor rather than being promoted to
    lip-critical — promoting them made them borrow duration from the
    neighbouring vowel and cost a third of the jaw movement."""
    segments = plan(word_to_phonemes_stressed("dad"))
    vowel = next(s for s in segments if s["vis"] == "aa")
    assert vowel["ms"] >= 100, "the vowel kept its own duration"
    assert any(s["vis"] == "DD" for s in segments)
