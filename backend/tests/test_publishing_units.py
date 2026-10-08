"""Unit tests, no HTTP, of the draft/published split and the records it
carries: services.publishing driven with in-memory Avatars and an in-memory
Storage, and the leaves it builds on: services.disclosure (what visitors are
told AI made), services.scene (zoom, pan, background) and services.mouth
(which renderer a face may have, the character settings, the mouth's keys
and presigned URLs, the teeth records).

The behaviour through the API (the Publish bar, embed and share serving the
snapshot) is pinned in test_publishing, test_scene, test_mouth_config and
test_voice_publishing; these pin the decisions inside the functions.
"""

from __future__ import annotations

import copy
import json
import logging
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.models import Avatar
from app.services import disclosure, publishing
from app.services import mouth as mouth_service
from app.services import scene as scene_service
from app.services.layers import layer_key
from app.services.storage import Storage

ORG, AID = "o1", "a1"
ROOT = f"orgs/{ORG}/avatars/{AID}/"
P3 = publishing.published_prefix(ORG, AID, 3)
STAMP = "feedc0de"
SIGNED = "https://signed/"
VOICE = {"provider": "piper", "voice": "fa_amir", "locale": "fa-IR"}
CHARACTER = {"style": "classic", "teeth": "none", "tongue": False, "jaw": 1.3}
KIT = {"id": "k1", "state": "made", "generated": 6, "model": "s"}


class FakeStorage(Storage):
    """Bytes in a dict; a presigned URL is the key behind a fixed origin."""

    def __init__(self, files: dict[str, bytes] | None = None):
        self.files: dict[str, bytes] = dict(files or {})
        self.types: dict[str, str] = {}
        self.broken_listing = False
        self.undeletable: set[str] = set()

    async def presign_get(self, key: str) -> str:
        return f"{SIGNED}{key}"

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.files[key] = data
        self.types[key] = content_type

    async def get_bytes(self, key: str) -> bytes:
        try:
            return self.files[key]
        except KeyError as exc:
            raise FileNotFoundError(key) from exc

    async def exists(self, key: str) -> bool:
        return key in self.files

    async def list_names(self, prefix: str) -> list[str]:
        if self.broken_listing:
            raise OSError("listing unavailable")
        return sorted(
            {k[len(prefix) :].split("/", 1)[0] for k in self.files if k.startswith(prefix)}
        )

    async def delete(self, key: str) -> None:
        if key in self.undeletable:
            raise OSError(f"cannot delete {key}")
        self.files.pop(key, None)

    async def delete_prefix(self, prefix: str) -> int:
        if prefix in self.undeletable:
            raise OSError(f"cannot delete {prefix}")
        doomed = [k for k in self.files if k.startswith(prefix)]
        for key in doomed:
            del self.files[key]
        return len(doomed)

    def names_under(self, prefix: str) -> list[str]:
        return sorted(
            {k[len(prefix) :].split("/", 1)[0] for k in self.files if k.startswith(prefix)}
        )


def _avatar(**fields) -> Avatar:
    """An Avatar row built in memory, never flushed: every column the code
    reads is given, since column defaults only apply on insert."""
    values = {
        "id": AID,
        "org_id": ORG,
        "name": "Ada",
        "content_type": "image/png",
        "framing": "face",
        "face_type": "human",
        "draft_revision": 0,
        "has_layers": False,
        "image_key": None,
        "rig_key": None,
        "thumbnail_key": None,
        "mouth_config": None,
        "voice_config": None,
        "published_config": None,
        "ai_edited": None,
        "scene_config": None,
    }
    values.update(fields)
    return Avatar(**values)


def _snapshot(**fields) -> dict:
    """A published config at revision 3, as `publish` writes one."""
    config = {
        "revision": 3,
        "framing": "face",
        "scene": None,
        "face_type": "human",
        "voice": None,
        "mouth": None,
        "image_key": f"{P3}/image.png",
        "rig_key": None,
        "thumbnail_key": None,
        "layer_keys": None,
        "disclosure": {"ai_edited": None, "line": "human"},
        "published_at": "2026-01-02T03:04:05+00:00",
    }
    config.update(fields)
    return config


@pytest.fixture
def stamp(monkeypatch):
    """The fresh-key stamp (uuid4().hex[:8]) made predictable."""
    fixed = SimpleNamespace(hex=STAMP + "0" * 24)
    monkeypatch.setattr(publishing, "uuid4", lambda: fixed)
    monkeypatch.setattr(scene_service, "uuid4", lambda: fixed)
    return STAMP


# --- publishing: the counter and the snapshot record ------------------------------------


def test_config_of_is_none_until_published_and_for_an_unreadable_snapshot(caplog):
    assert publishing.config_of(_avatar()) is None
    assert publishing.config_of(_avatar(published_config="")) is None
    with caplog.at_level(logging.WARNING, logger="liveface.publishing"):
        assert publishing.config_of(_avatar(published_config="{not json")) is None
    assert f"avatar {AID} has unreadable published_config" in caplog.text
    assert publishing.config_of(_avatar(published_config='{"revision": 4}')) == {"revision": 4}


def test_unpublished_changes_are_the_counter_and_the_snapshot_disagreeing():
    assert publishing.has_unpublished_changes(_avatar(draft_revision=0)) is True, "never published"
    live = _avatar(draft_revision=3, published_config=json.dumps({"revision": 3}))
    assert publishing.has_unpublished_changes(live) is False
    publishing.mark_dirty(live)
    assert live.draft_revision == 4
    assert publishing.has_unpublished_changes(live) is True


def test_mark_dirty_counts_from_nothing_on_an_avatar_not_yet_flushed():
    """A row built in memory has no column default yet: None counts as 0."""
    avatar = Avatar(id=AID, org_id=ORG)
    assert avatar.draft_revision is None
    publishing.mark_dirty(avatar)
    publishing.mark_dirty(avatar)
    assert avatar.draft_revision == 2


def test_a_confirmed_note_keeps_its_reason_and_loses_only_a_trailing_instruction():
    instruction = publishing.CONFIRM_BEFORE_PUBLISH
    reason = "The face is small in the picture."
    assert publishing.confirmed(None) is None
    assert publishing.confirmed(reason) == reason
    assert publishing.confirmed(f"{reason} {instruction}") == reason
    assert publishing.confirmed(instruction) is None, "nothing but the instruction: no note"
    assert publishing.confirmed(f"{instruction} {reason}") == f"{instruction} {reason}"


def test_the_extension_is_the_file_names_never_a_folders():
    assert publishing._ext(f"{ROOT}rig.json", "png") == "json"
    assert publishing._ext("orgs/o.x/avatars/a/source", "png") == "png"
    assert publishing._ext("orgs/o/avatars/a/backup.tar.gz", "png") == "gz"


@pytest.mark.parametrize(
    "key, expected",
    [
        ("a/image.png", "image/png"),
        ("a/thumb.jpg", "image/jpeg"),
        ("a/photo.jpeg", "image/jpeg"),
        ("a/scene.webp", "image/webp"),
        ("a/rig.json", "application/json"),
        ("a/model.glb", "model/gltf-binary"),
        ("a/blob.bin", "application/octet-stream"),
        ("a.b/no-extension", "application/octet-stream"),
    ],
)
def test_a_copys_content_type_follows_its_extension(key, expected):
    assert publishing._content_type(key) == expected


# --- publish_mouth: the snapshot's mouth -------------------------------------------------


async def test_no_mouth_publishes_as_the_classic_one():
    copy_ = publishing._copier(FakeStorage(), P3)
    assert await publishing.publish_mouth(None, "human", copy_) is None
    assert await publishing.publish_mouth({}, "human", copy_) is None


@pytest.mark.parametrize("face_type", ["animal", "cartoon"])
async def test_a_photographic_mouth_on_a_face_that_may_not_have_it_publishes_as_the_classic_one(
    face_type,
):
    """Whatever route put it in the draft: human teeth never reach a muzzle,
    and none of its files are copied."""
    storage = FakeStorage({f"{ROOT}mouth-s1.webp": b"teeth", f"{ROOT}mouth-s1.json": b"rig"})
    mouth = {
        "renderer": "continuous",
        "profile": {"teethScale": 1.1},
        "oral_image_key": f"{ROOT}mouth-s1.webp",
        "oral_rig_key": f"{ROOT}mouth-s1.json",
    }
    assert await publishing.publish_mouth(mouth, face_type, publishing._copier(storage, P3)) is None
    assert storage.names_under(f"{ROOT}published/") == []


