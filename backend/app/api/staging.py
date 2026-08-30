"""A photo you are still working on, before it becomes an avatar.

Uploading used to create the avatar and start rigging immediately, which put
the editing tools on the far side of the thing they were meant to prepare:
you could only crop or cut out the background after the rig had already been
built from the uncropped original.

So the photo lands here first. Nothing exists in the avatar list until Save,
so abandoning a half-edited upload leaves no half-made avatar behind.

Every operation returns a NEW key rather than overwriting the old one, which
makes undo free: the client keeps the keys it has seen and steps back through
them. No history table, and no way for an edit to destroy the thing it was
applied to.

These live under the same `candidates/` prefix as generated images, because
they are the same thing — a picture that is not yet an avatar — and
`from-candidate` already knows how to turn one into the real article.
"""

from __future__ import annotations

import io
import logging
from uuid import uuid4

from fastapi import APIRouter, UploadFile
from pydantic import BaseModel, Field

from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import Conflict409, Validation422
from app.services.storage import get_storage

logger = logging.getLogger("liveface.staging")
router = APIRouter(prefix="/orgs/{org_id}/staging", tags=["staging"])

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
# Matches the avatar crop endpoint: below this there is not enough face left.
MIN_CROP_FRACTION = 0.15


class StagedImage(BaseModel):
    key: str
    url: str
    width: int
    height: int


def _prefix(org_id: str) -> str:
    return f"orgs/{org_id}/candidates/"


def _check_key(org_id: str, key: str) -> None:
    """The key comes from the client, so it is confined to this org's own
    staging area — otherwise it would address any object in storage."""
    if not key.startswith(_prefix(org_id)) or ".." in key:
        raise Validation422("Unknown image", code="unknown_staged_image")


async def _store(org_id: str, data: bytes) -> StagedImage:
    from PIL import Image

    storage = get_storage()
    key = f"{_prefix(org_id)}{uuid4().hex}.png"
    await storage.put_bytes(key, data, "image/png")
    with Image.open(io.BytesIO(data)) as image:
        width, height = image.size
    return StagedImage(key=key, url=await storage.presign_get(key), width=width, height=height)


@router.post("", response_model=StagedImage, status_code=201)
async def upload_staged(file: UploadFile, ctx: OrgMember) -> StagedImage:
    """Take a photo without committing to anything."""
    settings = get_settings()
    if file.content_type not in settings.allowed_image_types:
        raise Validation422(
            f"content_type must be one of {settings.allowed_image_types}",
            code="unsupported_image_type",
        )
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise Validation422("Image is too large", code="image_too_large")

    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
    except Exception:
        raise Validation422("That file is not a readable image", code="unreadable_image")

    # Normalised to PNG on the way in so every later step has one format to
    # deal with, and so alpha survives if it was there.
    with Image.open(io.BytesIO(data)) as image:
        buffer = io.BytesIO()
        image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB").save(
            buffer, format="PNG", optimize=True
        )
    return await _store(ctx.org.id, buffer.getvalue())


class StagedCrop(BaseModel):
    key: str
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(gt=0.0, le=1.0)
    height: float = Field(gt=0.0, le=1.0)


@router.post("/crop", response_model=StagedImage)
async def crop_staged(body: StagedCrop, ctx: OrgMember) -> StagedImage:
    _check_key(ctx.org.id, body.key)
    if body.x + body.width > 1.0 or body.y + body.height > 1.0:
        raise Validation422("Crop falls outside the image", code="crop_out_of_bounds")
    if body.width < MIN_CROP_FRACTION or body.height < MIN_CROP_FRACTION:
        raise Validation422(
            f"Crop must keep at least {int(MIN_CROP_FRACTION * 100)}% of each side",
            code="crop_too_small",
        )

    from PIL import Image

    storage = get_storage()
    source = Image.open(io.BytesIO(await storage.get_bytes(body.key)))
    has_alpha = source.mode in ("RGBA", "LA") or "transparency" in source.info
    source = source.convert("RGBA" if has_alpha else "RGB")
    w, h = source.size
    cropped = source.crop(
        (
            int(round(body.x * w)),
            int(round(body.y * h)),
            int(round((body.x + body.width) * w)),
            int(round((body.y + body.height) * h)),
        )
    )
    buffer = io.BytesIO()
    cropped.save(buffer, format="PNG", optimize=True)
    return await _store(ctx.org.id, buffer.getvalue())


class StagedKey(BaseModel):
    key: str


@router.post("/remove-background", response_model=StagedImage)
async def remove_background_staged(body: StagedKey, ctx: OrgMember) -> StagedImage:
    from app.services.segment import SegmentationUnavailable, remove_background

    _check_key(ctx.org.id, body.key)
    storage = get_storage()
    try:
        cut_out = remove_background(await storage.get_bytes(body.key))
    except SegmentationUnavailable as exc:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        ) from exc
    return await _store(ctx.org.id, cut_out)


class StagedGenerate(BaseModel):
    """Restyle a staged photo. Omit `key` to invent a face from nothing."""

    key: str | None = None
    style: str = "photoreal"
    count: int = Field(default=2, ge=1, le=4)
    note: str = Field(default="", max_length=300)


@router.post("/generate")
async def generate_staged(body: StagedGenerate, ctx: OrgMember, db: DB) -> dict:
    """Same loop as the avatar-level endpoint: generate, then keep only what
    the rig can use, and report what was discarded and why."""
    from app.services.imagegen import (
        STYLES,
        ImageGenUnavailable,
        configured_backends,
        generate_with,
    )
    from app.services.riggable import check_image, salvage_portrait
    from app.services.usage import check_image_limit, record_generation

    if body.style not in STYLES:
        raise Validation422(f"style must be one of {sorted(STYLES)}", code="unknown_style")

    backends = configured_backends()
    if not backends:
        raise Conflict409(
            "Image generation is not configured on this server",
            code="imagegen_unavailable",
        )

    storage = get_storage()
    source = None
    if body.key:
        _check_key(ctx.org.id, body.key)
        source = await storage.get_bytes(body.key)

    # One image per configured backend, not N rolls of the same die: with
    # Gemini, OpenAI and Qwen keyed, one style choice returns one take from
    # each, and the user compares models instead of variance.
    accepted: list[dict] = []
    rejected: list[str] = []
    attempts = 0
    for backend in backends:
        if len(accepted) >= body.count:
            break
        await check_image_limit(db, ctx.org.id)
        attempts += 1
        try:
            result = await generate_with(backend, body.style, source, extra=body.note)
            await record_generation(db, ctx.org.id, backend)
        except ImageGenUnavailable:
            continue
        except Exception as exc:
            logger.exception("staged generation failed (%s)", backend)
            rejected.append(f"{backend}: {str(exc)[:110]}")
            continue

        image = result.image
        verdict = check_image(image)
        if not verdict.ok:
            # A face the checker could measure is a face the crop can fix.
            # Six paid generations were once discarded in a row for "face too
            # small" — for framing the model was explicitly asked for.
            salvaged = salvage_portrait(image)
            if salvaged is not None:
                verdict = check_image(salvaged)
                if verdict.ok:
                    image = salvaged
        if not verdict.ok:
            rejected.append(f"{backend}: {verdict.summary}")
            continue
        staged = await _store(ctx.org.id, image)
        entry = staged.model_dump()
        entry["provider"] = backend
        accepted.append(entry)

    return {"candidates": accepted, "rejected": rejected, "attempts": attempts}
