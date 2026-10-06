"""A finished person's own mouth: their mouth kit (or their teeth alone)
made from the chosen picture before the first publish, when AI may make
it, and the standard mouth with the reason when it may not."""

from __future__ import annotations

import json
import logging

from sqlalchemy import select, update

from app.core.errors import AppError
from app.db import execute_dml, get_session_factory
from app.models import Avatar, Creation
from app.services.jobs import (
    Job,
    runner,
)
from app.services.creations.records import error_record

logger = logging.getLogger("liveface.creations")

TEETH_FAILED = error_record(
    "teeth_failed", "The teeth could not be made, so this avatar uses standard teeth"
)
# The finish's last stage, and the same when a person's mouth was not made
# after all (no AI allowed, or it failed): the standard teeth and shapes.
PUBLISH_LABEL = "publishing"
PUBLISH_STANDARD_LABEL = "publishing with the standard mouth"


def _animal_character_mouth(creation: Creation, avatar: Avatar) -> None:
    """A new animal-like character starts with no teeth in its character
    mouth. An animation or a cartoon is stored as the plain `cartoon` line
    whatever it shows, so the line cannot tell a dog from a woman; the
    wizard's plan (the owner's first choice, "Animal") can. Human-style upper
    teeth on a dog look wrong, and the owner can turn them on in the Mouth
    panel. Only where the character mouth applies and nothing is set yet."""
    from app.services import mouth, wizard

    plan = wizard.plan_of(creation.steps)
    if not plan or plan.get("model") != "animal" or not mouth.character_allowed(avatar.face_type):
        return
    config = json.loads(avatar.mouth_config) if avatar.mouth_config else {}
    if config.get("character"):
        return
    config.setdefault("renderer", "classic")
    config.setdefault("profile", {})
    config["character"] = mouth.clean_character({**mouth.DEFAULT_CHARACTER, "teeth": "none"})
    avatar.mouth_config = json.dumps(config)


async def _own_mouth(
    job: Job, creation: Creation, avatar: Avatar, image: bytes, rig: dict, storage
) -> bool | None:
    """The mouth a new avatar speaks with, set before its first publish:
    the wizard's last step, "Preparing your avatar". True when the person's
    own mouth was made (some of their shapes, or their teeth), False when a
    person got the standard one, None for a line that has no photographic
    mouth.

    A person gets the photographic mouth (services.mouth_photo.default_config;
    every other line keeps the classic one, mouth_config null) and, when AI
    may make it (_ai_allowed: the organization's switch, the image model,
    the monthly limit, the finishing member's current consent), the quality
    the Reference avatar has: their own performance kit (services.mouth_kit)
    from `image`, the picture just chosen, and the rig's 478 points the
    owner just confirmed. That is their own six mouth shapes, their teeth
    photo when the embed would draw it, and the teeth fitted to it. Where
    the kit cannot be made on this server at all (no face detector for its
    registration; nothing was sent), the single "ee" photo is made instead
    (_single_teeth), so a person can still get their teeth. Anything short
    of that (no consent, AI off, the limit, a crash) publishes with the
    standard teeth (the Reference's own teeth photo, seated as the
    Reference's: mouth_photo.default_config) and the bundled motion, and
    records why in the teeth note. Never fails the finish: the avatar is
    worth having without them.

    The consent that lets the picture go is recorded on the creation, for
    good, before the first picture is sent (and on the avatar, which this
    finish writes): a refusal, a rejected answer or a provider error still
    sent a photo, and a finish that fails afterwards, or a restart that
    interrupts it, deletes the half-built avatar and rolls nothing back of
    what was sent, so an audit must still find what allowed it. The calls
    wait outside the runner's slot (JobRunner.outside_slot), so a finish
    waiting on Google never holds another person's upload queued.
    """
    from app.services import consent, mouth_kit, mouth_photo, performance_kit

    config = mouth_photo.default_config(avatar.face_type)
    if config is None:
        return None
    avatar.mouth_config = json.dumps(config)

    def standard(note: dict) -> bool:
        # The standard teeth and the bundled motion, and why.
        avatar.mouth_config = json.dumps(
            {**config, "teeth": mouth_photo.generic_teeth_record(note)}
        )
        return False

    try:
        consent_id = await _ai_allowed(avatar)
    except mouth_photo.TeethFailure as exc:
        logger.info("finish %s: no AI mouth (%s)", job.id, exc.code)
        return standard(exc.note())
    except Exception:
        # Not knowing whether AI may make the mouth (the database, say) is
        # not a reason to lose the avatar.
        logger.exception("finish %s: could not tell whether AI may make the mouth", job.id)
        return standard(TEETH_FAILED)

    async def sending() -> None:
        await _record_finish_consent(creation, consent_id)
        avatar.consent_ids = consent.with_consent(avatar.consent_ids, consent_id)
        creation.consent_ids = consent.with_consent(creation.consent_ids, consent_id)

    job.report(0.6, mouth_kit.SHAPES_LABEL, count=(0, mouth_kit.SHAPE_COUNT + 1))
    try:
        result = await mouth_kit.make(
            avatar.org_id, image, rig["points"], job=job, on_first_send=sending,
            on_progress=mouth_kit.progress_to(job, 0.6, 0.85),
        )
    except (performance_kit.KitUnavailable, ValueError) as exc:
        logger.info("finish %s: no mouth kit on this server (%s); the teeth alone", job.id, exc)
        return await _single_teeth(job, avatar, image, storage, sending)
    except Exception:
        # Every call it sent was metered as it ended (mouth_kit.CallGuard).
        logger.exception("finish %s: making the mouth kit failed", job.id)
        return standard(TEETH_FAILED)
    job.report(0.87, mouth_kit.FIT_LABEL)
    ai_edited = avatar.ai_edited
    try:
        await mouth_kit.store(avatar, storage, result, source="finish")
    except Exception:
        logger.exception("finish %s: storing the mouth kit failed", job.id)
        avatar.ai_edited = ai_edited
        return standard(TEETH_FAILED)
    stored = avatar.mouth_config
    assert stored is not None  # mouth_kit.store wrote it
    kit = json.loads(stored)["kit"]
    return kit["generated"] > 0 or bool(kit["teeth"]["used"])