async def test_the_classic_mouth_publishes_on_any_face_with_the_owners_character_settings():
    mouth = {"renderer": "classic", "profile": None, "character": CHARACTER}
    published = await publishing.publish_mouth(
        mouth, "animal", publishing._copier(FakeStorage(), P3)
    )
    assert published == {"renderer": "classic", "profile": {}, "character": CHARACTER}
    no_settings = {"renderer": "classic", "profile": {"teethY": 0.02}, "character": None}
    assert await publishing.publish_mouth(
        no_settings, "animal", publishing._copier(FakeStorage(), P3)
    ) == {"renderer": "classic", "profile": {"teethY": 0.02}}


async def test_a_photographic_mouth_is_copied_under_the_snapshots_keys_with_its_records():
    storage = FakeStorage(
        {
            f"{ROOT}mouth-s1.webp": b"teeth",
            f"{ROOT}mouth-s1.json": b"rig",
            f"{ROOT}mouth-motion-s1.json": b"motion",
        }
    )
    teeth = {"source": "ai", "model": "t"}
    mouth = {
        "renderer": "continuous",
        "profile": {"teethScale": 1.1},
        "oral_image_key": f"{ROOT}mouth-s1.webp",
        "oral_rig_key": f"{ROOT}mouth-s1.json",
        "motion_key": f"{ROOT}mouth-motion-s1.json",
        "teeth": teeth,
        "kit": KIT,
    }
    published = await publishing.publish_mouth(mouth, "human", publishing._copier(storage, P3))
    assert published == {
        "renderer": "continuous",
        "profile": {"teethScale": 1.1},
        "oral_image_key": f"{P3}/mouth.webp",
        "oral_rig_key": f"{P3}/mouth-rig.json",
        "motion_key": f"{P3}/mouth-motion.json",
        "teeth": teeth,
        "kit": KIT,
    }
    assert storage.files[f"{P3}/mouth.webp"] == b"teeth"
    assert storage.files[f"{P3}/mouth-rig.json"] == b"rig"
    assert storage.files[f"{P3}/mouth-motion.json"] == b"motion"
    assert storage.types[f"{P3}/mouth.webp"] == "image/webp"
    assert storage.types[f"{P3}/mouth-motion.json"] == "application/json"


async def test_a_teeth_photo_without_its_rig_is_not_published_nor_a_motion_that_is_gone():
    """Both teeth files or neither: the engine cannot seat a photo without
    its landmarks. A named file that is gone is simply not published."""
    storage = FakeStorage({f"{ROOT}mouth-s1.webp": b"teeth"})
    mouth = {
        "renderer": "continuous",
        "profile": {},
        "oral_image_key": f"{ROOT}mouth-s1.webp",
        "oral_rig_key": f"{ROOT}mouth-s1.json",
        "motion_key": f"{ROOT}mouth-motion-s1.json",
    }
    published = await publishing.publish_mouth(mouth, "human", publishing._copier(storage, P3))
    assert published == {"renderer": "continuous", "profile": {}}


# --- publish: what a snapshot records ----------------------------------------------------


async def test_a_publish_copies_the_draft_into_its_revisions_folder_and_records_what_it_serves():
    storage = FakeStorage(
        {
            f"{ROOT}source.png": b"img",
            f"{ROOT}rig.json": b"rig",
            f"{ROOT}thumb.jpg": b"thumb",
        }
    )
    avatar = _avatar(
        draft_revision=5,
        framing="full",
        face_type="cartoon",
        voice_config=json.dumps(VOICE),
        image_key=f"{ROOT}source.png",
        rig_key=f"{ROOT}rig.json",
        thumbnail_key=f"{ROOT}thumb.jpg",
        ai_edited={"mode": "generate", "model": "g1"},
    )
    config = await publishing.publish(avatar, storage)

    prefix = f"{ROOT}published/r5"
    published_at = config.pop("published_at")
    assert config == {
        "revision": 5,
        "framing": "full",
        "scene": None,
        "face_type": "cartoon",
        "voice": VOICE,
        "mouth": None,
        "image_key": f"{prefix}/image.png",
        "rig_key": f"{prefix}/rig.json",
        "thumbnail_key": f"{prefix}/thumb.jpg",
        "layer_keys": None,
        "disclosure": {"ai_edited": {"mode": "generate", "model": "g1"}, "line": "cartoon"},
    }
    assert datetime.fromisoformat(published_at).utcoffset() is not None
    assert json.loads(avatar.published_config) == {**config, "published_at": published_at}
    assert storage.files[f"{prefix}/image.png"] == b"img"
    assert storage.types[f"{prefix}/thumb.jpg"] == "image/jpeg"
    assert publishing.has_unpublished_changes(avatar) is False
    # The draft's own files are untouched: the snapshot holds copies.
    assert avatar.image_key == f"{ROOT}source.png"
    assert storage.files[f"{ROOT}source.png"] == b"img"


@pytest.mark.parametrize("image_key", [None, f"{ROOT}gone.png"])
async def test_a_draft_without_its_picture_cannot_be_published_and_the_live_snapshot_stays(
    image_key,
):
    live = json.dumps(_snapshot())
    avatar = _avatar(draft_revision=4, image_key=image_key, published_config=live)
    with pytest.raises(ValueError, match="avatar has no image to publish"):
        await publishing.publish(avatar, FakeStorage())
    assert avatar.published_config == live


async def test_only_the_layers_that_exist_are_published_and_only_for_a_layered_avatar():
    files = {
        f"{ROOT}source.png": b"img",
        layer_key(ORG, AID, "background"): b"bg",
        layer_key(ORG, AID, "head"): b"head",
    }
    storage = FakeStorage(files)
    layered = _avatar(draft_revision=2, image_key=f"{ROOT}source.png", has_layers=True)
    config = await publishing.publish(layered, storage)
    prefix = f"{ROOT}published/r2"
    assert config["layer_keys"] == {
        "background": f"{prefix}/layer-background.jpg",
        "head": f"{prefix}/layer-head.png",
    }
    assert storage.types[f"{prefix}/layer-background.jpg"] == "image/jpeg"
    assert storage.files[f"{prefix}/layer-head.png"] == b"head"

    flat = _avatar(draft_revision=6, image_key=f"{ROOT}source.png", has_layers=False)
    assert (await publishing.publish(flat, FakeStorage(files)))["layer_keys"] is None


async def test_a_scene_is_published_by_value_without_a_picture_it_does_not_show():
    """A colour behind the cut-out, with a picture stored for later: the
    picture is neither copied nor named in the snapshot, and the draft keeps
    it."""
    draft_scene = {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "color", "color": "#1e3a8a", "image_key": f"{ROOT}scene-d1.webp"},
    }
    storage = FakeStorage({f"{ROOT}source.png": b"img", f"{ROOT}scene-d1.webp": b"bg"})
    avatar = _avatar(image_key=f"{ROOT}source.png", scene_config=copy.deepcopy(draft_scene))
    config = await publishing.publish(avatar, storage)
    assert config["scene"] == {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "color", "color": "#1e3a8a"},
    }
    assert avatar.scene_config == draft_scene
    assert f"{ROOT}published/r0/scene.webp" not in storage.files
    assert storage.files[f"{ROOT}scene-d1.webp"] == b"bg", "named by the draft: not swept"


async def test_a_shown_background_picture_is_copied_into_the_snapshot():
    storage = FakeStorage({f"{ROOT}source.png": b"img", f"{ROOT}scene-d1.webp": b"bg"})
    avatar = _avatar(
        draft_revision=1,
        image_key=f"{ROOT}source.png",
        scene_config={
            "zoom": 0.4,
            "pan": {"x": 0.0, "y": 0.0},
            "background": {"kind": "image", "image_key": f"{ROOT}scene-d1.webp"},
        },
    )
    config = await publishing.publish(avatar, storage)
    copied = f"{ROOT}published/r1/scene.webp"
    assert config["scene"]["background"] == {"kind": "image", "image_key": copied}
    assert storage.files[copied] == b"bg"
    assert storage.types[copied] == "image/webp"


