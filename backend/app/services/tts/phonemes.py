"""ARPABET phonemes -> Oculus visemes, with coarticulation.

A phoneme is a sound; a viseme is what that sound LOOKS like. The map is
many-to-one — /p/, /b/ and /m/ are one closed mouth, and no viewer can tell
them apart — so this collapses 39 phonemes onto the 15 Oculus visemes the rig
carries, and assigns each a duration.

The part that matters visually is that the map is not a lookup. The same
phoneme is a different mouth depending on its neighbours, and getting this
wrong is immediately obvious even to someone who cannot say why:

  - /h/ has no lip shape at all. The lips are already in the following vowel,
    so "who" is one continuous pucker. Mapping it to a shape of its own makes
    the mouth open neutrally and only THEN round.
  - /j/ before /u/ ("you", "cute") is rounded throughout. A spread-then-pucker
    flip in 50ms is a 20Hz movement no face can make.
  - Lip-neutral consonants before a rounded vowel round early: /sw/ in "swim",
    /tw/ in "two" are already protruded during the consonant.
  - A /t/ between vowels is a flap in most English — "better" has no /t/
    shape at all.

Timings assume a citation rate; `normalize_rate` retargets them onto a known
speech rate, and `merge_and_cap` enforces a change-rate ceiling afterwards,
because the face cannot articulate faster than about 14Hz no matter what the
phoneme durations add up to.
"""

from copy import deepcopy

# --- viseme canonical poses on three ORTHOGONAL rig axes -------------------
# open: jaw aperture 0..1 | wide: corner spread -1(pursed)..+1(retracted)
# prot: forward protrusion 0..1 | tongue: tongue-tip visibility 0..1
VISEME_POSE = {
    "sil": {"open": 0.05, "wide": 0.00, "prot": 0.00, "tongue": 0.0},
    "PP": {"open": 0.00, "wide": 0.00, "prot": 0.00, "tongue": 0.0},
    "FF": {"open": 0.10, "wide": 0.05, "prot": 0.00, "tongue": 0.0},
    "TH": {"open": 0.15, "wide": 0.05, "prot": 0.00, "tongue": 1.0},
    "DD": {"open": 0.18, "wide": 0.05, "prot": 0.00, "tongue": 0.0},
    "kk": {"open": 0.28, "wide": 0.00, "prot": 0.00, "tongue": 0.0},
    "CH": {"open": 0.20, "wide": -0.55, "prot": 0.75, "tongue": 0.0},
    "SS": {"open": 0.12, "wide": 0.40, "prot": 0.00, "tongue": 0.0},
    "nn": {"open": 0.20, "wide": 0.05, "prot": 0.00, "tongue": 0.0},
    "RR": {"open": 0.30, "wide": -0.45, "prot": 0.55, "tongue": 0.0},
    "aa": {"open": 1.00, "wide": 0.00, "prot": 0.00, "tongue": 0.0},
    "E": {"open": 0.55, "wide": 0.30, "prot": 0.00, "tongue": 0.0},
    "ih": {"open": 0.30, "wide": 0.65, "prot": 0.00, "tongue": 0.0},
    "oh": {"open": 0.60, "wide": -0.55, "prot": 0.60, "tongue": 0.0},
    "ou": {"open": 0.22, "wide": -0.85, "prot": 0.95, "tongue": 0.0},
}


# weight = blend weight toward the pose (0 = hold previous/rest, 1 = fully reach it).
# NOT "mouth opening" -- opening lives in VISEME_POSE["open"].
# dw / dp = per-phone deltas on wide / prot, added AFTER the pose lookup.
# ms = citation duration at ~4.3 syll/s (measured); use normalize_rate() to retarget.
def _p(vis, ms, ms_un, w, glide=None, split=1.0, dw=0.0, dp=0.0, cls="C", voiced=False, liprole=0):
    return {
        "vis": vis,
        "glide": glide,
        "split": split,
        "ms": ms,
        "ms_un": ms_un,
        "weight": w,
        "dw": dw,
        "dp": dp,
        "cls": cls,
        "voiced": voiced,
        "liprole": liprole,
    }


# liprole: 0 = no inherent lip target (borrows from context) | 1 = lip-critical (never overridden)

