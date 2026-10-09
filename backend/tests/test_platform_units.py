"""Platform pieces, called directly (no HTTP): the persistent rate limit
(services.rate_limit.allow_persistent, against the test database) and
object storage (services.storage): LocalStorage's signed URLs, keys and
sweep, S3Storage against a fake client, and which one get_storage picks.

The in-memory limiter is tests.test_rate_limit's; delete_prefix, list_names
on S3, the published URL window and the sweeper's guard are
tests.test_storage's and tests.test_sweeper's.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from sqlalchemy import func, select

from app.core.config import Settings
from app.db import get_session_factory
from app.models import RateHit, utcnow
from app.services import storage as storage_module
from app.services.rate_limit import allow_persistent
from app.services.storage import (
    STORAGE_ERRORS,
    LocalStorage,
    S3Storage,
    get_storage,
    is_published,
    reset_storage,
)

NOW = 1_790_000_000

# --- allow_persistent ------------------------------------------------------------------


@pytest.fixture
async def db(app):
    async with get_session_factory()() as session:
        yield session


async def _count(db, key: str) -> int:
    query = select(func.count()).select_from(RateHit).where(RateHit.key == key)
    return (await db.execute(query)).scalar_one()


async def _old_hits(db, key: str, n: int, age: timedelta) -> None:
    db.add_all(RateHit(key=key, created_at=utcnow() - age) for _ in range(n))
    await db.commit()


async def test_a_persistent_limit_allows_up_to_its_count_then_refuses(db):
    allowed = [
        await allow_persistent(db, "pwreset:a@x", limit=3, window_seconds=3600) for _ in range(5)
    ]
    assert allowed == [True, True, True, False, False]
    # A refused hit is not counted.
    assert await _count(db, "pwreset:a@x") == 3


async def test_persistent_keys_are_counted_apart(db):
    for _ in range(2):
        assert await allow_persistent(db, "a", limit=2, window_seconds=60)
    assert not await allow_persistent(db, "a", limit=2, window_seconds=60)
    assert await allow_persistent(db, "b", limit=2, window_seconds=60)
    assert (await _count(db, "a"), await _count(db, "b")) == (2, 1)


async def test_an_expired_hit_is_purged_and_no_longer_counts(db):
    await _old_hits(db, "a", 3, timedelta(hours=2))
    assert await allow_persistent(db, "a", limit=3, window_seconds=3600)
    # The three expired rows are gone; only the new hit is left.
    assert await _count(db, "a") == 1


async def test_a_hit_still_inside_the_window_counts(db):
    await _old_hits(db, "a", 2, timedelta(minutes=50))
    assert await allow_persistent(db, "a", limit=3, window_seconds=3600)
    assert not await allow_persistent(db, "a", limit=3, window_seconds=3600)


async def test_purging_one_key_leaves_another_keys_expired_hits(db):
    """Each call cleans up its own key only."""
    await _old_hits(db, "b", 2, timedelta(hours=2))
    assert await allow_persistent(db, "a", limit=1, window_seconds=3600)
    assert await _count(db, "b") == 2


async def test_a_persistent_hit_lands_only_with_the_callers_commit(db):
    """The hit and the action it gates are one transaction: rolled back,
    neither happened."""
    assert await allow_persistent(db, "a", limit=1, window_seconds=3600)
    await db.rollback()
    assert await _count(db, "a") == 0
    assert await allow_persistent(db, "a", limit=1, window_seconds=3600)
    await db.commit()
    async with get_session_factory()() as other:
        assert await _count(other, "a") == 1
        assert not await allow_persistent(other, "a", limit=1, window_seconds=3600)


# --- LocalStorage: signatures ----------------------------------------------------------


@pytest.fixture
def local(tmp_path) -> LocalStorage:
    return LocalStorage(tmp_path / "root", "http://testserver/", "secret", 60)


@pytest.fixture
def frozen(monkeypatch):
    """time.time() is NOW (storage reads it through the time module)."""
    monkeypatch.setattr(storage_module.time, "time", lambda: NOW)


def test_a_signature_is_hmac_sha256_of_method_key_and_expiry(local):
    expected = hmac.new(b"secret", b"GET:orgs/o/a.png:123", hashlib.sha256).hexdigest()
    assert local.sign("GET", "orgs/o/a.png", 123) == expected


def test_a_signature_verifies_only_for_its_method_key_and_expiry(local, frozen):
    key, expires = "orgs/o/a.png", NOW + 60
    signature = local.sign("GET", key, expires)
    assert local.verify("GET", key, expires, signature)
    assert not local.verify("PUT", key, expires, signature)
    assert not local.verify("GET", "orgs/o/b.png", expires, signature)
    assert not local.verify("GET", key, expires + 1, signature)
    tampered = signature[:-1] + ("0" if signature[-1] != "0" else "1")
    assert not local.verify("GET", key, expires, tampered)


def test_a_signature_made_with_another_secret_does_not_verify(local, frozen):
    other = LocalStorage(local.root, "http://testserver", "other-secret", 60)
    signature = other.sign("GET", "orgs/o/a.png", NOW + 60)
    assert not local.verify("GET", "orgs/o/a.png", NOW + 60, signature)


def test_a_signature_is_valid_through_its_last_second_then_expires(local, frozen):
    for expires, valid in ((NOW, True), (NOW - 1, False)):
        signature = local.sign("GET", "orgs/o/a.png", expires)
        assert local.verify("GET", "orgs/o/a.png", expires, signature) is valid


# --- LocalStorage: URLs ----------------------------------------------------------------


def _parts(url: str) -> tuple[str, int, str]:
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    return (
        f"{parts.scheme}://{parts.netloc}{parts.path}",
        int(query["expires"][0]),
        query["signature"][0],
    )


async def test_a_put_url_is_signed_for_put_and_expires_after_the_expiry(local, frozen):
    key = "orgs/o/a b.png"
    where, expires, signature = _parts(await local.presign_put(key, "image/png"))
    # No double slash from the base URL's own; the key is quoted.
    assert where == "http://testserver/storage/orgs/o/a%20b.png"
    assert expires == NOW + 60
    assert local.verify("PUT", key, expires, signature)
    assert not local.verify("GET", key, expires, signature)


async def test_a_drafts_get_url_expires_after_the_expiry(local, frozen):
    where, expires, signature = _parts(await local.presign_get("orgs/o/avatars/1/rig.json"))
    assert where == "http://testserver/storage/orgs/o/avatars/1/rig.json"
    assert expires == NOW + 60
    assert local.verify("GET", "orgs/o/avatars/1/rig.json", expires, signature)


async def test_a_published_files_put_url_is_not_windowed(local, frozen):
    """Only a GET of a published file is shared within a window."""
    key = "orgs/o/avatars/1/published/r3/rig.json"
    _, expires, _ = _parts(await local.presign_put(key, "application/json"))
    assert expires == NOW + 60


async def test_without_an_expiry_a_published_get_url_is_not_windowed(local, frozen):
    """A zero window would divide by zero: the URL is a plain one then."""
    unwindowed = LocalStorage(local.root, "http://testserver", "secret", 0)
    _, expires, _ = _parts(await unwindowed.presign_get("orgs/o/avatars/1/published/r3/rig.json"))
    assert expires == NOW


def test_a_published_key_is_one_under_a_published_folder():
    assert is_published("orgs/o/avatars/1/published/r3/rig.json")
    assert not is_published("orgs/o/avatars/1/rig.json")
    assert not is_published("orgs/o/avatars/1/published-notes.json")


# --- LocalStorage: keys and files ------------------------------------------------------


@pytest.mark.parametrize("key", ["../x", "a/../../x", "..", "/etc/passwd"])
def test_a_key_escaping_the_root_is_refused(local, key):
    with pytest.raises(ValueError, match="invalid storage key"):
        local._path(key)


def test_a_key_that_wanders_but_stays_inside_the_root_is_allowed(local):
    assert local._path("a/../b.png") == (local.root / "b.png").resolve()


async def test_no_file_operation_reaches_outside_the_root(local, tmp_path):
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"keep")
    with pytest.raises(ValueError):
        await local.put_bytes("../outside.png", b"x", "image/png")
    with pytest.raises(ValueError):
        await local.get_bytes("../outside.png")
    with pytest.raises(ValueError):
        await local.delete("../outside.png")
    with pytest.raises(ValueError):
        await local.file("../outside.png")
    assert outside.read_bytes() == b"keep"


async def test_a_stored_file_exists_reads_back_and_is_deleted(local):
    await local.put_bytes("orgs/o/a.png", b"data", "image/png")
    assert await local.exists("orgs/o/a.png")
    assert await local.get_bytes("orgs/o/a.png") == b"data"
    await local.delete("orgs/o/a.png")
    assert not await local.exists("orgs/o/a.png")


async def test_deleting_a_missing_key_is_a_no_op(local):
    await local.delete("orgs/o/never.png")
    assert not await local.exists("orgs/o/never.png")


async def test_a_missing_file_is_a_storage_error_when_read(local):
    with pytest.raises(STORAGE_ERRORS) as raised:
        await local.get_bytes("orgs/o/never.png")
    assert isinstance(raised.value, FileNotFoundError)


async def test_a_folder_is_not_a_file_to_check_or_delete(local):
    await local.put_bytes("orgs/o/a.png", b"x", "image/png")
    assert not await local.exists("orgs/o")
    await local.delete("orgs/o")
    assert await local.exists("orgs/o/a.png")


async def test_list_names_hides_a_write_in_progress(local):
    await local.put_bytes("orgs/o/a.png", b"x", "image/png")
    (local.root / "orgs/o/.a.png.0123abcd.tmp").write_bytes(b"half")
    assert await local.list_names("orgs/o/") == ["a.png"]


# --- LocalStorage: sweep ---------------------------------------------------------------


def _age(path: Path, hours: float) -> None:
    old = time.time() - hours * 3600
    os.utime(path, (old, old))


async def test_a_sweep_takes_only_files_both_old_and_matching(local):
    keys = {
        "orgs/o/candidates/old.png": 48,
        "orgs/o/candidates/new.png": 1,
        "orgs/o/avatars/a/old.png": 48,
        "orgs/o/avatars/a/new.png": 1,
    }
    for key, hours in keys.items():
        await local.put_bytes(key, b"x", "image/png")
        _age(local.root / key, hours)
    assert await local.sweep("orgs/", 24 * 3600, "/candidates/") == 1
    assert [key for key in keys if await local.exists(key)] == [
        "orgs/o/candidates/new.png",
        "orgs/o/avatars/a/old.png",
        "orgs/o/avatars/a/new.png",
    ]
    # Files go, folders stay.
    assert (local.root / "orgs/o/candidates").is_dir()


async def test_a_sweep_matches_the_key_with_a_leading_slash(local):
    """The guard can name the first segment of a key."""
    await local.put_bytes("candidates/top.png", b"x", "image/png")
    _age(local.root / "candidates/top.png", 48)
    assert await local.sweep("candidates/", 3600, "/candidates/") == 1


async def test_a_sweep_of_a_prefix_outside_the_root_removes_nothing(local, tmp_path):
    stray = tmp_path / "outside" / "candidates" / "x.png"
    stray.parent.mkdir(parents=True)
    stray.write_bytes(b"x")
    _age(stray, 48)
    assert await local.sweep("../outside/", 0, "/candidates/") == 0
    assert stray.exists()


async def test_a_sweep_of_a_missing_prefix_removes_nothing(local):
    assert await local.sweep("orgs/nobody/", 0, "/candidates/") == 0


# --- S3Storage -------------------------------------------------------------------------


class Body:
    def __init__(self, data: bytes) -> None:
        self.data = data

    async def read(self) -> bytes:
        return self.data


class FakeS3:
    """The few calls S3Storage makes, recorded."""

    exceptions = SimpleNamespace(ClientError=ClientError)

    def __init__(self, pages: list[dict] | None = None, head_error: Exception | None = None):
        self.pages = pages or []
        self.head_error = head_error
        self.calls: list[tuple[str, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def head_object(self, **kwargs):
        self.calls.append(("head_object", kwargs))
        if self.head_error is not None:
            raise self.head_error

    async def generate_presigned_url(self, operation, Params, ExpiresIn):
        self.calls.append((operation, {"Params": Params, "ExpiresIn": ExpiresIn}))
        return f"https://signed.example/{operation}/{Params['Key']}"

    async def put_object(self, **kwargs):
        self.calls.append(("put_object", kwargs))

    async def get_object(self, **kwargs):
        self.calls.append(("get_object", kwargs))
        return {"Body": Body(b"bytes")}

    async def delete_object(self, **kwargs):
        self.calls.append(("delete_object", kwargs))

    async def delete_objects(self, Bucket, Delete):
        self.calls.append(("delete_objects", {"Bucket": Bucket, "Delete": Delete}))

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        fake = self

        class Paginator:
            def paginate(self, **kwargs):
                fake.calls.append(("paginate", kwargs))

                async def pages():
                    for page in fake.pages:
                        yield page

                return pages()

        return Paginator()


def _s3(monkeypatch, client: FakeS3 | None) -> S3Storage:
    s3 = S3Storage("https://s3.example", "key", "secret", "bucket", "auto", 60)

    def opened():
        if client is None:
            raise AssertionError("no client may be opened")
        return client

    monkeypatch.setattr(s3, "_client", opened)
    return s3


async def test_s3_an_object_exists_when_its_head_answers(monkeypatch):
    client = FakeS3()
    assert await _s3(monkeypatch, client).exists("orgs/o/a.png")
    assert client.calls == [("head_object", {"Bucket": "bucket", "Key": "orgs/o/a.png"})]


async def test_s3_an_object_whose_head_is_refused_does_not_exist(monkeypatch):
    missing = ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
    assert not await _s3(monkeypatch, FakeS3(head_error=missing)).exists("orgs/o/a.png")


async def test_s3_an_outage_is_not_mistaken_for_a_missing_object(monkeypatch):
    down = EndpointConnectionError(endpoint_url="https://s3.example")
    with pytest.raises(EndpointConnectionError):
        await _s3(monkeypatch, FakeS3(head_error=down)).exists("orgs/o/a.png")


async def test_s3_presigned_urls_name_the_bucket_key_type_and_expiry(monkeypatch):
    client = FakeS3()
    s3 = _s3(monkeypatch, client)
    assert await s3.presign_put("orgs/o/a.png", "image/png") == (
        "https://signed.example/put_object/orgs/o/a.png"
    )
    assert await s3.presign_get("orgs/o/a.png") == (
        "https://signed.example/get_object/orgs/o/a.png"
    )
    assert client.calls == [
        (
            "put_object",
            {
                "Params": {"Bucket": "bucket", "Key": "orgs/o/a.png", "ContentType": "image/png"},
                "ExpiresIn": 60,
            },
        ),
        ("get_object", {"Params": {"Bucket": "bucket", "Key": "orgs/o/a.png"}, "ExpiresIn": 60}),
    ]


async def test_s3_puts_reads_and_deletes_one_object(monkeypatch):
    client = FakeS3()
    s3 = _s3(monkeypatch, client)
    await s3.put_bytes("orgs/o/a.png", b"png", "image/png")
    assert await s3.get_bytes("orgs/o/a.png") == b"bytes"
    await s3.delete("orgs/o/a.png")
    assert client.calls == [
        (
            "put_object",
            {"Bucket": "bucket", "Key": "orgs/o/a.png", "Body": b"png", "ContentType": "image/png"},
        ),
        ("get_object", {"Bucket": "bucket", "Key": "orgs/o/a.png"}),
        ("delete_object", {"Bucket": "bucket", "Key": "orgs/o/a.png"}),
    ]


async def test_s3_sweep_deletes_only_stale_matching_keys_a_thousand_at_a_time(monkeypatch):
    now = datetime.now(UTC)
    stale, fresh = now - timedelta(hours=48), now - timedelta(minutes=5)
    first = [{"Key": f"orgs/o/candidates/{i}.png", "LastModified": stale} for i in range(2500)]
    first += [
        {"Key": "orgs/o/candidates/fresh.png", "LastModified": fresh},
        {"Key": "orgs/o/avatars/a/source.png", "LastModified": stale},
        {"Key": "orgs/o/avatars/candidates-demo/source.png", "LastModified": stale},
    ]
    second = [{"Key": "candidates/top.png", "LastModified": stale}]
    client = FakeS3(pages=[{"Contents": first}, {"Contents": second}, {}])

    assert await _s3(monkeypatch, client).sweep("orgs/", 24 * 3600, "/candidates/") == 2501

    assert client.calls[0] == ("paginate", {"Bucket": "bucket", "Prefix": "orgs/"})
    deletes = [
        kwargs["Delete"]["Objects"] for name, kwargs in client.calls if name == "delete_objects"
    ]
    assert [len(batch) for batch in deletes] == [1000, 1000, 500, 1]
    deleted = [obj["Key"] for batch in deletes for obj in batch]
    assert deleted == [f"orgs/o/candidates/{i}.png" for i in range(2500)] + ["candidates/top.png"]
    assert all(kwargs["Bucket"] == "bucket" for _, kwargs in client.calls)


async def test_s3_sweep_with_nothing_stale_deletes_nothing(monkeypatch):
    fresh = datetime.now(UTC)
    client = FakeS3(
        pages=[{"Contents": [{"Key": "orgs/o/candidates/a.png", "LastModified": fresh}]}]
    )
    assert await _s3(monkeypatch, client).sweep("orgs/", 3600, "/candidates/") == 0
    assert [name for name, _ in client.calls] == ["paginate"]


async def test_s3_refuses_an_unguarded_sweep_or_a_bad_prefix_before_connecting(monkeypatch):
    s3 = _s3(monkeypatch, None)
    with pytest.raises(ValueError, match="must_contain is required"):
        await s3.sweep("orgs/", 0, "")
    with pytest.raises(ValueError, match="refusing"):
        await s3.list_names("orgs/o")


# --- by prefix: only a plain folder ----------------------------------------------------


@pytest.mark.parametrize("prefix", ["//", "///", "orgs", "orgs/a..b/", "/../", "orgs/o/../"])
async def test_a_prefix_that_is_not_a_plain_folder_is_refused(monkeypatch, prefix):
    s3 = _s3(monkeypatch, None)
    for by_prefix in (s3.list_names, s3.delete_prefix):
        with pytest.raises(ValueError, match="refusing to delete by prefix"):
            await by_prefix(prefix)


@pytest.mark.parametrize("prefix", ["orgs/", "orgs/o/avatars/1/", "/orgs/"])
async def test_a_folder_prefix_is_accepted(monkeypatch, prefix):
    client = FakeS3(pages=[{}])
    assert await _s3(monkeypatch, client).delete_prefix(prefix) == 0
    assert client.calls == [("paginate", {"Bucket": "bucket", "Prefix": prefix})]


# --- get_storage -----------------------------------------------------------------------


@pytest.fixture
def chosen(monkeypatch, tmp_path):
    """get_storage under settings a test picks; the cache dropped before and
    after, so no other test sees the storage chosen here."""
    asked: list[Settings] = []

    def use(**values) -> None:
        settings = Settings(
            _env_file=None,
            local_storage_dir=str(tmp_path / "files"),
            public_base_url="https://app.example/",
            jwt_secret="jwt",
            presign_expiry_seconds=900,
            **values,
        )

        def get_settings() -> Settings:
            asked.append(settings)
            return settings

        monkeypatch.setattr(storage_module, "get_settings", get_settings)

    reset_storage()
    yield use, asked
    reset_storage()


def test_storage_is_local_files_when_r2_is_not_configured(chosen, tmp_path):
    use, _ = chosen
    # Two of the three R2 settings are not enough.
    use(r2_endpoint="https://r2.example", r2_access_key="k", r2_secret="")
    storage = get_storage()
    assert type(storage) is LocalStorage
    assert storage.root == tmp_path / "files"
    assert (storage.base_url, storage.secret, storage.expiry_seconds) == (
        "https://app.example",
        b"jwt",
        900,
    )


def test_storage_is_s3_when_r2_is_configured(chosen):
    use, _ = chosen
    use(
        r2_endpoint="https://r2.example",
        r2_access_key="k",
        r2_secret="s",
        r2_bucket="b",
        r2_region="eu",
    )
    storage = get_storage()
    assert type(storage) is S3Storage
    assert (storage.bucket, storage.expiry_seconds) == ("b", 900)
    assert storage._client_kwargs == {
        "service_name": "s3",
        "endpoint_url": "https://r2.example",
        "aws_access_key_id": "k",
        "aws_secret_access_key": "s",
        "region_name": "eu",
    }


def test_storage_is_chosen_once_until_reset(chosen):
    use, asked = chosen
    use()
    first = get_storage()
    assert get_storage() is first
    assert len(asked) == 1
    reset_storage()
    second = get_storage()
    assert second is not first and len(asked) == 2