async def test_a_shown_picture_whose_file_is_gone_publishes_as_transparent():
    storage = FakeStorage({f"{ROOT}source.png": b"img"})
    avatar = _avatar(
        image_key=f"{ROOT}source.png",
        scene_config={
            "zoom": 0.4,
            "pan": {"x": 0.5, "y": 0.0},
            "background": {"kind": "image", "image_key": f"{ROOT}scene-gone.webp"},
        },
    )
    config = await publishing.publish(avatar, storage)
    assert config["scene"] == {
        "zoom": 0.4,
        "pan": {"x": 0.5, "y": 0.0},
        "background": {"kind": "transparent"},
    }


AI_BOTH = {
    "mode": "teeth",
    "model": "t",
    "teeth": {"model": "t"},
    "mouth_shapes": {"model": "s", "generated": 6},
}


@pytest.mark.parametrize(
    "face_type, present, expected",
    [
        ("human", ("mouth-s1.webp", "mouth-s1.json", "mouth-motion-s1.json"), AI_BOTH),
        (
            "human",
            ("mouth-s1.webp", "mouth-s1.json"),
            {"mode": "teeth", "model": "t", "teeth": {"model": "t"}},
        ),
        (
            "human",
            ("mouth-motion-s1.json",),
            {"mode": "mouth_shapes", "model": "s", "mouth_shapes": {"model": "s", "generated": 6}},
        ),
        ("animal", ("mouth-s1.webp", "mouth-s1.json", "mouth-motion-s1.json"), None),
    ],
)
async def test_ai_made_mouth_parts_are_disclosed_only_while_visitors_can_see_them(
    face_type, present, expected
):
    """The teeth label goes with a published teeth photo, the shapes label
    with a published motion; a muzzle gets neither, and the draft keeps
    both."""
    storage = FakeStorage({f"{ROOT}source.png": b"img"})
    for name in present:
        storage.files[f"{ROOT}{name}"] = b"x"
    mouth = {
        "renderer": "continuous",
        "profile": {},
        "oral_image_key": f"{ROOT}mouth-s1.webp",
        "oral_rig_key": f"{ROOT}mouth-s1.json",
        "motion_key": f"{ROOT}mouth-motion-s1.json",
    }
    avatar = _avatar(
        face_type=face_type,
        image_key=f"{ROOT}source.png",
        mouth_config=json.dumps(mouth),
        ai_edited=copy.deepcopy(AI_BOTH),
    )
    config = await publishing.publish(avatar, storage)
    assert config["disclosure"] == {"ai_edited": expected, "line": face_type}
    assert avatar.ai_edited == AI_BOTH
    if face_type == "animal":
        assert config["mouth"] is None


async def test_a_publish_keeps_the_live_and_the_previous_revision_and_prunes_the_rest():
    """Revisions have gaps (three edits, then a publish): the folders are
    listed, not counted down. Anything not named r<n> is left alone."""
    published = f"{ROOT}published/"
    storage = FakeStorage(
        {
            f"{ROOT}source.png": b"img",
            f"{published}r0/image.png": b"0",
            f"{published}r3/image.png": b"3",
            f"{published}r6/image.png": b"6",
            f"{published}r6x/image.png": b"?",
            f"{published}notes.txt": b"?",
        }
    )
    avatar = _avatar(
        draft_revision=9,
        image_key=f"{ROOT}source.png",
        published_config=json.dumps({"revision": 6, "image_key": f"{published}r6/image.png"}),
    )
    await publishing.publish(avatar, storage)
    assert storage.names_under(published) == ["notes.txt", "r6", "r6x", "r9"]


async def test_a_storage_that_cannot_list_or_prune_does_not_fail_the_publish():
    """Pruning and sweeping are housekeeping: the snapshot is recorded and
    what could not be removed stays until a later publish."""
    storage = FakeStorage(
        {
            f"{ROOT}source.png": b"img",
            f"{ROOT}published/r0/image.png": b"0",
            f"{ROOT}mouth-orphan.webp": b"x",
        }
    )
    storage.broken_listing = True
    avatar = _avatar(
        draft_revision=4,
        image_key=f"{ROOT}source.png",
        published_config=json.dumps({"revision": 1}),
    )
    config = await publishing.publish(avatar, storage)
    assert config["revision"] == 4
    assert f"{ROOT}published/r0/image.png" in storage.files
    assert f"{ROOT}mouth-orphan.webp" in storage.files

    storage.broken_listing = False
    storage.files[f"{ROOT}published/r1/image.png"] = b"1"
    storage.undeletable.add(f"{ROOT}published/r0/")
    avatar.draft_revision = 7
    await publishing.publish(avatar, storage)
    assert storage.names_under(f"{ROOT}published/") == ["r0", "r4", "r7"], "r1 pruned all the same"


async def test_a_publish_sweeps_the_drafts_orphaned_mouth_and_scene_files_only():
    named = ["mouth-cur.webp", "mouth-cur.json", "mouth-motion-cur.json", "scene-cur.webp"]
    orphans = ["mouth-old.webp", "mouth-old.json", "mouth-motion-old.json", "scene-old.webp"]
    others = ["source.png", "rig.json", "mouth-old.txt", "mouth.webp", "layers/head.png"]
    storage = FakeStorage({f"{ROOT}{name}": b"x" for name in named + orphans + others})
    storage.files[f"{ROOT}mouth-stuck.png"] = b"x"
    storage.undeletable.add(f"{ROOT}mouth-stuck.png")
    mouth = {
        "renderer": "continuous",
        "profile": {},
        "oral_image_key": f"{ROOT}mouth-cur.webp",
        "oral_rig_key": f"{ROOT}mouth-cur.json",
        "motion_key": f"{ROOT}mouth-motion-cur.json",
    }
    scene = {
        "zoom": 1.0,
        "pan": {"x": 0.0, "y": 0.0},
        "background": {"kind": "color", "color": "#112233", "image_key": f"{ROOT}scene-cur.webp"},
    }
    avatar = _avatar(
        image_key=f"{ROOT}source.png", mouth_config=json.dumps(mouth), scene_config=scene
    )
    await publishing.publish(avatar, storage)
    for name in orphans:
        assert f"{ROOT}{name}" not in storage.files, name
    for name in [*named, *others, "mouth-stuck.png"]:
        assert f"{ROOT}{name}" in storage.files, name


# --- republish_mouth ---------------------------------------------------------------------


async def test_republishing_the_mouth_rewrites_only_the_mouth_of_the_live_snapshot():
    snapshot = _snapshot()
    storage = FakeStorage({f"{ROOT}mouth-motion-m1.json": b"motion"})
    mouth = {
        "renderer": "continuous",
        "profile": {"teethY": 0.02},
        "motion_key": f"{ROOT}mouth-motion-m1.json",
    }
    avatar = _avatar(
        draft_revision=8, published_config=json.dumps(snapshot), mouth_config=json.dumps(mouth)
    )
    result = await publishing.republish_mouth(avatar, storage)
    expected_mouth = {
        "renderer": "continuous",
        "profile": {"teethY": 0.02},
        "motion_key": f"{P3}/mouth-motion.json",
    }
    assert result == {**snapshot, "mouth": expected_mouth}
    assert json.loads(avatar.published_config) == result
    assert storage.files[f"{P3}/mouth-motion.json"] == b"motion", "under the snapshot's revision"
    assert avatar.draft_revision == 8, "unpublished edits stay unpublished"


async def test_republishing_follows_the_snapshots_line_and_needs_a_snapshot():
    mouth = json.dumps({"renderer": "continuous", "profile": {}})
    never = _avatar(mouth_config=mouth)
    assert await publishing.republish_mouth(never, FakeStorage()) is None
    assert never.published_config is None

    animal_snapshot = _avatar(
        face_type="human",
        mouth_config=mouth,
        published_config=json.dumps(_snapshot(face_type="animal")),
    )
    assert (await publishing.republish_mouth(animal_snapshot, FakeStorage()))["mouth"] is None

    # A snapshot without a face type goes by the avatar's.
    untyped = _snapshot()
    untyped.pop("face_type")
    for face_type, renderer in (("animal", None), ("human", "continuous")):
        avatar = _avatar(
            face_type=face_type, mouth_config=mouth, published_config=json.dumps(untyped)
        )
        republished = (await publishing.republish_mouth(avatar, FakeStorage()))["mouth"]
        assert (republished or {}).get("renderer") == renderer


