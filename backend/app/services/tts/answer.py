"""The synthesize answer (POST /embed/v1/synthesize and the dashboard's
/orgs/{id}/synthesize): the audio, its cues and, when asked, each word's
start time, which places a text's expressions on the voice
(docs/emotions.md)."""

from __future__ import annotations

import base64

from app.schemas.tts import CueOut, SynthesizeRequest, SynthesizeResponse, WordMark
from app.services.tts.base import SynthesisResult
from app.services.tts.timing import on_planner_thread, word_marks_for_duration


async def synthesis_answer(
    body: SynthesizeRequest, result: SynthesisResult, cached: bool
) -> SynthesizeResponse:
    """`result` as answered to `body`: with `word_marks` (planned on a
    planning thread, retimed to the audio) only when the request asked, so
    every other answer is what it was."""
    marks = None
    if body.word_marks:
        planned = await on_planner_thread(
            word_marks_for_duration, body.text, result.duration_ms, body.locale
        )
        marks = [WordMark(**m) for m in planned]
    return SynthesizeResponse(
        audio_b64=base64.b64encode(result.audio).decode(),
        audio_mime=result.audio_mime,
        duration_ms=result.duration_ms,
        cues=[CueOut(**c) for c in result.cues],
        cached=cached,
        word_marks=marks,
    )
