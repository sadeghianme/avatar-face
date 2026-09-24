"""Validate and normalise a portrait or mouth-detail photo.

Shared by the avatar mouth-photo endpoint and the reference lab. Graduated
out of the lab router so that stable code never imports a lab module.
"""
from __future__ import annotations

import numpy as np

from app.core.errors import Validation422
from app.services.photo_io import ingest_photo
from app.services.rig import build_rig, landmarks_from_image
from app.services.riggable import check_landmarks

MAX_BYTES = 15 * 1024 * 1024


def prepare_photo(data: bytes, purpose: str) -> tuple[bytes, dict, str | None]:
    """Normalise the upload (see photo_io) and refuse synthetic detection."""
    photo = ingest_photo(data, max_edge=1600)
    points, blendshapes, size, detected = landmarks_from_image(photo)
    if not detected or len(points) != 478 or not np.isfinite(points).all():
        raise Validation422("No clear face detected. Use a front-facing portrait with the whole face visible.", code="reference_no_face")
    width = float(np.linalg.norm(points[291] - points[61]))
    gap = float(np.linalg.norm(points[14] - points[13])) / max(width, 1)
    if width < 30:
        raise Validation422("The face is too small. Crop closer to the head and shoulders.", code="reference_face_small")
    if purpose == "mouth" and gap < .08:
        raise Validation422("For mouth detail, use a photo saying 'ee', with the upper teeth clearly visible.", code="reference_mouth_closed")
    if purpose == "portrait" and gap > .04:
        raise Validation422("Start with a relaxed, closed-mouth portrait. Add the open-mouth photo as optional mouth detail afterwards.", code="reference_mouth_open")
    verdict = check_landmarks(points, size, detected)
    return photo, build_rig(points, size, blendshapes), verdict.reason if not verdict.ok else None