# --- discard_draft -----------------------------------------------------------------------


async def test_discarding_a_never_published_draft_changes_nothing():
    mouth = json.dumps({"renderer": "continuous", "profile": {}})
    avatar = _avatar(draft_revision=4, framing="full", mouth_config=mouth)
    assert await publishing.discard_draft(avatar, FakeStorage()) is None
    assert (avatar.draft_revision, avatar.framing, avatar.mouth_config) == (4, "full", mouth)


async def test_discard_copies_the_published_files_forward_into_fresh_draft_keys(stamp):
    snapshot = _snapshot(
        framing="face",
        face_type="animal",
        thumbnail_key=f"{P3}/thumb.jpg",
        disclosure={"ai_edited": None, "line": "animal"},
    )
    storage = FakeStorage({f"{P3}/image.png": b"pub-img", f"{P3}/thumb.jpg": b"pub-thumb"})
    avatar = _avatar(
        draft_revision=7,
        framing="full",
        face_type="human",
        has_layers=True,
        image_key=f"{ROOT}source-x.png",
        rig_key=f"{ROOT}rig.json",
        thumbnail_key=f"{ROOT}thumb.jpg",
        published_config=json.dumps(snapshot),
        ai_edited={"mode": "touchup", "model": "m"},
    )
    assert await publishing.discard_draft(avatar, storage) == []
    assert avatar.image_key == f"{ROOT}source-{stamp}.png"
    assert avatar.thumbnail_key == f"{ROOT}thumb-{stamp}.jpg"
    assert storage.files[avatar.image_key] == b"pub-img"
    assert storage.files[avatar.thumbnail_key] == b"pub-thumb"
    assert storage.types[avatar.thumbnail_key] == "image/jpeg"
    assert avatar.rig_key == f"{ROOT}rig.json", "nothing published to restore: kept"
    assert (avatar.framing, avatar.face_type, avatar.has_layers) == ("face", "animal", False)
    assert (avatar.mouth_config, avatar.scene_config, avatar.ai_edited) == (None, None, None)
    assert avatar.draft_revision == 3
    assert publishing.has_unpublished_changes(avatar) is False
    # The published copies are never aliased or moved.
    assert storage.files[f"{P3}/image.png"] == b"pub-img"


async def test_discard_restores_layers_in_place_and_deletes_those_the_snapshot_lacks(stamp):
    """Going back to a cut-out must not keep the edited draft's backdrop."""
    snapshot = _snapshot(layer_keys={"head": f"{P3}/layer-head.png"})
    storage = FakeStorage(
        {
            f"{P3}/image.png": b"img",
            f"{P3}/layer-head.png": b"pub-head",
            layer_key(ORG, AID, "background"): b"draft-bg",
            layer_key(ORG, AID, "body"): b"draft-body",
            layer_key(ORG, AID, "head"): b"draft-head",
        }
    )
    avatar = _avatar(draft_revision=5, has_layers=True, published_config=json.dumps(snapshot))
    await publishing.discard_draft(avatar, storage)
    assert storage.files[layer_key(ORG, AID, "head")] == b"pub-head"
    assert layer_key(ORG, AID, "background") not in storage.files
    assert layer_key(ORG, AID, "body") not in storage.files
    assert avatar.has_layers is True


async def test_discarding_to_a_snapshot_without_a_face_type_keeps_the_drafts(stamp):
    snapshot = _snapshot()
    snapshot.pop("face_type")
    storage = FakeStorage({f"{P3}/image.png": b"img"})
    avatar = _avatar(face_type="cartoon", draft_revision=5, published_config=json.dumps(snapshot))
    await publishing.discard_draft(avatar, storage)
    assert (avatar.face_type, avatar.draft_revision) == ("cartoon", 3)


async def test_discard_restores_the_published_mouth_into_fresh_keys_and_returns_the_drafts(stamp):
    """The restored mouth never aliases the immutable published copies; the
    discarded draft's mouth files are returned for deletion after the
    commit, not deleted here. The label is re-derived from what came back."""
    teeth = {"source": "ai", "model": "t"}
    snapshot = _snapshot(
        mouth={
            "renderer": "continuous",
            "profile": {"teethScale": 1.1},
            "oral_image_key": f"{P3}/mouth.webp",
            "oral_rig_key": f"{P3}/mouth-rig.json",
            "motion_key": f"{P3}/mouth-motion.json",
            "teeth": teeth,
            "kit": KIT,
        },
        disclosure={"ai_edited": {"mode": "touchup", "model": "p"}, "line": "human"},
    )
    draft_keys = [f"{ROOT}mouth-d1.webp", f"{ROOT}mouth-d1.json", f"{ROOT}mouth-motion-d1.json"]
    storage = FakeStorage(
        {
            f"{P3}/image.png": b"img",
            f"{P3}/mouth.webp": b"teeth",
            f"{P3}/mouth-rig.json": b"rig",
            f"{P3}/mouth-motion.json": b"motion",
            **dict.fromkeys(draft_keys, b"draft"),
        }
    )
    avatar = _avatar(
        draft_revision=9,
        published_config=json.dumps(snapshot),
        mouth_config=json.dumps(
            {
                "renderer": "classic",
                "profile": {},
                "oral_image_key": draft_keys[0],
                "oral_rig_key": draft_keys[1],
                "motion_key": draft_keys[2],
            }
        ),
    )
    leftovers = await publishing.discard_draft(avatar, storage)
    assert leftovers == sorted(draft_keys)
    assert all(key in storage.files for key in draft_keys)
    assert json.loads(avatar.mouth_config) == {
        "renderer": "continuous",
        "profile": {"teethScale": 1.1},
        "oral_image_key": f"{ROOT}mouth-{stamp}.webp",
        "oral_rig_key": f"{ROOT}mouth-rig-{stamp}.json",
        "motion_key": f"{ROOT}mouth-motion-{stamp}.json",
        "teeth": teeth,
        "kit": KIT,
    }
    assert storage.files[f"{ROOT}mouth-{stamp}.webp"] == b"teeth"
    assert storage.files[f"{ROOT}mouth-motion-{stamp}.json"] == b"motion"
    assert avatar.ai_edited == {
        "mode": "touchup",
        "model": "p",
        "teeth": {"model": "t"},
        "mouth_shapes": {"model": "s", "generated": 6},
    }


async def test_a_discarded_mouth_whose_published_files_are_gone_comes_back_unlabelled(stamp):
    """No teeth photo back: no teeth record and no teeth label. No motion
    back: the kit says it was dropped, and no shapes label."""
    snapshot = _snapshot(
        mouth={
            "renderer": "continuous",
            "profile": {},
            "oral_image_key": f"{P3}/mouth.webp",
            "oral_rig_key": f"{P3}/mouth-rig.json",
            "motion_key": f"{P3}/mouth-motion.json",
            "teeth": {"source": "ai", "model": "t"},
            "kit": KIT,
        },
        disclosure={"ai_edited": copy.deepcopy(AI_BOTH), "line": "human"},
    )
    storage = FakeStorage({f"{P3}/image.png": b"img"})
    avatar = _avatar(draft_revision=4, published_config=json.dumps(snapshot))
    await publishing.discard_draft(avatar, storage)
    restored = json.loads(avatar.mouth_config)
    assert set(restored) == {"renderer", "profile", "kit"}
    assert restored["kit"]["state"] == "dropped"
    assert restored["kit"]["dropped"] == {
        "code": "motion_missing",
        "detail": "The mouth shapes' file is gone",
    }
    assert avatar.ai_edited is None


async def test_discard_restores_the_published_scene_picture_into_a_fresh_draft_file(stamp):
    published_scene = {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "image", "image_key": f"{P3}/scene.webp"},
    }
    storage = FakeStorage(
        {
            f"{P3}/image.png": b"img",
            f"{P3}/scene.webp": b"pub-bg",
            f"{ROOT}scene-d1.webp": b"draft-bg",
        }
    )
    avatar = _avatar(
        draft_revision=6,
        published_config=json.dumps(_snapshot(scene=published_scene)),
        scene_config={
            "zoom": 0.3,
            "pan": {"x": 0.0, "y": 0.0},
            "background": {"kind": "image", "image_key": f"{ROOT}scene-d1.webp"},
        },
    )
    assert await publishing.discard_draft(avatar, storage) == [f"{ROOT}scene-d1.webp"]
    assert avatar.scene_config == {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "image", "image_key": f"{ROOT}scene-{stamp}.webp"},
    }
    assert storage.files[f"{ROOT}scene-{stamp}.webp"] == b"pub-bg"
    assert publishing.config_of(avatar)["scene"] == published_scene, "the snapshot is untouched"


