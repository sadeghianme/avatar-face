"""Speech timing model.

Evenly spreading characters across a duration is what makes lip-sync feel
off-beat: real speech gives vowels ~3x the time of a stop consonant, and
punctuation buys real silence. This module assigns each segment a duration
from its viseme class, adds word gaps and punctuation pauses, and applies
anticipatory coarticulation (lips round BEFORE a rounded vowel — articulators
lead the sound by ~50-100ms).

Segments come from PRONUNCIATION for English (see `g2p` and `phonemes`) and
from spelling for everything else. The difference is large: driven by letters,
"the" is three unrelated mouth shapes for a two-sound word and "knight" mimes
a hard k. The character path remains for locales the phoneme rules do not
cover, where per-letter shapes are still better than nothing.

Both the offline synthesizer and the cue builder use this module, so generated
audio and viseme cues share one clock by construction.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.services.tts.g2p import word_to_phonemes_stressed
from app.services.tts.phonemes import UnknownPhone, plan
from app.services.tts.visemes import char_to_viseme

# Typical articulation duration per viseme class at conversational rate (ms).
VISEME_DURATION_MS: dict[str, int] = {
    "sil": 45,
    "PP": 60,   # p, b, m — brief closure
    "FF": 95,   # f, v — sustained fricative
    "TH": 90,
    "DD": 55,   # t, d — quick stops
    "kk": 60,
    "CH": 85,
    "SS": 100,  # s, z — long fricatives
    "nn": 70,
    "RR": 75,
    "aa": 145,  # open vowels carry the most time
    "E": 120,
    "ih": 95,
    "oh": 130,
    "ou": 125,
}
DEFAULT_DURATION_MS = 80

# Silence bought by punctuation.
PAUSE_MS: dict[str, int] = {
    ",": 180, ";": 200, ":": 200, "—": 160, "–": 160, "-": 70,
    ".": 320, "!": 340, "?": 340, "…": 400,
    "。": 320, "！": 340, "？": 340, "、": 180, "؟": 340, "।": 320,
}
WORD_GAP_MS = 55

# Articulators reach position before the sound is heard. Rounded and labial
# shapes lead most visibly (you see the pucker before you hear the vowel).
ANTICIPATION_MS: dict[str, int] = {
    "ou": 70, "oh": 60, "PP": 55, "FF": 45, "CH": 40, "RR": 35,
}


@dataclass
class Segment:
    """One articulation slot: which mouth shape, for how long."""

    viseme: str
    duration_ms: int


def segment_text(text: str) -> list[Segment]:
    """Split text into timed articulation segments."""
    segments: list[Segment] = []
    for ch in text:
        if ch in PAUSE_MS:
            segments.append(Segment("sil", PAUSE_MS[ch]))
            continue
        if ch.isspace():
            # Merge consecutive whitespace into a single word gap.
            if segments and segments[-1].viseme == "sil":
                continue
            segments.append(Segment("sil", WORD_GAP_MS))
            continue
        viseme = char_to_viseme(ch)
        segments.append(
            Segment(viseme, VISEME_DURATION_MS.get(viseme, DEFAULT_DURATION_MS))
        )
    return segments


def total_duration_ms(segments: list[Segment]) -> int:
    return sum(s.duration_ms for s in segments)


def cues_from_segments(segments: list[Segment], scale: float = 1.0) -> list[dict]:
    """Viseme cues from timed segments, with anticipatory coarticulation.

    `scale` retimes the model onto a known audio duration (real providers);
    the offline provider generates audio at scale 1.0 by construction.
    """
    cues: list[dict] = []
    t = 0.0
    last_viseme: str | None = None
    for segment in segments:
        if segment.viseme != last_viseme:
            start = t - ANTICIPATION_MS.get(segment.viseme, 0)
            # Never precede the previous cue or run negative.
            floor = cues[-1]["t"] + 1 if cues else 0
            cues.append({"t": max(floor, int(round(start * scale))), "viseme": segment.viseme})
            last_viseme = segment.viseme
        t += segment.duration_ms
    end = int(round(t * scale))
    if not cues or cues[-1]["viseme"] != "sil":
        cues.append({"t": max(end, (cues[-1]["t"] + 1) if cues else 0), "viseme": "sil"})
    else:
        cues[-1]["t"] = min(cues[-1]["t"], end)
        cues.append({"t": max(end, cues[-1]["t"] + 1), "viseme": "sil"})
    return cues


def cues_for_duration(text: str, duration_ms: int, locale: str = "en-US") -> list[dict]:
    """Cue track for audio of a KNOWN duration (real TTS providers):
    the model's relative rhythm, retimed to fit the actual audio."""
    segments, _ = plan_utterance(text, locale)
    modelled = total_duration_ms(segments)
    if not segments or modelled <= 0 or duration_ms <= 0:
        return [{"t": 0, "viseme": "sil"}]
    return cues_from_segments(segments, scale=duration_ms / modelled)


