"""The one-off move of existing human avatars from the classic drawn mouth
onto the photographic one with the standard teeth, draft and snapshot both
(scripts/migrate_classic_mouths)."""

import json
from types import SimpleNamespace

import pytest
from sqlalchemy import select, update

from app.db import get_session_factory
from app.models import Avatar
from app.models.avatar import AvatarStatus
from app.services import mouth_photo
from app.services.performance_kit import REFERENCE_TEETH_SCALE, REFERENCE_TEETH_Y
from scripts import migrate_classic_mouths as script
from scripts.migrate_classic_mouths import (
    apply,
    main,
    make_plans,
    read_backup,
    revert,
    table,
    write_backup,
)
from tests.conftest import create_org, create_ready_avatar, register_and_login
from tests.test_model3d import _upload_glb

DAY = "2026-10-05"
# What a new person gets today without AI, plus why this one has no teeth
# of its own.
MIGRATED = {
    **mouth_photo.default_config("human"),
    "teeth": {
        "source": None,
        "note": {
            "code": "migrated_standard",
            "detail": f"Standard teeth: moved from the classic mouth on {DAY}",
        },
    },
}


async def _row(avatar_id: str) -> Avatar:
    async with get_session_factory()() as db:
        return (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()


async def _set(avatar_id: str, **values) -> None:
    async with get_session_factory()() as db:
        await db.execute(update(Avatar).where(Avatar.id == avatar_id).values(**values))
        await db.commit()


async def _state(avatar_id: str) -> tuple:
    """Everything the migration may and may not touch, byte for byte."""
    row = await _row(avatar_id)
    return (
        row.mouth_config, row.published_config, row.draft_revision,
        row.face_type, row.status, row.kind, row.framing,
    )


async def _states(ids) -> dict[str, tuple]:
    return {avatar_id: await _state(avatar_id) for avatar_id in ids}


@pytest.fixture
async def world(client):
    """A production database's avatars: two classic humans (one published
    and in step, one with the classic renderer set as an unpublished edit),
    and everything the migration must leave alone."""
    headers = await register_and_login(client, "migrator")
    org_id = await create_org(client, headers)
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    visitor = {"X-Api-Key": key.json()["plaintext"]}

    def url(avatar_id: str) -> str:
        return f"/orgs/{org_id}/avatars/{avatar_id}"

    async def human(name: str) -> str:
        avatar_id = await create_ready_avatar(client, headers, org_id)
        await _set(avatar_id, name=name)
        return avatar_id

    # Never had a mouth set: mouth_config null, published with mouth null.
    classic = await human("Classic Carl")
    # Chose the classic renderer in the Mouth panel after publishing: the
    # draft names it, the snapshot does not, and the edit is unpublished.
    edited = await human("Edited Edna")
    patched = await client.patch(url(edited), json={"mouth": {"renderer": "classic"}}, headers=headers)
    assert patched.status_code == 200 and patched.json()["unpublished"] is True
    # Already the photographic mouth, with a fit of its own.
    continuous = await human("Continuous Cora")
    await client.patch(
        url(continuous),
        json={"mouth": {"renderer": "continuous", "profile": {"teethScale": 1.1}}},
        headers=headers,
    )
    assert (await client.post(f"{url(continuous)}/publish", headers=headers)).status_code == 200
    # A kit of its own (its motion), on the classic renderer.
    kit = await human("Kit Kim")
    await _set(kit, mouth_config=json.dumps({
        "renderer": "classic", "profile": {},
        "motion_key": f"orgs/{org_id}/avatars/{kit}/mouth-motion-abc.json",
        "kit": {"id": "k1", "generated": 6},
    }))
    # The owner's teeth photo, on the classic renderer.
    photo = await human("Photo Pat")
    await _set(photo, mouth_config=json.dumps({
        "renderer": "classic", "profile": {},
        "oral_image_key": f"orgs/{org_id}/avatars/{photo}/mouth-abc.webp",
        "oral_rig_key": f"orgs/{org_id}/avatars/{photo}/mouth-abc.json",
        "teeth": {"source": "upload"},
    }))
    # Another line: the photographic mouth draws human teeth.
    cartoon = await human("Cartoon Cat")
    await client.patch(url(cartoon), json={"face_type": "cartoon"}, headers=headers)
    assert (await client.post(f"{url(cartoon)}/publish", headers=headers)).status_code == 200
    # Not ready.
    failed = await human("Failed Fay")
    await _set(failed, status=AvatarStatus.failed)
    # A 3D model.
    model = await _upload_glb(client, headers, org_id)
    assert (await client.get(url(model), headers=headers)).json()["status"] == "ready"

    return SimpleNamespace(
        headers=headers, org_id=org_id, visitor=visitor, url=url,
        classic=classic, edited=edited, moved=[classic, edited],
        untouched=[continuous, kit, photo, cartoon, failed, model],
        continuous=continuous,
    )


async def _migrate(world, tmp_path):
    plans = await make_plans(day=DAY)
    backup = write_backup(plans, tmp_path / "backups")
    outcome = await apply(plans)
    assert outcome.ok, outcome.failed
    return plans, backup


async def test_the_dry_run_lists_the_classic_humans_and_writes_nothing(client, world):
    before = await _states(world.moved + world.untouched)
    plans = await make_plans(day=DAY)
    assert [plan.id for plan in plans] == world.moved
    carl, edna = plans
    assert (carl.current, carl.published, carl.unpublished_changes) == ("null", True, False)
    assert (edna.current, edna.published, edna.unpublished_changes) == ("classic", True, True)
    assert carl.before["mouth_config"] is None
    assert json.loads(edna.before["mouth_config"])["renderer"] == "classic"
    assert json.loads(carl.after["mouth_config"]) == MIGRATED
    assert json.loads(carl.after["published_config"])["mouth"] == MIGRATED

    assert await _states(world.moved + world.untouched) == before, "a dry run writes nothing"
    text = table(plans)
    assert "Classic Carl" in text and "Edited Edna" in text
    assert "yes, unpublished edits" in text and "published mouth → photographic" in text


async def test_apply_moves_the_draft_and_the_snapshot_of_the_right_avatars_only(
    client, world, tmp_path
):
    before = await _states(world.moved + world.untouched)
    plans, backup = await _migrate(world, tmp_path)

    for avatar_id in world.moved:
        row = await _row(avatar_id)
        assert json.loads(row.mouth_config) == MIGRATED
        assert MIGRATED["profile"] == {"teethY": REFERENCE_TEETH_Y, "teethScale": REFERENCE_TEETH_SCALE}
        published, was = json.loads(row.published_config), json.loads(before[avatar_id][1])
        assert published["mouth"] == MIGRATED
        assert was["mouth"] is None
        without = lambda c: {k: v for k, v in c.items() if k != "mouth"}  # noqa: E731
        assert without(published) == without(was), "nothing but the mouth moves in the snapshot"
        assert row.draft_revision == before[avatar_id][2], "nothing is marked dirty"
    for avatar_id in world.untouched:
        assert await _state(avatar_id) == before[avatar_id]

    # In step stays in step; an unpublished edit stays unpublished.
    carl = (await client.get(world.url(world.classic), headers=world.headers)).json()
    edna = (await client.get(world.url(world.edited), headers=world.headers)).json()
    assert carl["unpublished"] is False and edna["unpublished"] is True

    # The snapshot's mouth is what Publish writes for this draft.
    published = await client.post(f"{world.url(world.edited)}/publish", headers=world.headers)
    assert published.status_code == 200
    assert json.loads((await _row(world.edited)).published_config)["mouth"] == MIGRATED

    # The backup holds the previous values and the written ones, exactly.
    entries = {entry["id"]: entry for entry in read_backup(backup)}
    assert set(entries) == set(world.moved)
    for avatar_id in world.moved:
        assert entries[avatar_id]["before"] == {
            "mouth_config": before[avatar_id][0], "published_config": before[avatar_id][1],
        }
    assert json.loads(entries[world.classic]["after"]["mouth_config"]) == MIGRATED


async def test_visitors_get_the_photographic_mouth_with_the_standard_teeth(
    client, world, tmp_path
):
    await _migrate(world, tmp_path)
    served = (await client.get(f"/embed/v1/avatars/{world.classic}", headers=world.visitor)).json()
    assert served["mouth"] == {
        "renderer": "continuous",
        "profile": {"teethY": REFERENCE_TEETH_Y, "teethScale": REFERENCE_TEETH_SCALE},
        "character": None,
        "oral": None,  # the standard teeth, loaded beside the bundled motion
        "motion_url": None,
    }
    # The owner sees the note, never a storage key.
    detail = (await client.get(world.url(world.classic), headers=world.headers)).json()
    assert detail["mouth"]["renderer"] == "continuous"
    assert detail["mouth"]["has_oral_photo"] is False
    assert detail["mouth"]["teeth"] == MIGRATED["teeth"]
    assert detail["mouth"]["kit"] is None
    assert detail["unpublished"] is False
    # An avatar that had its own fit keeps it.
    cora = (await client.get(f"/embed/v1/avatars/{world.continuous}", headers=world.visitor)).json()
    assert cora["mouth"]["profile"]["teethScale"] == 1.1


async def test_revert_restores_every_value_byte_for_byte(client, world, tmp_path):
    before = await _states(world.moved + world.untouched)
    _, backup = await _migrate(world, tmp_path)
    assert await _state(world.classic) != before[world.classic]

    outcome = await revert(backup)
    assert outcome.ok and sorted(outcome.done) == sorted(world.moved)
    assert await _states(world.moved + world.untouched) == before
    served = (await client.get(f"/embed/v1/avatars/{world.classic}", headers=world.visitor)).json()
    assert served["mouth"] is None


async def test_revert_leaves_an_avatar_edited_since_alone_unless_forced(client, world, tmp_path):
    before = await _states(world.moved)
    _, backup = await _migrate(world, tmp_path)
    moved = await client.patch(
        world.url(world.classic),
        json={"mouth": {"renderer": "continuous", "profile": {"teethScale": 1.2}}},
        headers=world.headers,
    )
    assert moved.status_code == 200
    edited_since = await _state(world.classic)

    outcome = await revert(backup)
    assert outcome.done == [world.edited]
    assert [avatar_id for avatar_id, _ in outcome.failed] == [world.classic]
    assert "edited since" in outcome.failed[0][1]
    assert await _state(world.classic) == edited_since
    assert await _state(world.edited) == before[world.edited]

    forced = await revert(backup, force=True)
    assert forced.ok
    row = await _row(world.classic)
    assert (row.mouth_config, row.published_config) == before[world.classic][:2]


async def test_a_second_apply_finds_nothing_to_do(client, world, tmp_path):
    await _migrate(world, tmp_path)
    after = await _states(world.moved + world.untouched)
    plans = await make_plans(day=DAY)
    assert plans == []
    assert (await apply(plans)).ok
    assert await _states(world.moved + world.untouched) == after


async def test_one_failure_leaves_that_avatar_as_it_was_and_the_rest_go_on(
    client, world, tmp_path, monkeypatch
):
    before = await _states(world.moved)
    plans = await make_plans(day=DAY)
    write_backup(plans, tmp_path)
    real = script.apply_plan

    async def flaky(db, plan):
        if plan.id == world.classic:
            raise RuntimeError("disk on fire")
        await real(db, plan)

    monkeypatch.setattr(script, "apply_plan", flaky)
    outcome = await apply(plans)
    assert outcome.done == [world.edited]
    assert outcome.failed == [(world.classic, "disk on fire")]
    assert await _state(world.classic) == before[world.classic]
    assert json.loads((await _row(world.edited)).mouth_config) == MIGRATED


async def test_a_row_that_changed_since_the_plan_is_not_overwritten(client, world, tmp_path):
    plans = await make_plans(day=DAY)
    write_backup(plans, tmp_path)
    # Between the plan and the write, the owner uploads nothing but moves
    # the fit: the row is no longer what the backup holds.
    moved = await client.patch(
        world.url(world.classic),
        json={"mouth": {"renderer": "classic", "profile": {"teethScale": 1.2}}},
        headers=world.headers,
    )
    assert moved.status_code == 200, moved.text
    outcome = await apply(plans)
    assert outcome.done == [world.edited]
    assert [avatar_id for avatar_id, _ in outcome.failed] == [world.classic]
    row = await _row(world.classic)
    assert json.loads(row.mouth_config)["profile"]["teethScale"] == 1.2
    assert json.loads(row.published_config)["mouth"] is None
    # Planned again, it moves: the plan is made from the row as it is now.
    again = await make_plans(day=DAY)
    assert [plan.id for plan in again] == [world.classic]
    assert (await apply(again)).ok


def test_the_backup_refuses_to_be_overwritten_and_names_its_script(tmp_path):
    (tmp_path / "x.json").write_text(json.dumps({"script": "something_else", "version": 1}))
    with pytest.raises(ValueError):
        read_backup(tmp_path / "x.json")


def test_apply_insists_on_yes_and_a_backup_dir():
    """Nothing here reaches the database: the parser refuses first."""
    for argv in (
        ["--apply"],
        ["--apply", "--yes"],
        ["--apply", "--backup-dir", "/tmp/x"],
        ["--yes"],
        ["--backup-dir", "/tmp/x"],
        ["--revert", "b.json", "--yes"],
        ["--revert", "b.json", "--apply"],
    ):
        with pytest.raises(SystemExit) as refused:
            main(argv)
        assert refused.value.code == 2, argv
