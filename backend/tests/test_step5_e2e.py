"""Step 5 from end to end, over the API, the way the dashboard and a
visitor's widget drive it.

A person's photo whose parted lips show their teeth goes through the
wizard: the background removed, the touch-up the photo check calls for
started by the wizard on the member's remembered consent and used ("Use
this"), the points placed and previewed. Finished with AI allowed, step 5
("Preparing your avatar") goes through its stages in the order the
dashboard lists them and publishes the avatar with its own mouth. A
customer's page on another site then loads it as the widget does (the
config, then the motion, the teeth photo and its rig, cross-origin), and
the motion is checked by the embed's own loader (validateMotionManifest)
and played by its continuous mouth. Re-marking the points and publishing
moves the kit onto them, every shape's movement kept; a Discard of a later
draft leaves every published file as it was.

Fakes only, as in tests.test_mouth_kit: KitWorld's FakeProvider answers the
kit's seven requests, a touch-up is answered with the lips closed, `Smiles`
stands in for MediaPipe and `person_segmenter` for the segmenter. No
provider is ever called.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import re
import shutil
import subprocess
import warnings
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.core import config
from app.schemas.avatar import MouthProfile
from app.services import face_template, imagegen, landmarks, segment
from app.services import performance_kit as pk
from app.services import photo_adjust as pa
from app.services.jobs import Job, runner
from app.services.storage import get_storage
from tests.test_creation_ai import GOOD, Faces, _adjust, _org, ai_consent, face_box, png_of
from tests.test_creations import _create, _detect, _get, _run, depiction, portrait
from tests.test_mouth_kit import MODEL, KitWorld, _targets
from tests.test_photo_analysis import with_mouth

EMBED = Path(__file__).resolve().parents[2] / "embed"
# A customer's page, on a site of its own: where the widget runs.
SITE = "shop.example"
ORIGIN = f"https://{SITE}"
# The words a finish reports its progress in, in the order step 5 lists
# them for a person whose own mouth is made. The dashboard maps these very
# strings to its stages (frontend creation.ts FINISH_STAGE_LABELS: copy,
# rig, layers, shapes, fit, publish), so they are written out here.
STAGES = [
    "copying images",
    "building the rig",
    "building layers",
    "making the mouth shapes",
    "fitting the mouth",
    "publishing",
]
SHAPES_STAGE = "making the mouth shapes"
TEETH_WHITE = (246, 244, 236)
LIPS_RED = (164, 84, 84)


# --- The photo, the detector and the segmenter ------------------------------------


def _teeth_strip(size) -> tuple[int, int, int, int]:
    """Where a photo of `size` shows its teeth: a strip across the mouth of
    the template face Faces finds in it, a few pixels either side of the
    lips' seam."""
    points = face_template.place(face_box(size))
    seam = float(points[13][1] + points[14][1]) / 2
    return int(points[61][0]) + 4, int(seam) - 3, int(points[291][0]) - 4, int(seam) + 4


def smiling_portrait() -> bytes:
    """A good photo of a person whose parted lips show white teeth."""
    with Image.open(io.BytesIO(portrait(*GOOD))) as photo:
        image = photo.convert("RGB")
    ImageDraw.Draw(image).rectangle(_teeth_strip(GOOD), fill=TEETH_WHITE)
    return png_of(image)


def shows_teeth(image: Image.Image) -> bool:
    x0, y0, x1, y1 = _teeth_strip(image.size)
    strip = np.asarray(image.convert("RGB"), dtype=np.float64)[y0:y1, x0:x1]
    return strip.size > 0 and float(strip.mean()) > 230


class Smiles(Faces):
    """Faces, reading the mouth off the pixels: a photo-sized picture whose
    teeth still show between the lips is found with its lips parted over
    them (what the photo check calls teeth_showing); once a touch-up has put
    closed lips over them, with the lips closed."""

    def detect(self, image):
        found = super().detect(image)
        if found is None or image.size != GOOD or not shows_teeth(image):
            return found
        return landmarks.FaceLandmarks(points=with_mouth(found.points, 0.07), z=found.z)


