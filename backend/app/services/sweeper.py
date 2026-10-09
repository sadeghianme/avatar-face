"""Delete staged images nobody kept, and keep the speech cache in bounds.

Uploading a photo, restyling it, cropping it and cutting out its background
each leave an image behind, because every edit writes a new object rather than
overwriting the old one — that is what makes undo work. Only the one the user
saves becomes an avatar; the rest are litter.

Nothing here is precious, which is the point: a staged image is picked within
minutes or abandoned. A day's grace is far longer than any real session and
still bounds the pile.

Each tick also moves what is left of the speech cache in the database to
storage and evicts the least recently used lines past its caps
(services.tts.speech_cache). The first tick is at startup, so a new release
drains the old table at once. And it deletes the dashboard's refresh tokens
past their expiry (services.sessions), which nothing can exchange any more.

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

from app.core.config import get_settings
from app.services import sessions
from app.services.creations import expire_idle, recover_stranded
from app.services.storage import get_storage
from app.services.tts import speech_cache

logger = logging.getLogger("liveface.sweeper")

# Everything an org owns lives under this prefix — avatars included, which is
# why the sweep is additionally required to match the segment below.
ORG_PREFIX = "orgs/"

# The guard. Avatar sources, rigs and thumbnails sit beside the staging area
# under the same prefix; without this a sweep would delete every avatar on the
# instance.
CANDIDATE_SEGMENT = "/candidates/"


async def sweep_once() -> int:
    """One pass: staged images past their retention (when it is on), idle
    creations, then the speech cache. Returns the staged images removed."""
    settings = get_settings()
    removed = 0
    if settings.candidate_retention_hours > 0:
        ttl = settings.candidate_retention_hours * 3600
        try:
            removed = await get_storage().sweep(ORG_PREFIX, ttl, CANDIDATE_SEGMENT)
        except Exception:
            # Broad on purpose, never fatal: a storage hiccup must not take the API with it, and
            # the next tick will try again.
            logger.exception("candidate sweep failed")
        if removed:
            logger.info("swept %d stale staged image(s)", removed)
    await expire_creations()
    # Never raises: it logs its own failures.
    await speech_cache.sweep()
    await purge_sessions()
    return removed


async def purge_sessions() -> int:
    """Expired refresh tokens out of the table; never raises."""
    try:
        return await sessions.purge_expired()
    except Exception:
        # Broad on purpose: housekeeping must never take the API down, and
        # the next tick tries again.
        logger.exception("refresh token purge failed")
        return 0


async def expire_creations() -> int:
    """Idle drafts expire by their rows (services.creations.expire_idle),
    not by file age like the staging area: a draft resumed today still
    needs the photo uploaded a week ago.

    Stranded creations are recovered first: a finish whose failure could not
    be written back is otherwise stuck until the next restart.
    """
    # Broad on purpose, both: periodic housekeeping must never take the
    # API down, and the next tick tries again.
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
