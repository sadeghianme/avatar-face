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

from app.services import ai_models

logger = logging.getLogger("liveface.imagegen")

# The source is billed as input tokens, and a portrait carries no useful
# detail past this for the model's purposes — it is redrawing a face, not
# retouching one. A 1254px PNG source costs roughly ten times what this does
# and produces the same result.
SOURCE_MAX_EDGE = 1024
SOURCE_QUALITY = 88

# Named with every other model id in services.ai_models, where startup
# checks it still exists.
MODEL = ai_models.IMAGE_MODEL
API_URL = ai_models.generate_url(MODEL)
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


class ImageGenRefused(RuntimeError):
    """The provider declined on safety or policy grounds.

    Separate from other failures because it must never be retried: the same
    photo and prompt are refused the same way, and each attempt is billed.
    `reason` is Google's own code (SAFETY, IMAGE_SAFETY, PROHIBITED_CONTENT…).
    """

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(f"the provider declined this image ({reason})")


class ImageGenNoImage(RuntimeError):
    """The provider answered (HTTP 200) but sent no image and named no
    policy reason: a text-only answer, or a finishReason such as NO_IMAGE,
    IMAGE_OTHER or OTHER.

    Separate from a transport or HTTP failure because this call WAS
    answered, so it was billed: the photo went up and its input tokens were
    charged. Callers meter it like any answered call, and do not ask again
    in the same round (the same photo and prompt tend to be declined the
    same way). `reason` is the finishReason when there was one.
    """

    answered = True

    def __init__(self, reason: str | None = None):
        self.reason = reason
        super().__init__(f"the model returned no image ({reason or 'no reason given'})")


# A candidate's finishReason when the answer was withheld on policy
# grounds. (Any promptFeedback.blockReason is a refusal of the request.)
REFUSAL_REASONS = frozenset(
    {
        "SAFETY",
        "PROHIBITED_CONTENT",
        "BLOCKLIST",
        "SPII",
        "RECITATION",
        "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT",
        "IMAGE_RECITATION",
    }
)


@dataclass
class Generated:
    image: bytes
    mime: str
    # The model that made it, recorded on what it made (disclosure).
    model: str = MODEL


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


def refusal_reason(body: dict) -> str | None:
    """The policy reason a 200 response carries no image, or None.

    A blocked prompt is `promptFeedback.blockReason`; a withheld answer is a
    candidate whose `finishReason` is a policy one. Anything else (no
    candidates, a text-only answer) is not a refusal we can name.
    """
    feedback = body.get("promptFeedback") or {}
    blocked = feedback.get("blockReason")
    if blocked and blocked != "BLOCK_REASON_UNSPECIFIED":
        return str(blocked)
    for candidate in body.get("candidates") or []:
        reason = candidate.get("finishReason")
        if reason in REFUSAL_REASONS:
            return str(reason)
    return None


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
            image.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=SOURCE_QUALITY, optimize=True)
        return out.getvalue(), "image/jpeg"
    except Exception:
        # Broad on purpose: Pillow raises many types on a picture it cannot
        # decode; the source is then sent as it is.
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


async def edit_image(prompt: str, source: bytes, source_mime: str) -> Generated:
    """One edit of `source` from a caller-written prompt, with the model that
    made it. For the creation wizard's AI adjust, which writes its own
    prompts (photo_adjust) and prepares its own source: a face crop must
    arrive at the size it was cut, not shrunk again here.

    Raises ImageGenUnavailable, ImageGenRefused (never retry),
    ImageGenNoImage (answered and billed, but no image) or RuntimeError (the
    call was not answered).
    """
    return await _request(prompt, source, source_mime)


async def create_image(prompt: str) -> Generated:
    """One image from a caller-written prompt and no source, with the model
    that made it (a creation generated from text)."""
    return await _request(prompt, None, "image/png")


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

    body = response.json()
    for candidate in body.get("candidates", []):
        for part in (candidate.get("content") or {}).get("parts", []):
            blob = part.get("inline_data") or part.get("inlineData")
            if blob and blob.get("data"):
                return Generated(
                    base64.b64decode(blob["data"]),
                    blob.get("mime_type") or blob.get("mimeType") or "image/png",
                    MODEL,
                )

    refused = refusal_reason(body)
    if refused:
        logger.info("gemini declined the image (%s)", refused)
        raise ImageGenRefused(refused)
    # A response with only text is usually a refusal, and the text says why.
    logger.error("gemini returned no image: %s", response.text[:400])
    reasons = [c.get("finishReason") for c in body.get("candidates") or [] if c.get("finishReason")]
    raise ImageGenNoImage(str(reasons[0]) if reasons else None)


async def verify_key() -> dict:
    """Is the configured key usable? Cheap — no image is generated.

    Checks every Gemini model the server calls (ai_models), not only the
    image one: the key's test button is where an owner looks when the point
    finder fails too. `model` stays the image model, as before.
    """
    result = await ai_models.verify_models()
    if not result["models"]:
        return {"ok": False, "error": result.get("error", "no API key set")}
    failed = [check for check in result["models"].values() if not check["ok"]]
    out = {"ok": not failed, "model": MODEL, "models": result["models"]}
    if failed:
        out["error"] = f"{failed[0]['model']}: {failed[0].get('error', '')}"
    return out


# --- Multiple image backends ------------------------------------------------
#
# One style choice fans out to every configured backend, one image each, so
# the user compares what Gemini, OpenAI and Qwen make of the same face
# instead of three rolls of the same die. Each backend is optional: only the
# ones with keys participate, and one backend failing costs one slot, not
# the batch.

