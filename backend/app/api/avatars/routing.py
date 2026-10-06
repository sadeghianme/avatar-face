"""The router every avatar route is registered on, and what it does around
them: an answering avatar shown as the owner sees it (with its draft motion
signed), and one edit at a time per avatar."""

from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter
from fastapi.routing import APIRoute

from app.api.avatars.presenting import avatar_out, signed_view
from app.models import Avatar
from app.services.edit_locks import avatar_edits


async def present(result: Any) -> Any:
    """What a route returned, as the owner API shows it: one avatar with its
    draft motion signed (presenting.signed_view); a list of avatars without
    (the list shows no mouth, and signing each would cost a storage round
    trip per avatar, a HEAD and a presign each on S3, for a page that never
    plays one); anything else as it is."""
    if isinstance(result, Avatar):
        return await signed_view(result)
    if isinstance(result, list) and result and all(isinstance(a, Avatar) for a in result):
        return [avatar_out(avatar) for avatar in result]
    return result


class _PresentingRoute(APIRoute):
    """A route whose returned avatar is shown as the owner sees it
    (`present`), whichever route answers with one: routes return the row,
    and the view, signing included, is built in one place."""

    def __init__(self, path: str, endpoint: Callable[..., Awaitable[Any]], **kwargs: Any):
        @functools.wraps(endpoint)
        async def presented(**values: Any) -> Any:
            return await present(await endpoint(**values))

        super().__init__(path, presented, **kwargs)


# One router for the whole package: each module registers its routes on it,
# so they are wrapped by the route class exactly as when they were one
# module (sub-routers included here would wrap every route once more).
router = APIRouter(
    prefix="/orgs/{org_id}/avatars", tags=["avatars"], route_class=_PresentingRoute
)


def one_edit_at_a_time[R](route: Callable[..., Awaitable[R]]) -> Callable[..., Awaitable[R]]:
    """Run a route that edits an avatar's draft with that avatar's edit lock
    held (services.edit_locks), taken before the route reads the row.

    These routes rewrite files in place and commit the row last, awaiting
    in between (seconds, for the layer build), so two of them interleaving
    on one avatar mix one's committed row with the other's rewritten files:
    two overlapping crops cut the image once and move the rig twice. Reads
    that only present the draft (GET) are not held; a publish is, since it
    snapshots the draft's files.
    """

    @functools.wraps(route)
    async def locked(**kwargs: Any) -> R:
        # FastAPI passes every parameter by name, and reads the signature
        # (dependencies included) from `route` through functools.wraps.
        async with avatar_edits.hold(kwargs["avatar_id"]):
            return await route(**kwargs)

    return locked
