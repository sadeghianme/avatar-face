"""Staged images ("candidates"): where they live and where they came from.

A candidate is any picture that is not yet an avatar — an upload being
cropped, a cut-out, a generated portrait. Saving one creates the avatar, and
only a picture that came out of image generation should count as a
generated avatar in the usage summary. The key records that: a generated
image, and every edit derived from it, is stored as
`gen-<backend>-<id>.png`. The key is chosen by the server and checked
against the org's prefix on the way back in, so a client cannot turn an
upload into a "generation" by renaming it.
"""

from __future__ import annotations

from uuid import uuid4

from app.services.imagegen import IMAGE_BACKENDS

GENERATED_MARK = "gen-"


def candidate_prefix(org_id: str) -> str:
    return f"orgs/{org_id}/candidates/"


def new_candidate_key(org_id: str, generated_by: str | None = None) -> str:
    mark = f"{GENERATED_MARK}{generated_by}-" if generated_by else ""
    return f"{candidate_prefix(org_id)}{mark}{uuid4().hex}.png"


def generated_by(key: str) -> str | None:
    """The image backend that produced this candidate, or None for a photo."""
    name = key.rsplit("/", 1)[-1]
    if not name.startswith(GENERATED_MARK):
        return None
    backend = name[len(GENERATED_MARK):].split("-", 1)[0]
    return backend if backend in IMAGE_BACKENDS else None
