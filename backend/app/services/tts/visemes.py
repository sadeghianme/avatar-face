"""Character -> Oculus-viseme mapping, multilingual.

Used by providers that don't emit native viseme events (offline, OpenAI,
coarse Google) to build cue tracks from text. Must animate non-Latin text:
diacritics are stripped, Cyrillic and Arabic map to phonetic viseme classes,
and CJK/Devanagari rotate deterministically through open-mouth visemes so
speech never freezes at "sil" for real letters. Punctuation stays "sil".
"""
from __future__ import annotations

import unicodedata

LATIN_MAP: dict[str, str] = {
    "a": "aa", "e": "E", "i": "ih", "o": "oh", "u": "ou", "y": "ih",
    "b": "PP", "p": "PP", "m": "PP",
    "f": "FF", "v": "FF", "w": "ou",
    "t": "DD", "d": "DD",
    "k": "kk", "g": "kk", "q": "kk", "c": "kk", "x": "SS",
    "j": "CH", "h": "kk",
    "s": "SS", "z": "SS",
    "n": "nn", "l": "nn",
    "r": "RR",
}

CYRILLIC_MAP: dict[str, str] = {
    "а": "aa", "э": "E", "е": "E", "и": "ih", "ы": "ih", "о": "oh", "у": "ou",
    "ю": "ou", "я": "aa", "ё": "oh",
    "б": "PP", "п": "PP", "м": "PP",
    "ф": "FF", "в": "FF",
    "т": "DD", "д": "DD",
    "к": "kk", "г": "kk", "х": "kk",
    "ж": "CH", "ч": "CH", "ш": "CH", "щ": "CH", "ц": "SS",
    "с": "SS", "з": "SS",
    "н": "nn", "л": "nn",
    "р": "RR", "й": "ih",
    "ь": "sil", "ъ": "sil",
}

ARABIC_MAP: dict[str, str] = {
    "ا": "aa", "أ": "aa", "إ": "ih", "آ": "aa", "ع": "aa", "غ": "kk",
    "ب": "PP", "م": "PP", "و": "ou",
    "ف": "FF",
    "ت": "DD", "د": "DD", "ط": "DD", "ض": "DD", "ث": "TH", "ذ": "TH", "ظ": "TH",
    "ك": "kk", "ق": "kk", "خ": "kk", "ح": "kk", "ه": "kk", "ة": "aa",
    "ج": "CH", "ش": "CH",
    "س": "SS", "ص": "SS", "ز": "SS",
    "ن": "nn", "ل": "nn",
    "ر": "RR", "ي": "ih", "ى": "aa", "ء": "sil",
}

# Visemes rotated through for syllabic scripts (CJK, Devanagari ...):
# every glyph is roughly a syllable, so cycle open/varied mouth shapes.
SYLLABIC_ROTATION = ["aa", "ih", "oh", "E", "ou", "kk", "nn", "DD"]


def _strip_diacritics(ch: str) -> str:
    decomposed = unicodedata.normalize("NFD", ch)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn") or ch


def _is_syllabic(ch: str) -> bool:
    code = ord(ch)
    return (
        0x3040 <= code <= 0x30FF      # Hiragana / Katakana
        or 0x4E00 <= code <= 0x9FFF   # CJK Unified
        or 0x3400 <= code <= 0x4DBF   # CJK ext A
        or 0xAC00 <= code <= 0xD7AF   # Hangul syllables
        or 0x0900 <= code <= 0x097F   # Devanagari
    )


def char_to_viseme(ch: str) -> str:
    if not ch:
        return "sil"
    # Syllabic check BEFORE diacritic stripping: NFD decomposes Hangul
    # syllables into multi-char jamo sequences, which would break the
    # single-character mapping below.
    if _is_syllabic(ch):
        return SYLLABIC_ROTATION[ord(ch) % len(SYLLABIC_ROTATION)]
    stripped = _strip_diacritics(ch)
    if len(stripped) == 1:
        ch = stripped
    lower = ch.lower()

    if lower in LATIN_MAP:
        return LATIN_MAP[lower]
    if lower in CYRILLIC_MAP:
        return CYRILLIC_MAP[lower]
    if ch in ARABIC_MAP:
        return ARABIC_MAP[ch]
    if len(ch) == 1 and _is_syllabic(ch):
        # Deterministic rotation keyed on the codepoint: same text always
        # animates the same way, and real letters never freeze at "sil".
        return SYLLABIC_ROTATION[ord(ch) % len(SYLLABIC_ROTATION)]
    if len(ch) == 1 and ch.isalpha():
        # Unknown alphabetic script: still animate.
        return SYLLABIC_ROTATION[ord(ch) % len(SYLLABIC_ROTATION)]
    return "sil"  # punctuation, digits, whitespace


def cues_from_text(text: str, duration_ms: int) -> list[dict]:
    """Evenly spread per-character viseme cues across a known duration."""
    chars = [c for c in text]
    if not chars or duration_ms <= 0:
        return [{"t": 0, "viseme": "sil"}]
    step = duration_ms / len(chars)
    cues: list[dict] = []
    last = None
    for i, ch in enumerate(chars):
        viseme = char_to_viseme(ch)
        if viseme != last:
            cues.append({"t": int(i * step), "viseme": viseme})
            last = viseme
    cues.append({"t": duration_ms, "viseme": "sil"})
    return cues
