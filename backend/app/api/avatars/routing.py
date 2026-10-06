"""The router every avatar route is registered on, and what it does around
them: the draft motion signed onto an answering avatar, and one edit at a
time per avatar."""

from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from fastapi import APIRouter
from fastapi.routing import APIRoute

from app.models import Avatar
from app.services.avatars.fitting import rig_profile
from app.services.edit_locks import avatar_edits
from app.services.storage import get_storage


async def sign_motion(result: Any) -> None:
    """Sign the draft motion of `result`, when it is one avatar, onto the
    instance, for its `mouth.motion_url` (Avatar.mouth). A list is left
    unsigned (motion_url null): the avatar list shows no mouth, and signing
    each would cost a storage round trip per avatar (a HEAD and a presign
    each, on S3) for a page that never plays one."""
    from app.services.mouth import load as load_mouth
    from app.services.mouth import motion_url

    if isinstance(result, Avatar) and getattr(result, "signed_motion_url", None) is None:
        result.signed_motion_url = await motion_url(load_mouth(result.mouth_config), get_storage())
    if isinstance(result, Avatar) and result.face_type in ("cartoon", "animal"):
        # Which look the draft has (character mouth or the classic one) is on
        # the rig, not the avatar: one read, for the lines that have a choice.
        result.signed_render_profile = await rig_profile(result)


class _SignedMouthRoute(APIRoute):
    """A route whose avatar carries its draft motion's presigned URL
    (AvatarOut.mouth.motion_url), whichever route answers with one.

    Presigning is async; AvatarOut reads the ORM object's `mouth` property,
    which is not. So the URL is signed onto the instance after the route
    returns and before FastAPI serializes it. Without it, a route that
    changed something else (a slider, a rename) would answer with a mouth
    without its motion, and a dashboard merging that answer into what it
    shows would preview the bundled motion while visitors get the avatar's
    own. The list (GET /avatars) is not signed (sign_motion)."""

    def __init__(self, path: str, endpoint: Callable[..., Awaitable[Any]], **kwargs: Any):
        @functools.wraps(endpoint)
        async def signed(**values: Any) -> Any:
            result = await endpoint(**values)
            await sign_motion(result)
            return result

        super().__init__(path, signed, **kwargs)


# One router for the whole package: each module registers its routes on it,
# so every route is wrapped once by the route class (an included router
# would wrap them again).
router = APIRouter(
    prefix="/orgs/{org_id}/avatars", tags=["avatars"], route_class=_SignedMouthRoute
)


R = TypeVar("R")


def one_edit_at_a_time(route: Callable[..., Awaitable[R]]) -> Callable[..., Awaitable[R]]:
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
