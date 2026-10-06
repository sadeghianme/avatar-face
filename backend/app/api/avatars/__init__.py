"""The owner's avatar routes, /orgs/{org_id}/avatars: HTTP only. What they
do is services.avatars (rows, the picture, the marks, the mouth, publishing).

Every route is registered on the one `router` (routing.py), which the app
includes; importing the modules below registers theirs.
"""

from app.api.avatars import core, mouth, photo, publish, rig  # noqa: F401  (registers routes)
from app.api.avatars.routing import router

__all__ = ["router"]
