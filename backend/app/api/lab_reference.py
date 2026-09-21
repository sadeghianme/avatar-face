"""Private, temporary reference previews. Never create or publish an avatar."""
from __future__ import annotations

import io
import json
from typing import Literal
from uuid import uuid4

import numpy as np
from fastapi import APIRouter, UploadFile
from PIL import Image, ImageOps
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.api.deps import OrgMember
from app.core.config import get_settings
from app.core.errors import Validation422
from app.services.rig import build_rig, landmarks_from_image
from app.services.riggable import check_landmarks
from app.services.storage import get_storage

router = APIRouter(prefix="/orgs/{org_id}/lab/reference", tags=["reference-lab"])
MAX_BYTES = 15 * 1024 * 1024
MAX_PIXELS = 24_000_000


class ReferencePreview(BaseModel):
    id: str
    image_url: str
    rig_url: str
    quality_note: str | None
    retention_hours: int


def prepare_photo(data: bytes, purpose: str) -> tuple[bytes, dict, str | None]:
    """Keep EXIF orientation, bound decoding, and refuse synthetic detection."""
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > MAX_PIXELS:
                raise Validation422("Use a photo smaller than 24 megapixels", code="image_too_large")
            image = ImageOps.exif_transpose(source)
            image = image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB")
            image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            normalized = io.BytesIO()
            image.save(normalized, format="PNG", optimize=True)
    except Validation422:
        raise
    except Exception as exc:
        raise Validation422("That file is not a readable photo", code="unreadable_image") from exc
    photo = normalized.getvalue()
    points, blendshapes, size, detected = landmarks_from_image(photo)
    if not detected or len(points) != 478 or not np.isfinite(points).all():
        raise Validation422("No clear face detected. Use a front-facing portrait with the whole face visible.", code="reference_no_face")
    width = float(np.linalg.norm(points[291] - points[61]))
    gap = float(np.linalg.norm(points[14] - points[13])) / max(width, 1)
    if width < 30:
        raise Validation422("The face is too small. Crop closer to the head and shoulders.", code="reference_face_small")
    if purpose == "mouth" and gap < .08:
        raise Validation422("For mouth detail, use a photo saying 'ah', with the upper teeth visible.", code="reference_mouth_closed")
    if purpose == "portrait" and gap > .04:
        raise Validation422("Start with a relaxed, closed-mouth portrait. Add the open-mouth photo as optional mouth detail afterwards.", code="reference_mouth_open")
    verdict = check_landmarks(points, size, detected)
    return photo, build_rig(points, size, blendshapes), verdict.reason if not verdict.ok else None


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
