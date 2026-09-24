"""Metering and limiting image generation.

Generation is the one feature here that spends real money per click, and the
retry loop can fire several times per press.
"""

import pytest

from app.core.config import get_settings
from app.services.usage import (
    check_image_limit,
    chars_used_this_month,
    images_used_this_month,
    record_generation,
    record_synthesis,
    usage_summary,
)
from app.core.errors import RateLimit429
from app.db import get_session_factory
from tests.conftest import create_org, register_and_login


async def _org(client, who: str) -> str:
    headers = await register_and_login(client, who)
    return await create_org(client, headers)


async def test_generations_do_not_inflate_the_character_total(client):
    """The two are metered separately; a shared table must not merge them."""
    org_id = await _org(client, "meter1")
    async with get_session_factory()() as db:
        await record_synthesis(db, org_id, "offline", 500, cached=False, source="dashboard")
        await record_generation(db, org_id, "gemini")
        await record_generation(db, org_id, "gemini")

        assert await chars_used_this_month(db, org_id) == 500
        assert await images_used_this_month(db, org_id) == 2


async def test_the_voice_breakdown_does_not_sprout_an_image_provider(client):
    org_id = await _org(client, "meter2")
    async with get_session_factory()() as db:
        await record_synthesis(db, org_id, "offline", 100, cached=False, source="dashboard")
        await record_generation(db, org_id, "gemini")
        summary = await usage_summary(db, org_id)

    providers = {row["provider"] for row in summary["by_provider"]}
    assert providers == {"offline"}, "gemini is not a voice provider"


async def test_the_summary_reports_attempts_kept_and_cost(client):
    org_id = await _org(client, "meter3")
    async with get_session_factory()() as db:
        for _ in range(3):
            await record_generation(db, org_id, "gemini")
        summary = await usage_summary(db, org_id)

    settings = get_settings()
    assert summary["images_generated"] == 3
    assert summary["avatars_generated"] == 0, "generated is not the same as kept"
    assert summary["image_cost_usd"] == round(3 * settings.image_generation_cost_usd, 2)
    assert summary["image_limit"] == settings.image_generation_monthly_limit


async def test_the_limit_stops_further_generation(client, monkeypatch):
    org_id = await _org(client, "meter4")
    settings = get_settings()
    monkeypatch.setattr(settings, "image_generation_monthly_limit", 2, raising=False)

    async with get_session_factory()() as db:
        await check_image_limit(db, org_id)          # nothing used yet
        await record_generation(db, org_id, "gemini")
        await record_generation(db, org_id, "gemini")
        with pytest.raises(RateLimit429):
            await check_image_limit(db, org_id)


async def test_a_rejected_candidate_still_counts(client):
    """It was generated and charged for, whatever the rig thought of it —
    counting only the keepers would under-report the bill."""
    org_id = await _org(client, "meter5")
    async with get_session_factory()() as db:
        await record_generation(db, org_id, "gemini")
        summary = await usage_summary(db, org_id)
    assert summary["images_generated"] == 1
    assert summary["avatars_generated"] == 0


@pytest.fixture
def one_backend(monkeypatch):
    """Generation that 'works' without a provider: one openai image that
    passes the rig checks."""
    from types import SimpleNamespace

    from app.services import imagegen, riggable
    from tests.conftest import sample_png

    async def generate(backend, style, source, extra=""):
        return SimpleNamespace(image=sample_png())

    monkeypatch.setattr(imagegen, "configured_backends", lambda: ["openai"])
    monkeypatch.setattr(imagegen, "generate_with", generate)
    monkeypatch.setattr(
        riggable, "check_image", lambda data: riggable.RigCheck(True, None, 0.3, 0.0, True)
    )


async def _kept(org_id: str) -> list[str]:
    from sqlalchemy import select

    from app.models.usage import UsageEvent
    from app.services.usage import GENERATED_AVATAR_KIND

    async with get_session_factory()() as db:
        rows = await db.execute(
            select(UsageEvent.provider).where(
                UsageEvent.org_id == org_id, UsageEvent.kind == GENERATED_AVATAR_KIND
            )
        )
        return [provider for (provider,) in rows]


async def test_saving_an_upload_is_not_a_generated_avatar(client):
    from tests.conftest import sample_png

    headers = await register_and_login(client, "uploader")
    org_id = await create_org(client, headers)
    staged = await client.post(
        f"/orgs/{org_id}/staging", files={"file": ("me.png", sample_png(), "image/png")},
        headers=headers,
    )
    saved = await client.post(
        f"/orgs/{org_id}/avatars/from-candidate",
        json={"name": "Me", "key": staged.json()["key"]},
        headers=headers,
    )
    assert saved.status_code == 201, saved.text
    assert await _kept(org_id) == []


async def test_a_kept_generation_counts_with_its_backend_even_after_edits(client, one_backend):
    headers = await register_and_login(client, "generator")
    org_id = await create_org(client, headers)
    generated = (
        await client.post(f"/orgs/{org_id}/staging/generate", json={"count": 1}, headers=headers)
    ).json()["candidates"][0]
    assert "/candidates/gen-openai-" in generated["key"]
    # A crop of a generated portrait is still a generated portrait.
    cropped = await client.post(
        f"/orgs/{org_id}/staging/crop",
        json={"key": generated["key"], "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
        headers=headers,
    )
    saved = await client.post(
        f"/orgs/{org_id}/avatars/from-candidate",
        json={"name": "Gen", "key": cropped.json()["key"]},
        headers=headers,
    )
    assert saved.status_code == 201, saved.text
    assert await _kept(org_id) == ["openai"]


async def test_avatar_level_generation_marks_its_candidates(client, one_backend):
    headers = await register_and_login(client, "generator2")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars/generate", json={"count": 1}, headers=headers
    )
    assert response.status_code == 200, response.text
    assert "/candidates/gen-openai-" in response.json()["candidates"][0]["key"]


def test_provenance_is_read_only_from_a_known_backend():
    from app.services.candidates import generated_by, new_candidate_key

    assert generated_by(new_candidate_key("o", "qwen")) == "qwen"
    assert generated_by(new_candidate_key("o")) is None
    assert generated_by("orgs/o/candidates/gen-madeup-123.png") is None