ARPABET = {
    "sil": _p("sil", 200, 100, 1.00, cls="X"),
    "sp": _p("sil", 80, 50, 0.60, cls="X"),
    "P": _p("PP", 85, 60, 1.00, liprole=1),
    "B": _p("PP", 65, 45, 0.95, voiced=True, liprole=1),
    "M": _p("PP", 70, 50, 0.90, voiced=True, liprole=1),
    "F": _p("FF", 95, 70, 1.00, liprole=1),
    "V": _p("FF", 60, 40, 0.90, voiced=True, liprole=1),
    "TH": _p("TH", 90, 60, 1.00),
    "DH": _p("TH", 40, 25, 0.50, voiced=True),
    "T": _p("DD", 75, 45, 0.55),
    "D": _p("DD", 55, 35, 0.50, voiced=True),
    "K": _p("kk", 80, 55, 0.60),
    "G": _p("kk", 65, 45, 0.55, voiced=True),
    "HH": _p("kk", 55, 35, 0.35),  # placeholder: always overwritten by context
    "SH": _p("CH", 120, 85, 1.00, liprole=1),
    "ZH": _p("CH", 75, 50, 0.90, voiced=True, liprole=1),
    "CH": _p("CH", 125, 90, 1.00, liprole=1),
    "JH": _p("CH", 95, 65, 0.95, voiced=True, liprole=1),
    "S": _p("SS", 115, 85, 1.00),
    "Z": _p("SS", 80, 55, 0.90, voiced=True),
    "N": _p("nn", 65, 45, 0.50, voiced=True),
    "L": _p("nn", 60, 40, 0.55, voiced=True),
    "NG": _p("nn", 75, 55, 0.45, voiced=True),
    "R": _p("RR", 65, 45, 0.85, voiced=True, liprole=1),
    "ER": _p("RR", 135, 80, 1.00, cls="V", voiced=True, liprole=1),
    "W": _p(
        "ou", 60, 45, 1.00, dp=0.05, dw=-0.10, voiced=True, liprole=1
    ),  # tighter than UW (flag #2)
    "Y": _p("ih", 50, 35, 0.80, voiced=True),
    "AA": _p("aa", 140, 80, 1.00, cls="V", voiced=True, liprole=1),
    "AE": _p(
        "aa", 150, 85, 0.95, cls="V", voiced=True, dw=+0.45, liprole=1
    ),  # spread, not neutral (flag #4)
    "AH": _p("aa", 110, 55, 0.70, cls="V", voiced=True, liprole=1),
    "AO": _p("oh", 145, 85, 1.00, cls="V", voiced=True, liprole=1),
    "EH": _p("E", 110, 65, 1.00, cls="V", voiced=True, liprole=1),
    "IH": _p("ih", 90, 50, 0.80, cls="V", voiced=True, dw=-0.15, liprole=1),
    "IY": _p("ih", 120, 70, 1.00, cls="V", voiced=True, dw=+0.20, liprole=1),
    "UH": _p("ou", 85, 55, 0.55, cls="V", voiced=True, dp=-0.30, dw=+0.25, liprole=1),
    "UW": _p("ou", 120, 70, 1.00, cls="V", voiced=True, liprole=1),
    "AY": _p("aa", 195, 110, 1.00, "ih", 0.60, cls="V", voiced=True, liprole=1),
    "AW": _p("aa", 205, 115, 1.00, "ou", 0.58, cls="V", voiced=True, liprole=1),
    "OY": _p("oh", 215, 120, 1.00, "ih", 0.62, cls="V", voiced=True, liprole=1),
    "EY": _p("E", 155, 90, 1.00, "ih", 0.60, cls="V", voiced=True, liprole=1),
    "OW": _p("oh", 165, 95, 1.00, "ou", 0.58, cls="V", voiced=True, liprole=1),
}
REDUCED = {
    "AH0": _p("E", 55, 45, 0.30, cls="V", voiced=True, dw=-0.25, liprole=1),
    "IH0": _p("ih", 50, 40, 0.45, cls="V", voiced=True, dw=-0.30, liprole=1),
    "ER0": _p("RR", 80, 65, 0.60, cls="V", voiced=True, liprole=1),
    "UW0": _p("ou", 65, 55, 0.55, cls="V", voiced=True, dp=-0.35, liprole=1),
    "OW0": _p("oh", 95, 80, 0.60, "ou", 0.60, cls="V", voiced=True, liprole=1),
    "AE0": _p("aa", 85, 70, 0.60, cls="V", voiced=True, dw=+0.30, liprole=1),
    "EH0": _p("E", 65, 55, 0.55, cls="V", voiced=True, liprole=1),
    "AA0": _p("aa", 80, 70, 0.60, cls="V", voiced=True, liprole=1),
    "AO0": _p("oh", 85, 70, 0.60, cls="V", voiced=True, liprole=1),
    "IY0": _p("ih", 70, 60, 0.65, cls="V", voiced=True, liprole=1),
    "UH0": _p("ou", 60, 50, 0.40, cls="V", voiced=True, dp=-0.35, liprole=1),
    "AY0": _p("aa", 110, 95, 0.60, "ih", 0.60, cls="V", voiced=True, liprole=1),
    "AW0": _p("aa", 115, 95, 0.60, "ou", 0.58, cls="V", voiced=True, liprole=1),
    "OY0": _p("oh", 120, 100, 0.60, "ih", 0.62, cls="V", voiced=True, liprole=1),
    "EY0": _p("E", 90, 75, 0.60, "ih", 0.60, cls="V", voiced=True, liprole=1),
}
ROUNDED_V = {"UW", "UH", "OW", "AO", "OY", "AW"}  # trigger anticipatory rounding
FRONTING_CTX = {"T", "D", "S", "Z", "N", "L", "Y", "CH", "JH", "SH"}  # flag #8
NO_LIP = {"T", "D", "K", "G", "N", "L", "NG", "S", "Z", "TH", "DH", "HH"}  # liprole 0
VOWELS = set("AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split())


class UnknownPhone(ValueError):
    pass


def base_stress(p):
    p = p.strip().upper()
    if p in ("SIL", "SP", "", "SPN", "NSN"):
        return ({"SPN": "sil", "NSN": "sil", "": "sil"}.get(p, p.lower()), "")
    if p and p[-1] in "012":
        return p[:-1], p[-1]
    return p, ""


def lookup(phone, strict=True):
    """Return a FRESH copy of the record for one CMUdict phone."""
    b, s = base_stress(phone)
    if s == "0" and b + "0" in REDUCED:
        return deepcopy(REDUCED[b + "0"])
    if b not in ARPABET:
        if strict:
            raise UnknownPhone(f"unmapped phone {phone!r}")
        return deepcopy(ARPABET["sil"])
    if b in VOWELS and s == "":
        raise UnknownPhone(
            f"vowel {phone!r} carries no stress digit. Stressless aligner output makes schwa "
            f"indistinguishable from stressed AH; supply CMUdict stress or run a stress tagger."
        )
    r = deepcopy(ARPABET[b])
    if s == "2":
        r["ms"] = round(r["ms"] * 0.78)
        r["weight"] = round(r["weight"] * 0.80, 2)
    elif s == "0":
        r["ms"] = r["ms_un"]
        r["weight"] = round(r["weight"] * 0.60, 2)
    return r


# ---------------------------------------------------------------- context --
def plan(phones, strict=True):
    """phones: list of CMUdict phones for one phrase. Returns list of segments."""
    ph = [base_stress(p)[0] for p in phones]
    recs = [lookup(p, strict) for p in phones]

    # (1) HH borrows the FOLLOWING vowel's shape (flag #1), else the preceding one.
    for i, b in enumerate(ph):
        if b != "HH":
            continue
        nxt = next((j for j in range(i + 1, len(ph)) if ph[j] in VOWELS), None)
        prv = next((j for j in range(i - 1, -1, -1) if ph[j] in VOWELS), None)
        src, w = (
            (nxt, 0.70) if nxt is not None else ((prv, 0.50) if prv is not None else (None, 0.35))
        )
        if src is None:
            recs[i].update(vis="sil", weight=0.35)
        else:
            s = recs[src]
            recs[i].update(
                vis=s["vis"], glide=None, dw=s["dw"], dp=s["dp"], weight=round(s["weight"] * w, 2)
            )

    # (2) Y borrows rounding before a rounded vowel (flag #2 mirror).
    for i, b in enumerate(ph):
        if b == "Y" and i + 1 < len(ph) and ph[i + 1] in ROUNDED_V:
            recs[i].update(vis="ou", weight=0.55, dp=-0.15)

    # (3) Anticipatory rounding: lip-neutral consonants before W or a rounded vowel.
    for i, b in enumerate(ph):
        if b in NO_LIP and i + 1 < len(ph) and (ph[i + 1] == "W" or ph[i + 1] in ROUNDED_V):
            recs[i]["dw"] -= 0.55
            recs[i]["dp"] += 0.45

    # (4) UW fronting after alveolar/palatal (flag #8): relax the pucker.
    for i, b in enumerate(ph):
        if b == "UW" and i and ph[i - 1] in FRONTING_CTX:
            recs[i]["dp"] -= 0.40
            recs[i]["dw"] += 0.35
            recs[i]["weight"] = round(recs[i]["weight"] * 0.75, 2)

    # (5) Flap: V T|D V (or R T V) -> no viseme at all (flag #12).
    drop = set()
    for i, b in enumerate(ph):
        if (
            b in ("T", "D")
            and 0 < i < len(ph) - 1
            and ph[i - 1] in (VOWELS | {"R"})
            and ph[i + 1] in VOWELS
        ):
            drop.add(i)

    # (6) Collapse runs of adjacent lip-neutral consonants into one held pose (flag #5).
    out, i = [], 0
    while i < len(ph):
        if i in drop:
            i += 1
            continue
        r = recs[i]
        if ph[i] in NO_LIP and r["liprole"] == 0:
            j, dur, wmax, dw, dp = i, 0, 0.0, 0.0, 0.0
            while j < len(ph) and j not in drop and ph[j] in NO_LIP and recs[j]["vis"] == r["vis"]:
                dur += recs[j]["ms"]
                wmax = max(wmax, recs[j]["weight"])
                dw += recs[j]["dw"]
                dp += recs[j]["dp"]
                j += 1
            if j > i:
                r = dict(r, ms=dur, weight=wmax, dw=dw, dp=dp)
                out.append((ph[i], r))
                i = j
                continue
        out.append((ph[i], r))
        i += 1

    # (7) Pre-voiced-coda and phrase-final lengthening.
    for k, (b, r) in enumerate(out):
        if r["cls"] == "V":
            nb = out[k + 1][1] if k + 1 < len(out) else None
            if nb and nb["cls"] == "C" and nb["voiced"]:
                r["ms"] = round(r["ms"] * 1.45)
            if k == len(out) - 1 or (k + 1 < len(out) and out[k + 1][1]["vis"] == "sil"):
                r["ms"] = round(r["ms"] * 1.30)

    # (8) Expand to segments with resolved poses.
    segs = []
    for b, r in out:
        parts = (
            [
                (r["vis"], round(r["ms"] * r["split"])),
                (r["glide"], r["ms"] - round(r["ms"] * r["split"])),
            ]
            if r["glide"]
            else [(r["vis"], r["ms"])]
        )
        for vis, ms in parts:
            pose = dict(VISEME_POSE[vis])
            pose["wide"] = max(-1.0, min(1.0, pose["wide"] + r["dw"]))
            pose["prot"] = max(0.0, min(1.0, pose["prot"] + r["dp"]))
            segs.append(
                {
                    "phone": b,
                    "vis": vis,
                    "ms": ms,
                    "weight": r["weight"],
                    "liprole": r["liprole"],
                    **pose,
                }
            )
    return merge_and_cap(segs)


def merge_and_cap(segs, max_hz=14.0):
    """Merge identical neighbours; enforce the change-rate cap without dropping lip-critical poses."""
    m = []
    for s in segs:
        if m and m[-1]["vis"] == s["vis"] and abs(m[-1]["wide"] - s["wide"]) < 0.2:
            m[-1]["ms"] += s["ms"]
            m[-1]["weight"] = max(m[-1]["weight"], s["weight"])
        else:
            m.append(dict(s))
    # PP/FF closures are ballistic transients, not dwells: lip-closure velocity is far above
    # 14 Hz and flag #14's anticipation window carries them. They are exempt from the floor
    # but never shorter than MIN_CLOSURE_MS.
    MIN_CLOSURE_MS = 30
    floor = 1000.0 / max_hz
    changed = True
    while changed and len(m) > 1:
        changed = False
        for i, s in enumerate(m):
            if s["ms"] >= floor:
                continue
            if s["vis"] in ("PP", "FF"):
                if s["ms"] < MIN_CLOSURE_MS:
                    nb = max(
                        [j for j in (i - 1, i + 1) if 0 <= j < len(m)], key=lambda j: m[j]["ms"]
                    )
                    take = min(MIN_CLOSURE_MS - s["ms"], max(0, m[nb]["ms"] - MIN_CLOSURE_MS))
                    if take > 0:
                        m[nb]["ms"] -= take
                        s["ms"] += take
                        changed = True
                continue
            if s["liprole"] == 1:
                # lip-critical: steal time from the longer neighbour instead of dropping it
                nb = max([j for j in (i - 1, i + 1) if 0 <= j < len(m)], key=lambda j: m[j]["ms"])
                take = min(floor - s["ms"], max(0, m[nb]["ms"] - floor))
                if take > 0:
                    m[nb]["ms"] -= take
                    s["ms"] += take
                    changed = True
                else:
                    continue
            else:
                nb = max([j for j in (i - 1, i + 1) if 0 <= j < len(m)], key=lambda j: m[j]["ms"])
                m[nb]["ms"] += s["ms"]
                m.pop(i)
                changed = True
            break
    for s in m:
        s["ms"] = int(round(s["ms"]))
    return m


def normalize_rate(segs, n_syllables, target_syll_per_sec=5.3):
    tot = sum(s["ms"] for s in segs)
    if not tot or not n_syllables:
        return segs
    k = (1000.0 * n_syllables / target_syll_per_sec) / tot
    for s in segs:
        s["ms"] = round(s["ms"] * k)
    return merge_and_cap(segs)


def crossfade_ms(a, b):
    """Blend length that always fits inside both segments."""
    nominal = 25 if (a["vis"] in ("PP", "DD", "kk") or b["vis"] in ("PP", "DD", "kk")) else 55
    return max(8, round(min(nominal, 0.40 * min(a["ms"], b["ms"]))))


def anticipation_ms(seg):
    """Lip contact leads the acoustics (flag #14)."""
    return 65 if seg["vis"] == "PP" else (55 if seg["vis"] == "FF" else 0)
