"""CPU work reached from a request runs on a thread, never on the event loop.

The API is one process and one loop: every widget on every customer's site
waits while anything runs on it (services.jobs). Each test spies on the
function that does the work and checks which thread called it.
"""

import io
import json
import threading

import pytest
from PIL import Image

from app import main
from app.api import lab, stock
from app.services import rig as rig_module
from app.services.avatars import fitting
from app.services.avatars import photo as avatar_photo
from app.services.storage import get_storage
from app.services.tts import offline, piper
from app.services.tts.piper import CATALOGUE, PiperTTSProvider
from tests.conftest import create_org, create_ready_avatar, register_and_login


def _spy(monkeypatch, owner, name):
    """Replace owner.name with a wrapper recording the calling threads."""
    threads: list[threading.Thread] = []
    real = getattr(owner, name)

    def wrapper(*args, **kwargs):
        threads.append(threading.current_thread())
        return real(*args, **kwargs)

    monkeypatch.setattr(owner, name, wrapper)
    return threads


def _off_loop(threads) -> bool:
    return bool(threads) and all(t is not threading.main_thread() for t in threads)


def _on_cpu_thread(threads) -> bool:
    return bool(threads) and all(t.name.startswith("liveface-cpu") for t in threads)


async def test_offline_speech_is_rendered_off_the_loop(monkeypatch):
    """Sample-by-sample Python: half a second for 600 characters."""
    threads = _spy(monkeypatch, offline, "plan_utterance")
    result = await offline.OfflineTTSProvider().synthesize("Hello there.", "offline-warm", "en-US")
    assert result.audio.startswith(b"RIFF") and result.cues
    assert _off_loop(threads)


async def test_provider_cues_are_built_off_the_loop(monkeypatch, tmp_path):
    """Planning (espeak outside English) and a pass over the recording."""
    from app.core import config

    (tmp_path / f"{CATALOGUE['fa_amir'][0]}.onnx").write_bytes(b"stub")
    monkeypatch.setattr(config.get_settings(), "piper_voices_dir", str(tmp_path), raising=False)
    monkeypatch.setattr(piper, "_render", lambda text, stem: (b"RIFF", 2000))
    threads = _spy(monkeypatch, piper, "cues_from_text")
    await PiperTTSProvider().synthesize("سلام", "fa_amir", "fa-IR")
    assert _off_loop(threads)


@pytest.fixture
async def avatar(client):
    headers = await register_and_login(client, "offloop")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    return headers, f"/orgs/{org_id}/avatars/{avatar_id}", org_id, avatar_id


def _transparent_png() -> bytes:
    out = io.BytesIO()
    Image.new("RGBA", (300, 300), (0, 0, 0, 0)).save(out, format="PNG")
    return out.getvalue()


async def test_background_removal_runs_on_the_cpu_thread(client, avatar, monkeypatch):
    headers, base, _, _ = avatar
    monkeypatch.setattr(avatar_photo, "remove_background", lambda raw: _transparent_png())
    cut = _spy(monkeypatch, avatar_photo, "remove_background")
    thumbs = _spy(monkeypatch, rig_module, "make_thumbnail")
    response = await client.post(f"{base}/background", json={"remove": True}, headers=headers)
    assert response.status_code == 200, response.text
    assert _on_cpu_thread(cut)
    assert _on_cpu_thread(thumbs)


async def test_a_crop_is_decoded_and_encoded_on_the_cpu_thread(client, avatar, monkeypatch):
    headers, base, _, _ = avatar
    encodes = _spy(monkeypatch, avatar_photo, "png_bytes")
    response = await client.post(
        f"{base}/crop", json={"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}, headers=headers
    )
    assert response.status_code == 200, response.text
    assert _on_cpu_thread(encodes)


async def test_a_crop_reset_searches_pixels_on_the_cpu_thread(client, avatar, monkeypatch):
    """A rig cropped before its origin was recorded is found in the pixels."""
    headers, base, org_id, avatar_id = avatar
    crop = {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}
    assert (await client.post(f"{base}/crop", json=crop, headers=headers)).status_code == 200
    # Make the stored rig look like one cropped before origins were kept.
    storage = get_storage()
    key = f"orgs/{org_id}/avatars/{avatar_id}/rig.json"
    rig = json.loads(await storage.get_bytes(key))
    del rig["crop_origin"]
    await storage.put_bytes(key, json.dumps(rig).encode(), "application/json")

    searches = _spy(monkeypatch, avatar_photo, "_locate_crop")
    reset = await client.post(f"{base}/crop", json={"reset": True}, headers=headers)
    assert reset.status_code == 200, reset.text
    assert _on_cpu_thread(searches)


async def test_lab_depth_runs_the_landmarker_on_the_cpu_thread(client, avatar, monkeypatch):
    headers, _, org_id, avatar_id = avatar
    threads = _spy(monkeypatch, lab, "_landmark_z")
    response = await client.get(f"/orgs/{org_id}/lab/avatars/{avatar_id}/depth", headers=headers)
    assert response.status_code == 200
    assert _on_cpu_thread(threads)


async def test_rig_fit_drags_are_fitted_off_the_loop(client, avatar, monkeypatch):
    headers, base, _, _ = avatar
    threads = _spy(monkeypatch, fitting, "fit_rig")
    anchors = await client.get(f"{base}/rig-anchors", headers=headers)
    assert anchors.status_code == 200, anchors.text
    assert _off_loop(threads)


async def test_stock_pictures_are_drawn_off_the_loop(client, monkeypatch):
    stock_ids = [s.id for s in stock.STOCK_STYLES]
    threads = _spy(monkeypatch, stock, "get_stock_image")
    response = await client.get(f"/stock-avatars/{stock_ids[0]}.png")
    assert response.status_code == 200
    assert _off_loop(threads)


def test_each_widget_bundle_is_hashed_once(tmp_path, monkeypatch):
    """One cache entry for every bundle re-hashed a bundle whenever another
    was asked for in between, which every page loading two of them does."""
    monkeypatch.setattr(main, "_ETAG_CACHE", {})
    first, second = tmp_path / "a.js", tmp_path / "b.js"
    first.write_text("one")
    second.write_text("two")
    reads = _spy(monkeypatch, type(first), "read_bytes")
    tags = [main._bundle_etag(path) for path in (first, second, first, second, first)]
    assert len(reads) == 2
    assert tags[0] == tags[2] == tags[4] != tags[1]
    first.write_text("one, rebuilt")
    assert main._bundle_etag(first) != tags[0]
    assert len(reads) == 3