class Touchups:
    """imagegen.edit_image for the whole flow: the kit's requests (its six
    shapes and its teeth photo) go to KitWorld's FakeProvider; anything
    else is AI adjust's touch-up, answered with the face crop it sent, the
    lips closed over the teeth, as a model asked to close them would."""

    def __init__(self, monkeypatch, world: KitWorld, faces: Faces):
        self.world = world
        self.faces = faces
        self.touchups = 0
        monkeypatch.setattr(imagegen, "edit_image", self.edit)

    async def edit(self, prompt, payload, mime):
        if prompt == pk.teeth_prompt() or any(p in prompt for p in pk.POSE_PROMPTS.values()):
            return await self.world.edit(prompt, payload, mime)
        self.touchups += 1
        with Image.open(io.BytesIO(payload)) as sent:
            crop = sent.convert("RGB")
        lips = self.faces.by_size[crop.size][pa.LIPS]
        ImageDraw.Draw(crop).polygon([tuple(p) for p in lips.tolist()], fill=LIPS_RED)
        return imagegen.Generated(png_of(crop), "image/png", MODEL)


@pytest.fixture(scope="module")
def reference() -> pk.ReferenceMotion:
    return pk.load_reference()


@pytest.fixture
def faces(monkeypatch):
    return Smiles(monkeypatch)


@pytest.fixture
def world(monkeypatch, reference):
    return KitWorld(monkeypatch, reference)


@pytest.fixture
def models(monkeypatch, world, faces):
    return Touchups(monkeypatch, world, faces)


@pytest.fixture
def person_segmenter(monkeypatch):
    """The segmenter: the person is the head (an ellipse round the face
    box) and the shoulders below it, whole; the room around them is the
    background."""

    def matte(image_bytes, prior_mask=None):
        rgb = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB")).astype(np.float32)
        height, width = rgb.shape[:2]
        x0, y0, x1, y1 = face_box((width, height))
        ys, xs = np.mgrid[0:height, 0:width]
        head = (((xs - (x0 + x1) / 2) / (0.65 * (x1 - x0))) ** 2
                + ((ys - (y0 + y1) / 2) / (0.65 * (y1 - y0))) ** 2) <= 1
        shoulders = (ys >= y1) & (xs >= 0.15 * width) & (xs <= 0.85 * width)
        return rgb, (head | shoulders).astype(np.float32)

    monkeypatch.setattr(config.get_settings(), "segment_model_path", "/fake.tflite", raising=False)
    monkeypatch.setattr(segment, "person_matte", matte)


# --- What a visitor's page does ----------------------------------------------------


def _path(url: str) -> str:
    """A signed storage URL as the test client requests it (same origin as
    the API; the widget's page is elsewhere, which its Origin says)."""
    return url[url.index("/storage/"):]


def _key(url: str) -> str:
    """The storage key a signed URL names."""
    return _path(url).split("?", 1)[0].removeprefix("/storage/")


async def _widget_config(client, avatar_id: str, key: str) -> dict:
    """GET the published avatar the way liveface.js does: its API key in
    X-Api-Key, from the customer's page (a cross-origin request, so
    preflighted, with the page's Origin)."""
    preflight = await client.options(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET",
                 "Access-Control-Request-Headers": "x-api-key"},
    )
    assert preflight.status_code == 204
    assert preflight.headers["access-control-allow-origin"] == ORIGIN
    assert "X-Api-Key" in preflight.headers["access-control-allow-headers"]
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key, "Origin": ORIGIN}
    )
    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] == ORIGIN
    return response.json()


async def _cross_origin(client, url: str, content_type: str) -> bytes:
    """A published file as the page fetches it: a plain GET from another
    site, readable only if the response allows the page's origin."""
    response = await client.get(_path(url), headers={"Origin": ORIGIN})
    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert response.headers["content-type"].startswith(content_type)
    return response.content


async def _visitors_mouth(client, config: dict) -> dict:
    """Everything the widget's continuous mouth loads (the motion, the
    teeth photo and its rig), fetched cross-origin; the motion, parsed."""
    mouth = config["mouth"]
    assert mouth["renderer"] == "continuous"
    assert "/published/" in mouth["motion_url"]
    motion = json.loads(await _cross_origin(client, mouth["motion_url"], "application/json"))
    await _cross_origin(client, mouth["oral"]["image_url"], "image/webp")
    json.loads(await _cross_origin(client, mouth["oral"]["rig_url"], "application/json"))
    return motion


