"""Private, temporary reference previews. Never create or publish an avatar."""
from __future__ import annotations

import json
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.api.deps import OrgMember
from app.core.config import get_settings
from app.core.errors import Validation422
from app.services.portrait_photo import (  # noqa: F401 (re-exported for tests)
    MAX_BYTES,
    prepare_photo,
)
from app.services.storage import get_storage

router = APIRouter(prefix="/orgs/{org_id}/lab/reference", tags=["reference-lab"])


class ReferencePreview(BaseModel):
    id: str
    image_url: str
    rig_url: str
    quality_note: str | None
    retention_hours: int


@router.post("/preview", response_model=ReferencePreview, status_code=201)
async def upload_reference(file: UploadFile, ctx: OrgMember, purpose: Literal["portrait", "mouth"] = "portrait") -> ReferencePreview:
    settings = get_settings()
    if file.content_type not in settings.allowed_image_types:
        raise Validation422("Choose a JPEG, PNG or WebP photo", code="unsupported_image_type")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Validation422("Photo must be 15 MB or smaller", code="image_too_large")
    photo, rig, note = await run_in_threadpool(prepare_photo, data, purpose)
    storage = get_storage()
    preview_id = uuid4().hex
    # Reuse the existing signed storage and candidate-retention sweeper. The
    # original avatar namespace and all published records remain untouched.
    prefix = f"orgs/{ctx.org.id}/candidates/reference-{preview_id}"
    await storage.put_bytes(f"{prefix}.png", photo, "image/png")
    await storage.put_bytes(f"{prefix}.json", json.dumps(rig).encode(), "application/json")
    return ReferencePreview(id=preview_id, image_url=await storage.presign_get(f"{prefix}.png"),
                            rig_url=await storage.presign_get(f"{prefix}.json"), quality_note=note,
                            retention_hours=settings.candidate_retention_hours)