@pytest.mark.parametrize(
    "published_background, restored_background",
    [
        ({"kind": "image", "image_key": f"{P3}/scene.webp"}, {"kind": "transparent"}),
        ({"kind": "color", "color": "#112233"}, {"kind": "color", "color": "#112233"}),
    ],
)
async def test_discard_shows_a_published_picture_that_is_gone_as_transparent(
    stamp, published_background, restored_background
):
    published_scene = {"zoom": 1.0, "pan": {"x": 0.0, "y": 0.0}, "background": published_background}
    storage = FakeStorage({f"{P3}/image.png": b"img"})
    avatar = _avatar(
        draft_revision=2, published_config=json.dumps(_snapshot(scene=published_scene))
    )
    await publishing.discard_draft(avatar, storage)
    assert avatar.scene_config["background"] == restored_background


async def test_discard_puts_back_the_published_character_mouth_settings(stamp):
    snapshot = _snapshot(
        face_type="animal", mouth={"renderer": "classic", "profile": {}, "character": CHARACTER}
    )
    storage = FakeStorage({f"{P3}/image.png": b"img"})
    avatar = _avatar(
        face_type="animal",
        draft_revision=5,
        published_config=json.dumps(snapshot),
        mouth_config=json.dumps(
            {"renderer": "classic", "profile": {}, "character": mouth_service.DEFAULT_CHARACTER}
        ),
    )
    await publishing.discard_draft(avatar, storage)
    assert json.loads(avatar.mouth_config).get("character") == CHARACTER


# --- _restored_ai_edited: the label after a Discard --------------------------------------


def test_restored_ai_teeth_are_labelled_with_their_model():
    config = {"disclosure": {"ai_edited": None, "line": "human"}}
    teeth = mouth_service.ai_teeth_record("t")
    assert publishing._restored_ai_edited(None, config, teeth) == {
        "mode": "teeth",
        "model": "t",
        "teeth": {"model": "t"},
    }


@pytest.mark.parametrize("teeth", [None, {"source": "upload"}])
def test_restored_teeth_that_are_not_ai_made_lose_the_teeth_label(teeth):
    picture = {
        "disclosure": {"ai_edited": {"mode": "touchup", "model": "p", "teeth": {"model": "t"}}}
    }
    assert publishing._restored_ai_edited(None, picture, teeth) == {"mode": "touchup", "model": "p"}
    mouth_only = {
        "disclosure": {"ai_edited": {"mode": "teeth", "model": "t", "teeth": {"model": "t"}}}
    }
    assert publishing._restored_ai_edited(None, mouth_only, teeth) is None


@pytest.mark.parametrize(
    "kit, shapes",
    [
        ({"state": "made", "generated": 6, "model": "s"}, {"model": "s", "generated": 6}),
        ({"generated": 3, "model": "s"}, {"model": "s", "generated": 3}),
        ({"state": "dropped", "generated": 6, "model": "s"}, None),
        ({"state": "made", "generated": 0, "model": "s"}, None),
        (None, None),
    ],
)
def test_restored_shapes_are_labelled_only_for_a_kit_that_made_some_and_was_not_dropped(
    kit, shapes
):
    config = {
        "disclosure": {
            "ai_edited": {
                "mode": "mouth_shapes",
                "model": "old",
                "mouth_shapes": {"model": "old", "generated": 2},
            }
        }
    }
    restored = publishing._restored_ai_edited(None, config, None, kit)
    if shapes is None:
        assert restored is None
    else:
        assert restored == {"mode": "mouth_shapes", "model": "s", "mouth_shapes": shapes}


def test_restored_ai_teeth_outrank_restored_ai_shapes_in_a_mouth_only_label():
    config = {"disclosure": {"ai_edited": None, "line": "human"}}
    restored = publishing._restored_ai_edited(None, config, {"source": "ai", "model": "t"}, KIT)
    assert restored == {
        "mode": "teeth",
        "model": "t",
        "teeth": {"model": "t"},
        "mouth_shapes": {"model": "s", "generated": 6},
    }


def test_the_snapshots_disclosure_wins_over_the_drafts_and_only_its_absence_falls_back():
    draft = SimpleNamespace(ai_edited={"mode": "teeth", "model": "t", "teeth": {"model": "t"}})
    assert publishing._restored_ai_edited(draft, {"disclosure": {"ai_edited": None}}, None) is None
    assert publishing._restored_ai_edited(draft, {"disclosure": {"ai_edited": {}}}, None) is None
    # Published before the disclosure was recorded: the draft's own, less
    # the teeth it no longer has, plus the shapes that came back.
    assert publishing._restored_ai_edited(draft, {}, None, KIT) == {
        "mode": "mouth_shapes",
        "model": "s",
        "mouth_shapes": {"model": "s", "generated": 6},
    }


# --- published_view and _mouth_view: what visitors are handed -----------------------------


async def test_a_never_published_avatar_has_no_published_view():
    assert await publishing.published_view(_avatar(), FakeStorage()) is None


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {"face_type": None, "layer_keys": {}},
        {"face_type": "", "layer_keys": None, "rig_key": None, "thumbnail_key": ""},
    ],
)
async def test_a_bare_snapshot_is_served_as_a_person_with_empty_urls(fields):
    """Older snapshots lack fields: a person (the line every avatar had
    first), the face framing, no layers, and "" for a file it has none of."""
    config = {"revision": 0, "image_key": "k/image.png", **fields}
    view = await publishing.published_view(
        _avatar(published_config=json.dumps(config)), FakeStorage()
    )
    assert view is not None
    # No disclosure in the snapshot: none in the answer, not even a null.
    assert view.model_dump(mode="json") == {
        "framing": "face",
        "face_type": "human",
        "scene": None,
        "voice": None,
        "mouth": None,
        "rig_url": "",
        "thumbnail_url": "",
        "image_url": f"{SIGNED}k/image.png",
        "layer_urls": None,
    }


async def test_a_full_snapshot_is_served_with_presigned_urls_and_nothing_internal():
    snapshot = _snapshot(
        framing="full",
        face_type="animal",
        voice=VOICE,
        scene={
            "zoom": 1.2,
            "pan": {"x": -0.25, "y": 0.1},
            "background": {"kind": "image", "image_key": f"{P3}/scene.webp"},
        },
        mouth={"renderer": "classic", "profile": {}, "character": CHARACTER},
        rig_key=f"{P3}/rig.json",
        thumbnail_key=f"{P3}/thumb.jpg",
        layer_keys={"head": f"{P3}/layer-head.png", "background": f"{P3}/layer-background.jpg"},
        disclosure={"ai_edited": {"mode": "generate", "model": "g"}, "line": "animal"},
    )
    storage = FakeStorage({f"{P3}/scene.webp": b"bg"})
    view = await publishing.published_view(_avatar(published_config=json.dumps(snapshot)), storage)
    assert view is not None
    assert view.model_dump(mode="json") == {
        "framing": "full",
        "face_type": "animal",
        "scene": {
            "zoom": 1.2,
            "pan": {"x": -0.25, "y": 0.1},
            "background": {"kind": "image", "image_url": f"{SIGNED}{P3}/scene.webp"},
        },
        "voice": VOICE,
        "mouth": {"renderer": "classic", "character": CHARACTER},
        "rig_url": f"{SIGNED}{P3}/rig.json",
        "thumbnail_url": f"{SIGNED}{P3}/thumb.jpg",
        "image_url": f"{SIGNED}{P3}/image.png",
        "layer_urls": {
            "head": f"{SIGNED}{P3}/layer-head.png",
            "background": f"{SIGNED}{P3}/layer-background.jpg",
        },
        "disclosure": {"ai_edited": {"mode": "generate", "model": "g"}, "line": "animal"},
    }


