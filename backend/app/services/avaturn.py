"""Avaturn: a rigged 3D avatar built from the user's own photos.

Replaces the in-house photo-to-GLB generator, which triangulated 478 face
landmarks and could only ever produce a mask — no skull, hair, ears or neck,
and a flat photo smeared over whatever turned away from the camera. Avaturn
returns a full head and body with ARKit blendshapes and visemes, which is
exactly what the existing 3D engine drives.

The integration is the SESSION flow, not the three-photo REST flow, and that
choice matters:

* Avaturn's editor guides the capture, shows the result, and lets the user
  adjust it before accepting. A blind server-side upload gives them one
  attempt at a result they cannot see coming.
* Their API wants a frontal photo plus two side photos. This product asks
  for one portrait. Rather than complicate that upload, the editor collects
  what it needs, in their UI, with their guidance.
* The user's photos go straight from their browser to Avaturn. This server
  never holds them, which is the better privacy story and one less thing to
  store.

What comes back is a GLB URL on an already-allow-listed host, so importing
it reuses the same path as pasting a Ready Player Me link.

Shapes here follow the published OpenAPI spec (api.avaturn.me/openapi.json):
bearer auth, POST /api/v1/users/new -> {id}, POST /api/v1/sessions/new
-> {url, id}.
"""

from __future__ import annotations

import logging

import httpx

logger = logging.getLogger("liveface.avaturn")

BASE_URL = "https://api.avaturn.me"
TIMEOUT_SECONDS = 30.0


class AvaturnUnavailable(RuntimeError):
    """No Avaturn token is configured on this instance."""


def api_token() -> str | None:
    """Dashboard-managed token, falling back to the environment."""
    from app.core.credentials import credentials

    return credentials.get("avaturn_api_token")


def configured() -> bool:
    return bool(api_token())


async def _post(path: str, payload: dict | None = None) -> dict:
    token = api_token()
    if not token:
        raise AvaturnUnavailable("avaturn_api_token is not set")
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{BASE_URL}{path}",
            headers={"Authorization": f"Bearer {token}"},
            json=payload if payload is not None else {},
        )
    if response.status_code >= 300:
        # The body carries the reason: an unpaid plan, an invalid token and a
        # malformed body are indistinguishable from the status alone.
        logger.error("avaturn %s failed (%s): %s", path, response.status_code, response.text[:400])
        raise RuntimeError(f"Avaturn request failed ({response.status_code})")
    return response.json()


async def new_session() -> dict:
    """An editor URL for the browser, plus the anonymous user it belongs to.

    A fresh anonymous user per session on purpose: Avaturn's user id is only
    a handle for their avatar list, and reusing one across our customers
    would let each of them see the others' avatars in the editor.
    """
    user = await _post("/api/v1/users/new")
    session = await _post(
        "/api/v1/sessions/new",
        {"user_id": user["id"], "config": {"type": "create"}},
    )
    return {"url": session["url"], "session_id": session["id"], "user_id": user["id"]}
