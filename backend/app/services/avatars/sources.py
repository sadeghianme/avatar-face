"""New avatars from a file: a photo or GLB the client uploads straight to
storage, or a GLB imported from an allowed host by URL. The rig job
(services.rig.process_avatar) takes over once the file is there.
"""

from __future__ import annotations

from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Validation422
from app.models import Avatar, AvatarKind
from app.services.avatars.repo import create_with_source
from app.services.storage import get_storage

GLB_CONTENT_TYPE = "model/gltf-binary"
MAX_MODEL_BYTES = 30 * 1024 * 1024


async def create_for_upload(
    db: AsyncSession, org_id: str, user_id: str, name: str, content_type: str, face_type: str
) -> tuple[Avatar, str]:
    """A pending avatar for a photo or a GLB of `content_type`, and the
    presigned URL the client PUTs the file to."""
    settings = get_settings()
    is_model = content_type == GLB_CONTENT_TYPE
    if not is_model and content_type not in settings.allowed_image_types:
        raise Validation422(
            f"content_type must be one of {settings.allowed_image_types} or {GLB_CONTENT_TYPE}",
            code="unsupported_image_type",
        )
    ext = "glb" if is_model else content_type.split("/")[-1].replace("jpeg", "jpg")
    avatar, image_key = await create_with_source(
        db,
        ext,
        org_id=org_id,
        created_by_id=user_id,
        name=name,
        kind=AvatarKind.model3d if is_model else AvatarKind.photo,
        content_type=content_type,
        face_type=face_type,
    )
    upload_url = await get_storage().presign_put(image_key, content_type)
    return avatar, upload_url


async def import_model(
    db: AsyncSession, org_id: str, user_id: str, url: str, name: str | None
) -> Avatar:
    """A 3D avatar from a GLB at `url` (e.g. https://models.readyplayer.me/<id>.glb),
    downloaded and stored. Only https, only from MODEL_URL_HOSTS, at most
    30 MB; named after the file when `name` is empty."""
    allowed_hosts = {h.lower() for h in get_settings().model_url_hosts}
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").lower() not in allowed_hosts:
        raise Validation422(
            f"URL host must be one of {sorted(allowed_hosts)} (configurable via MODEL_URL_HOSTS)",
            code="model_host_not_allowed",
        )
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=False) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.content
    except httpx.HTTPError as exc:
        raise Validation422(
            f"Could not download model: {exc}", code="model_download_failed"
        ) from exc
    if len(data) > MAX_MODEL_BYTES:
        raise Validation422("Model exceeds 30MB", code="model_too_large")

    name = name or (parts.path.rsplit("/", 1)[-1].removesuffix(".glb") or "3D avatar")[:64]
    avatar, _ = await create_with_source(
        db,
        "glb",
        data,
        org_id=org_id,
        created_by_id=user_id,
        name=name,
        kind=AvatarKind.model3d,
        content_type=GLB_CONTENT_TYPE,
    )
    return avatar
