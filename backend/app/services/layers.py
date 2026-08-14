"""Decompose a portrait into background / body / head layers.

This is the architecture hand-rigged avatar systems (SitePal and kin) are
built on: separate art for what is BEHIND the subject, so the head can move
without tearing the picture. An artist draws those layers; here they are cut
from the one photo the user gave us.

Three decisions carry the whole module:

1. The head/body split is geometric — a horizontal fade at the neck, taken
   from the face landmarks — not semantic. A hair-class model would assign a
   long braid on a shoulder to the "head", and the braid would then swing
   rigidly with every head turn, which looks far worse than it staying with
   the body.

2. The layers OVERLAP. The body owns every person pixel below the fade's
   start at full alpha, and the head is drawn over it. At rest the composite
   is exactly the original photo; when the head moves away, what shows is the
   body's own real pixels (collar, neck), not a guess.

3. The background behind the person is filled by normalised convolution —
   the same local-backdrop estimator the matting uses, no AI. Its fill is a
   blurry smear, which is fine: at the motion amplitudes the engine uses it
   is only ever revealed a few pixels at a time along the silhouette. Photos
   whose background was already removed skip the fill; their background
   layer is simply transparent.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger("liveface.layers")

LAYER_FILES = ("background", "body", "head")

# The head fade spans neck_y ± this fraction of face height. Wide enough that
# the seam never lands as a hard line across a chin or collar.
FADE_HALF_LIFE = 0.12
# Where the neck line sits below the face box's bottom.
NECK_DROP = 0.15
# Backdrop fill radius, as a fraction of the short image side.
FILL_RADIUS_FRACTION = 0.10


def build_layers(image_bytes: bytes, face_box: list[float]) -> dict[str, bytes]:
    """Return {"background": jpeg|png, "body": png, "head": png}, full-frame.

    All three are the same size as the input and aligned to its pixels, so a
    renderer places them with the exact transform it uses for the photo.
    Raises on any failure — the caller treats layers as strictly optional.
    """
    import numpy as np
    from PIL import Image

    from app.services.segment import person_matte

    source = Image.open(io.BytesIO(image_bytes))
    had_alpha = source.mode in ("RGBA", "LA", "PA")

    # The mask used to decide which pixels to REPAINT, kept separate from the
    # one used to cut the layers. They must differ: the layer mask is padded
    # with a landmark ellipse so an illustrated face never comes out with
    # holes, but repainting everything under that ellipse overwrites real
    # background with fill and leaves a visible elliptical seam around the
    # head — which is exactly what showed up on a photo with a lit ceiling
    # behind it. Only pixels the SEGMENTER calls person get repainted.
    fill_alpha = None

    if had_alpha:
        rgba = np.asarray(source.convert("RGBA")).astype(np.float32)
        rgb, alpha = rgba[:, :, :3], rgba[:, :, 3] / 255.0
    else:
        # The segmenter is trained on photographs and misfires on
        # illustrations — on flat art it can call half the face
        # "background", punching holes in the head layer, seeding the
        # backdrop fill with skin colours, and (worst) running the face
        # through edge un-mixing, which leaves literal black. The face
        # landmarks are the reliable detector, so the head region they
        # imply — an ellipse over the face box, generous upward for hair —
        # goes into the matte as a confident prior BEFORE refinement.
        width, height = source.size
        fx0, fy0, fx1, fy1 = face_box[:4]
        fcx, fw = (fx0 + fx1) / 2, max(fx1 - fx0, 8.0)
        fh = max(fy1 - fy0, 8.0)
        fcy = (fy0 + fy1) / 2 - fh * 0.2  # centre raised toward the skull
        ax, ay = fw * 0.8, fh * 1.1
        yy, xx = np.mgrid[0:height, 0:width]
        prior = (((xx - fcx) / ax) ** 2 + ((yy - fcy) / ay) ** 2 <= 1.0).astype(np.float32)
        rgb, alpha = person_matte(image_bytes, prior_mask=prior)
        _, fill_alpha = person_matte(image_bytes)  # no prior: the true silhouette

    height, width = alpha.shape
    _, fy0, _, fy1 = face_box[0], face_box[1], face_box[2], face_box[3]
    face_h = max(fy1 - fy0, 8.0)
    neck_y = fy1 + face_h * NECK_DROP
    fade = face_h * FADE_HALF_LIFE

    # Vertical head weight: 1 above the fade, 0 below it, smooth between.
    ys = np.arange(height, dtype=np.float32)
    t = np.clip((neck_y + fade - ys) / (2 * fade), 0.0, 1.0)
    head_w = (t * t * (3 - 2 * t))[:, None]  # smoothstep, as a column

    head_alpha = alpha * head_w
    # Overlap on purpose (decision 2): below the fade start the body owns the
    # full person alpha, underneath wherever the head still covers it.
    body_alpha = alpha * (1.0 - head_w) + np.where(ys[:, None] > neck_y - fade, alpha, 0.0) * head_w
    body_alpha = np.clip(body_alpha, 0.0, alpha)

    def png(colour, layer_alpha) -> bytes:
        out = np.dstack([colour.astype(np.uint8), (layer_alpha * 255).astype(np.uint8)])
        buf = io.BytesIO()
        Image.fromarray(out, mode="RGBA").save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    layers = {"body": png(rgb, body_alpha), "head": png(rgb, head_alpha)}

    # A cut-out has nothing behind it — no background layer at all, and the
    # renderer treats its absence as "transparent", same as today. Only an
    # opaque photo gets a fill.
    if not had_alpha:
        repaint = fill_alpha if fill_alpha is not None else alpha
        fill = _diffuse_fill(rgb.astype(np.float32), repaint)
        # Crossfade rather than switch: a hard boundary between filled and
        # original pixels is visible even when the colours nearly match,
        # because the fill is smooth and the photo has grain.
        blend = np.clip(repaint * 1.6, 0.0, 1.0)[:, :, None]
        background = (fill * blend + rgb * (1.0 - blend)).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(background, mode="RGB").save(buf, format="JPEG", quality=88)
        layers["background"] = buf.getvalue()

    return layers


def _diffuse_fill(rgb, alpha):
    """Fill the person region by diffusing the surrounding backdrop inward.

    Multi-scale normalised convolution: each pass averages only already-known
    pixels over a doubling radius, so colour propagates from the silhouette
    edge toward the middle — the area behind a head ends up wall-coloured,
    not the global-average grey a single wide pass degrades to (which read
    as a dark smudge whenever the head moved).
    """
    import numpy as np

    from app.services.matting import _box_mean

    height, width = alpha.shape
    known = (alpha < 0.02).astype(np.float32)
    filled = rgb.copy()
    radius = max(4, int(min(height, width) * 0.02))
    while known.min() < 1.0 and radius < 2 * max(height, width):
        num = _box_mean(filled * known[:, :, None], radius)
        den = _box_mean(known, radius)[:, :, None]
        have = den[:, :, 0] > 1e-4
        new = (known < 1.0) & have
        if new.any():
            filled[new] = (num / np.maximum(den, 1e-6))[new]
            known[new] = 1.0
        radius *= 2
    return filled


def layer_key(org_id: str, avatar_id: str, name: str) -> str:
    ext = "jpg" if name == "background" else "png"
    return f"orgs/{org_id}/avatars/{avatar_id}/layers/{name}.{ext}"


async def store_layers(avatar, storage, image_bytes: bytes, face_box: list[float]) -> bool:
    """Build and upload the layer set; True on success.

    Failures are logged and swallowed: layers are an enhancement, and every
    caller must be correct without them (no segmenter model, seg failure,
    weird geometry). has_layers is the caller's to set from the result.
    """
    try:
        built = build_layers(image_bytes, face_box)
    except Exception:
        logger.exception("layer build failed for avatar %s", avatar.id)
        return False
    for name, data in built.items():
        content_type = "image/jpeg" if built[name][:3] == b"\xff\xd8\xff" else "image/png"
        await storage.put_bytes(layer_key(avatar.org_id, avatar.id, name), data, content_type)
    return True