def _char_word_marks(text: str) -> list[dict]:
    """Character-path word offsets (see `plan_utterance` for the general case).

    `segment_text` emits exactly one segment per character, so segment i and
    character i share an index and the cumulative duration up to i IS that
    character's start time. The browser-voice path fires `onboundary` with a
    charIndex; this table turns that event into an exact clock correction
    instead of the uniform chars-per-ms guess it used before.
    """
    marks: list[dict] = []
    t = 0
    at_word_start = True
    for i, ch in enumerate(text):
        if ch.isspace() or ch in PAUSE_MS:
            at_word_start = True
        elif at_word_start:
            marks.append({"char": i, "t": t})
            at_word_start = False
        if ch in PAUSE_MS:
            t += PAUSE_MS[ch]
        elif ch.isspace():
            t += WORD_GAP_MS
        else:
            t += VISEME_DURATION_MS.get(char_to_viseme(ch), DEFAULT_DURATION_MS)
    return marks


# --------------------------------------------------------------------------
# Pronunciation-driven planning
# --------------------------------------------------------------------------
_WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*")


def _phoneme_segments(word: str) -> list[Segment]:
    """Segments for one English word, or [] if it cannot be handled."""
    try:
        phones = word_to_phonemes_stressed(word)
        if not phones:
            return []
        return [Segment(s["vis"], int(s["ms"])) for s in plan(phones) if s["ms"] > 0]
    except (UnknownPhone, ValueError, KeyError, IndexError):
        # Any gap in the rules falls back to the character path rather than
        # failing the request — a rough mouth beats no mouth.
        return []


def _char_segments(text: str) -> list[Segment]:
    """Segments for text the phoneme rules do not cover (non-Latin, other
    locales). One segment per character, timed by viseme class."""
    segments: list[Segment] = []
    for ch in text:
        viseme = char_to_viseme(ch)
        segments.append(
            Segment(viseme, VISEME_DURATION_MS.get(viseme, DEFAULT_DURATION_MS))
        )
    return segments


def uses_phonemes(locale: str) -> bool:
    """Whether this locale is driven by pronunciation rather than spelling.

    Only English: the rule table encodes English orthography specifically, and
    applying it to French or German spelling would be worse than the character
    path, not better.
    """
    return locale.lower().replace("_", "-").split("-")[0] == "en"


def plan_utterance(text: str, locale: str = "en-US") -> tuple[list[Segment], list[dict]]:
    """Timed segments for `text`, plus the ms offset of each word start.

    The word offsets exist because the browser voice reports progress as a
    character index (`onboundary`) and needs to convert that into a position
    on this clock. They are produced HERE, alongside the segments, so the two
    cannot drift apart.
    """
    segments: list[Segment] = []
    marks: list[dict] = []
    phonemic = uses_phonemes(locale)
    elapsed = 0
    cursor = 0

    def emit(new_segments: list[Segment]) -> None:
        nonlocal elapsed
        segments.extend(new_segments)
        elapsed += sum(s.duration_ms for s in new_segments)

    def gap(chunk: str) -> None:
        """Silence for the punctuation and whitespace between two words."""
        pauses = [PAUSE_MS[c] for c in chunk if c in PAUSE_MS]
        if pauses:
            emit([Segment("sil", max(pauses))])
        elif chunk:
            emit([Segment("sil", WORD_GAP_MS)])

    for match in _WORD_RE.finditer(text) if phonemic else []:
        gap(text[cursor : match.start()])
        marks.append({"char": match.start(), "t": elapsed})
        word = match.group()
        emit(_phoneme_segments(word) or _char_segments(word))
        cursor = match.end()

    if not phonemic:
        return segment_text(text), _char_word_marks(text)

    # No word matched at all: the text is not written in Latin script, so the
    # English rules have nothing to say about it. Fall back to per-character
    # shapes. Checking `marks` rather than `segments` matters — trailing
    # punctuation alone would otherwise leave a lone silence and look handled.
    if not marks:
        return segment_text(text), _char_word_marks(text)
    gap(text[cursor:])
    return segments, marks
