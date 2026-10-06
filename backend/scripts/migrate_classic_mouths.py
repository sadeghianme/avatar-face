"""Move every existing human photo avatar that still speaks with the classic
drawn mouth onto the photographic mouth with the standard teeth: exactly
what a new person gets today when AI makes nothing for them
(services.mouth_photo.default_config, the Reference's seat and size for the
standard teeth, docs/avatar-lines.md "The standard teeth"), in the DRAFT and
in the PUBLISHED snapshot both, so visitors see it without the owner
publishing again.

Which avatars: photo avatars of the human line, ready, whose mouth_config is
null or names the classic renderer with no character settings, and that have
no mouth files of their own (no teeth photo, no kit or motion): those keep
what they have. Never a 3D model, never an animal or an animation (the
photographic mouth draws human teeth), never an avatar mid-build.

What changes, per avatar, in one transaction: the draft's mouth_config
becomes default_config("human") plus the teeth record
{source: null, note: {code: "migrated_standard", detail}} (the Mouth panel
words it); the live snapshot's "mouth" key is rewritten from that draft the
way Publish writes it (publishing.republish_mouth) and nothing else in it
moves — not the revision, so an avatar in step with its snapshot stays in
step, and one with unpublished edits keeps them unpublished. Nothing is
marked dirty, nothing is published, no file is written.

Reversible: --apply first writes a JSON backup of every touched avatar's
previous mouth_config and published_config (and the values it is about to
write) under --backup-dir; --revert <backup.json> puts those exact values
back, skipping an avatar edited since unless --force. Idempotent: a migrated
avatar has the photographic mouth and is not selected again.

Dry run by default. Run inside the API container, from backend/:

    python -m scripts.migrate_classic_mouths                       # the table, nothing written
    python -m scripts.migrate_classic_mouths --apply --yes --backup-dir /data/migrations
    python -m scripts.migrate_classic_mouths --revert /data/migrations/classic-mouths-<stamp>.json

Exit status 1 when any avatar could not be migrated (or reverted); the
others are done, and the failed ones are listed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger("liveface.migrate_classic_mouths")

SCRIPT = "migrate_classic_mouths"
BACKUP_VERSION = 1


# --- Selection ---------------------------------------------------------------------


def classic_renderer(avatar) -> str | None:
    """"null" for an avatar whose mouth was never set (the classic mouth,
    as every avatar had before the photographic one), "classic" for one
    that names it; None for anything else, which this leaves alone: the
    photographic mouth already, a config this server cannot read, the
    owner's character settings, or mouth files of its own (a teeth photo,
    a kit, its motion)."""
    from app.services.mouth import load

    raw = getattr(avatar, "mouth_config", None)
    if not raw:
        return "null"
    config = load(raw)
    if config is None or config.get("renderer") != "classic":
        return None
    if config.get("character") is not None:
        return None
    if any(config.get(key) for key in ("oral_image_key", "oral_rig_key", "motion_key", "kit")):
        return None
    return "classic"


def selected(avatar) -> bool:
    from app.models.avatar import AvatarKind, AvatarStatus

    return (
        avatar.kind == AvatarKind.photo
        and avatar.face_type == "human"
        and avatar.status == AvatarStatus.ready
        and classic_renderer(avatar) is not None
    )


# --- The plan -----------------------------------------------------------------------


@dataclass
class Plan:
    """One avatar's migration, decided before anything is written: what it
    has (`before`), what it gets (`after`), both as the columns' exact
    text so a revert is byte for byte."""

    id: str
    name: str
    org_id: str
    current: str  # "null" | "classic"
    published: bool
    unpublished_changes: bool
    before: dict = field(default_factory=dict)  # {mouth_config, published_config}
    after: dict = field(default_factory=dict)

    def change(self) -> str:
        draft = "draft: classic → photographic mouth, standard teeth"
        if not self.published:
            return f"{draft}; never published, nothing to serve"
        snapshot = "published mouth → photographic, standard teeth"
        if json.loads(self.after["published_config"]).get("mouth") is None:
            snapshot = "published mouth unchanged (its snapshot is not a human face)"
        return f"{draft}; {snapshot}"


def today() -> str:
    return datetime.now(UTC).date().isoformat()


async def plan_for(avatar, storage, day: str) -> Plan:
    """The migration of one selected avatar, computed on the object and
    rolled back by the caller: nothing here is committed."""
    from app.services import mouth, mouth_photo
    from app.services.publishing import config_of, has_unpublished_changes, republish_mouth

    before = {
        "mouth_config": avatar.mouth_config,
        "published_config": avatar.published_config,
    }
    plan = Plan(
        id=avatar.id,
        name=avatar.name,
        org_id=avatar.org_id,
        current=classic_renderer(avatar) or "?",
        published=config_of(avatar) is not None,
        unpublished_changes=has_unpublished_changes(avatar),
        before=before,
    )
    config = mouth_photo.default_config("human")
    assert config is not None, "a human face is allowed the photographic mouth"
    config["teeth"] = mouth.migrated_teeth_record(day)
    avatar.mouth_config = json.dumps(config)
    await republish_mouth(avatar, storage)
    plan.after = {
        "mouth_config": avatar.mouth_config,
        "published_config": avatar.published_config,
    }
    # The object is not the database: back to what it was, for the caller.
    avatar.mouth_config = before["mouth_config"]
    avatar.published_config = before["published_config"]
    return plan


async def make_plans(day: str | None = None) -> list[Plan]:
    """Every avatar this would migrate, and how. Reads only."""
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar
    from app.models.avatar import AvatarKind, AvatarStatus
    from app.services.storage import get_storage

    day = day or today()
    storage = get_storage()
    plans: list[Plan] = []
    async with get_session_factory()() as db:
        rows = (
            await db.execute(
                select(Avatar)
                .where(
                    Avatar.kind == AvatarKind.photo,
                    Avatar.face_type == "human",
                    Avatar.status == AvatarStatus.ready,
                )
                .order_by(Avatar.created_at, Avatar.id)
            )
        ).scalars().all()
        # Detached: whatever plan_for does to them never reaches the database.
        db.expunge_all()
    for avatar in rows:
        if selected(avatar):
            plans.append(await plan_for(avatar, storage, day))
    return plans


# --- Backup and apply ----------------------------------------------------------------


def write_backup(plans: list[Plan], backup_dir: Path) -> Path:
    """Every planned avatar's previous values (and the ones about to be
    written), as --revert reads them. Written before anything changes."""
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    path = backup_dir / f"classic-mouths-{stamp}.json"
    if path.exists():
        raise FileExistsError(f"{path} exists; not overwriting a backup")
    payload = {
        "script": SCRIPT,
        "version": BACKUP_VERSION,
        "written_at": datetime.now(UTC).isoformat(),
        "avatars": [asdict(plan) for plan in plans],
    }
    path.write_text(json.dumps(payload, indent=2))
    return path


class Changed(Exception):
    """The row is not what the plan was made from."""


async def apply_plan(db, plan: Plan) -> None:
    """Write one avatar's planned values, if the row still holds the values
    the plan (and the backup) was made from; else Changed, and nothing is
    written for it. The caller commits."""
    from sqlalchemy import select

    from app.models import Avatar

    avatar = (await db.execute(select(Avatar).where(Avatar.id == plan.id))).scalar_one_or_none()
    if avatar is None:
        raise Changed("the avatar is gone")
    if (
        avatar.mouth_config != plan.before["mouth_config"]
        or avatar.published_config != plan.before["published_config"]
    ):
        raise Changed("the avatar was edited since the plan was made; run again")
    if not selected(avatar):
        raise Changed("the avatar no longer qualifies; run again")
    avatar.mouth_config = plan.after["mouth_config"]
    avatar.published_config = plan.after["published_config"]


@dataclass
class Outcome:
    done: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failed


async def apply(plans: list[Plan]) -> Outcome:
    """Each avatar in its own transaction: one that fails is left exactly
    as it was and the rest go on."""
    from app.db import get_session_factory

    outcome = Outcome()
    factory = get_session_factory()
    for plan in plans:
        try:
            async with factory() as db:
                await apply_plan(db, plan)
                await db.commit()
        except Exception as exc:  # noqa: BLE001 — every failure is reported, none stops the rest
            logger.error("avatar %s (%s): not migrated: %s", plan.id, plan.name, exc)
            outcome.failed.append((plan.id, str(exc)))
            continue
        logger.info("avatar %s (%s): migrated", plan.id, plan.name)
        outcome.done.append(plan.id)
    return outcome


# --- Revert --------------------------------------------------------------------------


def read_backup(path: Path) -> list[dict]:
    payload = json.loads(path.read_text())
    if payload.get("script") != SCRIPT or payload.get("version") != BACKUP_VERSION:
        raise ValueError(f"{path} is not a backup this script wrote")
    return payload["avatars"]


async def revert(path: Path, force: bool = False) -> Outcome:
    """Put back the exact mouth_config and published_config the backup
    holds, one avatar per transaction. An avatar whose columns are not
    what the migration wrote was edited since (an upload, a publish): it
    is skipped, and reported, unless `force`."""
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar

    outcome = Outcome()
    factory = get_session_factory()
    for entry in read_backup(path):
        avatar_id, name = entry["id"], entry.get("name", "")
        try:
            async with factory() as db:
                avatar = (
                    await db.execute(select(Avatar).where(Avatar.id == avatar_id))
                ).scalar_one_or_none()
                if avatar is None:
                    raise Changed("the avatar is gone")
                as_written = (
                    avatar.mouth_config == entry["after"]["mouth_config"]
                    and avatar.published_config == entry["after"]["published_config"]
                )
                if not as_written and not force:
                    raise Changed("edited since the migration; not reverted (use --force to insist)")
                avatar.mouth_config = entry["before"]["mouth_config"]
                avatar.published_config = entry["before"]["published_config"]
                await db.commit()
        except Exception as exc:  # noqa: BLE001
            logger.error("avatar %s (%s): not reverted: %s", avatar_id, name, exc)
            outcome.failed.append((avatar_id, str(exc)))
            continue
        logger.info("avatar %s (%s): reverted", avatar_id, name)
        outcome.done.append(avatar_id)
    return outcome


# --- The command ----------------------------------------------------------------------


def table(plans: list[Plan]) -> str:
    if not plans:
        return "no avatar has the classic mouth to move"
    rows = [("id", "name", "renderer", "published", "change")]
    for plan in plans:
        published = (
            "no" if not plan.published
            else "yes, unpublished edits" if plan.unpublished_changes
            else "yes"
        )
        rows.append((plan.id, plan.name, plan.current, published, plan.change()))
    widths = [max(len(row[i]) for row in rows) for i in range(4)]
    lines = []
    for row in rows:
        cells = [row[i].ljust(widths[i]) for i in range(4)] + [row[4]]
        lines.append("  ".join(cells).rstrip())
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True,
                      help="list what would change (the default)")
    mode.add_argument("--apply", action="store_true", help="write the draft and the snapshot")
    mode.add_argument("--revert", metavar="BACKUP", type=Path,
                      help="restore the values a backup holds")
    parser.add_argument("--yes", action="store_true", help="required with --apply")
    parser.add_argument("--backup-dir", type=Path, metavar="DIR",
                        help="where --apply writes its backup first (required)")
    parser.add_argument("--force", action="store_true",
                        help="with --revert: restore avatars edited since the migration too")
    args = parser.parse_args(argv)

    if args.revert is not None:
        if args.yes or args.backup_dir:
            parser.error("--revert takes only the backup (and --force)")
    elif args.apply:
        if not args.yes:
            parser.error("--apply changes every listed avatar; add --yes to confirm")
        if args.backup_dir is None:
            parser.error("--apply needs --backup-dir DIR for the backup it writes first")
    elif args.yes or args.backup_dir or args.force:
        parser.error("--yes, --backup-dir and --force go with --apply or --revert")

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    # One loop for everything: the engine's connections belong to it.
    return asyncio.run(run(args))


async def run(args: argparse.Namespace) -> int:
    if args.revert is not None:
        outcome = await revert(args.revert, force=args.force)
        print(f"{len(outcome.done)} avatar(s) reverted" + _failures(outcome))
        return 0 if outcome.ok else 1

    plans = await make_plans()
    print(table(plans))
    if not args.apply:
        print(f"{len(plans)} avatar(s) would move; run with --apply --yes --backup-dir DIR to write")
        return 0
    if not plans:
        return 0
    backup = write_backup(plans, args.backup_dir)
    print(f"backup written to {backup}")
    outcome = await apply(plans)
    print(f"{len(outcome.done)} avatar(s) moved" + _failures(outcome))
    print(f"to undo: python -m scripts.{SCRIPT} --revert {backup}")
    return 0 if outcome.ok else 1


def _failures(outcome: Outcome) -> str:
    if outcome.ok:
        return ""
    return f"; {len(outcome.failed)} FAILED:\n" + "\n".join(
        f"  {avatar_id}: {why}" for avatar_id, why in outcome.failed
    )


if __name__ == "__main__":
    sys.exit(main())
