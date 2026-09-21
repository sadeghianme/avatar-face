"""Bounded, phrase-level PCM streaming for the timestamp-enabled lab model.

Each packet contains audio AND its local native cues. Sample offsets, rather
than rounded milliseconds, define the joins. The stable TTS API is unchanged.
"""
from __future__ import annotations

import base64
import io
import re
import wave


def speech_phrases(text: str) -> list[str]:
    """A short first phrase, then modest look-ahead; never discard input.

    Prefer sentences/clauses over arbitrary words. Don't split decimal numbers,
    initials, or common titles. A long unpunctuated sentence still starts early.
    """
    parts: list[str] = []
    rest = text
    while rest:
        limit = 72
        if len(rest) <= limit:
            parts.append(rest)
            break
        boundaries = []
        for match in re.finditer(r"[.!?;:,。！？،؛](?:[\"'”’)]*)(?:\s+|(?=[\u3000-\u9fff]))|\n+", rest[:limit + 1]):
            end = match.end()
            prefix = rest[:end].strip().lower()
            if re.search(r"(?:\b(?:mr|mrs|ms|dr|prof|st|vs|etc)|\b[a-z])\.$", prefix):
                continue
            if end >= 24:
                boundaries.append(end)
        if boundaries:
            end = boundaries[-1]
        else:
            spaces = list(re.finditer(r"\s+", rest[:limit + 1]))
            # Do not cut a word, URL, number, or grapheme just to hit a target.
            end = spaces[-1].end() if spaces else next(
                (m.end() for m in re.finditer(r"\s+|[。！？]", rest)), len(rest)
            )
        parts.append(rest[:end])
        rest = rest[end:]
    return parts


def phrase_batch_size(phrases: list[str], buffered_seconds: float, seconds_per_char: float | None) -> int:
    """Only batch ahead when measured inference cost fits existing audio.

    First/slow-server packets stay short. Faster servers can recover longer
    prosodic context without making the next packet miss the playback deadline.
    This is conservative headroom, not a guarantee under variable network/CPU.
    """
    count = 1
    if not seconds_per_char or buffered_seconds <= .4:
        return count
    chars = len(phrases[0])
    for phrase in phrases[1:]:
        chars += len(phrase)
        if chars > 120 or chars * seconds_per_char * 1.25 + .4 > buffered_seconds:
            break
        count += 1
    return count


def pcm_packet(audio: bytes, sequence: int, start_sample: int, cues: list[dict], baseline: list[dict]) -> dict:
    with wave.open(io.BytesIO(audio), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 24000:
            raise ValueError("The native stream requires mono 24 kHz PCM16")
        count = wav.getnframes()
        pcm = wav.readframes(count)
    if not count or count > 24000 * 90 or len(pcm) != count * 2:
        raise ValueError("Invalid native audio packet")
    return {
        "type": "chunk", "sequence": sequence, "start_sample": start_sample,
        "sample_count": count, "sample_rate": 24000,
        "pcm_b64": base64.b64encode(pcm).decode(), "cues": cues, "baseline_cues": baseline,
    }
