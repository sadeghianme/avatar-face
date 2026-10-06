"""The engine: the rule table applied, suffixes peeled with the stem's
spelling restored before the rules run, and the public conversions."""

from __future__ import annotations

import re

from app.services.tts.g2p.lexicon import (
    _SIBILANTS,
    _VOICED_CONS,
    LEXICON,
    VOWEL_PHONEMES,
)
from app.services.tts.g2p.rules import _RULES


def _engine(w: str) -> list[tuple[str, int, int]]:
    out: list[tuple[str, int, int]] = []
    i, n = 0, len(w)
    while i < n:
        for text, left, right, res in _RULES.get(w[i], ()):
            j = i + len(text)
            if w[i:j] != text:
                continue
            if left is not None and not left.search(w[:i]):
                continue
            if right is not None and not right.match(w[j:]):
                continue
            for p in res(out) if callable(res) else res:
                out.append((p, i, j))
            i = j
            break
        else:
            i += 1
    return out


_VOW = "aeiou"


def _has_vowel(s: str) -> bool:
    return any(c in "aeiouy" for c in s)


def _restore(base: str) -> str:
    """Undo the orthographic changes a suffix caused (hopp->hop, hop->hope)."""
    if len(base) >= 3 and base[-1] == base[-2] and base[-1] in "bdfglmnprstz":
        return base[:-1]
    if base.endswith("i"):
        return base[:-1] + "y" if len(base) >= 4 else base + "e"
    if (
        len(base) >= 2
        and base[-1] not in "aeiouywx"
        and base[-2] in _VOW
        and not (len(base) >= 4 and base[-2] == "e" and base[-1] in "nlrmt")
        and (len(base) == 2 or base[-3] not in _VOW)
    ):
        return base + "e"
    return base


def _peel(w: str):
    """-> (stem_spelling, suffix_kind, n_suffix_letters) or None."""
    if len(w) >= 5 and w.endswith("ing") and _has_vowel(w[:-3]):
        return _restore(w[:-3]), "ed_ing", 3
    if len(w) >= 4 and w.endswith("ed") and not w.endswith("eed") and _has_vowel(w[:-2]):
        return _restore(w[:-2]), "ed", 2
    if len(w) >= 5 and w.endswith("ies"):
        return w[:-3] + "y", "s", 3
    if len(w) >= 4 and w.endswith("es") and (w[-3] in "sxz" or w[-4:-2] in ("ch", "sh")):
        return w[:-2], "s", 2
    if len(w) >= 4 and w.endswith("es"):
        return w[:-1], "s", 2
    if len(w) >= 4 and w.endswith("s") and not w.endswith(("ss", "us", "is", "os")):
        return w[:-1], "s", 1
    return None


def _suffix(kind: str, last: str) -> tuple[str, ...]:
    if kind == "ed_ing":
        return ("IH", "NG")
    if kind == "ed":
        if last in ("T", "D"):
            return ("IH", "D")
        return ("D",) if (last in _VOICED_CONS or last in VOWEL_PHONEMES) else ("T",)
    if last in _SIBILANTS:
        return ("IH", "Z")
    return ("Z",) if (last in _VOICED_CONS or last in VOWEL_PHONEMES) else ("S",)


def _spans(word: str) -> list[tuple[str, int, int]]:
    w = word.lower()
    if not w:
        return []
    if w in LEXICON:
        return [(p, 0, len(w)) for p in LEXICON[w]]
    core = "".join(c for c in w if c.isalpha() or c == "'")
    if core != w:
        w = core
        if w in LEXICON:
            return [(p, 0, len(w)) for p in LEXICON[w]]
    if not w:
        return []
    if "'" in w:
        head, _, tail = w.partition("'")
        base = _spans(head)
        if tail == "s":
            last = base[-1][0] if base else ""
            return base + [(p, len(head) + 1, len(w)) for p in _suffix("s", last)]
        extra = {
            "ll": ("AH", "L"),
            "re": ("ER",),
            "ve": ("V",),
            "d": ("D",),
            "m": ("M",),
            "t": ("T",),
        }.get(tail, ())
        return base + [(p, len(head) + 1, len(w)) for p in extra]

    peeled = _peel(w)
    if peeled:
        stem, kind, nsuf = peeled
        cut = len(w) - nsuf
        base = _spans(stem) if stem in LEXICON else _engine(stem)
        base = [(p, min(a, cut), min(b, cut)) for p, a, b in base]
        if base:
            last = base[-1][0]
            return base + [(p, cut, len(w)) for p in _suffix(kind, last)]
    return _engine(w)


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------
def word_to_phonemes(word: str) -> list[str]:
    return [p for p, _, _ in _spans(word)]


def word_to_pairs(word: str) -> list[tuple[str, str]]:
    w = word.lower()
    return [(p, w[a:b] or w[max(0, a - 1) : a]) for p, a, b in _spans(word)]


_TOKEN = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*")


def text_to_phonemes(text: str, pauses: bool = False):
    res: list[tuple[str, tuple[int, int]]] = []
    end = 0
    for m in _TOKEN.finditer(text):
        if pauses and res and re.search(r"[.,;:!?]", text[end : m.start()]):
            res.append(("SIL", (end, m.start())))
        off = m.start()
        for p, a, b in _spans(m.group()):
            res.append((p, (off + a, off + b)))
        end = m.end()
    return res
