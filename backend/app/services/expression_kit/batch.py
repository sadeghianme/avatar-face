"""Gemini's batch mode: the same edits at half the price, answered within
minutes to hours (Google's target is 24 h). For what may wait: a publish
whose owner chose "when ready", a re-made kit after a prompt bump, a
migration.

Inline requests (`models/{model}:batchGenerateContent`, each request the
very body imagegen sends, keyed by the expression), and the batch read back
(`GET /v1beta/{name}`) until it ends. Written from the published REST
reference (https://ai.google.dev/gemini-api/docs/batch-mode); the state and
the answers are read from either place the reference shows them (the
operation's `metadata` or its `response`, the `JOB_STATE_` or
`BATCH_STATE_` prefix), as the Avaturn and Qwen integrations were written,
and confirmed on first real use.

A collected batch is checked exactly as a live kit is: its answers are
handed to build_expressions as its edit function (`answers_as_edits`), so
registration, the checks and the skin are the same code. An expression the
batch refused is not asked again on the head crop (a batch is not sent
twice; that expression plays animated).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass

import httpx

from app.services import ai_models, imagegen

logger = logging.getLogger("liveface.expression_kit")

TIMEOUT_SECONDS = 60
SUCCEEDED, FAILED, RUNNING = "succeeded", "failed", "running"
# Ended without answers.
_DEAD = ("FAILED", "CANCELLED", "EXPIRED")


class BatchError(RuntimeError):
    """The batch could not be sent, or read back; nothing was billed for a
    batch that was never accepted."""


@dataclass
class BatchState:
    """A batch read back: its state (SUCCEEDED, FAILED or RUNNING), and once
    it succeeded each answer by key: the generateContent body, or the error
    Google put in its place."""

    state: str
    answers: dict[str, dict]
    errors: dict[str, dict]


def batch_url(model: str = ai_models.IMAGE_MODEL) -> str:
    return f"{ai_models.API_BASE}/{model}:batchGenerateContent"


def status_url(name: str) -> str:
    base = ai_models.API_BASE.rsplit("/models", 1)[0]
    return f"{base}/{name}"


def _key() -> str:
    key = imagegen.api_key()
    if not key:
        raise imagegen.ImageGenUnavailable("gemini_api_key is not set")
    return key


def batch_body(display_name: str, requests: Mapping[str, dict]) -> dict:
    return {
        "batch": {
            "display_name": display_name,
            "input_config": {
                "requests": {
                    "requests": [
                        {"request": body, "metadata": {"key": key}}
                        for key, body in requests.items()
                    ]
                }
            },
        }
    }


async def submit(display_name: str, requests: Mapping[str, dict]) -> str:
    """Send the batch; its name (`batches/...`), to read it back with."""
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.post(
            batch_url(),
            headers={"x-goog-api-key": _key()},
            json=batch_body(display_name, requests),
        )
    if response.status_code >= 300:
        logger.error("gemini refused the batch (%s): %s", response.status_code, response.text[:400])
        raise BatchError(f"the batch was not accepted ({response.status_code})")
    body = response.json()
    name = body.get("name") or (body.get("metadata") or {}).get("name")
    if not name:
        raise BatchError("the batch was accepted without a name")
    return str(name)


def state_of(body: dict) -> str:
    raw = str(body.get("state") or (body.get("metadata") or {}).get("state") or "")
    if raw.endswith("SUCCEEDED"):
        return SUCCEEDED
    if raw.endswith(_DEAD) or body.get("error"):
        return FAILED
    if body.get("done") and not raw:
        return SUCCEEDED
    return RUNNING


def _responses(body: dict) -> list[dict]:
    for holder in (
        body.get("response"),
        body.get("dest"),
        (body.get("metadata") or {}).get("output"),
        body.get("output"),
    ):
        if not isinstance(holder, dict):
            continue
        inlined = holder.get("inlinedResponses") or holder.get("inlined_responses")
        if isinstance(inlined, dict):
            inlined = inlined.get("inlinedResponses") or inlined.get("inlined_responses")
        if isinstance(inlined, list):
            return [item for item in inlined if isinstance(item, dict)]
    return []


def read_state(body: dict) -> BatchState:
    """A batch's body read as BatchState (see the module docstring)."""
    state = state_of(body)
    answers: dict[str, dict] = {}
    errors: dict[str, dict] = {}
    if state == SUCCEEDED:
        for item in _responses(body):
            key = str((item.get("metadata") or {}).get("key") or item.get("key") or "")
            if not key:
                continue
            if isinstance(item.get("response"), dict):
                answers[key] = item["response"]
            else:
                errors[key] = item.get("error") or {"message": "no answer"}
    return BatchState(state, answers, errors)


async def poll(name: str) -> BatchState:
    """The batch as it is now. Raises BatchError when it cannot be read."""
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.get(status_url(name), headers={"x-goog-api-key": _key()})
    if response.status_code >= 300:
        logger.error("gemini batch %s unreadable (%s)", name, response.status_code)
        raise BatchError(f"the batch could not be read ({response.status_code})")
    return read_state(response.json())


def answers_as_edits(state: BatchState, prompts: Mapping[str, str]):
    """The batch's answers as an edit function for build_expressions: the
    answer for the expression whose prompt is asked (`prompts`: expression
    to prompt), parsed as a live answer is (imagegen.answer_of: an image, a
    refusal, or an answer without one). An expression the batch has no
    answer for is an answer without an image; one asked again (the head
    crop after a refusal) gets its refusal again: a batch is not sent twice,
    and neither stops the other expressions (ImageGenUnavailable would).
    The calls a collected kit reports are the batch's, not these."""
    by_prompt = {prompt: name for name, prompt in prompts.items()}

    async def edit(prompt: str, payload: bytes, mime: str) -> imagegen.Generated:
        name = by_prompt.get(prompt)
        if name is None or name not in state.answers:
            raise imagegen.ImageGenNoImage("not in the batch")
        return imagegen.answer_of(state.answers[name])

    return edit
