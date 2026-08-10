"""IPA to Oculus visemes — the part that makes every language reuse one rig.

A viseme is a mouth shape, and mouths do not have accents: a rounded /u/ looks
the same in French, Turkish and Farsi. So the animation never needs to know
what language it is playing. Only the step *before* it — turning written text
into sounds — is language-specific, and that is what espeak-ng does.

That split is why this file is short and covers a hundred languages, while
g2p.py is two thousand lines and covers one. English earns its own hand-written
rules because it is the default and its orthography is uniquely irregular;
everything else is better served by a real phonemizer than by a rule table
written by someone who does not speak the language.

Mapping is inherently lossy in the same direction for every language: /p/, /b/
and /m/ are different sounds made with an identical mouth, so they share a
viseme. That is a property of faces, not a shortcut.
"""

from __future__ import annotations

import unicodedata

# Longest first — the two-character symbols must match before their parts, or
# the affricate /t͡ʃ/ becomes /t/ + /ʃ/ and the mouth makes two shapes where a
# speaker makes one.
_MULTI = {
    "tʃ": "CH",
    "dʒ": "CH",
    "ts": "SS",
    "dz": "SS",
    "tɕ": "CH",
    "dʑ": "CH",
    "ɕː": "CH",
}

_SINGLE = {
    # --- consonants, grouped by what the mouth does ---
    "p": "PP", "b": "PP", "m": "PP", "ɱ": "FF",
    "f": "FF", "v": "FF", "ʋ": "FF",
    "θ": "TH", "ð": "TH",
    "t": "DD", "d": "DD", "ʈ": "DD", "ɖ": "DD", "c": "DD", "ɟ": "DD",
    "s": "SS", "z": "SS", "ɬ": "SS", "ɮ": "SS",
    "ʃ": "CH", "ʒ": "CH", "ɕ": "CH", "ʑ": "CH", "ʂ": "CH", "ʐ": "CH",
    "k": "kk", "g": "kk", "ɡ": "kk", "ŋ": "kk", "q": "kk", "ɢ": "kk",
    "x": "kk", "ɣ": "kk", "χ": "kk", "ħ": "kk", "ʕ": "kk", "ʁ": "RR",
    "n": "nn", "ɲ": "nn", "ɳ": "nn", "l": "nn", "ʎ": "nn", "ɭ": "nn", "ɫ": "nn",
    "r": "RR", "ɾ": "RR", "ɹ": "RR", "ɻ": "RR", "ʀ": "RR", "ɽ": "RR",
    # /h/ and the glottal stop have no shape of their own — the mouth is
    # already forming whatever comes next. Silence is closer than inventing one.
    "h": "sil", "ɦ": "sil", "ʔ": "sil",
    "j": "ih", "ɥ": "ou",
    "w": "ou", "ʍ": "ou",
    # --- vowels ---
    "a": "aa", "ɑ": "aa", "ɐ": "aa", "ʌ": "aa", "æ": "aa", "ɒ": "oh",
    "e": "E", "ɛ": "E", "ə": "E", "ɘ": "E", "ɜ": "E", "ø": "E", "œ": "E", "ɶ": "E",
    "i": "ih", "ɪ": "ih", "y": "ih", "ʏ": "ih", "ɨ": "ih", "ɪ̈": "ih",
    "o": "oh", "ɔ": "oh", "ɵ": "oh", "ɤ": "oh",
    "u": "ou", "ʊ": "ou", "ɯ": "ou", "ʉ": "ou",
}

# Stress, length, syllable and word separators, ties: all timing or structure,
# none of it a mouth shape.
_IGNORE = set("ˈˌːˑ.|‖ ̯͡‿()[]/")


def _strip_marks(text: str) -> str:
    """Drop combining diacritics but keep the base letter.

    Nasalised vowels are the reason: French 'bon' is /bɔ̃/, and the tilde says
    the air goes through the nose — which changes the sound and not the mouth.
    Keeping the base vowel gives the right shape; keeping the mark gives an
    unmapped symbol.
    """
    return "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))


def ipa_to_visemes(ipa: str) -> list[str]:
    """Every recognised IPA symbol in `ipa`, as a viseme name.

    Unknown symbols are dropped rather than guessed at: a wrong mouth shape is
    more visible than a missing one, and espeak emits the occasional symbol
    that has no visual counterpart at all.
    """
    text = _strip_marks(ipa)
    out: list[str] = []
    i = 0
    while i < len(text):
        pair = text[i : i + 2]
        if pair in _MULTI:
            out.append(_MULTI[pair])
            i += 2
            continue
        char = text[i]
        i += 1
        if char in _IGNORE:
            continue
        viseme = _SINGLE.get(char) or _SINGLE.get(char.lower())
        if viseme:
            out.append(viseme)
    return out


def collapse_repeats(visemes: list[str]) -> list[str]:
    """Fold a run of the same shape into one.

    Adjacent identical visemes are one mouth position held slightly longer, not
    two movements. Emitting both makes a geminate look like a stutter.
    """
    out: list[str] = []
    for v in visemes:
        if not out or out[-1] != v:
            out.append(v)
    return out
