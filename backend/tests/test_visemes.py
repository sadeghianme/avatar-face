from app.services.rig import OCULUS_VISEMES
from app.services.tts.visemes import char_to_viseme, cues_from_text


def test_latin_vowels():
    assert char_to_viseme("a") == "aa"
    assert char_to_viseme("e") == "E"
    assert char_to_viseme("i") == "ih"
    assert char_to_viseme("o") == "oh"
    assert char_to_viseme("u") == "ou"


def test_latin_consonant_classes():
    assert char_to_viseme("b") == "PP"
    assert char_to_viseme("f") == "FF"
    assert char_to_viseme("s") == "SS"
    assert char_to_viseme("r") == "RR"


def test_diacritics_stripped():
    assert char_to_viseme("é") == char_to_viseme("e")
    assert char_to_viseme("ü") == char_to_viseme("u")
    assert char_to_viseme("ñ") == char_to_viseme("n")


def test_uppercase_same_as_lowercase():
    assert char_to_viseme("A") == char_to_viseme("a")
    assert char_to_viseme("É") == char_to_viseme("é")


def test_cyrillic_mapped_phonetically():
    assert char_to_viseme("а") == "aa"  # Cyrillic а
    assert char_to_viseme("б") == "PP"
    assert char_to_viseme("ш") == "CH"
    assert char_to_viseme("у") == "ou"


def test_arabic_mapped_phonetically():
    assert char_to_viseme("ب") == "PP"
    assert char_to_viseme("ا") == "aa"
    assert char_to_viseme("س") == "SS"


def test_cjk_never_silent_and_deterministic():
    for ch in "你好世界こんにちは안녕":
        viseme = char_to_viseme(ch)
        assert viseme != "sil"
        assert viseme in OCULUS_VISEMES
        assert char_to_viseme(ch) == viseme  # deterministic


def test_devanagari_never_silent():
    for ch in "नमस्ते":
        if ch.isalpha():
            assert char_to_viseme(ch) != "sil"


def test_punctuation_and_digits_silent():
    for ch in ".,!?;: 12345…！？":
        assert char_to_viseme(ch) == "sil"


def test_cues_from_text_structure():
    cues = cues_from_text("Hello, world", 1200)
    assert cues[0]["t"] == 0
    assert cues[-1]["t"] == 1200
    assert cues[-1]["viseme"] == "sil"
    assert all(cues[i]["t"] <= cues[i + 1]["t"] for i in range(len(cues) - 1))
    assert any(c["viseme"] != "sil" for c in cues)


def test_cues_empty_text():
    cues = cues_from_text("", 0)
    assert len(cues) == 1
    assert cues[0]["t"] == 0
    assert cues[0]["viseme"] == "sil"


def test_multilingual_text_produces_motion():
    """Mixed-script sentence must not freeze at sil."""
    text = "Привет мир 你好 مرحبا"
    cues = cues_from_text(text, 3000)
    non_sil = [c for c in cues if c["viseme"] != "sil"]
    assert len(non_sil) >= 5
