"""The public contract, byte for byte: what a customer's widget and a share
page are served for a published avatar.

The goldens in tests/fixtures/public_contract/ were recorded from main's
hand-built dicts (api.embed.embed_avatar, api.share.public_avatar) before
the two endpoints got their response models. Every value, every absent key
and every null must stay as it was: the widget on a customer's page is the
one client that cannot be redeployed with the server. Only the order of
keys may differ, so the comparison sorts them, and nothing else.

Deterministic on purpose: fixed ids, a fixed share token, and the storage
clock frozen, so every presigned URL is the same on every run.

    UPDATE_CONTRACT_GOLDENS=1 pytest tests/test_public_contract.py   # re-record
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.db import get_session_factory
from app.models import ApiKey, Avatar, AvatarKind, AvatarStatus, Organization, User
from app.models.api_key import hash_api_key
from app.services import storage as storage_module
from app.services.storage import get_storage

GOLDENS = Path(__file__).parent / "fixtures" / "public_contract"
UPDATE = os.environ.get("UPDATE_CONTRACT_GOLDENS") == "1"

FROZEN_NOW = 1_800_000_000
ORG = "0" * 31 + "a"
USER = "0" * 31 + "b"
KEY = "lf_golden-contract-key-not-a-secret"


def _prefix(avatar_id: str) -> str:
    return f"orgs/{ORG}/avatars/{avatar_id}/published/r3/"


def _snapshot(avatar_id: str, **fields) -> dict:
    """A published_config as services.publishing.publish writes it."""
    prefix = _prefix(avatar_id)
    config = {
        "revision": 3,
        "framing": "face",
        "image_key": f"{prefix}image.png",
        "rig_key": f"{prefix}rig.json",
        "thumbnail_key": f"{prefix}thumb.jpg",
        "layer_keys": None,
        "published_at": "2026-10-01T12:00:00+00:00",
    }
    config.update(fields)
    return config


def _cases() -> dict[str, dict]:
    """name -> {avatar fields, snapshot, files that must exist}."""
    human = "1" * 32
    cartoon = "2" * 32
    legacy = "3" * 32
    model3d = "4" * 32
    animal = "5" * 32
    return {
        # Everything a snapshot can carry: a scene with a picture, the
        # photographic mouth with its own teeth and motion, layers, a voice,
        # and an AI disclosure with both mouth entries.
        "human_full": {
            "id": human,
            "kind": AvatarKind.photo,
            "snapshot": _snapshot(
                human,
                face_type="human",
                scene={
                    "zoom": 1.15,
                    "pan": {"x": 0.1, "y": -0.05},
                    "background": {"kind": "image", "image_key": f"{_prefix(human)}scene.webp"},
                },
                voice={"provider": "kokoro", "voice": "af_heart", "locale": "en-US"},
                mouth={
                    "renderer": "continuous",
                    "profile": {
                        "teethScale": 1.05,
                        "teethY": -0.01,
                        "warmth": 0.5,
                        "lipProjection": 0.55,
                        "jawRange": 0.85,
                    },
                    "oral_image_key": f"{_prefix(human)}oral.webp",
                    "oral_rig_key": f"{_prefix(human)}oral.json",
                    "motion_key": f"{_prefix(human)}motion.json",
                    "teeth": {"source": "ai", "model": "gemini-image"},
                },
                layer_keys={
                    "background": f"{_prefix(human)}layer-background.jpg",
                    "body": f"{_prefix(human)}layer-body.png",
                    "head": f"{_prefix(human)}layer-head.png",
                },
                disclosure={
                    "ai_edited": {
                        "mode": "touchup",
                        "model": "gemini-image",
                        "teeth": {"model": "gemini-image"},
                        "mouth_shapes": {"model": "gemini-image", "generated": 6},
                    },
                    "line": "human",
                },
            ),
            "files": ["scene.webp", "oral.webp", "oral.json", "motion.json"],
        },
        # A cartoon on the classic mouth with the owner's character
        # settings, a colour behind it, no voice, and nothing AI-made.
        "cartoon_classic": {
            "id": cartoon,
            "kind": AvatarKind.photo,
            "snapshot": _snapshot(
                cartoon,
                framing="full",
                face_type="cartoon",
                scene={
                    "zoom": 0.0,
                    "pan": {"x": 0.0, "y": 0.0},
                    "background": {"kind": "color", "color": "#112233"},
                },
                voice=None,
                mouth={
                    "renderer": "classic",
                    "profile": {},
                    "character": {
                        "style": "character",
                        "teeth": "none",
                        "tongue": False,
                        "jaw": 1.3,
                    },
                },
                disclosure={"ai_edited": None, "line": "cartoon"},
            ),
            "files": [],
        },
        # Published before scenes, face types, voices, mouths and
        # disclosures existed, without a rig or a thumbnail copy.
        "legacy": {
            "id": legacy,
            "kind": AvatarKind.photo,
            "snapshot": {
                "revision": 0,
                "framing": "face",
                "image_key": f"{_prefix(legacy)}image.png",
                "rig_key": None,
                "thumbnail_key": None,
                "layer_keys": None,
                "published_at": None,
            },
            "files": [],
        },
        # A GLB, whose files are gone from storage: a photographic mouth
        # without its teeth photo or motion, an empty profile, and a scene
        # picture that no longer exists.
        "model3d_missing_files": {
            "id": model3d,
            "kind": AvatarKind.model3d,
            "snapshot": _snapshot(
                model3d,
                image_key=f"{_prefix(model3d)}image.glb",
                face_type="human",
                scene={
                    "zoom": 1.0,
                    "pan": {"x": 0.0, "y": 0.0},
                    "background": {"kind": "image", "image_key": f"{_prefix(model3d)}gone.webp"},
                },
                voice={"provider": "offline", "voice": "offline-warm", "locale": "fr-FR"},
                mouth={
                    "renderer": "continuous",
                    "profile": {},
                    "oral_image_key": f"{_prefix(model3d)}oral.webp",
                    "oral_rig_key": f"{_prefix(model3d)}oral.json",
                    "motion_key": f"{_prefix(model3d)}motion.json",
                },
                layer_keys={
                    "body": f"{_prefix(model3d)}layer-body.png",
                    "head": f"{_prefix(model3d)}layer-head.png",
                },
                disclosure={"ai_edited": {"mode": "generate", "model": None}, "line": "human"},
            ),
            "files": [],
        },
        # An animal on the classic mouth with no settings of its own: the
        # mouth is served as null; the transparent scene has no colour.
        "animal_plain": {
            "id": animal,
            "kind": AvatarKind.photo,
            "snapshot": _snapshot(
                animal,
                face_type="animal",
                scene={
                    "zoom": 1.0,
                    "pan": {"x": 0.25, "y": 0.0},
                    "background": {"kind": "transparent"},
                },
                mouth={"renderer": "classic", "profile": {}},
                disclosure={
                    "ai_edited": {
                        "mode": "mouth_shapes",
                        "model": "m",
                        "mouth_shapes": {"model": "m", "generated": 2},
                    },
                    "line": "animal",
                },
            ),
            "files": [],
        },
    }


@pytest.fixture
async def published(app, monkeypatch):
    """The cases above, as rows and files; the storage clock frozen."""
    monkeypatch.setattr(storage_module.time, "time", lambda: FROZEN_NOW)
    storage = get_storage()
    cases = _cases()
    async with get_session_factory()() as db:
        db.add(
            User(
                id=USER,
                email="golden@example.com",
                username="golden",
                password_hash="x",
                display_name="Golden",
            )
        )
        db.add(Organization(id=ORG, name="Golden"))
        await db.flush()
        db.add(
            ApiKey(
                org_id=ORG,
                created_by_id=USER,
                name="golden",
                prefix=KEY[:12],
                key_hash=hash_api_key(KEY),
                allowed_domains="",
            )
        )
        for index, (name, case) in enumerate(cases.items()):
            db.add(
                Avatar(
                    id=case["id"],
                    org_id=ORG,
                    created_by_id=USER,
                    name=f"Golden {name}",
                    status=AvatarStatus.ready,
                    kind=case["kind"],
                    content_type="image/png",
                    share_token=f"{index}" * 32,
                    published_config=json.dumps(case["snapshot"]),
                )
            )
            for file in case["files"]:
                await storage.put_bytes(
                    f"{_prefix(case['id'])}{file}", b"x", "application/octet-stream"
                )
        await db.commit()
    return cases


def _canonical(body: object) -> str:
    """Keys sorted, nothing else touched: 1 and 1.0 stay different."""
    return json.dumps(body, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


async def _served(client, published) -> dict[str, dict]:
    served: dict[str, dict] = {}
    for index, (name, case) in enumerate(published.items()):
        embed = await client.get(f"/embed/v1/avatars/{case['id']}", headers={"X-Api-Key": KEY})
        assert embed.status_code == 200, embed.text
        share = await client.get(f"/public/v1/avatars/{f'{index}' * 32}")
        assert share.status_code == 200, share.text
        served[f"embed_{name}"] = embed.json()
        served[f"share_{name}"] = share.json()
    return served


async def test_the_public_avatar_answers_are_unchanged(client, published):
    served = await _served(client, published)
    if UPDATE:
        GOLDENS.mkdir(parents=True, exist_ok=True)
        for name, body in served.items():
            (GOLDENS / f"{name}.json").write_text(_canonical(body), encoding="utf-8")
    for name, body in served.items():
        golden = (GOLDENS / f"{name}.json").read_text(encoding="utf-8")
        assert _canonical(body) == golden, f"{name} drifted from the recorded contract"
    assert len(list(GOLDENS.glob("*.json"))) == len(served), "a golden has no case"


async def test_the_share_answer_is_the_embed_answer_without_its_id(client, published):
    """One shape for both: what a share page renders is what a widget does."""
    served = await _served(client, published)
    for name in published:
        embed, share = served[f"embed_{name}"], served[f"share_{name}"]
        assert embed.pop("id") == published[name]["id"]
        assert embed == share
