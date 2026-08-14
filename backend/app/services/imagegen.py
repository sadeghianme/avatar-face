"""Avatar image generation, via Gemini.

Image-to-image by default: the user uploads a photo and gets a stylised
version of themselves. From-scratch works too, with no source image.

The prompt is not decoration. Every constraint in RIG_REQUIREMENTS below maps
to a specific way an avatar breaks — a turned head cannot be turned back, a
face at the edge tears when the mouth opens, a small face has too few pixels
for teeth. Asking for them up front is far cheaper than generating, checking,
and retrying, though the checking still happens: see services.riggable.

Gemini rather than the alternatives for the default path because it holds a
likeness through an edit better than the others, which is the whole job when
someone uploads their own face. It is called over plain HTTP; the SDK adds a
dependency for one POST.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass

import httpx

logger = logging.getLogger("liveface.imagegen")

# The source is billed as input tokens, and a portrait carries no useful
# detail past this for the model's purposes — it is redrawing a face, not
# retouching one. A 1254px PNG source costs roughly ten times what this does
# and produces the same result.
SOURCE_MAX_EDGE = 1024
SOURCE_QUALITY = 88

MODEL = "gemini-2.5-flash-image"
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
TIMEOUT_SECONDS = 90

# Everything the rig needs, stated to the model. Each line is a failure we
# have actually shipped: see services.riggable for the matching check.
RIG_REQUIREMENTS = (
    "The result must be a head-and-shoulders portrait facing the camera directly. "
    "Both eyes fully visible and unobstructed. Mouth closed, neutral expression. "
    "The whole head including hair must be inside the frame with clear space around it. "
    "The face should fill roughly half the width of the image. "
    "Plain, evenly lit, uncluttered background. No text, no watermark, no hands, "
    "no objects in front of the face, no extreme camera angle, no tilted head."
)

# Style first, and committed. An earlier version described each style in a
# single mild clause and asked hard for identity preservation; measured on a
# real portrait, the three stylised outputs differed from each other by only
# 10-17 (mean abs, 0-255) while each differed from the source by ~40. In other
# words every style produced the same thing: a lightly polished photograph.
# The instruction has to say what the picture IS, not merely tint it.
STYLES: dict[str, str] = {
    "photoreal": (
        "a polished professional photographic headshot, soft studio lighting, "
        "shallow depth of field, natural skin texture"
    ),
    "illustrated": (
        "a flat vector illustration: bold clean outlines, large areas of flat "
        "colour, simplified shading with no gradients or photographic texture. "
        "It should read as a drawing, not a photograph"
    ),
    "anime": (
        "an anime illustration: cel shading with hard-edged shadow shapes, "
        "large stylised eyes with visible highlights, simplified nose and mouth, "
        "clean ink linework, flat colour blocking. Unmistakably anime, "
        "definitely not photorealistic"
    ),
    "render3d": (
        "a stylised 3D character render in the manner of a modern animated "
        "feature: smooth subsurface-scattering skin, slightly exaggerated "
        "proportions with larger eyes, soft cinematic key light, clearly a "
        "rendered character rather than a photograph"
    ),
}

# Which styles must actively resist looking like the source photograph.
_STYLISED = {"illustrated", "anime", "render3d"}


class ImageGenUnavailable(RuntimeError):
    """No API key configured on this instance."""


@dataclass
class Generated:
    image: bytes
    mime: str


def api_key() -> str | None:
    """The key, from the dashboard if set there, otherwise the environment.

    Through the credential overlay rather than settings directly, so a key
    entered in Settings takes effect without a redeploy — which is the whole
    point of having that page.
    """
    from app.core.credentials import credentials

    return credentials.get("gemini_api_key")


def configured() -> bool:
    return bool(api_key())


def shrink_source(data: bytes) -> tuple[bytes, str]:
    """Downscale and re-encode the source before sending it.

    Input images are billed by token count, and an over-large source is the
    easiest way to exhaust a quota for nothing: the model is redrawing the
    face, not retouching it, so detail beyond SOURCE_MAX_EDGE buys nothing.
    JPEG rather than PNG for the same reason — the source is a photograph and
    lossless is wasted on it.
    """
    import io

    from PIL import Image

    try:
        image = Image.open(io.BytesIO(data)).convert("RGB")
        if max(image.size) > SOURCE_MAX_EDGE:
            image.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.LANCZOS)
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=SOURCE_QUALITY, optimize=True)
        return out.getvalue(), "image/jpeg"
    except Exception:
        logger.exception("could not shrink the source; sending it as-is")
        return data, "image/png"


def build_prompt(style: str, has_source: bool, extra: str = "") -> str:
    look = STYLES.get(style, STYLES["photoreal"])
    if has_source:
        # Identity is described as structure, not rendering. Asking to keep
        # "skin tone and texture" pulls every style back toward the photograph;
        # asking to keep the face's proportions does not.
        subject = (
            f"Redraw this person as {look}. "
            "Keep them recognisable: same face proportions, same hairstyle and "
            "hair colour, same apparent age and ethnicity, same clothing. "
        )
        if style in _STYLISED:
            subject += (
                "This is a full stylistic reinterpretation, not a retouch of "
                "the photograph — commit completely to the style above. "
            )
    else:
        subject = f"Create {look} of a plausible person. "
    note = f" {extra.strip()}" if extra.strip() else ""
    return f"{subject}{RIG_REQUIREMENTS}{note}"


async def generate_raw(
    prompt: str, source: bytes | None = None, source_mime: str = "image/png"
) -> bytes:
    """One image from a caller-written prompt. Returns the raw bytes.

    For callers that are not making an avatar portrait and must not inherit
    the style/rig prompt scaffolding — viseme keyframes, where the whole
    instruction is "change only the mouth". `source` is passed through as
    given; shrink it first if it is large.
    """
    return (await _request(prompt, source, source_mime)).image


async def generate(
    style: str, source: bytes | None = None, source_mime: str = "image/png", extra: str = ""
) -> Generated:
    """One candidate. Raises ImageGenUnavailable or RuntimeError on failure."""
    payload = source
    mime = source_mime
    if source is not None:
        payload, mime = shrink_source(source)
        logger.info("source %dKB -> %dKB", len(source) // 1024, len(payload) // 1024)
    return await _request(build_prompt(style, source is not None, extra), payload, mime)


async def _request(prompt: str, source: bytes | None, source_mime: str) -> Generated:
    """POST one generation and pull the image out of the response."""
    key = api_key()
    if not key:
        raise ImageGenUnavailable("gemini_api_key is not set")

    parts: list[dict] = [{"text": prompt}]
    if source is not None:
        parts.append(
            {
                "inline_data": {
                    "mime_type": source_mime,
                    "data": base64.b64encode(source).decode(),
                }
            }
        )

    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.post(
            API_URL,
            headers={"x-goog-api-key": key},
            json={"contents": [{"parts": parts}]},
        )

    if response.status_code >= 300:
        # The body carries the reason — a blocked prompt and an invalid key
        # look identical without it.
        logger.error("gemini rejected the request (%s): %s", response.status_code, response.text[:400])
        raise RuntimeError(f"image generation failed ({response.status_code})")

    for candidate in response.json().get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            blob = part.get("inline_data") or part.get("inlineData")
            if blob and blob.get("data"):
                return Generated(
                    base64.b64decode(blob["data"]),
                    blob.get("mime_type") or blob.get("mimeType") or "image/png",
                )

    # A response with only text is usually a refusal, and the text says why.
    logger.error("gemini returned no image: %s", response.text[:400])
    raise RuntimeError("the model returned no image")


async def verify_key() -> dict:
    """Is the configured key usable? Cheap — no image is generated.

    Fetching the model description exercises authentication and the model name
    together, which are the two things that are actually wrong when this fails.
    """
    key = api_key()
    if not key:
        return {"ok": False, "error": "no API key set"}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}",
                headers={"x-goog-api-key": key},
            )
    except httpx.HTTPError as exc:
        return {"ok": False, "error": str(exc)[:160]}
    if response.status_code >= 300:
        return {"ok": False, "error": f"{response.status_code}: {response.text[:160]}"}
    return {"ok": True, "model": MODEL}
