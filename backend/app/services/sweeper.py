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
    """One pass: staged images past their retention (when it is on), then
    idle creations. Returns the staged images removed."""
    from app.core.config import get_settings
    from app.services.storage import get_storage

    settings = get_settings()
    removed = 0
    if settings.candidate_retention_hours > 0:
        ttl = settings.candidate_retention_hours * 3600
        try:
            removed = await get_storage().sweep(ORG_PREFIX, ttl, CANDIDATE_SEGMENT)
        except Exception:
            # Never fatal: a storage hiccup must not take the API with it, and
            # the next tick will try again.
            logger.exception("candidate sweep failed")
        if removed:
            logger.info("swept %d stale staged image(s)", removed)
    await expire_creations()
    return removed


async def expire_creations() -> int:
    """Idle drafts expire by their rows (services.creations.expire_idle),
    not by file age like the staging area: a draft resumed today still
    needs the photo uploaded a week ago.

    Stranded creations are recovered first: a finish whose failure could not
    be written back is otherwise stuck until the next restart.
    """
    from app.services.creations import expire_idle, recover_stranded

    try:
        await recover_stranded()
    except Exception:
        logger.exception("creation recovery failed")
    try:
        return await expire_idle()
    except Exception:
        logger.exception("creation expiry failed")
        return 0


async def run_forever(interval_seconds: int) -> None:
    """Sweep now, then on a timer until cancelled."""
    while True:
        await sweep_once()
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise
