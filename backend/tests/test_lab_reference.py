"""Temporary previews must not create customer avatars or accept bad faces."""
from __future__ import annotations

import io
import json
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import pytest
from PIL import Image

from app.api import lab_reference
from app.services import portrait_photo
from app.core.errors import Validation422
from conftest import create_org, register_and_login, sample_png

RIG_PATH = Path(__file__).resolve().parents[2] / "frontend/public/lab/reference/rig.json"


def mock_detection(monkeypatch, *, detected=True, gap=None):
    rig = json.loads(RIG_PATH.read_text())
    points = np.array(rig["points"], dtype=float)
    if gap is not None:
        width = np.linalg.norm(points[291] - points[61])
        points[14] = points[13] + [0, width * gap]
    monkeypatch.setattr(portrait_photo, "landmarks_from_image", lambda _: (points, {}, tuple(rig["image_size"]), detected))


@pytest.mark.asyncio
async def test_preview_private_signed_temporary_and_not_published(client, monkeypatch):
    mock_detection(monkeypatch)
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    route = f"/orgs/{org}/lab/reference/preview"
    files = {"file": ("portrait.png", sample_png(), "image/png")}
    assert (await client.post(route, files=files)).status_code == 401
    other = await register_and_login(client, "bob")
    assert (await client.post(route, headers=other, files=files)).status_code == 404
    response = await client.post(route, headers=headers, files=files)
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["retention_hours"] == 24
    assert f"orgs/{org}/candidates/reference-" in result["image_url"]
    assert (await client.get(result["image_url"])).status_code == 200
    unsigned = urlsplit(result["image_url"]).path
    assert (await client.get(unsigned)).status_code == 422
    assert (await client.get(unsigned + "?expires=1999999999&signature=wrong")).status_code == 401
    rig = await client.get(result["rig_url"])
    assert rig.status_code == 200
    assert len(rig.json()["points"]) == 478
    avatars = await client.get(f"/orgs/{org}/avatars", headers=headers)
    assert avatars.json() == []


@pytest.mark.asyncio
async def test_upload_validation_and_size_bound(client, monkeypatch):
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    route = f"/orgs/{org}/lab/reference/preview"
    for content, mime, code in [(b"bad", "text/plain", "unsupported_image_type"), (b"bad", "image/png", "unreadable_image")]:
        result = await client.post(route, headers=headers, files={"file": ("photo", content, mime)})
        assert result.status_code == 422
        assert result.json()["code"] == code
    monkeypatch.setattr(lab_reference, "MAX_BYTES", 4)
    result = await client.post(route, headers=headers, files={"file": ("photo.png", sample_png(), "image/png")})
    assert result.json()["code"] == "image_too_large"


def test_refuses_synthetic_face_and_open_neutral(monkeypatch):
    mock_detection(monkeypatch, detected=False)
    with pytest.raises(Validation422, match="No clear face"):
        lab_reference.prepare_photo(sample_png(), "portrait")
    mock_detection(monkeypatch, gap=.2)
    with pytest.raises(Validation422, match="closed-mouth"):
        lab_reference.prepare_photo(sample_png(), "portrait")
    assert len(lab_reference.prepare_photo(sample_png(), "mouth")[1]["points"]) == 478
    mock_detection(monkeypatch, gap=.005)
    with pytest.raises(Validation422, match="upper teeth"):
        lab_reference.prepare_photo(sample_png(), "mouth")


def test_normalizes_exif_and_rejects_large_decode(monkeypatch):
    mock_detection(monkeypatch)
    image = Image.new("RGB", (200, 300), "#d9b690")
    exif = image.getexif()
    exif[274] = 6
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif)
    photo, _, _ = lab_reference.prepare_photo(out.getvalue(), "portrait")
    assert Image.open(io.BytesIO(photo)).size == (300, 200)
    monkeypatch.setattr(portrait_photo, "MAX_PIXELS", 10)
    with pytest.raises(Validation422, match="megapixels"):
        lab_reference.prepare_photo(sample_png(), "portrait")
