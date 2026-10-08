"""Render clone jobs inside this backend, when its hardware allows.

Two deployments, one UI. On the operator's laptop the backend process sits
on Apple Silicon, so there is no reason to route a render through a second
terminal: the dashboard shows a "Render now" button and this module does the
work in-process. On the CPU-only server the capability probe fails, the
button never appears, and the dashboard shows the worker instructions
instead. The UI asks which world it is in; it never assumes.

Capability is probed, not configured: chatterbox importable AND an
accelerator present. A flag would rot — the truth is whether the import
succeeds on this machine today. CPU is deliberately not accepted even
though it would "work": at 5-10x slower than real time a render would pin
all cores for many minutes, and on the shared server that is the API dying
for a nice-to-have.
"""

from __future__ import annotations

import asyncio
import io
import logging
import tempfile
import threading
import wave
from collections.abc import AsyncGenerator

import numpy as np

logger = logging.getLogger("liveface.local_render")

_probe_lock = threading.Lock()
_probe_result: dict | None = None
_engine = None
_engine_lock = threading.Lock()
# One render at a time, and shared with nothing: the engine holds ~2GB and
# concurrent generates slow each other superlinearly.
_render_semaphore: asyncio.Semaphore | None = None


def capability() -> dict:
    """{"available": bool, "device": str|None, "reason": str|None}, cached.

    Cached because the import alone costs ~2s of torch initialisation, and
    the answer cannot change without restarting the process.
    """
    global _probe_result
    with _probe_lock:
        if _probe_result is not None:
            return _probe_result
        # torch and chatterbox are the [clone] extra: absent from the server
        # image and from CI, so the type checker may not find them either.
        try:
            import torch  # pyright: ignore[reportMissingImports]  # noqa: F401
            from chatterbox.tts import (  # pyright: ignore[reportMissingImports]  # noqa: F401
                ChatterboxTTS,
            )
        except Exception as exc:
            # Broad on purpose: importing torch can fail as ImportError,
            # OSError (a missing library) or RuntimeError (the device), and
            # every one of them means "not here".
            logger.info("local rendering unavailable: %s", type(exc).__name__)
            _probe_result = {
                "available": False,
                "device": None,
                "reason": f"chatterbox is not installed here ({type(exc).__name__})",
            }
            return _probe_result
        import torch  # pyright: ignore[reportMissingImports]

        if torch.backends.mps.is_available():
            device = "mps"
        elif torch.cuda.is_available():
            device = "cuda"
        else:
            _probe_result = {
                "available": False,
                "device": None,
                "reason": "no accelerator (CPU rendering would starve the API)",
            }
            return _probe_result
        _probe_result = {"available": True, "device": device, "reason": None}
        return _probe_result


def _get_engine():
    global _engine
    with _engine_lock:
        if _engine is None:
            from chatterbox.tts import ChatterboxTTS  # pyright: ignore[reportMissingImports]

            logger.info("loading Chatterbox on %s", capability()["device"])
            _engine = ChatterboxTTS.from_pretrained(device=capability()["device"])
        return _engine


def _clone_reference(engine, reference: bytes) -> None:
    with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
        handle.write(reference)
        handle.flush()
        engine.prepare_conditionals(handle.name)


def _render_one(engine, text: str) -> tuple[bytes, int]:
    tensor = engine.generate(text)
    samples = tensor.squeeze().detach().cpu().numpy()
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(engine.sr)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue(), int(len(pcm) * 1000 / engine.sr)


async def render_text(reference: bytes, text: str) -> tuple[bytes, int]:
    """Clone from `reference` and render one line. Serialised with renders.

    Used for on-demand synthesis when a cloned voice is asked for a line it
    was never given. Re-cloning per call costs ~1.5s and keeps this
    stateless — caching a speaker embedding per voice would be faster and
    would also mean holding one person's voice print in memory indefinitely.
    """
    global _render_semaphore
    if _render_semaphore is None:
        _render_semaphore = asyncio.Semaphore(1)
    async with _render_semaphore:
        engine = await asyncio.to_thread(_get_engine)
        await asyncio.to_thread(_clone_reference, engine, reference)
        return await asyncio.to_thread(_render_one, engine, text)


async def render_lines(reference: bytes, lines: list[str]) -> AsyncGenerator[tuple[bytes, int]]:
    """Clone from `reference` once, then render each line in turn:
    (audio, duration_ms) per line, in order. Serialised with every other
    render; the engine is held for the whole run."""
    global _render_semaphore
    if _render_semaphore is None:
        _render_semaphore = asyncio.Semaphore(1)
    async with _render_semaphore:
        engine = await asyncio.to_thread(_get_engine)
        await asyncio.to_thread(_clone_reference, engine, reference)
        for text in lines:
            yield await asyncio.to_thread(_render_one, engine, text)