# --- The embed's own view of a manifest ----------------------------------------------

POINT_LIMIT = 3.0  # |x| and |y| of a manifest point stay below it (validateMotionManifest)
IMAGE_NAME = re.compile(r"[a-z0-9-]+\.(png|webp)")


def assert_loadable(manifest: dict) -> None:
    """validateMotionManifest's version 2 checks, one by one, so a manifest
    it would refuse says why here (and where no node can run the embed's
    own, below, they are still checked)."""

    def point(p) -> bool:
        return (isinstance(p, list) and len(p) == 2
                and all(isinstance(v, (int, float)) and math.isfinite(v)
                        and abs(v) < POINT_LIMIT for v in p))

    def ring(indices) -> bool:
        return (8 <= len(indices) <= 40 and len(set(indices)) == len(indices)
                and all(isinstance(i, int) and 0 <= i < 478 for i in indices))

    jaw = MouthProfile.model_fields["jawRange"].metadata
    low = next(m.ge for m in jaw if hasattr(m, "ge"))
    high = next(m.le for m in jaw if hasattr(m, "le"))
    assert manifest["version"] == 2
    assert re.fullmatch(r"avatar-v1:[A-Za-z0-9_-]{1,64}", manifest["character"])
    assert [pose["id"] for pose in manifest["poses"]] == list(pk.POSES)
    assert point(manifest["center"])
    assert 0.03 <= manifest["mouth_width"] <= 0.6
    assert low <= manifest["jaw_range"] <= high
    assert 0 < len(manifest["triangles"]) <= 2000
    assert all(len(t) == 3 and len(set(t)) == 3 and all(0 <= i < 478 for i in t)
               for t in manifest["triangles"])
    assert ring(manifest["inner_ring"]) and ring(manifest["outer_ring"])
    for i, pose in enumerate(manifest["poses"]):
        assert (pose["provenance"] == pk.BASE) == (i == 0), pose["id"]
        assert pose["provenance"] in (pk.BASE, pk.GENERATED, pk.RETARGETED)
        rms = pose["registration_rms"]
        if pose["provenance"] == pk.RETARGETED:
            assert rms is None, pose["id"]
        else:
            assert isinstance(rms, (int, float)) and 0 <= rms <= 0.007, pose["id"]
        assert pose["image"] is None or IMAGE_NAME.fullmatch(pose["image"])
        assert pose["source"] is None or (
            len(pose["source"]) == 478 and all(map(point, pose["source"])))
        assert len(pose["points"]) == 478 and all(map(point, pose["points"])), pose["id"]


# The embed's loader check and its continuous mouth, run by node on a
# manifest file: validateMotionManifest, then the mouth built on it (with
# the profile visitors get) driven into "aa" for half a second at 60 fps,
# on the manifest's own rest face. Prints what it returned and how far the
# inner lips parted, in rest mouth widths.
PLAYER = """\
import { readFileSync } from "node:fs";
import { validateMotionManifest } from "%(src)s/mouth/photographic-performance-model.ts";
import { ContinuousMouth } from "%(src)s/mouth/continuous-mouth.ts";
import { REFERENCE_POSES, normalizeProfile } from "%(src)s/mouth/reference-mouth-model.ts";

let clock = 1000;
performance.now = () => clock;
const manifest = validateMotionManifest(JSON.parse(readFileSync(process.argv[2], "utf8")));
const mouth = new ContinuousMouth(manifest);
mouth.setProfile(normalizeProfile(JSON.parse(process.argv[3])));
const rest = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
let points = rest;
for (let frame = 0; frame < 30; frame++) {
  clock += 1000 / 60;
  points = rest.map(p => ({ ...p }));
  mouth.deform(points, rest, {}, REFERENCE_POSES.aa.weights);
}
const width = Math.hypot(rest[291].x - rest[61].x, rest[291].y - rest[61].y);
console.log(JSON.stringify({
  version: manifest.version,
  character: manifest.character,
  finite: points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
  aa: ((points[14].y - points[13].y) - (rest[14].y - rest[13].y)) / width,
}));
"""


