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
import math

import numpy as np
from PIL import Image, ImageOps

from app.core.errors import Validation422
from app.models.shapes import CropRect

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


# The flat backdrop a cut-out is shown on whenever it must be opaque: to an
# image model, to the face detector, to the photo check. Neutral grey,
# because black reads as a dark room and white as an overexposed one (a
# model relights the face to match either), and because RGB under alpha 0
# is already zero (see `png_bytes`): dropping the alpha would show black.
NEUTRAL_BACKDROP = (128, 128, 128)


def on_backdrop(image: Image.Image, colour: tuple[int, int, int] = NEUTRAL_BACKDROP) -> Image.Image:
    """`image` as opaque RGB: a transparent image composited onto `colour`
    (never its removed background, which is not in the file), an opaque
    one converted as it is."""
    if not has_alpha(image):
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    flat = Image.new("RGB", rgba.size, colour)
    flat.paste(rgba, mask=rgba.getchannel("A"))
    return flat


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


def probe_photo(data: bytes) -> tuple[int, int]:
    """(width, height) of an upload, read from its header alone.

    For refusing a file at request time without paying for a decode: the
    same two refusals as `ingest_photo`, in milliseconds, so a request that
    cannot succeed never queues a job. Raises Validation422.
    """
    try:
        with Image.open(io.BytesIO(data)) as source:
            size = source.size
    except Exception as exc:
        # Broad on purpose: Pillow raises many types on untrusted bytes, and
        # every one of them means the file is not a readable photo.
        raise Validation422("That file is not a readable photo", code="unreadable_image") from exc
    if size[0] * size[1] > MAX_PIXELS:
        raise Validation422("Use a photo smaller than 100 megapixels", code="image_too_large")
    return size


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
        # Broad on purpose: Pillow raises many types on untrusted bytes.
        raise Validation422("That file is not a readable photo", code="unreadable_image") from exc


def frame_photo(data: bytes, crop: CropRect, roll: float = 0.0) -> Image.Image:
    """The crop of a stored photo, levelled by `roll` degrees.

    `crop` is {x, y, w, h} in fractions of the photo. `roll` is the tilt to
    remove (photo_analysis.eye_line_roll): the output's horizontal runs along
    a line that slopes by `roll` in the photo, turned about the crop's centre
    — the way a crop tool with a straighten slider behaves, where the frame
    stays put and the picture turns under it.

    Where a turned frame reaches past the photo's edge, an opaque photo is
    extended with its own edge pixels (a black or transparent wedge in the
    corner would be a new edge for the rig to tear on); a transparent one
    stays transparent there, which is what its edge already is.
    """
    with Image.open(io.BytesIO(data)) as source:
        transparent = has_alpha(source)
        image = source.convert("RGBA" if transparent else "RGB")
    width, height = image.size
    left, top = crop["x"] * width, crop["y"] * height
    out_w = max(1, int(round(crop["w"] * width)))
    out_h = max(1, int(round(crop["h"] * height)))

    if not roll:
        return image.crop((int(round(left)), int(round(top)), int(round(left)) + out_w,
                           int(round(top)) + out_h))

    theta = math.radians(roll)
    cos, sin = math.cos(theta), math.sin(theta)
    cx, cy = left + crop["w"] * width / 2, top + crop["h"] * height / 2
    # Output (u, v) samples the photo at centre + R(roll) · (u - out_w/2, v - out_h/2).
    a, b, d, e = cos, -sin, sin, cos
    c = cx - a * out_w / 2 - b * out_h / 2
    f = cy - d * out_w / 2 - e * out_h / 2

    fill: tuple[int, ...] | None = (0, 0, 0, 0) if transparent else None
    if not transparent:
        corners = [(a * u + b * v + c, d * u + e * v + f) for u in (0, out_w) for v in (0, out_h)]
        xs, ys = [p[0] for p in corners], [p[1] for p in corners]
        pad_l = max(0, math.ceil(-min(xs)) + 2)
        pad_t = max(0, math.ceil(-min(ys)) + 2)
        pad_r = max(0, math.ceil(max(xs) - width) + 2)
        pad_b = max(0, math.ceil(max(ys) - height) + 2)
        if pad_l or pad_t or pad_r or pad_b:
            pads = ((pad_t, pad_b), (pad_l, pad_r), (0, 0))
            padded = np.pad(np.asarray(image), pads, mode="edge")
            image = Image.fromarray(padded, mode="RGB")
            c, f = c + pad_l, f + pad_t
    return image.transform(
        (out_w, out_h),
        Image.Transform.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC,
        fillcolor=fill,
    )
