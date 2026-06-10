"""Serves the local-filesystem storage fallback with presigned-URL semantics.

Only mounted when S3/R2 is NOT configured. GET/PUT both validate the HMAC
signature + expiry produced by LocalStorage.presign_*.
"""
from __future__ import annotations

import mimetypes

from fastapi import APIRouter, Query, Request, Response

from app.core.errors import Auth401, NotFound404, Validation422
from app.services.storage import LocalStorage, get_storage

router = APIRouter(prefix="/storage", tags=["storage"])


def _local() -> LocalStorage:
    storage = get_storage()
    if not isinstance(storage, LocalStorage):
        raise NotFound404("Local storage is not enabled", code="not_found")
    return storage


@router.get("/{key:path}")
async def storage_get(
    key: str, expires: int = Query(...), signature: str = Query(...)
) -> Response:
    storage = _local()
    if not storage.verify("GET", key, expires, signature):
        raise Auth401("Invalid or expired storage URL", code="bad_signature")
    if not await storage.exists(key):
        raise NotFound404("Object not found", code="object_not_found")
    data = await storage.get_bytes(key)
    media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        # Third-party embed pages fetch textures/audio cross-origin.
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "private, max-age=300"},
    )


@router.put("/{key:path}")
async def storage_put(
    key: str, request: Request, expires: int = Query(...), signature: str = Query(...)
) -> Response:
    storage = _local()
    if not storage.verify("PUT", key, expires, signature):
        raise Auth401("Invalid or expired storage URL", code="bad_signature")
    body = await request.body()
    if not body:
        raise Validation422("Empty body", code="empty_upload")
    content_type = request.headers.get("content-type", "application/octet-stream")
    await storage.put_bytes(key, body, content_type)
    return Response(status_code=200)