@pytest.mark.parametrize(
    "mouth",
    [
        None,
        {},
        {"renderer": "classic", "profile": {}},
        {"renderer": "classic", "profile": {}, "character": None},
        {"renderer": "classic", "profile": {}, "character": "loud"},
    ],
)
async def test_the_classic_mouth_without_character_settings_is_no_mouth_to_a_visitor(mouth):
    assert await publishing._mouth_view(mouth, FakeStorage()) is None


async def test_a_visitor_gets_the_classic_mouths_character_settings_cleaned():
    mouth = {
        "renderer": "classic",
        "profile": {},
        "character": {"style": "weird", "jaw": 9, "tongue": False, "secret": 1},
    }
    assert await publishing._mouth_view(mouth, FakeStorage()) == {
        "renderer": "classic",
        "character": {"style": "character", "teeth": "upper", "tongue": False, "jaw": 1.6},
    }


async def test_the_photographic_mouth_view_presigns_its_files_and_never_shows_the_records():
    storage = FakeStorage(
        {f"{P3}/mouth.webp": b"t", f"{P3}/mouth-rig.json": b"r", f"{P3}/mouth-motion.json": b"m"}
    )
    mouth = {
        "renderer": "continuous",
        "profile": {"teethScale": 1.1},
        "character": CHARACTER,
        "oral_image_key": f"{P3}/mouth.webp",
        "oral_rig_key": f"{P3}/mouth-rig.json",
        "motion_key": f"{P3}/mouth-motion.json",
        "teeth": {"source": "ai", "model": "t"},
        "kit": KIT,
    }
    assert await publishing._mouth_view(mouth, storage) == {
        "renderer": "continuous",
        "profile": {"teethScale": 1.1},
        "character": None,
        "oral": {
            "image_url": f"{SIGNED}{P3}/mouth.webp",
            "rig_url": f"{SIGNED}{P3}/mouth-rig.json",
        },
        "motion_url": f"{SIGNED}{P3}/mouth-motion.json",
    }


async def test_the_photographic_mouth_view_falls_back_to_the_standard_teeth_and_motion():
    """Null teeth: the engine loads the standard ones; null motion: the
    bundled Reference motion."""
    mouth = {
        "renderer": "continuous",
        "profile": None,
        "oral_image_key": f"{P3}/mouth.webp",
        "oral_rig_key": f"{P3}/mouth-rig.json",
        "motion_key": f"{P3}/mouth-motion.json",
    }
    assert await publishing._mouth_view(mouth, FakeStorage()) == {
        "renderer": "continuous",
        "profile": {},
        "character": None,
        "oral": None,
        "motion_url": None,
    }


# --- disclosure ---------------------------------------------------------------------------


def test_a_pictures_own_mode_is_left_as_it_is_and_nothing_is_nothing():
    picture = {"mode": "touchup", "model": "p", "teeth": {"model": "t"}}
    assert disclosure.mouth_disclosure(picture) is picture
    assert disclosure.mouth_disclosure(None) is None
    assert disclosure.mouth_disclosure({}) is None


@pytest.mark.parametrize(
    "ai_edited, expected",
    [
        ({"mode": "teeth", "model": "stale"}, None),
        (
            {"mode": "teeth", "model": "t", "mouth_shapes": {"model": "s", "generated": 2}},
            {"mode": "mouth_shapes", "model": "s", "mouth_shapes": {"model": "s", "generated": 2}},
        ),
        (
            {
                "mode": "mouth_shapes",
                "model": "stale",
                "mouth_shapes": {"model": "s", "generated": 2},
            },
            {"mode": "mouth_shapes", "model": "s", "mouth_shapes": {"model": "s", "generated": 2}},
        ),
        (
            {
                "mode": "mouth_shapes",
                "model": "s",
                "teeth": {"model": "t"},
                "mouth_shapes": {"model": "s", "generated": 2},
            },
            {
                "mode": "teeth",
                "model": "t",
                "teeth": {"model": "t"},
                "mouth_shapes": {"model": "s", "generated": 2},
            },
        ),
    ],
)
def test_a_mouth_only_mode_and_model_are_re_derived_from_its_entries(ai_edited, expected):
    assert disclosure.mouth_disclosure(ai_edited) == expected


def test_new_ai_parts_replace_the_old_entry_without_mutating_the_record():
    before = {
        "mode": "teeth",
        "model": "t1",
        "teeth": {"model": "t1"},
        "mouth_shapes": {"model": "s1", "generated": 2},
    }
    kept = copy.deepcopy(before)
    assert disclosure.with_ai_teeth(before, "t2") == {
        "mode": "teeth",
        "model": "t2",
        "teeth": {"model": "t2"},
        "mouth_shapes": {"model": "s1", "generated": 2},
    }
    assert disclosure.with_ai_shapes(before, "s2", 5) == {
        "mode": "teeth",
        "model": "t1",
        "teeth": {"model": "t1"},
        "mouth_shapes": {"model": "s2", "generated": 5},
    }
    assert before == kept
    assert disclosure.with_ai_teeth({}, None) == {
        "mode": "teeth",
        "model": None,
        "teeth": {"model": None},
    }
    assert disclosure.with_ai_shapes({}, "s", 1) == {
        "mode": "mouth_shapes",
        "model": "s",
        "mouth_shapes": {"model": "s", "generated": 1},
    }


def test_ai_shapes_added_to_ai_teeth_leave_the_teeth_in_charge():
    teeth = disclosure.with_ai_teeth(None, "t")
    assert disclosure.with_ai_shapes(teeth, "s", 3) == {
        "mode": "teeth",
        "model": "t",
        "teeth": {"model": "t"},
        "mouth_shapes": {"model": "s", "generated": 3},
    }
    assert teeth == {"mode": "teeth", "model": "t", "teeth": {"model": "t"}}


def test_removing_a_mouth_part_keeps_the_picture_and_the_other_part_in_a_new_dict():
    picture = {
        "mode": "stylise",
        "model": "x",
        "teeth": {"model": "t"},
        "mouth_shapes": {"model": "s", "generated": 2},
    }
    kept = copy.deepcopy(picture)
    assert disclosure.without_ai_teeth(picture) == {
        "mode": "stylise",
        "model": "x",
        "mouth_shapes": {"model": "s", "generated": 2},
    }
    assert disclosure.without_ai_shapes(picture) == {
        "mode": "stylise",
        "model": "x",
        "teeth": {"model": "t"},
    }
    assert picture == kept
    plain = {"mode": "generate", "model": "g"}
    for remove in (disclosure.without_ai_teeth, disclosure.without_ai_shapes):
        removed = remove(plain)
        assert removed == plain and removed is not plain
        assert remove(None) is None
        assert remove({}) is None


# --- scene: clean -------------------------------------------------------------------------

MISSING_PICTURE = "no background picture has been uploaded"


@pytest.mark.parametrize(
    "value, image_key, message",
    [
        (None, None, "scene must be an object"),
        ([("zoom", 1)], None, "scene must be an object"),
        ({"zoom": "near"}, None, "zoom must be a number"),
        ({"zoom": None}, None, "zoom must be a number"),
        ({"zoom": float("nan")}, None, "zoom must be between 0.0 and 1.3"),
        ({"zoom": 1.31}, None, "zoom must be between 0.0 and 1.3"),
        ({"zoom": -0.01}, None, "zoom must be between 0.0 and 1.3"),
        ({"pan": [0, 0]}, None, "pan must be an object"),
        ({"pan": {"x": "left"}}, None, "pan.x must be a number"),
        ({"pan": {"y": 1.5}}, None, "pan.y must be between -1.0 and 1.0"),
        ({"background": "red"}, None, "background must be an object"),
        (
            {"background": {"kind": "gradient"}},
            None,
            "background kind must be transparent, color or image",
        ),
        ({"background": {"kind": "color"}}, None, "color must be #rrggbb"),
        ({"background": {"kind": "color", "color": "#12345g"}}, None, "color must be #rrggbb"),
        ({"background": {"kind": "color", "color": "#1234567"}}, None, "color must be #rrggbb"),
        ({"background": {"kind": "image"}}, None, MISSING_PICTURE),
        ({"background": {"kind": "image"}}, "", MISSING_PICTURE),
    ],
)
def test_a_scene_is_refused_with_a_message_per_problem(value, image_key, message):
    """The API turns a message mentioning an upload into scene_image_missing
    and every other into scene_invalid (services.avatars.settings), so only
    the missing picture may say "uploaded"."""
    with pytest.raises(ValueError) as refused:
        scene_service.clean(value, image_key)
    assert str(refused.value) == message
    assert ("uploaded" in message) == (message == MISSING_PICTURE)