def embed_player(workdir: Path) -> Path | None:
    """PLAYER bundled for node with the embed's own esbuild, or None where
    this checkout cannot run it (no node, or the embed's dependencies are
    not installed): the Python checks above stand in for it there, and a
    warning says the embed's own were not run."""
    esbuild = EMBED / "node_modules" / ".bin" / "esbuild"
    if shutil.which("node") is None or not esbuild.exists():
        warnings.warn("node or embed/node_modules missing: the manifest was checked "
                      "against validateMotionManifest's rules in Python only", stacklevel=2)
        return None
    entry = workdir / "player.ts"
    entry.write_text(PLAYER % {"src": (EMBED / "src").as_posix()})
    bundle = workdir / "player.mjs"
    subprocess.run(
        [str(esbuild), str(entry), "--bundle", "--platform=node", "--format=esm",
         f"--outfile={bundle}", "--log-level=error"],
        check=True, capture_output=True, timeout=120,
    )
    return bundle


def play(player: Path, manifest: dict, profile: dict, workdir: Path):
    """Run the embed's player on `manifest`, written to a file of its own,
    with `profile` as visitors get it."""
    text = json.dumps(manifest)
    path = workdir / f"manifest-{hashlib.sha256(text.encode()).hexdigest()[:12]}.json"
    path.write_text(text)
    return subprocess.run(
        [shutil.which("node"), str(player), str(path), json.dumps(profile)],
        capture_output=True, text=True, timeout=120,
    )


def embed_plays(player: Path | None, manifest: dict, profile: dict, workdir: Path) -> float | None:
    """How far the embed's mouth opens "aa" on `manifest`, in its rest mouth
    widths, once its loader has accepted it; None where node cannot run the
    embed here. The loader's rules are checked in Python either way."""
    assert_loadable(manifest)
    if player is None:
        return None
    result = play(player, manifest, profile, workdir)
    assert result.returncode == 0, result.stderr
    played = json.loads(result.stdout)
    assert played["version"] == 2 and played["character"] == manifest["character"]
    assert played["finite"] is True
    return played["aa"]


# --- helpers ------------------------------------------------------------------------


def _mouth_width(points: np.ndarray) -> float:
    """From mouth corner to mouth corner (61, 291)."""
    return float(np.linalg.norm(points[291] - points[61]))


def _quantum(manifest: dict) -> float:
    """The last decimal a manifest keeps of its points (MANIFEST_DECIMALS of
    manifest units), in the base picture's pixels: how exactly a point read
    back from it can be where it was. A point is within 0.71 of it (half a
    unit on each axis, turned by the frame's levelling)."""
    frame = np.asarray(manifest["frame"]["to_manifest"], dtype=np.float64)[:, :2]
    return 10.0 ** -pk.MANIFEST_DECIMALS / math.sqrt(abs(np.linalg.det(frame)))


def _watch_finish(monkeypatch) -> list[tuple[float, str | None, tuple | None]]:
    """Every progress report of a finish job, as (fraction, label, count)."""
    reports: list[tuple[float, str | None, tuple | None]] = []
    real = Job.report

    def spy(self, fraction, label=None, count=None):
        if self.step == "finish":
            reports.append((fraction, label, count))
        return real(self, fraction, label, count)

    monkeypatch.setattr(Job, "report", spy)
    return reports


def _published_files(prefix: str) -> dict[str, str]:
    """Every file under the avatar's published/ folder, by its SHA-256."""
    root = Path(get_storage().root) / prefix / "published"
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


async def _files_visitors_get(client, config: dict) -> dict[str, bytes]:
    """The bytes behind every URL the widget's config names."""
    urls = {"image": config["image_url"], "rig": config["rig_url"],
            "thumbnail": config["thumbnail_url"],
            "motion": config["mouth"]["motion_url"],
            "teeth": config["mouth"]["oral"]["image_url"],
            "teeth_rig": config["mouth"]["oral"]["rig_url"]}
    urls.update({f"layer_{name}": url for name, url in (config["layer_urls"] or {}).items()})
    out = {}
    for name, url in urls.items():
        response = await client.get(_path(url), headers={"Origin": ORIGIN})
        assert response.status_code == 200, (name, response.text)
        out[name] = response.content
    return out


