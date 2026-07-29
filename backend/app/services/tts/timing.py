"""Speech timing model.

Evenly spreading characters across a duration is what makes lip-sync feel
off-beat: real speech gives vowels ~3x the time of a stop consonant, and
punctuation buys real silence. This module assigns each character a
duration from its viseme class, adds word gaps and punctuation pauses, and
applies anticipatory coarticulation (lips round BEFORE a rounded vowel —
articulators lead the sound by ~50-100ms).

Both the offline synthesizer and the cue builder use it, so generated audio
and viseme cues share one clock by construction.
"""
from __future__ import annotations

from dataclasses import dataclass

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


def cues_for_duration(text: str, duration_ms: int) -> list[dict]:
    """Cue track for audio of a KNOWN duration (real TTS providers):
    the model's relative rhythm, retimed to fit the actual audio."""
    segments = segment_text(text)
    modelled = total_duration_ms(segments)
    if not segments or modelled <= 0 or duration_ms <= 0:
        return [{"t": 0, "viseme": "sil"}]
    return cues_from_segments(segments, scale=duration_ms / modelled)


def word_marks(text: str) -> list[dict]:
    """Millisecond offset of each word start, keyed by character index.

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
