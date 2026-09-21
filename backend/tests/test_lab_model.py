"""Opt-in real neural synthesis checks. No downloads during tests.

RUN_LIPSYNC_MODEL_TESTS=1 plus KOKORO_LIPSYNC_MODEL_PATH and KOKORO_VOICES_PATH
enables these on a machine with the lab weights installed.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("RUN_LIPSYNC_MODEL_TESTS") != "1", reason="requires lab model weights")


@pytest.mark.parametrize("voice,text", [
    ("af_heart", "Peter bought a blue paper bag. Five very vivid flowers."),
    ("bf_emma", "Please pause. We see two little boats. Mother made blueberry muffins."),
    ("ff_siwis", "Papa prépare un beau bouquet. Vous voyez cinq fleurs magnifiques."),
])
def test_real_phoneme_tracks(voice, text):
    from app.services.tts.lab_timing import _render
    audio, duration, native, baseline = _render(text, voice)
    assert audio.startswith(b"RIFF")
    assert 500 < duration < 30000
    assert len(native) > 5
    assert native != baseline
    assert all(a["t"] < b["t"] for a, b in zip(native, native[1:]))
    assert native[-1]["t"] == duration
    assert native[-1]["viseme"] == "sil"
    assert any(c["viseme"] == "PP" for c in native)
