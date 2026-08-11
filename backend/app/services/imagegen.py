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

STYLES: dict[str, str] = {
    "photoreal": (
        "a polished, professional photographic headshot with soft studio lighting"
    ),
    "illustrated": (
        "a clean vector-style illustrated portrait with flat colour and simple shading"
    ),
    "anime": "an anime-style portrait with clean linework and cel shading",
    "render3d": (
        "a friendly stylised 3D character render, like a modern animated feature"
    ),
}


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


def build_prompt(style: str, has_source: bool, extra: str = "") -> str:
    look = STYLES.get(style, STYLES["photoreal"])
    if has_source:
        subject = (
            f"Redraw the person in this photograph as {look}. "
            "Keep their identity clearly recognisable — same face shape, hair, "
            "skin tone and apparent age. Do not beautify or change their features."
        )
    else:
        subject = f"Create {look} of a plausible person."
    note = f" {extra.strip()}" if extra.strip() else ""
    return f"{subject} {RIG_REQUIREMENTS}{note}"


async def generate(
    style: str, source: bytes | None = None, source_mime: str = "image/png", extra: str = ""
) -> Generated:
    """One candidate. Raises ImageGenUnavailable or RuntimeError on failure."""
    key = api_key()
    if not key:
        raise ImageGenUnavailable("gemini_api_key is not set")

    parts: list[dict] = [{"text": build_prompt(style, source is not None, extra)}]
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