def test_a_scene_is_filled_with_defaults_and_rounded():
    assert scene_service.clean({}, None) == {
        "zoom": 1.0,
        "pan": {"x": 0.0, "y": 0.0},
        "background": {"kind": "transparent"},
    }
    assert scene_service.clean({"pan": None, "background": None}, None) == scene_service.clean(
        {}, None
    )
    tidied = scene_service.clean({"zoom": 0.123456, "pan": {"x": -0.333333, "y": 1}}, None)
    assert tidied["zoom"] == 0.1235
    assert tidied["pan"] == {"x": -0.3333, "y": 1.0}
    assert scene_service.clean({"zoom": 0}, None)["zoom"] == 0.0
    assert scene_service.clean({"zoom": scene_service.ZOOM_MAX}, None)["zoom"] == 1.3


def test_a_colour_is_normalised_and_kept_only_for_kind_color():
    def background(sent):
        return scene_service.clean({"background": sent}, "k")["background"]

    assert background({"kind": "color", "color": "  #1E3A8A "}) == {
        "kind": "color",
        "color": "#1e3a8a",
        "image_key": "k",
    }
    assert background({"kind": "transparent", "color": "#ffffff"}) == {
        "kind": "transparent",
        "image_key": "k",
    }
    assert background({"kind": "image", "color": "#ffffff"}) == {"kind": "image", "image_key": "k"}


def test_the_owner_never_names_a_key_the_stored_picture_is_kept_whatever_is_shown():
    sent = {"kind": "image", "image_key": "orgs/other/avatars/x/scene-evil.webp"}
    assert scene_service.clean({"background": sent}, "k")["background"] == {
        "kind": "image",
        "image_key": "k",
    }
    with pytest.raises(ValueError, match=MISSING_PICTURE):
        scene_service.clean({"background": sent}, None)
    hidden = {"kind": "color", "color": "#000000", "image_key": "orgs/other/x.webp"}
    assert scene_service.clean({"background": hidden}, None)["background"] == {
        "kind": "color",
        "color": "#000000",
    }


def test_a_new_zoom_is_a_checked_copy():
    scene = scene_service.from_framing("face")
    zoomed = scene_service.with_zoom(scene, 0.25)
    assert zoomed == {**scene, "zoom": 0.25}
    assert scene["zoom"] == 1.0
    with pytest.raises(ValueError, match="zoom must be between 0.0 and 1.3"):
        scene_service.with_zoom(scene, 2)


# --- scene: the stored scene and its views ---------------------------------------------


def test_an_avatar_without_a_scene_renders_by_its_framing():
    assert scene_service.from_framing(None) == {
        "zoom": 1.0,
        "pan": {"x": 0.0, "y": 0.0},
        "background": {"kind": "transparent"},
    }
    assert scene_service.effective(SimpleNamespace(framing="full")) == scene_service.from_framing(
        "full"
    )
    assert scene_service.effective(SimpleNamespace())["zoom"] == 1.0, "no framing: the face"
    own = {"zoom": 0.7, "pan": {"x": 0.0, "y": 0.0}, "background": {"kind": "transparent"}}
    assert scene_service.effective(SimpleNamespace(framing="full", scene_config=own)) is own
    assert scene_service.framing_of({}) == "face"
    assert scene_service.framing_of({"zoom": scene_service.ZOOM_MAX}) == "face"
    assert scene_service.framing_of({"zoom": 0}) == "full"


@pytest.mark.parametrize(
    "stored", [None, "{}", [], {}, {"background": {"kind": "color", "color": "#000000"}}]
)
def test_only_a_stored_scene_with_a_zoom_is_loaded(stored):
    assert scene_service.load(SimpleNamespace(scene_config=stored)) is None


def test_which_picture_a_scene_holds_and_whether_it_shows_it():
    image = {"zoom": 1.0, "background": {"kind": "image", "image_key": "k"}}
    hidden = {"zoom": 1.0, "background": {"kind": "color", "image_key": "k"}}
    empty = {"zoom": 1.0, "background": {"kind": "image", "image_key": ""}}
    for scene in (None, {}, {"background": None}, empty):
        assert scene_service.image_key_of(scene) is None
        assert scene_service.keys(scene) == set()
        assert scene_service.shows_image(scene) is False
    assert scene_service.image_key_of(hidden) == "k"
    assert scene_service.keys(hidden) == {"k"}
    assert scene_service.shows_image(hidden) is False
    assert scene_service.shows_image(image) is True


def test_the_owner_is_told_whether_a_picture_is_stored_never_where():
    scene = {
        "zoom": 1.2,
        "pan": {"x": 0.1, "y": -0.2},
        "background": {"kind": "color", "color": "#112233", "image_key": f"{ROOT}scene-a.webp"},
    }
    view = scene_service.public_view(scene)
    assert view == {
        "zoom": 1.2,
        "pan": {"x": 0.1, "y": -0.2},
        "background": {"kind": "color", "has_image": True, "color": "#112233"},
    }
    assert view["pan"] is not scene["pan"]
    assert scene_service.public_view({"zoom": 0.5}) == {
        "zoom": 0.5,
        "pan": {"x": 0.0, "y": 0.0},
        "background": {"kind": "transparent", "has_image": False},
    }
    assert scene_service.public_view(None) is None
    assert scene_service.public_view({"pan": {"x": 0, "y": 0}}) is None


async def test_a_visitor_gets_a_presigned_url_for_a_picture_that_exists():
    key = f"{P3}/scene.webp"
    scene = {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "image", "image_key": key},
    }
    view = await scene_service.visitor_view(scene, FakeStorage({key: b"bg"}))
    assert view == {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "image", "image_url": f"{SIGNED}{key}"},
    }


@pytest.mark.parametrize(
    "background",
    [{"kind": "image"}, {"kind": "image", "image_key": f"{P3}/gone.webp"}, None],
)
async def test_a_visitor_sees_a_picture_that_cannot_load_as_transparent(background):
    view = await scene_service.visitor_view({"zoom": 1.0, "background": background}, FakeStorage())
    assert view == {"zoom": 1.0, "pan": {"x": 0.0, "y": 0.0}, "background": {"kind": "transparent"}}


async def test_a_visitor_gets_the_colour_and_no_picture_that_is_not_shown():
    key = f"{P3}/scene.webp"
    storage = FakeStorage({key: b"bg"})
    shown = await scene_service.visitor_view(
        {
            "zoom": 1.0,
            "pan": {"x": 0.0, "y": 0.0},
            "background": {"kind": "color", "color": "#112233", "image_key": key},
        },
        storage,
    )
    assert shown["background"] == {"kind": "color", "color": "#112233"}
    uncoloured = await scene_service.visitor_view(
        {"zoom": 1.0, "background": {"kind": "color"}}, storage
    )
    assert uncoloured["background"] == {"kind": "color", "color": "#000000"}
    assert await scene_service.visitor_view(None, storage) is None
    assert await scene_service.visitor_view({"background": {"kind": "color"}}, storage) is None


# --- scene: the background file ----------------------------------------------------------


async def test_storing_a_picture_shows_it_and_returns_the_key_it_replaced(stamp):
    old = f"{ROOT}scene-old.webp"
    storage = FakeStorage({old: b"old"})
    avatar = _avatar(
        scene_config={
            "zoom": 1.2,
            "pan": {"x": 0.1, "y": 0.0},
            "background": {"kind": "color", "color": "#112233", "image_key": old},
        }
    )
    assert await scene_service.store_image(avatar, storage, b"webp") == [old]
    new = scene_service.image_key(ORG, AID, stamp)
    assert new == f"{ROOT}scene-{stamp}.webp"
    assert avatar.scene_config == {
        "zoom": 1.2,
        "pan": {"x": 0.1, "y": 0.0},
        "background": {"kind": "image", "image_key": new},
    }
    assert storage.files[new] == b"webp"
    assert storage.types[new] == "image/webp"
    assert old in storage.files, "deleted by the caller after its commit"