async def _record_finish_consent(creation: Creation, consent_id: str) -> None:
    """The consent that lets a finish's pictures go, on the creation's row
    and committed, before the first of them leaves: the finish's own write
    comes minutes later, or never (a failure deletes the half-built avatar
    and puts the creation back to draft; a restart interrupts it). Raises
    when it cannot be recorded, and then nothing is sent
    (mouth_kit.CallGuard)."""
    from app.services import consent

    async with get_session_factory()() as db:
        stored = (
            await db.execute(
                select(Creation.consent_ids).where(
                    Creation.id == creation.id, Creation.org_id == creation.org_id
                )
            )
        ).scalar_one_or_none()
        recorded = await execute_dml(
            db,
            update(Creation)
            .where(Creation.id == creation.id, Creation.org_id == creation.org_id)
            .values(consent_ids=consent.with_consent(stored, consent_id)),
        )
        if recorded != 1:
            raise RuntimeError("the creation being finished is gone")
        await db.commit()


async def _single_teeth(job: Job, avatar: Avatar, image: bytes, storage, sending) -> bool:
    """A person's teeth alone: an "ee" photo the image model makes from
    `image`, admitted exactly like an uploaded mouth photo, when the kit
    cannot be made. Anything short of it publishes the standard teeth with
    the reason in the teeth note. True when the teeth were made."""
    from app.services import mouth_photo

    config = mouth_photo.default_config(avatar.face_type) or {}
    job.report(0.65, "making the teeth")
    try:
        async with runner.outside_slot(job):
            made = await mouth_photo.make_teeth(avatar.org_id, image, on_send=sending)
        await mouth_photo.store(
            avatar, storage, made.photo, made.rig, mouth_photo.ai_teeth_record(made.model)
        )
    except mouth_photo.TeethFailure as exc:
        logger.info("finish %s: standard teeth (%s)", job.id, exc.code)
        note = exc.note()
    except Exception:
        logger.exception("finish %s: making the teeth failed", job.id)
        note = TEETH_FAILED
    else:
        # AI made part of what visitors see: the disclosure says so.
        avatar.ai_edited = mouth_photo.with_ai_teeth(avatar.ai_edited, made.model)
        return True
    config["teeth"] = mouth_photo.generic_teeth_record(note)
    avatar.mouth_config = json.dumps(config)
    return False


async def _ai_allowed(avatar: Avatar) -> str:
    """The finishing member's current third_party_ai consent, when AI may
    make this mouth at all: the organization allows third-party AI, the
    member agreed, the server has its image model, and the monthly image
    limit is not reached (the switch and the limit are read again before
    every call). Else TeethFailure, whose code the teeth note shows."""
    from app.services import imagegen
    from app.services.mouth_photo import TeethFailure
    from app.services.usage import check_image_limit

    consent_id = await _teeth_consent(avatar)
    if not imagegen.configured():
        raise TeethFailure(
            "imagegen_unavailable", "AI editing is not configured on this server", 409
        )
    try:
        async with get_session_factory()() as db:
            await check_image_limit(db, avatar.org_id)
    except AppError as exc:
        raise TeethFailure(exc.code, exc.detail, 429) from exc
    return consent_id


async def _teeth_consent(avatar: Avatar) -> str:
    """The finishing member's current third_party_ai consent, in an
    organization that allows third-party AI; else TeethFailure (nothing is
    sent without both)."""
    from app.models import Organization
    from app.services import consent
    from app.services.ai_models import PROVIDER
    from app.services.mouth_photo import TeethFailure

    async with get_session_factory()() as db:
        org = await db.get(Organization, avatar.org_id)
        if org is None or not org.third_party_ai_enabled:
            raise TeethFailure(
                "third_party_ai_disabled",
                "Your organization has turned off third-party AI, so standard teeth are used",
                403,
            )
        agreed = await consent.latest(db, org, avatar.created_by_id, consent.THIRD_PARTY_AI)
    if agreed is None or PROVIDER not in (agreed.providers or []):
        raise TeethFailure(
            "no_ai_consent",
            "AI was not used: you have not agreed to the current statement on sending photos "
            "to Google, so standard teeth are used",
            403,
        )
    return agreed.id
