"""The /storage routes: files streamed off the loop, uploads bounded."""

import threading
from urllib.parse import urlsplit

import pytest

from app.api import storage_routes
from app.services.storage import LocalStorage, get_storage


def _path(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.path}?{parts.query}"


@pytest.fixture
def local(tmp_path) -> LocalStorage:
    return LocalStorage(tmp_path, "http://testserver", "secret", 60)


async def test_every_filesystem_call_runs_off_the_event_loop(local, monkeypatch):
    threads: list[threading.Thread] = []
    real = LocalStorage._path

    def spy(self, key):
        threads.append(threading.current_thread())
        return real(self, key)

    monkeypatch.setattr(LocalStorage, "_path", spy)
    await local.put_bytes("orgs/o/a.png", b"x", "image/png")
    await local.get_bytes("orgs/o/a.png")
    await local.exists("orgs/o/a.png")
    await local.file("orgs/o/a.png")
    await local.list_names("orgs/o/")
    await local.delete("orgs/o/a.png")
    await local.delete_prefix("orgs/o/")
    assert len(threads) == 7
    assert all(t is not threading.main_thread() for t in threads)


async def test_file_is_none_for_a_missing_key_or_a_folder(local):
    await local.put_bytes("orgs/o/a.png", b"x", "image/png")
    assert await local.file("orgs/o/missing.png") is None
    assert await local.file("orgs/o") is None
    path, stat = await local.file("orgs/o/a.png")
    assert path.read_bytes() == b"x" and stat.st_size == 1


async def test_a_get_streams_the_file_without_reading_it_whole(client, monkeypatch):
    storage = get_storage()
    assert isinstance(storage, LocalStorage)
    data = bytes(range(256)) * 400  # 100 KiB
    await storage.put_bytes("orgs/o/avatars/a/rig.json", data, "application/json")

    async def no_whole_reads(key):
        raise AssertionError("GET must stream, not read the file into memory")

    monkeypatch.setattr(storage, "get_bytes", no_whole_reads)
    url = _path(await storage.presign_get("orgs/o/avatars/a/rig.json"))
    response = await client.get(url)
    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-type"] == "application/json"
    assert response.headers["content-length"] == str(len(data))
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["accept-ranges"] == "bytes"


async def test_a_range_request_gets_that_part(client):
    storage = get_storage()
    data = b"0123456789" * 10
    await storage.put_bytes("orgs/o/voice.wav", data, "audio/wav")
    url = _path(await storage.presign_get("orgs/o/voice.wav"))
    response = await client.get(url, headers={"Range": "bytes=10-19"})
    assert response.status_code == 206
    assert response.content == data[10:20]
    assert response.headers["content-range"] == f"bytes 10-19/{len(data)}"


async def test_a_missing_object_is_still_a_404(client):
    url = _path(await get_storage().presign_get("orgs/o/nothing.png"))
    response = await client.get(url)
    assert response.status_code == 404
    assert response.json()["code"] == "object_not_found"


def test_upload_limits_follow_the_signed_keys_type():
    assert storage_routes.upload_limit("orgs/o/avatars/a/source.glb") == 30 * 1024 * 1024
    assert storage_routes.upload_limit("orgs/o/avatars/a/source.png") == 15 * 1024 * 1024
    assert storage_routes.upload_limit("orgs/o/avatars/a/source.JPG") == 15 * 1024 * 1024
    assert storage_routes.upload_limit("orgs/o.d/avatars/a/source") == 15 * 1024 * 1024


async def test_a_put_past_the_limit_is_refused(client, monkeypatch):
    monkeypatch.setattr(storage_routes, "upload_limit", lambda key: 1000)
    storage = get_storage()
    url = _path(await storage.presign_put("orgs/o/big.png", "image/png"))

    refused = await client.put(url, content=b"x" * 1001, headers={"Content-Type": "image/png"})
    assert refused.status_code == 413
    assert refused.json()["code"] == "upload_too_large"
    assert not await storage.exists("orgs/o/big.png")

    accepted = await client.put(url, content=b"x" * 1000, headers={"Content-Type": "image/png"})
    assert accepted.status_code == 200
    assert await storage.get_bytes("orgs/o/big.png") == b"x" * 1000


async def test_a_put_without_a_length_is_cut_off_as_it_streams(client, monkeypatch):
    """A chunked body declares no length; it is counted as it arrives."""
    monkeypatch.setattr(storage_routes, "upload_limit", lambda key: 1000)
    url = _path(await get_storage().presign_put("orgs/o/chunked.png", "image/png"))

    async def body():
        for _ in range(5):
            yield b"x" * 300

    refused = await client.put(url, content=body(), headers={"Content-Type": "image/png"})
    assert refused.status_code == 413
    assert refused.json()["code"] == "upload_too_large"


async def test_an_empty_put_is_still_a_422(client):
    url = _path(await get_storage().presign_put("orgs/o/empty.png", "image/png"))
    response = await client.put(url, content=b"", headers={"Content-Type": "image/png"})
    assert response.status_code == 422
    assert response.json()["code"] == "empty_upload"
