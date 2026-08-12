"""Delete staged images nobody kept.

Uploading a photo, restyling it, cropping it and cutting out its background
each leave an image behind, because every edit writes a new object rather than
overwriting the old one — that is what makes undo work. Only the one the user
saves becomes an avatar; the rest are litter.

Nothing here is precious, which is the point: a staged image is picked within
minutes or abandoned. A day's grace is far longer than any real session and
still bounds the pile.

Runs in-process on a timer rather than as a cron entry, so a fresh deployment
sweeps without anyone remembering to install anything. That is the right call
at one instance and the wrong one at several — every replica would sweep the
same bucket. The deletes are idempotent, so the failure mode is wasted
requests rather than lost data, but it should move to a single scheduled job
before scaling out.
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger("liveface.sweeper")

# Everything an org owns lives under this prefix — avatars included, which is
# why the sweep is additionally required to match the segment below.
ORG_PREFIX = "orgs/"

# The guard. Avatar sources, rigs and thumbnails sit beside the staging area
# under the same prefix; without this a sweep would delete every avatar on the
# instance.
CANDIDATE_SEGMENT = "/candidates/"


async def sweep_once() -> int:
    from app.core.config import get_settings
    from app.services.storage import get_storage

    settings = get_settings()
    ttl = settings.candidate_retention_hours * 3600
    removed = 0
    try:
        removed = await get_storage().sweep(ORG_PREFIX, ttl, CANDIDATE_SEGMENT)
    except Exception:
        # Never fatal: a storage hiccup must not take the API with it, and the
        # next tick will try again.
        logger.exception("candidate sweep failed")
    if removed:
        logger.info("swept %d stale staged image(s)", removed)
    return removed


async def run_forever(interval_seconds: int) -> None:
    """Sweep now, then on a timer until cancelled."""
    while True:
        await sweep_once()
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise
