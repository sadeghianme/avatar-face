"""Test fixtures.

Determinism rule: tests must behave the same regardless of a developer's
.env — so storage is forced to the local-filesystem fallback (R2_* nulled,
storage cache cleared) and the DB is a throwaway SQLite file per session.
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

TMP = Path(tempfile.mkdtemp(prefix="liveface-tests-"))

# Must be set before app modules import settings.
os.environ.update(
    {
        "DATABASE_URL": f"sqlite+aiosqlite:///{TMP / 'test.sqlite3'}",
        "JWT_SECRET": "test-secret",
        "R2_ENDPOINT": "",
        "R2_ACCESS_KEY": "",
        "R2_SECRET": "",
        "LOCAL_STORAGE_DIR": str(TMP / "storage"),
        "PUBLIC_BASE_URL": "http://testserver",
        "RIG_MODEL_PATH": "",
        "EMBED_RATE_LIMIT_PER_MINUTE": "5",
        "MONTHLY_CHAR_LIMIT": "1000",
        "AZURE_SPEECH_KEY": "",
        "AZURE_SPEECH_REGION": "",
        "ELEVENLABS_API_KEY": "",
        "GOOGLE_TTS_CREDENTIALS_JSON": "",
        "OPENAI_API_KEY": "",
        "CREDENTIAL_ENCRYPTION_KEY": "",
    }
)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()

from app.core.credentials import credentials  # noqa: E402
from app.db import get_engine, reset_engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Base  # noqa: E402
from app.services.rate_limit import reset_embed_rate_limiter  # noqa: E402
from app.services.storage import reset_storage  # noqa: E402


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture()
async def app():
    reset_engine()
    reset_storage()
    reset_embed_rate_limiter()
    credentials.clear()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    application = create_app()
    yield application
    await engine.dispose()
    reset_engine()


@pytest_asyncio.fixture()
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


# --- helpers ---


async def register_and_login(
    client: AsyncClient, username: str = "alice", email: str | None = None,
    password: str = "password123",
) -> dict[str, str]:
    """Returns auth headers for a fresh user."""
    email = email or f"{username}@example.com"
    response = await client.post(
        "/auth/register",
        json={"email": email, "username": username, "password": password},
    )
    assert response.status_code == 201, response.text
    response = await client.post(
        "/auth/login", json={"username_or_email": username, "password": password}
    )
    assert response.status_code == 200, response.text
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def create_org(client: AsyncClient, headers: dict, name: str = "Acme") -> str:
    response = await client.post("/orgs", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def sample_png() -> bytes:
    """A small valid PNG portrait."""
    import io

    from PIL import Image

    img = Image.new("RGB", (320, 400), "#d9b690")
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


async def create_ready_avatar(client: AsyncClient, headers: dict, org_id: str) -> str:
    """Full upload pipeline: create -> PUT image -> confirm -> rig runs."""
    response = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Test Avatar", "content_type": "image/png"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    avatar_id = payload["avatar"]["id"]
    upload_url = payload["upload_url"]

    put = await client.put(
        upload_url, content=sample_png(), headers={"Content-Type": "image/png"}
    )
    assert put.status_code == 200, put.text

    confirm = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/uploaded", headers=headers
    )
    assert confirm.status_code == 200, confirm.text

    # BackgroundTasks run before the response returns under the ASGI
    # transport, so the avatar should already be ready; poll to be safe.
    for _ in range(20):
        detail = await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
        if detail.json()["status"] in ("ready", "failed"):
            break
        await asyncio.sleep(0.05)
    assert detail.json()["status"] == "ready", detail.text
    return avatar_id
