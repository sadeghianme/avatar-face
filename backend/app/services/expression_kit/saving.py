"""A made kit saved on the avatar, however long it took: on the picture as
it is now, and published at once when it completes a publish.

Shared by the live job (jobs) and a collected batch (batching)."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from sqlalchemy import select

from app.core.errors import AppError, Conflict409, NotFound404, Validation422
from app.db import get_session_factory
from app.models import Avatar, AvatarKind, AvatarStatus
from app.services import consent
from app.services.edit_locks import avatar_edits
from app.services.expression_kit.build import ExpressionsResult
from app.services.expression_kit.manifest import rebase
from app.services.expression_kit.records import Source
from app.services.expression_kit.storing import store
from app.services.expressions import (
    load,
    made_count,
    picture_of,
    publish_expressions,
    published_disclosure,
)
from app.services.jobs import run_cpu
from app.services.publishing import config_of, copier, mark_dirty, published_prefix
from app.services.storage import Storage, get_storage

logger = logging.getLogger("liveface.expression_kit")


@dataclass(frozen=True)
class Origin:
    """What a kit was made from and for: the avatar's picture and points
    when it was asked for, and the published revision it completes (a
    publish's kit, None for the panel's)."""

    org_id: str
    avatar_id: str
    image_key: str
    points: list
    source: Source
    revision: int | None = None


async def load_avatar(db, org_id: str, avatar_id: str) -> Avatar | None:
    return (
        await db.execute(select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == org_id))
    ).scalar_one_or_none()


def require_person(avatar) -> None:
    """A ready photo avatar of a person (or a drawn person: the face_type
    is human), with its picture and rig. Animals and cartoons play the
    animated expressions: their engines draw no second picture."""
    if avatar is None:
        raise NotFound404("Avatar not found", code="avatar_not_found")
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready:
        raise Conflict409(
            "Only a ready photo avatar can have expression pictures", code="not_a_photo"
        )
    if (avatar.face_type or "human") != "human":
        raise Validation422(
            "AI expression pictures are made for human faces; this one plays its "
            "animated expressions",
            code="not_a_person",
        )
    if not avatar.image_key or not avatar.rig_key:
        raise Conflict409("The avatar's picture is gone", code="source_gone")


async def record_consent(org_id: str, avatar_id: str, consent_id: str) -> None:
    """The consent that lets the picture go, on the avatar as it goes (an
    audit must find what allowed it). Not a change a visitor sees."""
    async with avatar_edits.hold(avatar_id), get_session_factory()() as db:
        row = await load_avatar(db, org_id, avatar_id)
        if row is not None:
            row.consent_ids = consent.with_consent(row.consent_ids, consent_id)
            await db.commit()


def nothing_made(result: ExpressionsResult) -> AppError:
    """The failure when no expression was made: why the calls stopped or
    were refused, else the first expression's reason."""
    reasons = [entry["reason"] for entry in result.report.values() if entry.get("reason")]
    reason = (
        reasons[0]
        if reasons
        else {
            "code": "provider_error",
            "detail": "The AI service did not return an image",
        }
    )
    return AppError(
        f"None of the expression pictures could be made: {reason['detail']}", code=reason["code"]
    )


async def republish(avatar: Avatar, storage: Storage) -> None:
    """Rewrite the live snapshot's `expressions` (and its disclosure) from
    the draft's, exactly as Publish would, and nothing else: the revision
    and every other file stay. For a publish's own kit, made after that
    publish returned: the kit completes the publish that asked for it. A
    no-op for an avatar never published."""
    config = config_of(avatar)
    if config is None:
        return
    prefix = published_prefix(avatar.org_id, avatar.id, config.get("revision", 0))
    published = await publish_expressions(avatar, copier(storage, prefix))
    config["expressions"] = published
    snapshot = config.get("disclosure")
    if snapshot is not None:
        snapshot["ai_edited"] = published_disclosure(snapshot.get("ai_edited"), published)
    avatar.published_config = json.dumps(config)


async def save(origin: Origin, result: ExpressionsResult) -> None:
    """Store `result` on the avatar (expression_kit.store), under its edit
    lock, on the row as it is now.

    The picture must still be the one the kit was made on (409
    picture_changed otherwise: the pictures are of another photo); new
    points on it (re-marked meanwhile) are followed. A kit that made
    nothing replaces only a kit that made nothing either (the pictures an
    earlier kit made stay), and raises nothing_made for the caller to
    report. A panel's kit is a draft edit (the owner publishes). A publish's
    kit completes that publish: when the snapshot is still that revision,
    its expressions are published at once (republish) and the draft stays
    in step; when the owner published again or edited meanwhile, it is a
    draft edit like any other."""
    storage = get_storage()
    stale: list[str] = []
    async with avatar_edits.hold(origin.avatar_id), get_session_factory()() as db:
        avatar = await load_avatar(db, origin.org_id, origin.avatar_id)
        if avatar is None:
            return
        if avatar.image_key != origin.image_key or not avatar.rig_key:
            raise Conflict409(
                "The avatar's picture changed while its expressions were made; make them again",
                code="picture_changed",
            )
        rig = json.loads(await storage.get_bytes(avatar.rig_key))
        if result.manifest is not None and rig.get("points") != origin.points:
            result.manifest = await run_cpu(rebase, result.manifest, rig["points"])
        previous = (load(avatar) or {}).get("kit")
        if not result.made and made_count(previous):
            raise nothing_made(result)
        in_step = (config_of(avatar) or {}).get("revision") == avatar.draft_revision
        stale = await store(
            avatar,
            storage,
            result,
            source=origin.source,
            picture=picture_of(avatar, rig.get("image_size") or [0, 0]),
        )
        published = config_of(avatar)
        if (
            origin.revision is not None
            and published is not None
            and published.get("revision") == origin.revision
        ):
            await republish(avatar, storage)
            if not in_step:
                mark_dirty(avatar)
        else:
            mark_dirty(avatar)
        await db.commit()
    for key in stale:
        await storage.delete(key)
    if not result.made:
        raise nothing_made(result)
