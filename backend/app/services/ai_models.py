"""Every Google model this server calls, named in one place and checked at startup.

Model ids are the part of an AI integration that breaks by itself: Google
retires ids on a published schedule (gemini-2.5-flash-image went away on
2026-10-02), and a retired id fails every request with a 404 that looks, in
the logs, exactly like a bad key. Keeping every id here means one file to
change when a deprecation notice arrives, and `verify_models` turns "the
model is gone" into a startup log line instead of a customer's failed edit.

Ids are pinned, stable (non-preview) versions, never an alias such as
`gemini-flash-latest`: an alias is hot-swapped to a new model on Google's
schedule, and a new model changes what the touch-up paints and where the
point finder puts an eye without anything here changing. The prompts and
the checks in photo_adjust and vision_points were written against these.
See https://ai.google.dev/gemini-api/docs/deprecations before changing one.
"""

from __future__ import annotations

import logging

import httpx

from app.core.credentials import credentials

logger = logging.getLogger("liveface.ai_models")

API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# Image edits and generation (imagegen, photo_adjust). The stable successor
# of gemini-2.5-flash-image; no shutdown date announced.
IMAGE_MODEL = "gemini-3.1-flash-image"

# Keypoints on faces MediaPipe cannot see (vision_points). The current
# stable Flash: Google's own object-detection examples use it, it supports
# structured output, and gemini-3.5-flash is now labelled legacy. No
# shutdown date announced.
VISION_MODEL = "gemini-3.8-flash"

# The provider every model above belongs to, as a consent names it
# (services.consent). A model from another provider needs its own name
# there, and a new consent: people agreed to Google, not to "AI".
PROVIDER = "google"

ALL_MODELS = {"image": IMAGE_MODEL, "vision": VISION_MODEL}

VERIFY_TIMEOUT_SECONDS = 20


def generate_url(model: str) -> str:
    return f"{API_BASE}/{model}:generateContent"


def api_key() -> str | None:
    """The Gemini key: the dashboard's if set there, else the environment."""
    return credentials.get("gemini_api_key")


async def verify_model(model: str, key: str) -> dict:
    """Does `model` exist for this key? Fetches its description only: no
    tokens are spent, and it exercises authentication and the id together,
    the two things that are wrong when calls start failing."""
    try:
        async with httpx.AsyncClient(timeout=VERIFY_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{API_BASE}/{model}", headers={"x-goog-api-key": key})
    except httpx.HTTPError as exc:
        return {"ok": False, "model": model, "error": str(exc)[:160]}
    if response.status_code >= 300:
        return {
            "ok": False,
            "model": model,
            "error": f"{response.status_code}: {response.text[:160]}",
        }
    return {"ok": True, "model": model}


async def verify_models() -> dict:
    """Every configured model, checked. {"ok", "models": {role: result}}."""
    key = api_key()
    if not key:
        return {"ok": False, "error": "no API key set", "models": {}}
    results = {role: await verify_model(model, key) for role, model in ALL_MODELS.items()}
    return {"ok": all(r["ok"] for r in results.values()), "models": results}


async def verify_at_startup() -> None:
    """Log, never raise: a retired model disables the AI steps, not the
    server. Without a key there is nothing to check (AI steps are off)."""
    if not api_key():
        return
    try:
        result = await verify_models()
    except Exception:
        # Broad on purpose: a startup check logs, it never stops the server.
        logger.exception("could not verify the Gemini models")
        return
    for role, check in result["models"].items():
        if check["ok"]:
            logger.info("gemini %s model %s is available", role, check["model"])
        else:
            logger.error(
                "gemini %s model %s is NOT available (%s); the AI steps that use it will "
                "fail until app/services/ai_models.py names a current model",
                role,
                check["model"],
                check.get("error"),
            )
