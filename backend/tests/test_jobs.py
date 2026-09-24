"""The job runner and the CPU thread: admission, bounds, progress, and that
heavy work really leaves the event loop."""

import asyncio
import threading

import pytest

from app.core.errors import Conflict409, RateLimit429, ServiceUnavailable503
from app.services.jobs import CPU_THREAD_PREFIX, JobRunner, run_cpu


def test_one_active_job_per_subject():
    runner = JobRunner()
    job = runner.reserve("org", "creation", "detect", 3)
    with pytest.raises(Conflict409) as caught:
        runner.reserve("org", "creation", "background", 3)
    assert caught.value.code == "job_in_progress"
    runner.release(job)
    assert runner.reserve("org", "creation", "background", 3).revision == 3


def test_an_org_is_capped_and_told_when_to_come_back():
    runner = JobRunner(max_per_org=2)
    runner.reserve("busy", "a", "detect", 0)
    runner.reserve("busy", "b", "detect", 0)
    with pytest.raises(RateLimit429) as caught:
        runner.reserve("busy", "c", "detect", 0)
    assert caught.value.code == "too_many_jobs"
    assert int(caught.value.headers["Retry-After"]) > 0
    # Another org is not held up by it.
    runner.reserve("quiet", "d", "detect", 0)


def test_the_queue_is_bounded():
    runner = JobRunner(max_active=2, max_per_org=5)
    runner.reserve("o1", "a", "detect", 0)
    runner.reserve("o2", "b", "detect", 0)
    with pytest.raises(ServiceUnavailable503) as caught:
        runner.reserve("o3", "c", "detect", 0)
    assert caught.value.code == "job_queue_full"
    assert int(caught.value.headers["Retry-After"]) > 0


async def test_at_most_max_running_jobs_run_at_once_and_all_are_released():
    runner = JobRunner(max_running=2, max_per_org=10)
    running, peak = 0, 0
    release = asyncio.Event()

    async def work(job):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await release.wait()
        running -= 1

    jobs = [runner.reserve("org", f"s{i}", "detect", 0) for i in range(4)]
    for job in jobs:
        runner.start(job, work)
    await asyncio.sleep(0.01)
    assert peak == 2
    assert sorted(job.state for job in jobs) == ["queued", "queued", "running", "running"]
    release.set()
    await runner.drain()
    assert peak == 2
    assert runner.active_for("s0") is None and runner.get(jobs[0].id) is None


async def test_a_crashing_job_is_released_and_does_not_escape():
    runner = JobRunner()

    async def boom(job):
        raise RuntimeError("bad")

    job = runner.reserve("org", "s", "detect", 0)
    await runner.start(job, boom)
    assert runner.active_for("s") is None


async def test_shutdown_cancels_what_is_running():
    runner = JobRunner()
    started = asyncio.Event()

    async def forever(job):
        started.set()
        await asyncio.Event().wait()

    job = runner.reserve("org", "s", "detect", 0)
    task = runner.start(job, forever)
    await started.wait()
    await runner.shutdown()
    assert task.cancelled()
    assert runner.active_for("s") is None


def test_progress_only_moves_forward():
    runner = JobRunner()
    job = runner.reserve("org", "s", "detect", 0)
    job.report(0.5, "halfway")
    job.report(0.2)
    job.report(7)
    assert job.progress() == {"fraction": 1.0, "label": "halfway"}


async def test_cpu_work_runs_on_the_one_cpu_thread():
    names = {await run_cpu(lambda: threading.current_thread().name) for _ in range(3)}
    assert len(names) == 1
    assert names.pop().startswith(CPU_THREAD_PREFIX)


def test_the_cpu_thread_caps_opencv(monkeypatch):
    """Asserted on the call, not on cv2.getNumThreads(): macOS builds use
    GCD, which ignores the setting; the Linux server's backend honours it."""
    import cv2

    from app.services import jobs

    calls = []
    monkeypatch.setattr(cv2, "setNumThreads", calls.append)
    jobs._limit_cpu_thread()
    assert calls == [1]


async def test_cpu_errors_are_raised_to_the_caller():
    def fails():
        raise ValueError("no")

    with pytest.raises(ValueError):
        await run_cpu(fails)


async def test_building_an_avatar_does_its_cpu_work_off_the_loop(client, monkeypatch):
    """process_avatar is a request's background task; its detection,
    triangulation and thumbnail must run on the CPU thread."""
    from app.services import rig
    from tests.conftest import create_org, create_ready_avatar, register_and_login

    seen: dict[str, str] = {}
    real_detect, real_thumbnail = rig.landmarks_from_image, rig.make_thumbnail

    def detect(data):
        seen["detect"] = threading.current_thread().name
        return real_detect(data)

    def thumbnail(data):
        seen["thumbnail"] = threading.current_thread().name
        return real_thumbnail(data)

    monkeypatch.setattr(rig, "landmarks_from_image", detect)
    monkeypatch.setattr(rig, "make_thumbnail", thumbnail)
    headers = await register_and_login(client, "cpu")
    org_id = await create_org(client, headers)
    await create_ready_avatar(client, headers, org_id, publish=False)
    assert seen["detect"].startswith(CPU_THREAD_PREFIX)
    assert seen["thumbnail"].startswith(CPU_THREAD_PREFIX)
