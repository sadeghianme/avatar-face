"""In-process background jobs, and the one thread CPU work runs on.

The API is one uvicorn process on a four-core box, and the same event loop
that answers the dashboard also serves every customer's widget: embed
configs, speech, storage. Two things follow.

**CPU work never runs on the loop.** Decoding a phone photo, MediaPipe,
matting, compositing and PNG encoding each take from a tenth of a second to
several seconds, and on the loop every embed on every customer's site waits
for them. They run on ONE worker thread instead (`run_cpu`). One, not a pool:
the box also synthesises speech (Kokoro, with its own threads), and a pool
sized to the cores would starve it whenever a few people upload at once.
Queueing a second upload behind the first costs that person seconds; letting
image work take every core costs every visitor their audio. The thread's
OpenCV is capped to a single thread for the same reason. Network calls stay
on the loop, where waiting is free.

**Jobs are tasks on this loop, bounded three ways.** One active job per
subject (a second click is a 409, not a second copy of the work), at most
MAX_PER_ORG active per organization (one busy customer cannot fill the
queue), and at most MAX_ACTIVE in the whole process (503 with Retry-After
beyond that, so a burst degrades into "try again shortly" instead of memory
growing without bound). At most MAX_RUNNING run at once; the rest wait
queued. A job that waits on the network for long (an image-model call in
a finish) gives its slot back for the wait (`JobRunner.outside_slot`):
the slot bounds work on this box, and a finish waiting half a minute on
Google must not hold the next person's upload at "waiting for a free
worker".

Progress lives here, in memory, keyed by job id. Writing every tick to the
database would be a commit per tick on a SQLite file that the widget reads
from; callers persist only state transitions. A restart therefore loses
progress and the job itself (deploys restart the container often), which is
why callers mark jobs left queued or running as interrupted at startup.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, TypeVar

from app.core.errors import Conflict409, RateLimit429, ServiceUnavailable503
from app.models.base import new_id

logger = logging.getLogger("liveface.jobs")

T = TypeVar("T")

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
INTERRUPTED = "interrupted"
ACTIVE_STATES = frozenset({QUEUED, RUNNING})

# See the module docstring for why each bound exists.
MAX_ACTIVE = 12
MAX_PER_ORG = 2
MAX_RUNNING = 2
# What a client is told to wait. An org's own jobs finish in seconds; a full
# queue means several people's work is ahead, so it is told to wait longer.
ORG_RETRY_AFTER_SECONDS = 10
QUEUE_RETRY_AFTER_SECONDS = 30

CPU_THREAD_PREFIX = "liveface-cpu"


def _limit_cpu_thread() -> None:
    """Runs once, on the worker thread, before its first task.

    OpenCV otherwise sizes its own pool to every core for each call. The
    setting is OpenCV's alone: Kokoro's ONNX runtime keeps the threads it
    was configured with.
    """
    try:
        import cv2
    except ImportError:  # the rig extra (MediaPipe, OpenCV) is optional
        return
    cv2.setNumThreads(1)


_executor = ThreadPoolExecutor(
    max_workers=1, thread_name_prefix=CPU_THREAD_PREFIX, initializer=_limit_cpu_thread
)


async def run_cpu(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Run `fn(*args, **kwargs)` on the CPU thread and await its result.

    `fn` must be plain synchronous work: it runs on a thread with no event
    loop, and anything it raises is raised here. Cancelling the awaiting task
    does not stop `fn`; it finishes and its result is dropped.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, functools.partial(fn, *args, **kwargs))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Job:
    """One job's identity and live progress. Never persisted as a whole."""

    id: str
    org_id: str
    # What the job works on (a creation id); one active job per subject.
    subject_id: str
    step: str
    # The subject's revision when the job was accepted. A result is stored
    # only if the subject is still at it (see services.creations).
    revision: int
    started_at: str = field(default_factory=_now_iso)
    state: str = QUEUED
    fraction: float = 0.0
    label: str | None = None
    # How far a counted stage is, as (done, total): "3 of 6" mouth shapes.
    # Belongs to the label it was reported with.
    count: tuple[int, int] | None = None
    task: asyncio.Task | None = field(default=None, repr=False)
    # Whether it holds one of the runner's running slots right now (not
    # while queued, nor while `outside_slot` has lent it back).
    holds_slot: bool = field(default=False, repr=False)

    def report(
        self, fraction: float, label: str | None = None, count: tuple[int, int] | None = None
    ) -> None:
        """Record progress. Monotonic: a later, smaller report is ignored,
        so a bar driven by it never runs backwards. A new label drops the
        previous one's `count` unless it brings its own: "fitting the mouth"
        is not "6 of 6"."""
        self.fraction = max(self.fraction, min(max(float(fraction), 0.0), 1.0))
        if label is not None:
            self.label = label
            self.count = count
        elif count is not None:
            self.count = count

    def progress(self) -> dict:
        count = None
        if self.count is not None:
            count = {"done": self.count[0], "total": self.count[1]}
        return {"fraction": round(self.fraction, 3), "label": self.label, "count": count}


