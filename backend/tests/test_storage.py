"""Storage writes that cannot be seen half-done, and deletes that leave nothing."""

import os
from pathlib import Path

import pytest

from app.services.storage import LocalStorage, S3Storage
from tests.conftest import create_org, create_ready_avatar, register_and_login


@pytest.fixture
def local(tmp_path) -> LocalStorage:
    return LocalStorage(tmp_path, "http://testserver", "secret", 60)


async def test_a_rewrite_replaces_the_file_in_one_step(local, tmp_path):
    await local.put_bytes("a/rig.json", b"old", "application/json")
    await local.put_bytes("a/rig.json", b"new", "application/json")
    assert await local.get_bytes("a/rig.json") == b"new"
    assert [p.name for p in (tmp_path / "a").iterdir()] == ["rig.json"], "no temp files left"


async def test_a_failed_write_leaves_the_previous_file_whole(local, tmp_path, monkeypatch):
    """What a crash mid-write looks like to the next reader."""
    await local.put_bytes("a/rig.json", b"complete", "application/json")

    def crash(src, dst):
        raise OSError("disk went away")

    monkeypatch.setattr(os, "replace", crash)
    with pytest.raises(OSError):
        await local.put_bytes("a/rig.json", b"half", "application/json")
    assert await local.get_bytes("a/rig.json") == b"complete"
    assert [p.name for p in (tmp_path / "a").iterdir()] == ["rig.json"]


async def test_delete_prefix_takes_a_folder_and_nothing_beside_it(local):
    for key in ("orgs/o/avatars/1/source.png", "orgs/o/avatars/1/published/r3/rig.json",
                "orgs/o/avatars/10/source.png", "orgs/o/candidates/x.png"):
        await local.put_bytes(key, b"x", "image/png")
    assert await local.delete_prefix("orgs/o/avatars/1/") == 2
    assert not await local.exists("orgs/o/avatars/1/source.png")
    assert await local.exists("orgs/o/avatars/10/source.png")
    assert await local.exists("orgs/o/candidates/x.png")
    assert await local.delete_prefix("orgs/o/avatars/404/") == 0


@pytest.mark.parametrize("prefix", ["", "/", "orgs/o/avatars/1", "orgs/../", "../"])
async def test_delete_prefix_refuses_anything_but_a_folder(local, prefix):
    with pytest.raises(ValueError):
        await local.delete_prefix(prefix)


async def test_s3_delete_prefix_lists_and_deletes_in_batches(monkeypatch):
    """One delete_objects call per listing page, scoped to the prefix."""
    pages = [
        {"Contents": [{"Key": f"orgs/o/avatars/1/f{i}"} for i in range(1000)]},
        {"Contents": [{"Key": "orgs/o/avatars/1/last"}]},
    ]
    calls: dict[str, list] = {"listed": [], "deleted": []}

    class Paginator:
        def paginate(self, **kwargs):
            calls["listed"].append(kwargs["Prefix"])

            async def gen():
                for page in pages:
                    yield page

            return gen()

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get_paginator(self, name):
            assert name == "list_objects_v2"
            return Paginator()

        async def delete_objects(self, Bucket, Delete):
            calls["deleted"].append(len(Delete["Objects"]))

    storage = S3Storage("https://s3", "k", "s", "bucket", "auto", 60)
    monkeypatch.setattr(storage, "_client", lambda: Client())
    assert await storage.delete_prefix("orgs/o/avatars/1/") == 1001
    assert calls == {"listed": ["orgs/o/avatars/1/"], "deleted": [1000, 1]}
    with pytest.raises(ValueError):
        await storage.delete_prefix("orgs/o/avatars/1")


async def test_deleting_an_avatar_removes_every_file_it_ever_had(client, monkeypatch):
    """Crops, the pre-crop photo, undo history, thumbnails and every
    published revision — none of which a key column still points at."""
    from app.core.config import get_settings

    headers = await register_and_login(client, "deleter")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.post(f"{base}/crop", json={"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
                      headers=headers)
    await client.post(f"{base}/publish", headers=headers)
    await client.patch(base, json={"framing": "full"}, headers=headers)
    await client.post(f"{base}/publish", headers=headers)

    folder = Path(get_settings().local_storage_dir) / "orgs" / org_id / "avatars" / avatar_id
    assert (folder / "history").is_dir() and (folder / "published").is_dir()

    assert (await client.delete(base, headers=headers)).status_code == 204
    assert not folder.exists()
