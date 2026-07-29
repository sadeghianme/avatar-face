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
"""

from __future__ import annotations
import re
from typing import Callable, Sequence

VOWEL_PHONEMES = frozenset("AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split())
CONSONANT_PHONEMES = frozenset("B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH".split())
PHONEMES = VOWEL_PHONEMES | CONSONANT_PHONEMES
_VOICED_CONS = frozenset("B D DH G JH L M N NG R V W Y Z ZH".split())
_SIBILANTS = frozenset("S Z SH ZH CH JH".split())

LEXICON_RAW = {
    "a": "AH",
    "the": "DH AH",
    "of": "AH V",
    "to": "T UW",
    "and": "AE N D",
    "is": "IH Z",
    "as": "AE Z",
    "are": "AA R",
    "was": "W AH Z",
    "were": "W ER",
    "be": "B IY",
    "been": "B IH N",
    "being": "B IY IH NG",
    "am": "AE M",
    "one": "W AH N",
    "two": "T UW",
    "once": "W AH N S",
    "only": "OW N L IY",
    "said": "S EH D",
    "says": "S EH Z",
    "say": "S EY",
    "do": "D UW",
    "does": "D AH Z",
    "done": "D AH N",
    "doing": "D UW IH NG",
    "have": "HH AE V",
    "has": "HH AE Z",
    "had": "HH AE D",
    "having": "HH AE V IH NG",
    "come": "K AH M",
    "comes": "K AH M Z",
    "coming": "K AH M IH NG",
    "some": "S AH M",
    "gone": "G AO N",
    "go": "G OW",
    "goes": "G OW Z",
    "going": "G OW IH NG",
    "none": "N AH N",
    "who": "HH UW",
    "whom": "HH UW M",
    "whose": "HH UW Z",
    "what": "W AH T",
    "where": "W EH R",
    "there": "DH EH R",
    "their": "DH EH R",
    "they": "DH EY",
    "them": "DH EH M",
    "then": "DH EH N",
    "than": "DH AE N",
    "this": "DH IH S",
    "that": "DH AE T",
    "these": "DH IY Z",
    "those": "DH OW Z",
    "though": "DH OW",
    "through": "TH R UW",
    "thought": "TH AO T",
    "throughout": "TH R UW AW T",
    "people": "P IY P AH L",
    "because": "B IH K AO Z",
    "would": "W UH D",
    "could": "K UH D",
    "should": "SH UH D",
    "again": "AH G EH N",
    "against": "AH G EH N S T",
    "women": "W IH M AH N",
    "woman": "W UH M AH N",
    "many": "M EH N IY",
    "any": "EH N IY",
    "every": "EH V R IY",
    "very": "V EH R IY",
    "you": "Y UW",
    "your": "Y AO R",
    "yours": "Y AO R Z",
    "our": "AW ER",
    "hour": "AW ER",
    "honest": "AA N AH S T",
    "honor": "AA N ER",
    "know": "N OW",
    "knows": "N OW Z",
    "knew": "N UW",
    "known": "N OW N",
    "new": "N UW",
    "now": "N AW",
    "how": "HH AW",
    "cow": "K AW",
    "allow": "AH L AW",
    "own": "OW N",
    "shown": "SH OW N",
    "grown": "G R OW N",
    "thrown": "TH R OW N",
    "down": "D AW N",
    "town": "T AW N",
    "write": "R AY T",
    "wrote": "R OW T",
    "written": "R IH T AH N",
    "wrong": "R AO NG",
    "walk": "W AO K",
    "talk": "T AO K",
    "half": "HH AE F",
    "laugh": "L AE F",
    "enough": "IH N AH F",
    "tough": "T AH F",
    "rough": "R AH F",
    "cough": "K AO F",
    "bought": "B AO T",
    "brought": "B R AO T",
    "ought": "AO T",
    "love": "L AH V",
    "above": "AH B AH V",
    "move": "M UW V",
    "prove": "P R UW V",
    "give": "G IH V",
    "gives": "G IH V Z",
    "given": "G IH V AH N",
    "giving": "G IH V IH NG",
    "live": "L IH V",
    "lives": "L IH V Z",
    "living": "L IH V IH NG",
    "get": "G EH T",
    "gets": "G EH T S",
    "getting": "G EH T IH NG",
    "girl": "G ER L",
    "gift": "G IH F T",
    "begin": "B IH G IH N",
    "together": "T AH G EH DH ER",
    "forget": "F ER G EH T",
    "good": "G UH D",
    "food": "F UW D",
    "blood": "B L AH D",
    "flood": "F L AH D",
    "door": "D AO R",
    "floor": "F L AO R",
    "poor": "P UH R",
    "four": "F AO R",
    "sure": "SH UH R",
    "sugar": "SH UH G ER",
    "school": "S K UW L",
    "machine": "M AH SH IY N",
    "chef": "SH EH F",
    "ache": "EY K",
    "echo": "EH K OW",
    "character": "K EH R IH K T ER",
    "stomach": "S T AH M AH K",
    "ocean": "OW SH AH N",
    "christmas": "K R IH S M AH S",
    "eye": "AY",
    "eyes": "AY Z",
    "key": "K IY",
    "money": "M AH N IY",
    "month": "M AH N TH",
    "mother": "M AH DH ER",
    "father": "F AA DH ER",
    "brother": "B R AH DH ER",
    "other": "AH DH ER",
    "another": "AH N AH DH ER",
    "son": "S AH N",
    "won": "W AH N",
    "nothing": "N AH TH IH NG",
    "something": "S AH M TH IH NG",
    "front": "F R AH N T",
    "friend": "F R EH N D",
    "heart": "HH AA R T",
    "earth": "ER TH",
    "early": "ER L IY",
    "earn": "ER N",
    "learn": "L ER N",
    "heard": "HH ER D",
    "here": "HH IY R",
    "hear": "HH IH R",
    "world": "W ER L D",
    "work": "W ER K",
    "word": "W ER D",
    "worse": "W ER S",
    "worth": "W ER TH",
    "water": "W AO T ER",
    "watch": "W AA CH",
    "want": "W AA N T",
    "put": "P UH T",
    "push": "P UH SH",
    "bush": "B UH SH",
    "pull": "P UH L",
    "busy": "B IH Z IY",
    "business": "B IH Z N AH S",
    "buy": "B AY",
    "build": "B IH L D",
    "built": "B IH L T",
    "break": "B R EY K",
    "great": "G R EY T",
    "steak": "S T EY K",
    "bread": "B R EH D",
    "head": "HH EH D",
    "dead": "D EH D",
    "death": "D EH TH",
    "breath": "B R EH TH",
    "breathe": "B R IY DH",
    "ready": "R EH D IY",
    "already": "AO L R EH D IY",
    "health": "HH EH L TH",
    "weather": "W EH DH ER",
    "measure": "M EH ZH ER",
    "pleasure": "P L EH ZH ER",
    "island": "AY L AH N D",
    "answer": "AE N S ER",
    "sword": "S AO R D",
    "lamb": "L AE M",
    "climb": "K L AY M",
    "comb": "K OW M",
    "thumb": "TH AH M",
    "debt": "D EH T",
    "doubt": "D AW T",
    "listen": "L IH S AH N",
    "often": "AO F AH N",
    "castle": "K AE S AH L",
    "hundred": "HH AH N D R AH D",
    "why": "W AY",
    "which": "W IH CH",
    "while": "W AY L",
    "white": "W AY T",
    "whole": "HH OW L",
    "minute": "M IH N AH T",
    "use": "Y UW Z",
    "used": "Y UW Z D",
    "useful": "Y UW S F AH L",
    "first": "F ER S T",
    "sign": "S AY N",
    "science": "S AY AH N S",
    "eight": "EY T",
    "height": "HH AY T",
    "either": "IY DH ER",
    "neither": "N IY DH ER",
    "friends": "F R EH N D Z",
    "young": "Y AH NG",
    "touch": "T AH CH",
    "country": "K AH N T R IY",
    "couple": "K AH P AH L",
    "double": "D AH B AH L",
    "trouble": "T R AH B AH L",
    "southern": "S AH DH ER N",
    "among": "AH M AH NG",
    "company": "K AH M P AH N IY",
    "color": "K AH L ER",
    "cover": "K AH V ER",
    "monday": "M AH N D EY",
    "nose": "N OW Z",
    "rose": "R OW Z",
    "close": "K L OW Z",
    "chose": "CH OW Z",
    "choose": "CH UW Z",
    "lose": "L UW Z",
    "loose": "L UW S",
    "wise": "W AY Z",
    "please": "P L IY Z",
    "cause": "K AO Z",
    "both": "B OW TH",
    "most": "M OW S T",
    "post": "P OW S T",
    "journey": "JH ER N IY",
    "toward": "T AO R D",
    "course": "K AO R S",
    "over": "OW V ER",
    "open": "OW P AH N",
    "almost": "AO L M OW S T",
    "also": "AO L S OW",
    "always": "AO L W EY Z",
    "picture": "P IH K CH ER",
    "nature": "N EY CH ER",
    "future": "F Y UW CH ER",
    "receive": "R IH S IY V",
    "believe": "B IH L IY V",
    "piece": "P IY S",
    "field": "F IY L D",
    "tie": "T AY",
    "die": "D AY",
    "lie": "L AY",
    "pie": "P AY",
    "yes": "Y EH S",
    "us": "AH S",
    "his": "HH IH Z",
    "hers": "HH ER Z",
    "its": "IH T S",
    "i": "AY",
    "my": "M AY",
    "by": "B AY",
    "or": "AO R",
    "for": "F AO R",
    "nor": "N AO R",
    # contractions
    "i'm": "AY M",
    "i've": "AY V",
    "i'll": "AY L",
    "i'd": "AY D",
    "it's": "IH T S",
    "that's": "DH AE T S",
    "he's": "HH IY Z",
    "she's": "SH IY Z",
    "we're": "W IH R",
    "you're": "Y AO R",
    "they're": "DH EH R",
    "don't": "D OW N T",
    "won't": "W OW N T",
    "can't": "K AE N T",
    "isn't": "IH Z AH N T",
    "didn't": "D IH D AH N T",
    "doesn't": "D AH Z AH N T",
    "wasn't": "W AA Z AH N T",
    "couldn't": "K UH D AH N T",
    "wouldn't": "W UH D AH N T",
    "let's": "L EH T S",
    "shoe": "SH UW",
    "author": "AO TH ER",
    "method": "M EH TH AH D",
    "anger": "AE NG G ER",
    "angry": "AE NG G R IY",
    "knowledge": "N AA L IH JH",
    "worry": "W ER IY",
    "sorry": "S AA R IY",
}
LEXICON: dict[str, tuple[str, ...]] = {k: tuple(v.split()) for k, v in LEXICON_RAW.items()}

# --------------------------------------------------------------------------
# rule table
# --------------------------------------------------------------------------
Out = Sequence[str] | Callable[[list], Sequence[str]]
_RULES: dict[str, list] = {}
MAGIC = r"^([^aeiouy]l?e|(st|ng|th)e)$"  # ...Ce / ...Cle / waste, change, bathe
CE = r"^([^aeiouyr]|$)"  # consonant (not r) or word end: <ar> in car, not carry
CEO = r"^([^aeiour]|$)"  # same, but <y> allowed: story, glory
LSUF = r"^(tion|sion|ture|tial|tient|cial|cious|cian)$"  # lengthens a/o: nation, social


def _R(text: str, out: Out, left: str | None = None, right: str | None = None):
    _RULES.setdefault(text[0], []).append(
        (
            text,
            re.compile(left) if left else None,
            re.compile(right) if right else None,
            tuple(out) if not callable(out) else out,
        )
    )


def _s_end(out):  # word-final <s>
    prev = out[-1][0] if out else ""
    return ("Z",) if prev in _VOICED_CONS else ("S",)


# a
_R("augh", ("AO",))
_R("aigh", ("EY",))
_R("air", ("EH", "R"))
_R("are", ("EH", "R"), right=r"^$")
_R("ar", ("AO", "R"), left=r"w$")
_R("ar", ("AA", "R"), right=CE)
_R("ai", ("EY",))
_R("ay", ("EY",))
_R("au", ("AO",))
_R("aw", ("AO",), right=r"^([^aeiou]|$)")
_R("all", ("AO", "L"))
_R("alk", ("AO", "K"))
_R("alm", ("AA", "M"))
_R("alt", ("AO", "L", "T"))
_R("a", ("AH",), left=r"^$", right=r"^(?![^aeiouy]l?e$)[^aeiouy][aeiouy]")
_R("a", ("EY",), right=MAGIC)
_R("a", ("AA",), left=r"w$")
_R("a", ("EY",), right=LSUF)
_R("a", ("AH",), right=r"^$")
_R("a", ("AE",))
# b
_R("bb", ("B",))
_R("b", (), left=r"m$", right=r"^s?$")
_R("b", (), right=r"^t$")
_R("b", ("B",))
# c
_R("ck", ("K",))
_R("ch", ("K",), left=r"^s$")
_R("ch", ("K",), right=r"^[lnr]")
_R("ch", ("CH",))
_R("cc", ("K", "S"), right=r"^[eiy]")
_R("cc", ("K",))
_R("cial", ("SH", "AH", "L"))
_R("cian", ("SH", "AH", "N"))
_R("cious", ("SH", "AH", "S"))
_R("c", ("SH",), right=r"^i[aeou]")
_R("c", ("S",), right=r"^[eiy]")
_R("c", ("K",))
# d
_R("dge", ("JH",))
_R("dg", ("JH",), right=r"^[eiy]")
_R("dd", ("D",))
_R("d", ("D",))
# e
_R("eigh", ("EY",))
_R("ear", ("IH", "R"))
_R("ee", ("IY",))
_R("ea", ("IY",))
_R("ei", ("IY",), left=r"c$")
_R("ei", ("EY",))
_R("ew", ("UW",))
_R("eu", ("UW",))
_R("er", ("ER",), right=CE)
_R("e", ("IH",), left=r"^$", right=r"^x")
_R("e", ("IY",), right=r"^(tion|ture|sion)$")
_R("e", ("IY",), right=MAGIC)
_R("e", ("IY",), left=r"^[^aeiouy]{1,2}$", right=r"^$")
_R("e", (), left=r"[aeiouy].*$", right=r"^$")
_R("e", ("EH",))
# f
_R("ff", ("F",))
_R("f", ("F",))
# g
_R("gh", (), left=r"[aeiou]$")
_R("gg", ("G",))
_R("g", (), left=r"^$", right=r"^n")
_R("g", (), right=r"^n$")
_R("g", ("JH",), right=r"^[eiy]")
_R("g", ("G",))
# h
_R("h", ("HH",))
# i
_R("igh", ("AY",))
_R("ir", ("ER",), right=CE)
_R("ique", ("IY", "K"), right=r"^$")
_R("ie", ("AY",), right=r"^$")
_R("ie", ("AY", "AH"), right=r"^t$")
_R("ie", ("IY",))
_R("ion", ("AH", "N"), right=r"^$")
_R("i", ("AY",), right=r"^(nd|ld)$")
_R("i", ("AY",), right=MAGIC)
_R("i", ("IH",))
# j
_R("j", ("JH",))
# k
_R("kk", ("K",))
_R("k", (), left=r"^$", right=r"^n")
_R("k", ("K",))
# l
_R("ll", ("L",))
_R("le", ("AH", "L"), left=r"[^aeiouy]$", right=r"^$")
_R("l", ("L",))
# m
_R("mm", ("M",))
_R("ment", ("M", "AH", "N", "T"), right=r"^$")
_R("m", ("M",))
# n
_R("ng", ("NG", "G"), left=r"[iou]$", right=r"^er$")
_R("ng", ("NG", "G"), right=r"^[aour]")
_R("ng", ("NG",), right=r"^([^eiy]|$)")
_R("nk", ("NG", "K"))
_R("nn", ("N",))
_R("n", ("N",))
# o
_R("ough", ("AO",))
_R("oo", ("UH",), right=r"^[kd]")
_R("oo", ("UW",))
_R("oi", ("OY",))
_R("oy", ("OY",))
_R("oa", ("OW",))
_R("oe", ("OW",))
_R("our", ("AO", "R"), right=CE)
_R("ou", ("AW",))
_R("ow", ("OW",), right=r"^$")
_R("ow", ("AW",))
_R("ore", ("AO", "R"), right=r"^$")
_R("or", ("ER",), left=r"^[a-z]{3,}$", right=r"^$")
_R("or", ("AO", "R"), right=CEO)
_R("o", ("AH",), right=r"^ther")
_R("o", ("AO",), right=r"^(ng|g|ff|ss|th)")
_R("o", ("OW",), right=r"^(ld|lt)$")
_R("o", ("OW",), right=LSUF)
_R("o", ("OW",), right=MAGIC)
_R("o", ("OW",), right=r"^$")
_R("o", ("AA",))
# p
_R("ph", ("F",))
_R("pp", ("P",))
_R("p", (), left=r"^$", right=r"^[sn]")
_R("p", ("P",))
# q
_R("que", ("K",), right=r"^$")
_R("qu", ("K", "W"))
_R("q", ("K",))
# r
_R("rh", ("R",))
_R("rr", ("R",))
_R("r", ("R",))
# s
_R("stion", ("S", "CH", "AH", "N"))
_R("ssion", ("SH", "AH", "N"))
_R("ssure", ("SH", "ER"), right=r"^$")
_R("sion", ("ZH", "AH", "N"), left=r"[aeiou]$")
_R("sion", ("SH", "AH", "N"))
_R("sure", ("ZH", "ER"), left=r"[aeiou]$", right=r"^$")
_R("sure", ("SH", "ER"), right=r"^$")
_R("sh", ("SH",))
_R("ss", ("S",))
_R("sc", ("S",), right=r"^[eiy]")
_R("s", ("Z",), left=r"[aeiouy]$", right=r"^(?!e$)[aeiouy]")
_R("s", _s_end, right=r"^$")
_R("s", ("S",))
# t
_R("tch", ("CH",))
_R("tion", ("SH", "AH", "N"))
_R("tial", ("SH", "AH", "L"))
_R("tient", ("SH", "AH", "N", "T"))
_R("tious", ("SH", "AH", "S"))
_R("ture", ("CH", "ER"), right=r"^$")
_R("th", ("TH",), right=r"^ing$")
_R("th", ("DH",), left=r"[aeiouy]$", right=r"^[aeiouy]")
_R("th", ("DH",), right=r"^e$")
_R("th", ("TH",))
_R("tt", ("T",))
_R("t", (), left=r"s$", right=r"^(en|le)$")
_R("t", ("T",))
# u
_R("ue", ("UW",))
_R("ui", ("UW",))
_R("ur", ("ER",), right=CE)
_R("ull", ("UH", "L"))
_R("u", ("Y", "UW"), left=r"(^|[bcfghkmpv])$", right=MAGIC)
_R("u", ("UW",), right=MAGIC)
_R("u", ("Y", "UW"), left=r"(^|[bcfghkmpv])$", right=r"^[^aeiouy][aeiou]")
_R("u", ("UW",), right=r"^[^aeiouy][aeiou]")
_R("u", ("AH",))
# v
_R("v", ("V",))
# w
_R("wr", ("R",), left=r"^$")
_R("wh", ("W",))
_R("w", ("W",))
# x
_R("x", ("G", "Z"), left=r"^e$", right=r"^[aeiou]")
_R("x", ("Z",), left=r"^$")
_R("x", ("K", "S"))
# y
_R("y", ("Y",), left=r"^$", right=r"^[aeiou]")
_R("y", ("AY",), right=MAGIC)
_R("y", ("AY",), left=r"^[^aeiou]{1,3}$", right=r"^$")
_R("y", ("IY",), right=r"^$")
_R("y", ("Y",), right=r"^[aeiou]")
_R("y", ("IH",))
# z
_R("zz", ("Z",))
_R("z", ("Z",))


# --------------------------------------------------------------------------
# engine
# --------------------------------------------------------------------------
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


# --------------------------------------------------------------------------
# stress
# --------------------------------------------------------------------------
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
