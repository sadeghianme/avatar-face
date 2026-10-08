"""Serves the local-filesystem storage fallback with presigned-URL semantics.

Only mounted when S3/R2 is NOT configured. GET/PUT both validate the HMAC
signature + expiry produced by LocalStorage.presign_*.

Production runs on this fallback, so every texture, rig, GLB and audio file
a visitor loads comes through here. A GET streams the file in chunks from a
worker thread (Starlette's FileResponse, which also answers Range requests)
instead of reading it whole on the event loop; a PUT is read up to a size
limit and refused past it.
"""
from __future__ import annotations

import mimetypes
import time

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import FileResponse

from app.core.errors import Auth401, NotFound404, PayloadTooLarge413, Validation422
from app.services.avatars.sources import MAX_MODEL_BYTES
from app.services.creations.rules import MAX_UPLOAD_BYTES
from app.services.storage import LocalStorage, get_storage, is_published

router = APIRouter(prefix="/storage", tags=["storage"])

# Python 3.12's built-in table has no .webp, and the slim image has no
# /etc/mime.types to add it, so mouth photos would go out as
# application/octet-stream.
mimetypes.add_type("image/webp", ".webp")


def _local() -> LocalStorage:
    storage = get_storage()
    if not isinstance(storage, LocalStorage):
        raise NotFound404("Local storage is not enabled", code="not_found")
    return storage


@router.get("/{key:path}")
async def storage_get(
    key: str, expires: int = Query(...), signature: str = Query(...)
) -> Response:
    """The file behind a signed GET URL, streamed. A `Range` header gets a
    206 with that part. 401 `bad_signature`, 404 `object_not_found`."""
    storage = _local()
    if not storage.verify("GET", key, expires, signature):
        raise Auth401("Invalid or expired storage URL", code="bad_signature")
    try:
        found = await storage.file(key)
    except ValueError:  # a key outside the storage root
        found = None
    if found is None:
        raise NotFound404("Object not found", code="object_not_found")
    path, stat = found
    media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    return FileResponse(
        path,
        stat_result=stat,
        media_type=media_type,
        # Third-party embed pages fetch textures, audio and JSON (the rig,
        # the mouth photo's rig, the avatar's own motion) cross-origin.
        # PublicCorsMiddleware (app.main) reflects the page's origin over
        # this for every /storage/ response.
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": cache_control(key, expires),
        },
    )


def cache_control(key: str, expires: int | None = None) -> str:
    """How long a browser may keep a stored file.

    A draft's rig JSON is mutable (manual fit adjustments rewrite rig.json
    in place); a cached copy would make saved adjustments invisible until
    expiry, so draft JSON is revalidated. A published snapshot's files are
    copies no edit writes again (every revision publishes to keys of its
    own, services.publishing), JSON included (its rig, the mouth photo's
    rig, the avatar's own motion), and their URL is the same for every page
    view within a window (LocalStorage signs them so): a browser keeps
    them for as long as their URL is valid (`expires`), so a visitor coming
    back downloads none of them again."""
    if key.endswith(".json") and not is_published(key):
        return "no-cache"
    if is_published(key) and expires is not None:
        return f"private, max-age={max(0, expires - int(time.time()))}"
    return "private, max-age=300"


# The most a signed PUT may carry, by the extension of the key it was signed
# for (the client cannot change that; it can change its Content-Type). The
# same ceilings the API applies to these files elsewhere: a GLB import and a
# photo upload.
_UPLOAD_LIMITS = {".glb": MAX_MODEL_BYTES}
_DEFAULT_UPLOAD_LIMIT = MAX_UPLOAD_BYTES


def upload_limit(key: str) -> int:
    """Bytes a PUT to `key` may carry."""
    suffix = key[key.rfind(".") :].lower() if "." in key.rsplit("/", 1)[-1] else ""
    return _UPLOAD_LIMITS.get(suffix, _DEFAULT_UPLOAD_LIMIT)


async def _read_body(request: Request, limit: int) -> bytes:
    """The request body, or 413 as soon as it passes `limit` bytes."""
    too_large = PayloadTooLarge413(
        f"Uploads here are limited to {limit // (1024 * 1024)} MB", code="upload_too_large"
    )
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise too_large
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > limit:
            raise too_large
        chunks.append(chunk)
    return b"".join(chunks)


@router.put("/{key:path}")
async def storage_put(
    key: str, request: Request, expires: int = Query(...), signature: str = Query(...)
) -> Response:
    """Store the body at a signed PUT URL's key. 401 `bad_signature`, 422
    `empty_upload`, 413 `upload_too_large` past `upload_limit(key)` (30 MB
    for a GLB, 15 MB for anything else)."""
    storage = _local()
    if not storage.verify("PUT", key, expires, signature):
        raise Auth401("Invalid or expired storage URL", code="bad_signature")
    body = await _read_body(request, upload_limit(key))
    if not body:
        raise Validation422("Empty body", code="empty_upload")
    content_type = request.headers.get("content-type", "application/octet-stream")
    await storage.put_bytes(key, body, content_type)
    return Response(status_code=200)
