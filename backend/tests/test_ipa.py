"""IPA to visemes.

Tested with literal IPA rather than by running espeak, so these pass on a
machine without the binary — which is most development machines. The espeak
call is a thin subprocess wrapper; this is where the judgement lives.
"""

from app.services.tts.espeak import voice_for
from app.services.tts.ipa import collapse_repeats, ipa_to_visemes
from app.services.tts.timing import _ANY_WORD_RE, is_english, plan_utterance


def test_the_lips_close_for_p_b_and_m():
    """Different sounds, identical mouth. Sharing a viseme is correct."""
    assert ipa_to_visemes("p") == ipa_to_visemes("b") == ipa_to_visemes("m") == ["PP"]


def test_affricates_are_one_shape_not_two():
    """/t͡ʃ/ is a single gesture; splitting it makes the mouth move twice."""
    assert ipa_to_visemes("tʃ") == ["CH"]
    assert ipa_to_visemes("dʒ") == ["CH"]
    # And with the tie bar espeak sometimes emits.
    assert ipa_to_visemes("t͡ʃ") == ["CH"]


def test_stress_and_length_marks_are_not_mouth_shapes():
    assert ipa_to_visemes("ˈbaː") == ["PP", "aa"]
    assert ipa_to_visemes("ˌbo.ku") == ["PP", "oh", "kk", "ou"]


def test_a_nasal_vowel_keeps_its_shape():
    """French /bɔ̃/: the tilde routes air through the nose, which the face
    does not show. Dropping the base vowel with the mark would lose the shape."""
    assert ipa_to_visemes("bɔ̃") == ["PP", "oh"]


def test_unknown_symbols_are_dropped_not_guessed():
    """A wrong mouth shape is more visible than a missing one."""
    assert ipa_to_visemes("b¤a") == ["PP", "aa"]
    assert ipa_to_visemes("") == []


def test_espeaks_own_separator_is_not_treated_as_unknown():
    """`--ipa=1` joins phonemes with underscores. Handling them explicitly
    keeps the unknown-symbol path meaning what it says."""
    assert ipa_to_visemes("b_o_k_\u02c8u") == ["PP", "oh", "kk", "ou"]


def test_repeats_collapse():
    assert collapse_repeats(["PP", "PP", "aa", "aa", "PP"]) == ["PP", "aa", "PP"]


def test_french_beaucoup_is_four_shapes_not_eight():
    """The measurement that motivated this.

    Spelling gives eight movements for 'beaucoup' because 'eau' is three
    letters; it is one vowel. Through IPA it is what a mouth actually does.
    """
    visemes = collapse_repeats(ipa_to_visemes("boku"))
    assert visemes == ["PP", "oh", "kk", "ou"]
    assert len(visemes) < 8


def test_a_script_agnostic_word_regex_finds_words_the_latin_one_cannot():
    """Arabic, Cyrillic and Han are exactly where per-character shapes are
    least like speech, so they must not be excluded from the phoneme path."""
    assert _ANY_WORD_RE.findall("Привет мир") == ["Привет", "мир"]
    assert _ANY_WORD_RE.findall("مرحبا بالعالم") == ["مرحبا", "بالعالم"]
    # No spaces: the whole run goes to espeak, which segments it itself.
    assert _ANY_WORD_RE.findall("你好世界") == ["你好世界"]
    assert _ANY_WORD_RE.findall("hi 42 there") == ["hi", "there"]


def test_espeak_voice_is_the_language_subtag():
    assert voice_for("fr-FR") == "fr"
    assert voice_for("de_DE") == "de"
    assert voice_for("pt-BR") == "pt-br"  # variety matters here
    assert voice_for("fa") == "fa"


def test_english_keeps_its_own_rules():
    """The hand-written table beats a general phonemiser on English
    orthography, which is the one it was written for."""
    assert is_english("en-US") and is_english("en-GB")
    assert not is_english("fr-FR")


def test_non_english_still_speaks_without_espeak_installed():
    """Absence is normal on a dev machine and must not fail the request."""
    segments, marks = plan_utterance("Bonjour tout le monde", "fr-FR")
    assert segments, "an avatar with no phonemiser must still move its mouth"
    assert marks