OPENAI_IMAGES_URL = "https://api.openai.com/v1"
# gpt-image-1 shuts down on 2026-10-23; same Images API, same response shape.
# https://developers.openai.com/api/docs/deprecations
OPENAI_IMAGE_MODEL = "gpt-image-2"

# Alibaba's international DashScope endpoint. NOTE: unverified against the
# live service until a key exists — same policy as the Avaturn integration,
# where the shapes were written from the published docs and confirmed on
# first real use.
DASHSCOPE_URL = "https://dashscope-intl.aliyuncs.com/api/v1"
QWEN_T2I_MODEL = "qwen-image"
QWEN_EDIT_MODEL = "qwen-image-edit"

IMAGE_BACKENDS = ("gemini", "openai", "qwen")


def _backend_key(backend: str) -> str | None:
    from app.core.credentials import credentials

    return credentials.get(
        {
            "gemini": "gemini_api_key",
            # The one OpenAI key on the account: also used for their voices.
            "openai": "openai_api_key",
            "qwen": "dashscope_api_key",
        }[backend]
    )


def configured_backends() -> list[str]:
    return [b for b in IMAGE_BACKENDS if _backend_key(b)]


async def generate_with(
    backend: str, style: str, source: bytes | None = None, extra: str = ""
) -> Generated:
    """One image from one named backend, same style prompt for all."""
    if backend == "gemini":
        return await generate(style, source, extra=extra)

    prompt = build_prompt(style, source is not None, extra)
    payload = mime = None
    if source is not None:
        payload, mime = shrink_source(source)

    if backend == "openai":
        return await _openai_image(prompt, payload, mime)
    if backend == "qwen":
        return await _qwen_image(prompt, payload, mime)
    raise ImageGenUnavailable(f"unknown image backend '{backend}'")


async def _openai_image(prompt: str, source: bytes | None, mime: str | None) -> Generated:
    key = _backend_key("openai")
    if not key:
        raise ImageGenUnavailable("openai_api_key is not set")
    headers = {"Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        if source is not None:
            response = await client.post(
                f"{OPENAI_IMAGES_URL}/images/edits",
                headers=headers,
                data={"model": OPENAI_IMAGE_MODEL, "prompt": prompt, "size": "1024x1024"},
                files={"image": ("source.png", source, mime or "image/png")},
            )
        else:
            response = await client.post(
                f"{OPENAI_IMAGES_URL}/images/generations",
                headers=headers,
                json={"model": OPENAI_IMAGE_MODEL, "prompt": prompt, "size": "1024x1024"},
            )
    if response.status_code >= 300:
        logger.error("openai images rejected (%s): %s", response.status_code, response.text[:300])
        raise RuntimeError(f"OpenAI image generation failed ({response.status_code})")
    data = response.json().get("data") or []
    if not data or not data[0].get("b64_json"):
        raise RuntimeError("OpenAI returned no image")
    return Generated(base64.b64decode(data[0]["b64_json"]), "image/png")


async def _qwen_image(prompt: str, source: bytes | None, mime: str | None) -> Generated:
    key = _backend_key("qwen")
    if not key:
        raise ImageGenUnavailable("dashscope_api_key is not set")
    headers = {"Authorization": f"Bearer {key}"}

    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        if source is not None:
            # Image-to-image: the synchronous multimodal endpoint, source
            # inlined as a data URI.
            data_uri = f"data:{mime or 'image/png'};base64,{base64.b64encode(source).decode()}"
            response = await client.post(
                f"{DASHSCOPE_URL}/services/aigc/multimodal-generation/generation",
                headers=headers,
                json={
                    "model": QWEN_EDIT_MODEL,
                    "input": {
                        "messages": [
                            {"role": "user", "content": [{"image": data_uri}, {"text": prompt}]}
                        ]
                    },
                },
            )
            if response.status_code >= 300:
                logger.error("qwen edit rejected (%s): %s", response.status_code, response.text[:300])
                raise RuntimeError(f"Qwen image generation failed ({response.status_code})")
            content = (
                response.json().get("output", {}).get("choices", [{}])[0]
                .get("message", {}).get("content", [])
            )
            image_url = next((c["image"] for c in content if "image" in c), None)
        else:
            # Text-to-image is an async task: submit, then poll.
            submitted = await client.post(
                f"{DASHSCOPE_URL}/services/aigc/text2image/image-synthesis",
                headers={**headers, "X-DashScope-Async": "enable"},
                json={
                    "model": QWEN_T2I_MODEL,
                    "input": {"prompt": prompt},
                    "parameters": {"size": "1024*1024", "n": 1},
                },
            )
            if submitted.status_code >= 300:
                logger.error("qwen submit rejected (%s): %s", submitted.status_code, submitted.text[:300])
                raise RuntimeError(f"Qwen image generation failed ({submitted.status_code})")
            task_id = submitted.json().get("output", {}).get("task_id")
            if not task_id:
                raise RuntimeError("Qwen returned no task id")
            image_url = None
            for _ in range(30):
                import asyncio

                await asyncio.sleep(2)
                status = await client.get(f"{DASHSCOPE_URL}/tasks/{task_id}", headers=headers)
                output = status.json().get("output", {})
                state = output.get("task_status")
                if state == "SUCCEEDED":
                    results = output.get("results") or []
                    image_url = results[0].get("url") if results else None
                    break
                if state in ("FAILED", "CANCELED"):
                    raise RuntimeError(f"Qwen task {state.lower()}: {output.get('message', '')[:120]}")

        if not image_url:
            raise RuntimeError("Qwen returned no image")
        downloaded = await client.get(image_url)
        downloaded.raise_for_status()
        return Generated(downloaded.content, downloaded.headers.get("content-type", "image/png"))
