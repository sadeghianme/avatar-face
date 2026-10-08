"""The standard teeth: the Reference's own teeth photo, which the
continuous mouth draws for every avatar without a teeth photo of its own
(embed/assets/mouth-teeth.webp and its rig, made by
scripts/build_standard_teeth.py, served beside /mouth-motion.json).

They are every such avatar's teeth, so they must be teeth the embed draws:
a pair its DentalOralSurface refused would put the drawn ones back in every
one of those mouths, and nothing would say so (the loader falls back to
them rather than fail the mouth).
"""

from __future__ import annotations

import io
import json

import numpy as np
import pytest
from PIL import Image

from app.services import dental_photo


def _assets():
    from scripts.build_standard_teeth import ASSETS, IMAGE_NAME, RIG_NAME

    return (ASSETS / IMAGE_NAME).read_bytes(), json.loads((ASSETS / RIG_NAME).read_text())


def test_the_embed_draws_the_standard_teeth():
    """The embed's own test on the committed pair (dental_photo, ported
    pass for pass): the Reference's teeth, with the central crown the
    Reference's photo is known for (0.115 of the mouth width)."""
    photo, rig = _assets()
    with Image.open(io.BytesIO(photo)) as image:
        assert image.format == "WEBP"
        assert list(image.size) == rig["image_size"]
        verdict = dental_photo.accept_teeth_photo(
            image, np.asarray(rig["points"]), rig["inner_lip_ring"]
        )
    assert verdict.accepted, verdict.as_dict()
    assert verdict.crown_coverage == pytest.approx(0.115, abs=0.003)


def test_they_are_what_the_script_builds_from_the_references_photo():
    """Their provenance is the script: the lab Reference's delivery photo
    and rig, admitted as every mouth photo is (cut to the lips, WebP, the
    teeth test). A hand edit, or a photo from elsewhere, would be teeth
    nobody can say the origin of."""
    from scripts.build_standard_teeth import REFERENCE, build

    photo, rig = _assets()
    built, built_rig = build(
        REFERENCE / "oral-detail-v3.webp", REFERENCE / "oral-detail-v3.rig.json"
    )
    assert rig == built_rig
    # Pixel for pixel as built here (the encoder of another Pillow may
    # write other bytes for the same pixels, within the WebP's own loss).
    with Image.open(io.BytesIO(photo)) as ours, Image.open(io.BytesIO(built)) as fresh:
        difference = np.abs(
            np.asarray(ours.convert("RGB"), dtype=np.int16)
            - np.asarray(fresh.convert("RGB"), dtype=np.int16)
        )
    assert difference.mean() < 1.0


def test_only_what_the_renderer_reads_is_downloaded():
    """Every visitor of every avatar without its own teeth downloads them:
    the photo cut to the lips (not the 1254 px portrait it comes from), and
    of the rig only what the embed's validateOralRig reads."""
    photo, rig = _assets()
    assert len(photo) < 40_000
    assert set(rig) == {"version", "image_size", "points", "inner_lip_ring", "outer_lip_ring"}
    assert len(rig["points"]) == 478
    width = float(np.linalg.norm(np.subtract(rig["points"][291], rig["points"][61])))
    # The lips and their margin: about two mouth widths across.
    assert rig["image_size"][0] < 2.2 * width
