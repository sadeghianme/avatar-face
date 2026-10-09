"""The rule table: longest match first, each rule with an optional regex
on the text to its left and right, which is what lets one letter behave
differently in "cat" and "city", "go" and "gem"."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence

from app.services.tts.g2p.lexicon import VOICED_CONS

Out = Sequence[str] | Callable[[list], Sequence[str]]
# (text, left context, right context, phonemes or a function of those so far)
Rule = tuple[str, re.Pattern[str] | None, re.Pattern[str] | None, Out]
RULES: dict[str, list[Rule]] = {}
MAGIC = r"^([^aeiouy]l?e|(st|ng|th)e)$"  # ...Ce / ...Cle / waste, change, bathe
CE = r"^([^aeiouyr]|$)"  # consonant (not r) or word end: <ar> in car, not carry
CEO = r"^([^aeiour]|$)"  # same, but <y> allowed: story, glory
LSUF = r"^(tion|sion|ture|tial|tient|cial|cious|cian)$"  # lengthens a/o: nation, social


def _R(text: str, out: Out, left: str | None = None, right: str | None = None):
    RULES.setdefault(text[0], []).append(
        (
            text,
            re.compile(left) if left else None,
            re.compile(right) if right else None,
            tuple(out) if not callable(out) else out,
        )
    )


def _s_end(out):  # word-final <s>
    prev = out[-1][0] if out else ""
    return ("Z",) if prev in VOICED_CONS else ("S",)


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
