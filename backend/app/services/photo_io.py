"""Photos in, images out: the two places pixels cross our storage boundary.

**In.** A phone photo carries more than its pixels: EXIF with the GPS
position it was taken at, the camera serial, an XMP editing history, and an
orientation flag that viewers honour and a raw decode does not (which is how
a portrait ends up rigged lying on its side). Every stored upload therefore
goes through `ingest_photo`: turned upright, rebuilt from its pixels alone,
and re-encoded, so none of that survives into storage or reaches a visitor.
The size check reads the header before anything is decoded — a 100-megapixel
PNG is a few MB on the wire and several GB once decompressed.

**Out.** A PNG pixel with alpha 0 is invisible, but its RGB is still in the
file. After a background removal those invisible pixels ARE the removed
background — the room, the people behind — and anyone who drops the alpha
channel gets it back. `png_bytes` zeroes RGB under alpha 0 for every
transparent PNG we write, so a cut-out holds nothing but the cut-out.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageOps

from app.core.errors import Validation422

# Header-checked before decode: a guard against decompression bombs, not a
# photo-size policy. It sits above every camera a customer is likely to hold
# (a "24 MP" iPhone photo is 5712x4284, just over 24.4 million pixels, and
# 50 and 64 MP phone modes exist); large photos are scaled down, not refused.
MAX_PIXELS = 100_000_000

# The long edge of a stored upload. Far more than a widget ever draws, and it
# bounds every later step (crop, matting, thumbnails) and every visitor's
# download, whatever the phone produced.
STORED_MAX_EDGE = 2048


def has_alpha(image: Image.Image) -> bool:
    return image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info


def scrub_transparent(image: Image.Image) -> Image.Image:
    """RGBA copy of `image` with RGB set to 0 wherever alpha is 0."""
    rgba = np.array(image.convert("RGBA"))
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba, mode="RGBA")


def png_bytes(image: Image.Image) -> bytes:
    """Encode an image we are about to store as PNG.

    Transparent images are scrubbed first (see the module docstring); opaque
    ones are written as they are. Metadata is never carried over — Pillow
    writes EXIF to a PNG only when asked to, and nothing here asks.
    """
    icc = image.info.get("icc_profile")
    target = scrub_transparent(image) if has_alpha(image) else image
    out = io.BytesIO()
    target.save(out, format="PNG", optimize=True, **({"icc_profile": icc} if icc else {}))
    return out.getvalue()


def ingest_photo(data: bytes, max_edge: int | None = None) -> bytes:
    """An uploaded photo as a clean, upright PNG.

    Raises Validation422 for an image over MAX_PIXELS (judged from the header,
    before decoding) or one that cannot be read at all. `max_edge`, when set,
    also bounds the long side.
    """
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > MAX_PIXELS:
                raise Validation422(
                    "Use a photo smaller than 100 megapixels", code="image_too_large"
                )
            if max_edge:
                # A JPEG decodes directly at 1/2, 1/4 or 1/8 scale, never
                # below the size asked for, so a big phone photo bound for
                # max_edge never has its full-size pixels in memory.
                source.draft(None, (max_edge, max_edge))
            upright = ImageOps.exif_transpose(source)
            icc = source.info.get("icc_profile")
            upright = upright.convert("RGBA" if has_alpha(upright) else "RGB")
            if max_edge:
                upright.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            # Rebuilt from raw pixels so no metadata can ride along. The ICC
            # profile is the one exception: it is colour, not information
            # about the person, and dropping it would shift how a wide-gamut
            # phone photo renders.
            clean = Image.frombytes(upright.mode, upright.size, upright.tobytes())
            if icc:
                clean.info["icc_profile"] = icc
            return png_bytes(clean)
    except Validation422:
        raise
    except Exception as exc:
        raise Validation422("That file is not a readable photo", code="unreadable_image") from exc