# --- The flow ---------------------------------------------------------------------------


async def test_step_5_from_a_photo_to_a_visitors_page_and_back(
    client, faces, world, models, person_segmenter, monkeypatch, tmp_path
):
    reports = _watch_finish(monkeypatch)
    player = embed_player(tmp_path)
    headers, org_id = await _org(client, "stepfive")

    # AI allowed: the organization's switch (on by default; set as an admin
    # would), and the member's agreement to send photos, remembered.
    switched = await client.patch(
        f"/orgs/{org_id}", json={"third_party_ai_enabled": True}, headers=headers)
    assert switched.status_code == 200 and switched.json()["third_party_ai_enabled"] is True
    consent_id = await ai_consent(client, headers, org_id)

    # 1. Upload: a person, whose parted lips show their teeth.
    base, body = await _create(client, headers, org_id, data=smiling_portrait())
    assert body["face_type"] == "human"
    assert body["analysis"]["recommendation"]["reasons"] == ["teeth_showing"]

    # 2. Background: removed, a job.
    removed = await _run(client, headers, "POST", f"{base}/background", json={"mode": "remove"})
    assert removed.status_code == 202, removed.text
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    assert body["background"] == "remove"
    cutout = body["current"]
    assert next(s for s in body["steps"] if s["id"] == cutout)["cutout"] is True

    # 3. AI adjust: the check's fix is recommended and pre-selected, and
    # the wizard starts it itself on the remembered consent.
    assert body["ai"]["suggested"] == ["touchup"]
    assert body["ai"]["auto_adjust"] == {
        "mode": "touchup", "image": cutout, "reasons": ["teeth_showing"]}
    started = await _adjust(client, headers, base, consent_id, auto=True, count=2)
    assert started.status_code == 202, started.text
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    assert models.touchups == 2
    offered = [c for c in body["ai"]["last_round"]["candidates"] if c["ok"]]
    assert len(offered) == 2, body["ai"]["last_round"]
    assert body["current"] == cutout, "offered, never chosen for the owner"
    # "Use this": the result, a cut-out like its source, its lips closed.
    chosen = await _run(
        client, headers, "POST", f"{base}/choose", json={"choice": offered[0]["step"]})
    assert chosen.status_code == 200, chosen.text
    body = chosen.json()
    assert body["current"] == offered[0]["step"]
    assert next(s for s in body["steps"] if s["id"] == body["current"])["cutout"] is True
    assert body["analysis"]["recommendation"]["mode"] == "none"

    # 4. Place points: detected, one mouth corner moved a little by the
    # owner, previewed as the wizard does while the marks are dragged.
    anchors = await _detect(client, headers, base)
    assert anchors["detected"] is True and anchors["validation"]["ok"] is True
    marks = anchors["marks"]
    marks["mouth"]["right"]["x"] += 2
    preview = await client.post(
        f"{base}/preview-rig", json={"anchors_id": anchors["id"], "marks": marks},
        headers=headers)
    assert preview.status_code == 200, preview.text
    assert preview.json()["reasons"] == []
    previewed = preview.json()["rig"]

    # 5. "Preparing your avatar": finished with the points, the statement
    # the creation asks for, and AI allowed. The dashboard polls while the
    # kit's first requests are out: the stage, and how many of its seven
    # requests are settled.
    arrived, release = asyncio.Event(), asyncio.Event()

    async def hold():
        arrived.set()
        await release.wait()

    world.before_answer = hold
    assert body["statement"] == "depiction"
    statement = await depiction(client, headers, base, body["statement"])
    finish = await client.post(f"{base}/finish", headers=headers, json={
        "name": "Ada", "anchors_id": anchors["id"], "marks": marks, "consent_id": statement,
    })
    assert finish.status_code == 202, finish.text
    assert finish.json()["warnings"] == [], "the touch-up closed the lips"
    avatar_id = finish.json()["avatar_id"]
    await asyncio.wait_for(arrived.wait(), 30)
    running = (await _get(client, headers, base))["job"]
    assert running["step"] == "finish" and running["state"] == "running"
    assert running["progress"]["label"] == SHAPES_STAGE
    assert running["progress"]["count"] == {"done": 0, "total": 7}
    release.set()
    await runner.drain()
    body = await _get(client, headers, base)
    assert body["status"] == "finished" and body["job"]["state"] == "done", body["job"]
    assert body["avatar_id"] == avatar_id

    # The stages, in order, each once; the bar never runs back; the shapes
    # counted from none to all but the last settled, then fitted.
    labels = [label for _, label, _ in reports if label is not None]
    assert [label for i, label in enumerate(labels) if i == 0 or labels[i - 1] != label] == STAGES
    fractions = [fraction for fraction, _, _ in reports]
    assert fractions == sorted(fractions)
    counts = [count for _, label, count in reports if label == SHAPES_STAGE]
    assert counts[0] == (0, 7) and counts[-1] == (6, 7)
    assert [done for done, _ in counts] == sorted(done for done, _ in counts)
    assert len(world.requests) == 7 and models.touchups == 2

    # The avatar: live, with its own mouth, made by AI and disclosed.
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    avatar = await _get(client, headers, url)
    assert avatar["status"] == "ready" and avatar["face_type"] == "human"
    assert avatar["published"] is True and avatar["unpublished"] is False
    kit = avatar["mouth"]["kit"]
    assert kit["state"] == "made" and (kit["generated"], kit["retargeted"]) == (6, 0)
    assert kit["teeth"] == {"used": True, "reason": None}
    assert avatar["mouth"]["teeth"] == {"source": "ai", "note": None}
    # The owner previews the draft's own motion, a file of the draft's.
    draft_motion = _key(avatar["mouth"]["motion_url"])
    assert "/published/" not in draft_motion
    assert avatar["ai_edited"]["mode"] == "touchup"
    assert avatar["ai_edited"]["teeth"] == {"model": MODEL}
    assert avatar["ai_edited"]["mouth_shapes"] == {"model": MODEL, "generated": 6}

    # A customer's page on another site: the widget's config, then what its
    # continuous mouth loads.
    created = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "shop", "allowed_domains": [SITE]},
        headers=headers)
    assert created.status_code == 201, created.text
    key = created.json()["plaintext"]
    served = await _widget_config(client, avatar_id, key)
    assert served["disclosure"]["ai_edited"]["mouth_shapes"] == {"model": MODEL, "generated": 6}
    first = await _visitors_mouth(client, served)
    profile = served["mouth"]["profile"]
    assert profile["jawRange"] == first["jaw_range"] == 0.85
    # The embed takes it, and its mouth opens the person's own "aa" as far
    # as the Reference's (a kit is made at the Reference's size).
    assert [pose["provenance"] for pose in first["poses"]] == [pk.BASE] + [pk.GENERATED] * 6
    opened = embed_plays(player, first, profile, tmp_path)
    if opened is not None:
        assert opened == pytest.approx(pk.REFERENCE_OPENINGS["aa"], abs=0.01)
    # Its rest pose is what the owner previewed and visitors' rig is.
    rig = json.loads(await _cross_origin(client, served["rig_url"], "application/json"))
    assert np.allclose(rig["points"], previewed["points"], atol=1e-6)
    assert np.allclose(_targets(first)["rest"], rig["points"], rtol=0, atol=_quantum(first))
    # A tampered copy is refused by the same check: it is not vacuous.
    if player is not None:
        tampered = {**first, "jaw_range": 2.0}
        refused = play(player, tampered, profile, tmp_path)
        assert refused.returncode != 0
        assert "Invalid avatar motion manifest" in refused.stderr

    # Mark the face again: the corners moved, saved. The kit follows its
    # face with no AI call; visitors see nothing of it until Publish.
    remarked = (await client.get(f"{url}/rig-anchors", headers=headers)).json()["anchors"]
    remarked["mouth"]["left"]["x"] -= 3
    remarked["mouth"]["right"]["x"] += 3
    saved = await client.post(
        f"{url}/rig-fit", json={"mouth": remarked["mouth"], "persist": True}, headers=headers)
    assert saved.status_code == 200, saved.text
    avatar = await _get(client, headers, url)
    assert avatar["unpublished"] is True
    assert _key(avatar["mouth"]["motion_url"]) != draft_motion
    assert not await get_storage().exists(draft_motion), "the draft's old motion is gone"
    unpublished = await _widget_config(client, avatar_id, key)
    assert _key(unpublished["mouth"]["motion_url"]) == _key(served["mouth"]["motion_url"])
    published = await client.post(f"{url}/publish", headers=headers)
    assert published.status_code == 200, published.text
    served = await _widget_config(client, avatar_id, key)
    second = await _visitors_mouth(client, served)
    rig = json.loads(await _cross_origin(client, served["rig_url"], "application/json"))
    # Rebased: its rest pose is the new points, and every shape moves from
    # them exactly as far, and the same way, as it did before.
    before, after = _targets(first), _targets(second)
    # (Four points read back, each within 0.71 of the last decimal kept.)
    quantum = max(_quantum(first), _quantum(second))
    assert np.allclose(after["rest"], rig["points"], rtol=0, atol=quantum)
    assert np.abs(after["rest"] - before["rest"]).max() == pytest.approx(3, abs=0.01)
    for shape in pk.SHAPES:
        assert np.allclose(after[shape] - after["rest"], before[shape] - before["rest"],
                           rtol=0, atol=3 * quantum), shape
    assert second["character"] == first["character"] and second["kit"] == first["kit"]
    assert [(p["provenance"], p["registration_rms"]) for p in second["poses"]] == [
        (p["provenance"], p["registration_rms"]) for p in first["poses"]]
    assert len(world.requests) == 7, "no AI call"
    # Played, the same movement in pixels, from a mouth marked wider: a
    # smaller part of it.
    reopened = embed_plays(player, second, served["mouth"]["profile"], tmp_path)
    if opened is not None:
        widened = _mouth_width(after["rest"]) / _mouth_width(before["rest"])
        assert widened > 1.05
        assert reopened == pytest.approx(opened / widened, abs=0.002)

    # A later draft (the points moved again, the teeth nudged), discarded.
    # The published files stay exactly as they were, and so does what
    # visitors get; the draft is what is published again, in files of its
    # own.
    prefix = f"orgs/{org_id}/avatars/{avatar_id}"
    files = _published_files(prefix)
    assert "mouth-motion.json" in {name.rsplit("/", 1)[-1] for name in files}
    visible = await _files_visitors_get(client, served)
    again = (await client.get(f"{url}/rig-anchors", headers=headers)).json()["anchors"]
    again["mouth"]["left"]["x"] -= 2
    assert (await client.post(f"{url}/rig-fit", json={"mouth": again["mouth"], "persist": True},
                              headers=headers)).status_code == 200
    nudged = await client.patch(url, json={"mouth": {
        "renderer": "continuous", "profile": {**served["mouth"]["profile"], "teethY": 0.03}}},
        headers=headers)
    assert nudged.status_code == 200, nudged.text
    draft = await _get(client, headers, url)
    assert draft["unpublished"] is True
    discarded = await client.post(f"{url}/discard-draft", headers=headers)
    assert discarded.status_code == 200, discarded.text
    restored = await _get(client, headers, url)
    assert _published_files(prefix) == files
    after_discard = await _widget_config(client, avatar_id, key)
    assert await _files_visitors_get(client, after_discard) == visible
    # The draft is what is published again: its points, its profile, its
    # kit and disclosure, and the published motion, from a copy of its own.
    assert restored["unpublished"] is False
    assert restored["mouth"]["profile"] == served["mouth"]["profile"]
    assert (await client.get(_path(restored["rig_url"]))).content == visible["rig"]
    assert restored["mouth"]["kit"]["state"] == "made"
    assert restored["ai_edited"]["mouth_shapes"] == {"model": MODEL, "generated": 6}
    copy = _key(restored["mouth"]["motion_url"])
    assert "/published/" not in copy
    assert json.loads(await get_storage().get_bytes(copy)) == second
    assert not await get_storage().exists(_key(draft["mouth"]["motion_url"])), (
        "the discarded draft's motion is gone")