class JobRunner:
    def __init__(
        self,
        max_active: int = MAX_ACTIVE,
        max_per_org: int = MAX_PER_ORG,
        max_running: int = MAX_RUNNING,
    ):
        self.max_active = max_active
        self.max_per_org = max_per_org
        self.max_running = max_running
        self._jobs: dict[str, Job] = {}
        self._by_subject: dict[str, str] = {}
        self._slots: asyncio.Semaphore | None = None

    # --- admission -------------------------------------------------------------

    def reserve(self, org_id: str, subject_id: str, step: str, revision: int) -> Job:
        """Admit a job, or refuse with the error the client should see.

        Synchronous on purpose: with no await between the checks and the
        registration, two requests on this loop cannot both pass them.
        The caller must `start` the job or `release` it.
        """
        if subject_id in self._by_subject:
            raise Conflict409(
                "Something is already running for this; wait for it to finish",
                code="job_in_progress",
            )
        if sum(1 for job in self._jobs.values() if job.org_id == org_id) >= self.max_per_org:
            raise RateLimit429(
                "Your organization already has work running; try again in a few seconds",
                code="too_many_jobs",
                headers={"Retry-After": str(ORG_RETRY_AFTER_SECONDS)},
            )
        if len(self._jobs) >= self.max_active:
            raise ServiceUnavailable503(
                "The server is busy; try again shortly",
                code="job_queue_full",
                headers={"Retry-After": str(QUEUE_RETRY_AFTER_SECONDS)},
            )
        job = Job(id=new_id(), org_id=org_id, subject_id=subject_id, step=step, revision=revision)
        self._jobs[job.id] = job
        self._by_subject[subject_id] = job.id
        return job

    def release(self, job: Job) -> None:
        self._jobs.pop(job.id, None)
        if self._by_subject.get(job.subject_id) == job.id:
            del self._by_subject[job.subject_id]

    # --- running -----------------------------------------------------------------

    def start(self, job: Job, work: Callable[[Job], Awaitable[None]]) -> asyncio.Task:
        """Run `work(job)` once a slot is free; the job is released after.

        `work` owns persistence: it records its own state transitions and
        result. What escapes it is logged here, never raised into the loop.
        """

        async def body() -> None:
            slots = self._running_slots()
            try:
                await slots.acquire()
                job.holds_slot = True
                try:
                    job.state = RUNNING
                    await work(job)
                finally:
                    # Not held when cancelled while taking it back after
                    # `outside_slot`: releasing then would mint a slot.
                    if job.holds_slot:
                        job.holds_slot = False
                        slots.release()
            except asyncio.CancelledError:
                # Shutdown. The subject is left queued or running on purpose:
                # the next startup marks it interrupted.
                raise
            except Exception:
                logger.exception("job %s (%s) failed outside its handler", job.id, job.step)
            finally:
                self.release(job)

        job.task = asyncio.create_task(body(), name=f"job-{job.step}-{job.id}")
        return job.task

    @contextlib.asynccontextmanager
    async def outside_slot(self, job: Job | None) -> AsyncIterator[None]:
        """Lend `job`'s running slot back for a wait on the network, and
        take one again after (queueing behind others if they took them).

        For long provider calls inside a job. Its CPU work still runs on
        the one CPU thread (`run_cpu`), which is the bound that protects
        speech; the slot only decides whose work goes next, and a call
        that waits on Google does not need one. A no-op for a job that
        holds no slot, or none at all.
        """
        if job is None or not job.holds_slot or self._slots is None:
            yield
            return
        slots = self._slots
        job.holds_slot = False
        slots.release()
        try:
            yield
        finally:
            await slots.acquire()
            job.holds_slot = True

    def _running_slots(self) -> asyncio.Semaphore:
        # Created on first use, so it belongs to the loop that runs the jobs.
        if self._slots is None:
            self._slots = asyncio.Semaphore(self.max_running)
        return self._slots

    # --- inspection ---------------------------------------------------------------

    def get(self, job_id: str | None) -> Job | None:
        return self._jobs.get(job_id) if job_id else None

    def active_for(self, subject_id: str) -> Job | None:
        return self.get(self._by_subject.get(subject_id))

    async def drain(self) -> None:
        """Wait until no job is active, including jobs started meanwhile."""
        while True:
            tasks = [job.task for job in self._jobs.values() if job.task is not None]
            if not tasks:
                return
            await asyncio.gather(*tasks, return_exceptions=True)

    async def shutdown(self) -> None:
        """Cancel every job. What they were working on is recovered at the
        next startup, which is where a deploy's restart lands anyway."""
        tasks = [job.task for job in self._jobs.values() if job.task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def reset(self) -> None:
        """Forget everything (tests: each gets a fresh app on the same loop)."""
        self._jobs.clear()
        self._by_subject.clear()
        self._slots = None


runner = JobRunner()
