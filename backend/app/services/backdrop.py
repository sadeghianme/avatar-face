"""Cut a subject off a plain studio backdrop, for any kind of face.

The person segmenter (services.segment) is trained on people: on a muzzle,
whiskers or a drawn outline it cuts pieces off. The creation wizard asks the
image model for every picture it makes on a plain, flat, uniform backdrop
(services.wizard's prompts), and a plain backdrop does not need a model to
find it: it is the colour that runs all round the frame.

1. The backdrop colour is the median of a band along the image's edges, and
   its spread (a robust sigma, from the MAD) says how flat it really is
   (the top and side edges only: shoulders cross the bottom one). A
   backdrop that is not flat (a room, a gradient, a photo taken anywhere) is
   refused here: `None`, and the caller keeps the picture as it is. Cutting
   a real background by colour would eat the subject wherever it matches.
2. Pixels close to that colour (a distance in LAB, scaled to the spread) are
   backdrop candidates; only those CONNECTED to the frame's edge are
   backdrop. A grey shirt inside the silhouette is not the backdrop because
   its colour matches: it is enclosed by the subject.
3. The subject must be a plausible size, and must hold the middle of the
   frame, or the answer is refused (`None`): a backdrop that swallowed the
   subject or a subject that is all backdrop is not a cut-out.
4. The hard mask is refined into a real matte, and the backdrop colour
   un-mixed from the edge pixels, by the same guided filter the person
   segmenter's mask goes through (services.matting). Written through
   photo_io.png_bytes, which zeroes the colour under alpha 0.

Pure numpy and scipy; CPU work for the jobs thread.
"""

from __future__ import annotations

import io
import logging

import numpy as np
from PIL import Image

logger = logging.getLogger("liveface.backdrop")

# The band along the edges the backdrop colour is read from, as a fraction
# of the shorter side.
EDGE_BAND = 0.03
# How much of that band must be the backdrop colour for the backdrop to be
# plain: a subject may cross the bottom edge (shoulders), not the whole frame.
MIN_EDGE_BACKDROP = 0.55
# Distance (LAB, delta E) below which a pixel may be backdrop: this many
# robust sigmas of the band, never tighter than the floor (a render's flat
# grey has almost no spread) nor looser than the ceiling (a noisy photo
# must not take a whole skin tone with it).
SIGMAS = 4.0
MIN_DISTANCE = 6.0
MAX_DISTANCE = 22.0
# A spread above this is not a plain backdrop at all.
MAX_BACKDROP_SIGMA = 6.0
# The subject's share of the frame, and the middle it must hold.
MIN_SUBJECT = 0.06
MAX_SUBJECT = 0.95
CENTRE_BOX = 0.2
MIN_CENTRE_SUBJECT = 0.6


def _lab(rgb: np.ndarray) -> np.ndarray:
    from app.services.photo_adjust import rgb_to_lab

    return rgb_to_lab(rgb.astype(np.float64))


def _edge_band(height: int, width: int) -> np.ndarray:
    """The top, left and right edges. Not the bottom: a head-and-shoulders
    portrait's shoulders cross it, and a grey jacket there must not be
    taken for (or seed) the backdrop."""
    band = max(2, int(round(min(height, width) * EDGE_BAND)))
    mask = np.zeros((height, width), dtype=bool)
    mask[:band, :] = True
    mask[:, :band] = mask[:, -band:] = True
    return mask


def backdrop_mask(rgb: np.ndarray) -> np.ndarray | None:
    """HxW bool, True on the backdrop; None when there is no plain backdrop
    to cut, or cutting it would not leave a subject."""
    from scipy import ndimage

    height, width = rgb.shape[:2]
    lab = _lab(rgb)
    edge = _edge_band(height, width)
    samples = lab[edge]
    colour = np.median(samples, axis=0)
    distance = np.linalg.norm(lab - colour, axis=2)
    edge_distance = distance[edge]
    # Robust spread of the band, measured on its backdrop-like half only:
    # a subject crossing the bottom edge must not widen the threshold.
    near = edge_distance[edge_distance <= np.median(edge_distance)]
    sigma = 1.4826 * float(np.median(np.abs(near - np.median(near)))) + float(np.median(near))
    if sigma > MAX_BACKDROP_SIGMA:
        logger.info("backdrop not plain (sigma %.1f)", sigma)
        return None
    limit = float(np.clip(SIGMAS * max(sigma, 1.0), MIN_DISTANCE, MAX_DISTANCE))
    candidate = distance < limit
    if float(candidate[edge].mean()) < MIN_EDGE_BACKDROP:
        logger.info("backdrop does not run round the frame (%.2f)", float(candidate[edge].mean()))
        return None
    labels, _ = ndimage.label(candidate)
    touching = np.unique(labels[edge & candidate])
    touching = touching[touching != 0]
    backdrop = np.isin(labels, touching)
    # Specks of the subject that happen to be backdrop-coloured next to the
    # edge are taken back: the subject is closed over small gaps.
    # (Padded with the edge's own values: a closing treats the outside as
    # empty, and would eat the shoulders along the bottom edge.)
    pad = 3
    padded = np.pad(~backdrop, pad, mode="edge")
    subject = ndimage.binary_closing(padded, iterations=2)[pad:-pad, pad:-pad]
    subject = ndimage.binary_fill_holes(subject)
    share = float(subject.mean())
    if not MIN_SUBJECT <= share <= MAX_SUBJECT:
        logger.info("backdrop cut would leave %.2f of the frame", share)
        return None
    cy, cx = height // 2, width // 2
    dy, dx = int(height * CENTRE_BOX / 2), int(width * CENTRE_BOX / 2)
    if float(subject[cy - dy:cy + dy + 1, cx - dx:cx + dx + 1].mean()) < MIN_CENTRE_SUBJECT:
        logger.info("backdrop cut leaves the middle of the frame empty")
        return None
    return ~subject


def cut_backdrop(data: bytes) -> bytes | None:
    """A PNG of `data` with its plain backdrop made transparent, or None
    when it has no plain backdrop to cut (the caller keeps the picture)."""
    from app.services.matting import refine_matte
    from app.services.photo_io import png_bytes

    with Image.open(io.BytesIO(data)) as opened:
        rgb = np.asarray(opened.convert("RGB"))
    backdrop = backdrop_mask(rgb)
    if backdrop is None:
        return None
    from scipy import ndimage

    subject = ~backdrop
    alpha, colour = refine_matte(rgb, subject.astype(np.float32))
    # The filter softens only edges: well inside the silhouette (and along
    # the frame's own edge, where its window runs out) the subject is solid,
    # and well out in the backdrop there is nothing.
    reach = max(3, int(round(min(rgb.shape[:2]) * 0.01)))
    alpha = np.where(ndimage.binary_erosion(subject, iterations=reach, border_value=1), 1.0, alpha)
    alpha = np.where(ndimage.binary_erosion(backdrop, iterations=reach, border_value=1), 0.0, alpha)
    rgba = np.dstack([colour.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    return png_bytes(Image.fromarray(rgba, mode="RGBA"))