async def test_storing_a_picture_on_an_avatar_without_a_scene_starts_from_its_framing(stamp):
    avatar = _avatar(framing="full")
    assert await scene_service.store_image(avatar, FakeStorage(), b"webp") == []
    assert avatar.scene_config == {
        "zoom": 0.0,
        "pan": {"x": 0.0, "y": 0.0},
        "background": {"kind": "image", "image_key": f"{ROOT}scene-{stamp}.webp"},
    }


def test_removing_the_picture_shows_nothing_behind_and_returns_its_key():
    key = f"{ROOT}scene-a.webp"
    avatar = _avatar(
        scene_config={
            "zoom": 0.8,
            "pan": {"x": 0.2, "y": 0.0},
            "background": {"kind": "image", "image_key": key},
        }
    )
    assert scene_service.without_image(avatar) == [key]
    assert avatar.scene_config == {
        "zoom": 0.8,
        "pan": {"x": 0.2, "y": 0.0},
        "background": {"kind": "transparent"},
    }
    bare = _avatar(framing="face")
    assert scene_service.without_image(bare) == []
    assert bare.scene_config == scene_service.from_framing("face")


async def test_the_scene_sweep_deletes_only_the_drafts_unnamed_background_files():
    names = [
        "scene-old.webp",
        "scene-cur.webp",
        "scene.webp",
        "scene-x.png",
        "mouth-a.webp",
        "published/r1/scene.webp",
    ]
    storage = FakeStorage({f"{ROOT}{name}": b"x" for name in names})
    scene = {"zoom": 1.0, "background": {"kind": "image", "image_key": f"{ROOT}scene-cur.webp"}}
    await scene_service.sweep_files(_avatar(), storage, scene)
    assert sorted(k[len(ROOT) :] for k in storage.files) == sorted(
        n for n in names if n != "scene-old.webp"
    )


async def test_the_scene_sweep_survives_a_storage_that_cannot_list_or_delete():
    storage = FakeStorage({f"{ROOT}scene-a.webp": b"x", f"{ROOT}scene-b.webp": b"x"})
    storage.broken_listing = True
    await scene_service.sweep_files(_avatar(), storage, None)
    assert len(storage.files) == 2
    storage.broken_listing = False
    storage.undeletable.add(f"{ROOT}scene-a.webp")
    await scene_service.sweep_files(_avatar(), storage, None)
    assert list(storage.files) == [f"{ROOT}scene-a.webp"], "one failure does not stop the rest"


# --- mouth --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "face_type, photographic, character",
    [("human", True, False), ("animal", False, True), ("cartoon", False, True)],
)
def test_which_mouths_each_face_may_have(face_type, photographic, character):
    """The photographic mouth paints human enamel; the character mouth is
    how an animation or an animal talks. The classic one suits every face."""
    assert mouth_service.renderer_allowed("continuous", face_type) is photographic
    assert mouth_service.renderer_allowed("classic", face_type) is True
    assert mouth_service.character_allowed(face_type) is character


def test_valid_character_choices_are_kept_the_jaw_rounded_and_nothing_given_is_the_default():
    assert mouth_service.clean_character(
        {"style": "classic", "teeth": "none", "tongue": False, "jaw": 1.23456}
    ) == {"style": "classic", "teeth": "none", "tongue": False, "jaw": 1.235}
    jaw = mouth_service.clean_character({"jaw": 1})["jaw"]
    assert jaw == 1.0 and isinstance(jaw, float)
    cleaned = mouth_service.clean_character({})
    assert cleaned == mouth_service.DEFAULT_CHARACTER
    assert cleaned is not mouth_service.DEFAULT_CHARACTER, "a new dict, the default untouched"


@pytest.mark.parametrize(
    "jaw, expected",
    [(float("inf"), 1.6), (float("-inf"), 0.5), ("1.2", 1.0), (None, 1.0), (-3, 0.5)],
)
def test_an_unusable_jaw_is_clamped_or_defaulted(jaw, expected):
    assert mouth_service.clean_character({"jaw": jaw})["jaw"] == expected


@pytest.mark.parametrize(
    "raw, style",
    [
        (None, "character"),
        ("", "character"),
        ("{broken", "character"),
        (json.dumps({"renderer": "classic"}), "character"),
        (json.dumps({"renderer": "classic", "character": None}), "character"),
        (json.dumps({"renderer": "classic", "character": {"teeth": "none"}}), "character"),
        (json.dumps({"renderer": "hologram", "character": {"style": "classic"}}), "character"),
        (json.dumps({"renderer": "continuous", "character": {"style": "classic"}}), "classic"),
    ],
)
def test_the_mouth_style_is_the_character_one_unless_the_owner_chose_classic(raw, style):
    assert mouth_service.character_style(raw) == style


@pytest.mark.parametrize(
    "raw",
    [None, "", "{broken", "[]", "null", '"classic"', '{"profile": {}}', '{"renderer": "hologram"}'],
)
def test_a_stored_mouth_needs_a_known_renderer(raw):
    assert mouth_service.load(raw) is None


def test_a_stored_mouth_with_a_known_renderer_is_loaded_as_is():
    for renderer in mouth_service.RENDERERS:
        stored = {"renderer": renderer, "profile": {"teethScale": 1.1}, "extra": 1}
        assert mouth_service.load(json.dumps(stored)) == stored


def test_draft_file_keys_sit_beside_the_avatar_where_the_sweeps_know_them():
    image, rig = mouth_service.oral_keys(ORG, AID, "s1")
    motion = mouth_service.motion_key(ORG, AID, "s1")
    background = scene_service.image_key(ORG, AID, "s1")
    assert (image, rig, motion, background) == (
        f"{ROOT}mouth-s1.webp",
        f"{ROOT}mouth-s1.json",
        f"{ROOT}mouth-motion-s1.json",
        f"{ROOT}scene-s1.webp",
    )
    for key in (image, rig, motion):
        name = key[len(ROOT) :]
        assert publishing._MOUTH_FILE.fullmatch(name)
        assert not scene_service.SCENE_FILE.fullmatch(name)
    assert scene_service.SCENE_FILE.fullmatch(background[len(ROOT) :])
    assert not publishing._MOUTH_FILE.fullmatch(background[len(ROOT) :])


BOTH_KEYS = {"renderer": "continuous", "oral_image_key": "i", "oral_rig_key": "r"}


@pytest.mark.parametrize(
    "config, present, expected",
    [
        (None, ("i", "r"), None),
        ({"renderer": "continuous", "oral_image_key": "i"}, ("i", "r"), None),
        ({"renderer": "continuous", "oral_rig_key": "r"}, ("i", "r"), None),
        (BOTH_KEYS, ("i",), None),
        (BOTH_KEYS, ("r",), None),
        (BOTH_KEYS, ("i", "r"), {"image_url": f"{SIGNED}i", "rig_url": f"{SIGNED}r"}),
    ],
)
async def test_the_teeth_photo_urls_need_both_files(config, present, expected):
    storage = FakeStorage(dict.fromkeys(present, b"x"))
    assert await mouth_service.photo_urls(config, storage) == expected


async def test_the_motion_url_needs_its_file():
    storage = FakeStorage({"m.json": b"{}"})
    assert await mouth_service.motion_url(None, storage) is None
    assert await mouth_service.motion_url({"renderer": "continuous"}, storage) is None
    assert await mouth_service.motion_url({"motion_key": "gone.json"}, storage) is None
    assert await mouth_service.motion_url({"motion_key": "m.json"}, storage) == f"{SIGNED}m.json"


def test_the_teeth_records_say_where_the_teeth_came_from_or_why_there_are_none():
    assert mouth_service.ai_teeth_record("m") == {"source": "ai", "model": "m"}
    assert mouth_service.ai_teeth_record(None) == {"source": "ai", "model": None}
    assert mouth_service.upload_teeth_record() == {"source": "upload"}
    assert mouth_service.upload_teeth_record() is not mouth_service.upload_teeth_record()
    note = {"code": "no_ai_consent", "detail": "x"}
    assert mouth_service.generic_teeth_record(note) == {"source": None, "note": note}
    assert mouth_service.generic_teeth_record(None) == {"source": None, "note": None}
    assert mouth_service.migrated_teeth_record("2026-10-08") == {
        "source": None,
        "note": {
            "code": mouth_service.MIGRATED_STANDARD,
            "detail": "Standard teeth: moved from the classic mouth on 2026-10-08",
        },
    }
    assert mouth_service.MIGRATED_STANDARD == "migrated_standard"
