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
import threading
import wave

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
        try:
            import torch  # noqa: F401
            from chatterbox.tts import ChatterboxTTS  # noqa: F401
        except Exception as exc:
            _probe_result = {
                "available": False,
                "device": None,
                "reason": f"chatterbox is not installed here ({type(exc).__name__})",
            }
            return _probe_result
        import torch

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
            from chatterbox.tts import ChatterboxTTS

            logger.info("loading Chatterbox on %s", capability()["device"])
            _engine = ChatterboxTTS.from_pretrained(device=capability()["device"])
        return _engine


def _clone_reference(engine, reference: bytes) -> None:
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
        handle.write(reference)
        handle.flush()
        engine.prepare_conditionals(handle.name)


def _render_one(engine, text: str) -> tuple[bytes, int]:
    import numpy as np

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


async def render_job(org_id: str, job_id: str) -> None:
    """Background task: render one claimed job and store its lines.

    Opens its own database sessions — a BackgroundTask outlives the request
    session that scheduled it. Every failure lands in the job's error field,
    because the person watching is looking at the dashboard, not at logs.
    """
    global _render_semaphore
    if _render_semaphore is None:
        _render_semaphore = asyncio.Semaphore(1)

    from app.db import get_session_factory
    from app.services import clonejobs
    from app.services.storage import get_storage
    from app.services.tts.cloned import store_line

    storage = get_storage()
    try:
        async with _render_semaphore:
            job = await clonejobs.get_job(storage, org_id, job_id)
            if job is None or job["status"] not in ("pending", "processing"):
                return
            reference = await storage.get_bytes(
                clonejobs.reference_key(org_id, job_id)
            )

            engine = await asyncio.to_thread(_get_engine)
            await asyncio.to_thread(_clone_reference, engine, reference)

            for index, text in enumerate(job["lines"], start=1):
                audio, duration_ms = await asyncio.to_thread(_render_one, engine, text)
                async with get_session_factory()() as db:
                    await store_line(
                        db, org_id, job["name"], job["locale"], text, audio, duration_ms
                    )
                    await db.commit()
                await clonejobs.update_progress(storage, org_id, job_id, index)
            await clonejobs.finish_job(storage, org_id, job_id)
            logger.info("rendered clone job %s in-process", job_id)
    except Exception as exc:
        logger.exception("in-process render failed for job %s", job_id)
        await clonejobs.finish_job(storage, org_id, job_id, error=f"{type(exc).__name__}: {exc}"[:900])
