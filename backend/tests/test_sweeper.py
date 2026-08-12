"""Sweeping staged images — and, above all, not sweeping anything else.

Avatar sources, rigs and thumbnails live under the same `orgs/` prefix as the
staging area. A sweep scoped only by prefix and age would delete every avatar
on the instance, which is why the segment guard exists and why most of these
tests are about what SURVIVES.
"""

import os
import time
from pathlib import Path

import pytest

from app.services.storage import LocalStorage
from app.services.sweeper import CANDIDATE_SEGMENT, ORG_PREFIX


@pytest.fixture
def storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(tmp_path, "http://test", "secret", 300)


async def _write(storage: LocalStorage, key: str, age_hours: float = 0.0) -> Path:
    await storage.put_bytes(key, b"x", "image/png")
    path = Path(storage.root) / key
    if age_hours:
        old = time.time() - age_hours * 3600
        os.utime(path, (old, old))
    return path


async def test_an_old_candidate_is_swept(storage):
    path = await _write(storage, "orgs/o1/candidates/abc.png", age_hours=48)
    removed = await storage.sweep(ORG_PREFIX, 24 * 3600, CANDIDATE_SEGMENT)
    assert removed == 1
    assert not path.exists()


async def test_a_fresh_candidate_survives(storage):
    """Someone may be looking at it right now."""
    path = await _write(storage, "orgs/o1/candidates/new.png", age_hours=1)
    assert await storage.sweep(ORG_PREFIX, 24 * 3600, CANDIDATE_SEGMENT) == 0
    assert path.exists()


async def test_avatars_are_never_touched_however_old(storage):
    """The test this file exists for."""
    keep = [
        await _write(storage, "orgs/o1/avatars/a1/source.png", age_hours=24 * 365),
        await _write(storage, "orgs/o1/avatars/a1/rig.json", age_hours=24 * 365),
        await _write(storage, "orgs/o1/avatars/a1/thumb.png", age_hours=24 * 365),
        await _write(storage, "orgs/o1/avatars/a1/history/x.json", age_hours=24 * 365),
    ]
    doomed = await _write(storage, "orgs/o1/candidates/old.png", age_hours=48)

    removed = await storage.sweep(ORG_PREFIX, 24 * 3600, CANDIDATE_SEGMENT)

    assert removed == 1
    assert not doomed.exists()
    for path in keep:
        assert path.exists(), f"{path} must survive a sweep"


async def test_candidates_across_orgs_are_all_swept(storage):
    a = await _write(storage, "orgs/o1/candidates/a.png", age_hours=48)
    b = await _write(storage, "orgs/o2/candidates/b.png", age_hours=48)
    assert await storage.sweep(ORG_PREFIX, 24 * 3600, CANDIDATE_SEGMENT) == 2
    assert not a.exists() and not b.exists()


async def test_the_guard_cannot_be_skipped(storage):
    """An empty guard would make the prefix the only protection."""
    await _write(storage, "orgs/o1/avatars/a1/source.png", age_hours=48)
    with pytest.raises(ValueError):
        await storage.sweep(ORG_PREFIX, 0, "")


async def test_a_name_that_merely_mentions_candidates_is_not_enough(storage):
    """Matching the path segment, not the word — an avatar called
    "candidates" must not be mistaken for the staging area."""
    path = await _write(storage, "orgs/o1/avatars/candidates-demo/source.png", age_hours=48)
    assert await storage.sweep(ORG_PREFIX, 24 * 3600, CANDIDATE_SEGMENT) == 0
    assert path.exists()


async def test_sweeping_an_empty_instance_is_harmless(storage):
    assert await storage.sweep(ORG_PREFIX, 24 * 3600, CANDIDATE_SEGMENT) == 0
