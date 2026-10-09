"""The mouth kit's and the performance kit's gates, called directly.

services.mouth_kit: CallGuard (who may send, what a call costs when it
ends), progress_to, make, the kit's record and its public view, the kit
stored on a draft and following the avatar's later edits, and the Mouth
panel's job (its refusals, its job view, how it ends). services
.performance_kit: the registration on stable anchors, the Reference's
manifest, and the gates an answer must pass.

No HTTP, no database and no provider: every DB-touching helper is faked
where the module under test looks it up, storage is an in-memory Storage,
and imagegen.edit_image is a fake. tests.test_mouth_kit and
tests.test_performance_kit drive the same code end to end through the API
and the Scene; this file pins the branches and edge cases they do not.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import math

import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError
from scipy.spatial import Delaunay

from app.core.errors import (
    AppError,
    Conflict409,
    NotFound404,
    RateLimit429,
    Validation422,
)
from app.models import Avatar, AvatarKind, AvatarStatus
from app.services import imagegen, mouth_photo
from app.services import performance_kit as pk
from app.services.jobs import DONE, FAILED, QUEUED, Job, runner
from app.services.mouth_kit import calls, panel, records, storing
from app.services.storage import Storage

ORG = "org1"
AVATAR_ID = "avatar1"
PREFIX = f"orgs/{ORG}/avatars/{AVATAR_ID}/"
MODEL = "fake-image-model"
REFUSED = {
    "code": "safety_refused",
    "detail": "The AI declined this edit, so it was not asked again",
}
# What a kit fits: its own teeth seated and sized as the Reference's, and
# values for everything else that are not the owner's to take.
KIT_PROFILE = {
    "teethY": 0.016,
    "teethScale": 1.0,
    "warmth": 0.7,
    "lipProjection": 0.4,
    "jawRange": 1.0,
}
DEFAULTS = {
    "teethScale": 1.0,
    "teethY": 0.0,
    "warmth": 0.5,
    "lipProjection": 0.55,
    "jawRange": 0.85,
}
POINTS = [[1.0, 2.0], [3.0, 4.0]]


# --- Fakes -------------------------------------------------------------------------------


class MemoryStorage(Storage):
    """Storage in a dict, with each file's content type."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.types: dict[str, str] = {}

    async def presign_put(self, key, content_type):
        return f"memory://{key}"

    async def presign_get(self, key):
        return f"memory://{key}"

    async def put_bytes(self, key, data, content_type):
        self.files[key] = data
        self.types[key] = content_type

    async def get_bytes(self, key):
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    async def exists(self, key):
        return key in self.files

    async def list_names(self, prefix):
        return sorted({k[len(prefix) :].split("/")[0] for k in self.files if k.startswith(prefix)})

    async def delete(self, key):
        self.files.pop(key, None)

    async def delete_prefix(self, prefix):
        gone = [k for k in self.files if k.startswith(prefix)]
        for key in gone:
            del self.files[key]
        return len(gone)


class FakeDb:
    def __init__(self):
        self.commits = 0

    async def commit(self):
        self.commits += 1


def _sessions(db: FakeDb):
    """get_session_factory as the code calls it: get_session_factory()()."""
    return lambda: lambda: contextlib.nullcontext(db)


class Gate:
    """CallGuard's world: the organization's switch, its monthly limit
    (`check_image_limit`, counting the usage rows written) and its usage
    rows, all faked where services.mouth_kit.calls looks them up."""

    def __init__(self, monkeypatch, *, limit: int = 100, switched_off: bool = False):
        self.limit = limit
        self.switched_off = switched_off
        self.incoming: list[int] = []
        self.rows: list[tuple[str, str, str]] = []
        self.meter_error: Exception | None = None
        monkeypatch.setattr(calls, "ai_switched_off", self._switched_off)
        monkeypatch.setattr(calls, "check_image_limit", self._check)
        monkeypatch.setattr(calls, "record_generation", self._record)
        monkeypatch.setattr(calls, "get_session_factory", _sessions(FakeDb()))

    async def _switched_off(self, org_id):
        return self.switched_off

    async def _check(self, db, org_id, incoming=1):
        self.incoming.append(incoming)
        used = len(self.rows)
        if used + incoming > self.limit:
            raise RateLimit429(
                f"Monthly image generation limit reached ({used}/{self.limit})",
                code="image_limit_reached",
            )

    async def _record(self, db, org_id, provider, call="dashboard"):
        if self.meter_error is not None:
            raise self.meter_error
        self.rows.append((org_id, provider, call))


def _answering(monkeypatch, sent: list | None = None):
    """imagegen.edit_image answering every call with an image."""

    async def provider(prompt, payload, mime):
        if sent is not None:
            sent.append(prompt)
        return imagegen.Generated(b"png", "image/png", MODEL)

    monkeypatch.setattr(imagegen, "edit_image", provider)


async def _until(condition, tries: int = 2000) -> None:
    for _ in range(tries):
        if condition():
            return
        await asyncio.sleep(0)
    raise AssertionError("the condition never held")


def _avatar(**changes) -> Avatar:
    fields = {
        "id": AVATAR_ID,
        "org_id": ORG,
        "created_by_id": "user1",
        "name": "Ada",
        "content_type": "image/png",
        "kind": AvatarKind.photo,
        "status": AvatarStatus.ready,
        "face_type": "human",
        "image_key": f"{PREFIX}source.png",
        "rig_key": f"{PREFIX}rig.json",
        "draft_revision": 0,
        "mouth_config": None,
        "ai_edited": None,
        "published_config": None,
    }
    return Avatar(**{**fields, **changes})


def _config(avatar: Avatar) -> dict:
    return json.loads(avatar.mouth_config)


def _result(
    *,
    generated: int = 6,
    model: str | None = MODEL,
    teeth_source=None,
    teeth_report=None,
    profile: dict | None = None,
    profile_fit: dict | None = None,
) -> pk.KitResult:
    """A KitResult as build_kit reports one: the first `generated` shapes
    made, the rest refused and retargeted."""
    report = {}
    for index, shape in enumerate(pk.SHAPES):
        made = index < generated
        report[shape] = {
            "status": "ok" if made else "retargeted",
            "outcome": "generated" if made else "refused",
            "reason": None if made else REFUSED,
            "attempts": ["face_crop"] if made else ["face_crop", "head_crop"],
            "checks": {},
        }
    return pk.KitResult(
        manifest={
            "version": 2,
            "character": f"{pk.CHARACTER_PREFIX}kit123",
            "kit": {"version": pk.KIT_VERSION, "prompts": pk.PROMPTS_VERSION},
            "frame": {"image_size": [400, 500]},
            "poses": [{"id": "rest"}],
        },
        profile=dict(profile or KIT_PROFILE),
        profile_fit={"reasons": [{"field": "teethY", "code": "x", "detail": "y"}]}
        if profile_fit is None
        else profile_fit,
        teeth_source=teeth_source,
        report=report,
        calls=7,
        billed_calls=7,
        call_log=[{"shape": s, "kind": "face_crop", "model": model} for s in pk.SHAPES],
        base_detected=True,
        teeth_report=teeth_report,
    )


def _failed_teeth(reason: dict | None) -> dict:
    return {
        "status": "failed",
        "outcome": "rejected",
        "reason": reason,
        "attempts": ["face_crop"],
        "checks": {},
    }


@pytest.fixture(autouse=True)
def _fresh_jobs():
    """The job runner and the panel's ended jobs are this process's."""
    runner.reset()
    panel.ended.clear()
    yield
    runner.reset()
    panel.ended.clear()


# --- CallGuard: who may send ------------------------------------------------------------


@pytest.mark.parametrize(
    ("switched_off", "limit", "code", "detail", "reads"),
    [
        (
            True,
            100,
            "third_party_ai_disabled",
            "Your organization turned off third-party AI, so nothing more was sent",
            [],
        ),
        (False, 0, "image_limit_reached", "Monthly image generation limit reached (0/0)", [1]),
    ],
    ids=["switch", "limit"],
)
async def test_a_stopped_call_sends_nothing_records_no_consent_and_says_why(
    monkeypatch, switched_off, limit, code, detail, reads
):
    """The switch is read first (the limit is not even counted when it is
    off); either stop is an ImageGenUnavailable the kit reads as "send
    nothing more", and the consent is recorded only for a call that goes."""
    gate = Gate(monkeypatch, limit=limit, switched_off=switched_off)
    sent: list[str] = []
    _answering(monkeypatch, sent)
    recorded: list[bool] = []

    async def on_send():
        recorded.append(True)

    guard = calls.CallGuard(ORG, on_send)
    with pytest.raises(imagegen.ImageGenUnavailable) as stopped:
        await guard("p", b"x", "image/jpeg")
    assert pk.stop_reason(stopped.value) == {"code": code, "detail": detail}
    assert gate.incoming == reads
    assert recorded == [] and sent == []
    assert guard.sent == 0 and guard.metered == 0 and gate.rows == []


async def test_calls_in_flight_count_against_the_limit_so_none_pass_its_last_unit_together(
    monkeypatch,
):
    """Two units left and three calls at once: the third is counted with
    the two still in flight and stopped; once they end, nothing is held."""
    gate = Gate(monkeypatch, limit=2)
    release = asyncio.Event()

    async def provider(prompt, payload, mime):
        await release.wait()
        return imagegen.Generated(b"png", "image/png", MODEL)

    monkeypatch.setattr(imagegen, "edit_image", provider)
    guard = calls.CallGuard(ORG)
    tasks = [asyncio.create_task(guard("p", b"x", "image/jpeg")) for _ in range(3)]
    await _until(lambda: tasks[2].done() and guard.sent == 2)
    release.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    assert [r.image for r in results[:2]] == [b"png", b"png"]
    assert isinstance(results[2], calls.CallsStopped) and results[2].code == "image_limit_reached"
    assert gate.incoming == [1, 2, 3]
    assert guard.sent == 2 and guard.metered == 2
    assert gate.rows == [(ORG, "gemini", calls.SHAPES_CALL)] * 2
    gate.limit = 100
    await guard("p", b"x", "image/jpeg")
    assert gate.incoming[-1] == 1, "the calls that ended hold no place in flight"


async def test_a_call_stopped_at_the_consent_holds_no_place_in_flight(monkeypatch):
    gate = Gate(monkeypatch)
    sent: list[str] = []
    _answering(monkeypatch, sent)
    attempts: list[bool] = []

    async def on_send():
        attempts.append(True)
        if len(attempts) == 1:
            raise RuntimeError("database is locked")

    guard = calls.CallGuard(ORG, on_send)
    with pytest.raises(calls.CallsStopped) as stopped:
        await guard("p", b"x", "image/jpeg")
    assert (stopped.value.code, stopped.value.detail) == calls.CONSENT_NOT_RECORDED
    assert isinstance(stopped.value.__cause__, RuntimeError)
    await guard("p", b"x", "image/jpeg")
    assert gate.incoming == [1, 1]
    assert sent == ["p"] and guard.sent == 1 and guard.metered == 1


async def test_a_usage_row_that_cannot_be_written_never_fails_the_answer(monkeypatch):
    gate = Gate(monkeypatch)
    _answering(monkeypatch)
    gate.meter_error = RuntimeError("database is locked")
    guard = calls.CallGuard(ORG)
    answer = await guard("p", b"x", "image/jpeg")
    assert answer.image == b"png" and answer.model == MODEL
    assert guard.sent == 1 and guard.metered == 0
    gate.meter_error = None
    await guard("p", b"x", "image/jpeg")
    assert gate.incoming == [1, 1], "the unmetered call left the flight all the same"
    assert guard.metered == 1 and gate.rows == [(ORG, "gemini", calls.SHAPES_CALL)]


async def test_a_call_cancelled_in_flight_is_metered_as_sent(monkeypatch):
    """Cancelled after it left: it may be billed, so its row is written
    (shielded from the cancellation)."""
    gate = Gate(monkeypatch)
    arrived = asyncio.Event()

    async def provider(prompt, payload, mime):
        arrived.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(imagegen, "edit_image", provider)
    guard = calls.CallGuard(ORG)
    task = asyncio.create_task(guard("p", b"x", "image/jpeg"))
    await arrived.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert guard.sent == 1 and guard.metered == 1
    assert gate.rows == [(ORG, "gemini", calls.SHAPES_CALL)]


async def test_the_guard_bounds_the_provider_call_by_imagegens_timeout(monkeypatch):
    """The provider's own time only, and a call that ran out of it may
    have been answered: metered."""
    gate = Gate(monkeypatch)
    monkeypatch.setattr(imagegen, "TIMEOUT_SECONDS", 0.01)

    async def provider(prompt, payload, mime):
        await asyncio.sleep(5)

    monkeypatch.setattr(imagegen, "edit_image", provider)
    guard = calls.CallGuard(ORG)
    with pytest.raises(TimeoutError):
        await guard("p", b"x", "image/jpeg")
    assert guard.metered == 1 and len(gate.rows) == 1


# --- calls: progress, make, the kit's model and count -----------------------------------


def test_progress_maps_the_kits_requests_onto_the_jobs_bar_then_the_fit():
    job = Job(id="job1", org_id=ORG, subject_id=AVATAR_ID, step="mouth_kit", revision=0)
    report = calls.progress_to(job, 0.05, 0.85)
    report(0.5, "aa generated", 3, 7)
    assert job.progress() == {
        "fraction": 0.45,
        "label": calls.SHAPES_LABEL,
        "count": {"done": 3, "total": 7},
    }
    report(1.0, "mouth kit ready", 7, 7)
    assert job.progress() == {"fraction": 0.85, "label": calls.FIT_LABEL, "count": None}
    # Without a job (a finish's kit reports elsewhere) it reports nothing.
    assert calls.progress_to(None, 0.0, 1.0)(0.5, "aa generated", 1, 7) is None


async def test_make_runs_the_kit_through_a_guard_for_the_organization(monkeypatch):
    captured: dict = {}

    async def build(picture, points, edit_image, **kwargs):
        captured.update(picture=picture, points=points, edit_image=edit_image, **kwargs)
        return "the kit"

    monkeypatch.setattr(pk, "build_kit", build)

    async def on_send():
        return None

    def on_progress(*args):
        return None

    made = await calls.make(
        ORG, b"picture", POINTS, teeth=False, on_first_send=on_send, on_progress=on_progress
    )
    assert made == "the kit"
    guard = captured.pop("edit_image")
    assert isinstance(guard, calls.CallGuard) and guard.org_id == ORG
    assert guard._on_first_send is on_send
    assert captured == {
        "picture": b"picture",
        "points": POINTS,
        "teeth": False,
        "concurrency": calls.CONCURRENCY,
        "bound_calls": False,
        "on_progress": on_progress,
    }


def test_the_kits_model_is_the_first_call_that_names_one_and_its_count_its_own_shapes():
    result = _result(generated=4)
    result.call_log = [{"model": None}, {"shape": "ee"}, {"model": "m1"}, {"model": "m2"}]
    assert calls.kit_model(result) == "m1"
    assert calls.generated_count(result) == 4
    result.call_log = []
    assert calls.kit_model(result) is None
    assert calls.generated_count(_result(generated=0)) == 0


# --- records ----------------------------------------------------------------------------


def test_a_kit_with_its_teeth_photo_or_not_asked_for_one_gives_no_reason():
    assert (
        records.teeth_reason(
            _result(
                teeth_source=pk.TeethSource(b"png", {}),
                teeth_report={"status": "ok", "reason": None},
            )
        )
        is None
    )
    assert records.teeth_reason(_result(teeth_report=None)) is None


def test_what_stopped_the_teeth_request_is_passed_on_as_its_own_note():
    for code in sorted(records.TEETH_NOTE_CODES):
        reason = {"code": code, "detail": f"why {code}"}
        assert records.teeth_reason(_result(teeth_report=_failed_teeth(reason))) == reason, code
    assert calls.CONSENT_NOT_RECORDED[0] in records.TEETH_NOTE_CODES


def test_teeth_the_embed_would_not_draw_are_unclear():
    for code in ("teeth_photo_refused", "no_teeth_visible"):
        reason = {"code": code, "detail": "too little crown"}
        assert records.teeth_reason(_result(teeth_report=_failed_teeth(reason))) == {
            "code": "mouth_teeth_unclear",
            "detail": "The AI's teeth photo shows too little of the upper teeth for the "
            "photographic mouth, so it was not used",
        }, code


def test_any_other_failed_check_is_rejected_and_names_the_check():
    reason = {"code": "head_moved", "detail": "The AI zoomed or tilted the head"}
    assert records.teeth_reason(_result(teeth_report=_failed_teeth(reason))) == {
        "code": "teeth_photo_rejected",
        "detail": "The AI's teeth photo did not pass its checks "
        "(The AI zoomed or tilted the head), so it was not used",
        "reason": reason,
    }
    # With no reason at all, or one that does not say why.
    assert records.teeth_reason(_result(teeth_report=_failed_teeth(None))) == {
        "code": "teeth_photo_rejected",
        "detail": "The AI's teeth photo did not pass its checks (no reason given), "
        "so it was not used",
        "reason": None,
    }
    wordless = {"code": "check_failed"}
    note = records.teeth_reason(_result(teeth_report=_failed_teeth(wordless)))
    assert "(no reason given)" in note["detail"] and note["reason"] == wordless


def test_the_kit_record_keeps_each_shapes_provenance_and_what_the_kit_took():
    teeth = {"used": False, "reason": REFUSED}
    record = records.kit_record(
        _result(generated=4), source="mouth_panel", teeth=teeth, fitted={"teethY": 0.016}
    )
    made_at = record.pop("made_at")
    assert isinstance(made_at, str) and made_at.endswith("+00:00")
    assert record == {
        "id": "kit123",
        "state": "made",
        "source": "mouth_panel",
        "recipe": {"version": pk.KIT_VERSION, "prompts": pk.PROMPTS_VERSION},
        "model": MODEL,
        "shapes": {
            **{
                shape: {
                    "provenance": "generated",
                    "outcome": "generated",
                    "reason": None,
                    "attempts": ["face_crop"],
                }
                for shape in ("aa", "ee", "oo", "oh")
            },
            **{
                shape: {
                    "provenance": "retargeted",
                    "outcome": "refused",
                    "reason": REFUSED,
                    "attempts": ["face_crop", "head_crop"],
                }
                for shape in ("fv", "th")
            },
        },
        "generated": 4,
        "retargeted": 2,
        "teeth": teeth,
        "fitted": {"teethY": 0.016},
        "fit_reasons": [{"field": "teethY", "code": "x", "detail": "y"}],
        "calls": 7,
        "billed_calls": 7,
        "base_detected": True,
        "rebased_at": None,
        "dropped": None,
    }
    bare = records.kit_record(
        _result(model=None, profile_fit={}), source="finish", teeth=teeth, fitted={}
    )
    assert bare["fit_reasons"] == [] and bare["model"] is None


def test_the_public_kit_lists_the_shapes_in_the_manifests_order():
    assert records.public_kit(None) is None
    assert records.public_kit({}) is None
    legacy = {
        "shapes": {
            "th": {"provenance": "retargeted", "reason": REFUSED, "outcome": "x"},
            "aa": {"provenance": "generated", "reason": None},
        }
    }
    assert records.public_kit(legacy) == {
        "state": "made",
        "made_at": None,
        "model": None,
        "generated": 0,
        "retargeted": 0,
        "shapes": [
            {"shape": "aa", "provenance": "generated", "reason": None},
            {"shape": "th", "provenance": "retargeted", "reason": REFUSED},
        ],
        "teeth": None,
        "dropped": None,
    }


# --- storing: a kit stored on the draft --------------------------------------------------


async def test_a_new_avatars_kit_stores_its_motion_its_teeth_fit_and_the_disclosure():
    """The kit decides only the teeth values: everything else in the
    profile is the defaults (a new avatar's), never the kit's."""
    storage, avatar = MemoryStorage(), _avatar()
    result = _result(teeth_report=_failed_teeth(REFUSED))
    assert await storing.store(avatar, storage, result, source="finish") == []
    config = _config(avatar)
    key = config["motion_key"]
    assert key.startswith(f"{PREFIX}mouth-motion-") and key.endswith(".json")
    assert storage.files == {key: json.dumps(result.manifest, separators=(",", ":")).encode()}
    assert storage.types[key] == calls.MOTION_TYPE
    assert config["profile"] == {**DEFAULTS, "teethY": 0.016, "teethScale": 1.0}
    assert config["teeth"] == {
        "source": None,
        "note": {
            "code": "safety_refused",
            "detail": f"{REFUSED['detail']}; this avatar uses standard teeth",
        },
    }
    assert "oral_image_key" not in config
    kit = config["kit"]
    assert (kit["source"], kit["generated"], kit["retargeted"]) == ("finish", 6, 0)
    assert kit["teeth"] == {"used": False, "reason": REFUSED}
    assert kit["fitted"] == {"teethY": 0.016, "teethScale": 1.0}
    assert avatar.ai_edited == {
        "mode": "mouth_shapes",
        "model": MODEL,
        "mouth_shapes": {"model": MODEL, "generated": 6},
    }


async def test_standard_teeth_with_no_reason_from_the_kit_still_say_why():
    avatar = _avatar()
    await storing.store(avatar, MemoryStorage(), _result(), source="finish")
    assert _config(avatar)["teeth"]["note"] == {
        "code": "teeth_failed",
        "detail": "The teeth could not be made; this avatar uses standard teeth",
    }
    assert _config(avatar)["kit"]["teeth"] == {"used": False, "reason": None}


@pytest.mark.parametrize("record", [{"source": "upload"}, None], ids=["upload", "before-records"])
async def test_the_owners_own_teeth_photo_is_never_replaced(monkeypatch, record):
    """Even a kit that brought a teeth photo: it is not admitted, the
    owner's photo, record and teeth fit stay, and the kit fits nothing."""

    def never(*args):
        raise AssertionError("the owner's photo must not be replaced")

    monkeypatch.setattr(mouth_photo, "admit_photo", never)
    before = {
        "renderer": "continuous",
        "profile": {**DEFAULTS, "teethY": 0.03, "teethScale": 1.05},
        "oral_image_key": f"{PREFIX}mouth-own.webp",
        "oral_rig_key": f"{PREFIX}mouth-own.json",
    }
    if record is not None:
        before["teeth"] = record
    avatar, storage = _avatar(mouth_config=json.dumps(before)), MemoryStorage()
    result = _result(
        teeth_source=pk.TeethSource(b"png", {}), teeth_report={"status": "ok", "reason": None}
    )
    assert await storing.store(avatar, storage, result, source="mouth_panel") == []
    config = _config(avatar)
    assert config["oral_image_key"] == before["oral_image_key"]
    assert config["oral_rig_key"] == before["oral_rig_key"]
    assert config.get("teeth") == record
    assert config["profile"] == before["profile"]
    assert config["kit"]["teeth"] == {"used": False, "reason": calls.OWNER_PHOTO}
    assert config["kit"]["fitted"] == {}
    assert [k for k in storage.files if "mouth-motion-" not in k] == []
    assert avatar.ai_edited == {
        "mode": "mouth_shapes",
        "model": MODEL,
        "mouth_shapes": {"model": MODEL, "generated": 6},
    }


async def test_the_kits_teeth_photo_replaces_earlier_ai_teeth_and_motion(monkeypatch):
    """Earlier AI teeth and an earlier kit's motion are replaced; their
    keys are returned for deletion after the commit, not deleted here."""
    monkeypatch.setattr(
        mouth_photo, "admit_photo", lambda png, rig: (b"webp:" + png, {**rig, "admitted": True})
    )
    old = {
        "image": f"{PREFIX}mouth-old.webp",
        "rig": f"{PREFIX}mouth-old.json",
        "motion": f"{PREFIX}mouth-motion-old.json",
    }
    before = {
        "renderer": "continuous",
        "profile": {**DEFAULTS, "teethScale": 1.1, "jawRange": 0.95},
        "oral_image_key": old["image"],
        "oral_rig_key": old["rig"],
        "teeth": {"source": "ai", "model": "older"},
        "motion_key": old["motion"],
    }
    avatar = _avatar(
        mouth_config=json.dumps(before),
        ai_edited={
            "mode": "teeth",
            "model": "older",
            "teeth": {"model": "older"},
            "mouth_shapes": {"model": "older", "generated": 3},
        },
    )
    storage = MemoryStorage()
    for key in old.values():
        storage.files[key] = b"old"
    result = _result(
        teeth_source=pk.TeethSource(b"png", {"points": []}),
        teeth_report={"status": "ok", "reason": None},
    )
    previous = await storing.store(avatar, storage, result, source="mouth_panel")
    assert previous == [old["image"], old["rig"], old["motion"]]
    assert all(key in storage.files for key in old.values())
    config = _config(avatar)
    image, rig = config["oral_image_key"], config["oral_rig_key"]
    assert image.startswith(f"{PREFIX}mouth-") and image.endswith(".webp") and image != old["image"]
    assert storage.files[image] == b"webp:png"
    assert json.loads(storage.files[rig]) == {"points": [], "admitted": True}
    assert config["teeth"] == {"source": "ai", "model": MODEL}
    assert config["profile"] == {**DEFAULTS, "teethY": 0.016, "teethScale": 1.0, "jawRange": 0.95}
    assert config["kit"]["teeth"] == {"used": True, "reason": None}
    assert config["kit"]["fitted"] == {"teethY": 0.016, "teethScale": 1.0}
    assert config["motion_key"] != old["motion"]
    assert avatar.ai_edited == {
        "mode": "teeth",
        "model": MODEL,
        "teeth": {"model": MODEL},
        "mouth_shapes": {"model": MODEL, "generated": 6},
    }


async def test_a_teeth_photo_refused_as_webp_leaves_the_standard_teeth_seated_as_the_references(
    monkeypatch,
):
    """Fitted for a photo that will not be drawn: refitted for the
    standard teeth, which are drawn instead, and nothing is written for
    the photo."""

    def refuse(png, rig):
        raise Validation422("too little crown", code="mouth_teeth_unclear")

    monkeypatch.setattr(mouth_photo, "admit_photo", refuse)
    avatar, storage = _avatar(), MemoryStorage()
    result = _result(
        teeth_source=pk.TeethSource(b"png", {}),
        teeth_report={"status": "ok", "reason": None},
        profile={**KIT_PROFILE, "teethY": -0.01, "teethScale": 1.1},
    )
    await storing.store(avatar, storage, result, source="finish")
    config = _config(avatar)
    seat = {"teethY": pk.REFERENCE_TEETH_Y, "teethScale": pk.REFERENCE_TEETH_SCALE}
    assert config["profile"] == {**DEFAULTS, **seat}
    assert config["kit"]["fitted"] == seat
    unclear = {"code": "mouth_teeth_unclear", "detail": "too little crown"}
    assert config["kit"]["teeth"] == {"used": False, "reason": unclear}
    assert config["teeth"] == {
        "source": None,
        "note": {
            "code": "mouth_teeth_unclear",
            "detail": "too little crown; this avatar uses standard teeth",
        },
    }
    assert list(storage.files) == [config["motion_key"]]
    assert "teeth" not in avatar.ai_edited


async def test_earlier_ai_teeth_stay_with_their_fit_when_the_new_kit_brings_none():
    timeout = {"code": "timeout", "detail": "The AI did not answer in time"}
    before = {
        "renderer": "continuous",
        "profile": {**DEFAULTS, "teethY": 0.02},
        "oral_image_key": f"{PREFIX}mouth-ai.webp",
        "oral_rig_key": f"{PREFIX}mouth-ai.json",
        "teeth": {"source": "ai", "model": "older"},
    }
    avatar = _avatar(
        mouth_config=json.dumps(before),
        ai_edited={"mode": "teeth", "model": "older", "teeth": {"model": "older"}},
    )
    previous = await storing.store(
        avatar, MemoryStorage(), _result(teeth_report=_failed_teeth(timeout)), source="mouth_panel"
    )
    assert previous == []
    config = _config(avatar)
    for key in ("oral_image_key", "oral_rig_key", "teeth", "profile"):
        assert config[key] == before[key], key
    assert config["kit"]["teeth"] == {"used": False, "reason": timeout}
    assert config["kit"]["fitted"] == {}
    assert avatar.ai_edited == {
        "mode": "teeth",
        "model": "older",
        "teeth": {"model": "older"},
        "mouth_shapes": {"model": MODEL, "generated": 6},
    }


@pytest.mark.parametrize(
    ("before", "after"),
    [
        (
            {
                "mode": "mouth_shapes",
                "model": "older",
                "mouth_shapes": {"model": "older", "generated": 6},
            },
            None,
        ),
        (
            {"mode": "touchup", "model": "pic", "mouth_shapes": {"model": "older", "generated": 6}},
            {"mode": "touchup", "model": "pic"},
        ),
    ],
    ids=["shapes-only", "picture-mode"],
)
async def test_a_kit_with_no_shape_of_its_own_stores_no_motion_and_drops_the_disclosure(
    before, after
):
    old_motion = f"{PREFIX}mouth-motion-old.json"
    avatar = _avatar(
        ai_edited=before,
        mouth_config=json.dumps(
            {"renderer": "continuous", "profile": DEFAULTS, "motion_key": old_motion}
        ),
    )
    storage = MemoryStorage()
    previous = await storing.store(avatar, storage, _result(generated=0), source="finish")
    assert previous == [old_motion]
    config = _config(avatar)
    assert "motion_key" not in config and storage.files == {}
    assert (config["kit"]["generated"], config["kit"]["retargeted"]) == (0, 6)
    assert avatar.ai_edited == after


async def test_the_stored_profile_is_held_to_mouth_profiles_fields_and_keeps_the_owners_jaw():
    avatar = _avatar(
        mouth_config=json.dumps(
            {
                "renderer": "continuous",
                "profile": {"teethY": 0.0, "teethScale": 1.0, "jawRange": 0.95, "legacyKnob": 3},
            }
        )
    )
    await storing.store(avatar, MemoryStorage(), _result(), source="finish")
    assert _config(avatar)["profile"] == {
        "teethScale": 1.0,
        "teethY": 0.016,
        "warmth": 0.5,
        "lipProjection": 0.55,
        "jawRange": 0.95,
    }


async def test_a_profile_outside_mouth_profiles_ranges_is_refused_before_the_draft_changes():
    """It is served to strangers: refused like an owner's own out-of-range
    save, and nothing of the kit is stored."""
    raw = json.dumps({"renderer": "continuous", "profile": {**DEFAULTS, "jawRange": 1.5}})
    avatar, storage = _avatar(mouth_config=raw), MemoryStorage()
    with pytest.raises(ValidationError):
        await storing.store(avatar, storage, _result(), source="finish")
    assert avatar.mouth_config == raw and avatar.ai_edited is None
    assert storage.files == {}


# --- storing: the teeth changed --------------------------------------------------------


def _kit_config(profile: dict, fitted: dict | None, teeth: dict | None = None) -> dict:
    kit = {
        "id": "kit123",
        "state": "made",
        "shapes": {"aa": {"provenance": "generated"}},
        "teeth": teeth if teeth is not None else {"used": True, "reason": None},
    }
    if fitted is not None:
        kit["fitted"] = fitted
    return {
        "renderer": "continuous",
        "profile": profile,
        "motion_key": f"{PREFIX}m.json",
        "kit": kit,
    }


def test_an_upload_refits_only_the_teeth_values_the_owner_did_not_move():
    config = _kit_config(
        {**DEFAULTS, "teethY": 0.03, "teethScale": 1.1, "jawRange": 0.95},
        {"teethY": 0.016, "teethScale": 1.1},
    )
    avatar = _avatar(mouth_config=json.dumps(config))
    storing.teeth_changed(avatar, calls.OWNER_PHOTO)
    after = _config(avatar)
    assert after["profile"] == {**DEFAULTS, "teethY": 0.03, "teethScale": 1.0, "jawRange": 0.95}
    assert after["kit"]["fitted"]["teethScale"] == 1.0
    assert after["kit"]["teeth"] == {"used": False, "reason": calls.OWNER_PHOTO}
    assert after["kit"]["shapes"] == config["kit"]["shapes"]
    assert after["motion_key"] == config["motion_key"]


def test_removed_teeth_refit_a_record_from_before_fitted_was_kept_for_the_standard_teeth():
    config = _kit_config({**DEFAULTS, "teethScale": 1.1, "jawRange": 0.7}, None)
    avatar = _avatar(mouth_config=json.dumps(config))
    storing.teeth_changed(avatar, calls.TEETH_REMOVED)
    after = _config(avatar)
    seat = {"teethY": pk.REFERENCE_TEETH_Y, "teethScale": pk.REFERENCE_TEETH_SCALE}
    assert after["profile"] == {**DEFAULTS, **seat, "jawRange": 0.7}
    assert after["kit"]["fitted"] == seat
    assert after["kit"]["teeth"] == {"used": False, "reason": calls.TEETH_REMOVED}


def test_a_kit_whose_teeth_were_never_used_keeps_saying_why():
    timeout = {"code": "timeout", "detail": "The AI did not answer in time"}
    config = _kit_config(
        dict(DEFAULTS), {"teethY": 0.0, "teethScale": 1.0}, {"used": False, "reason": timeout}
    )
    avatar = _avatar(mouth_config=json.dumps(config))
    storing.teeth_changed(avatar, calls.OWNER_PHOTO)
    assert _config(avatar)["kit"]["teeth"] == {"used": False, "reason": timeout}


@pytest.mark.parametrize("raw", [None, json.dumps({"renderer": "continuous", "profile": {}})])
def test_teeth_changed_without_a_kit_changes_nothing(raw):
    avatar = _avatar(mouth_config=raw)
    storing.teeth_changed(avatar, calls.TEETH_REMOVED)
    assert avatar.mouth_config == raw


def test_a_teeth_value_the_owner_moved_survives_a_second_teeth_change():
    config = _kit_config(
        {**DEFAULTS, "teethY": 0.03, "teethScale": 1.0}, {"teethY": 0.016, "teethScale": 1.0}
    )
    avatar = _avatar(mouth_config=json.dumps(config))
    storing.teeth_changed(avatar, calls.OWNER_PHOTO)  # their own photo
    assert _config(avatar)["profile"]["teethY"] == 0.03
    storing.teeth_changed(avatar, calls.TEETH_REMOVED)  # and removed again
    assert _config(avatar)["profile"]["teethY"] == 0.03, "moved by the owner: theirs"


# --- storing: drop and follow ----------------------------------------------------------


def test_drop_removes_the_motion_and_its_disclosure_and_keeps_the_teeth_and_profile():
    config = {
        "renderer": "continuous",
        "profile": {**DEFAULTS, "jawRange": 0.95},
        "oral_image_key": "t.webp",
        "oral_rig_key": "t.json",
        "teeth": {"source": "ai", "model": "m"},
        "motion_key": "motion.json",
        "kit": {"state": "made", "dropped": None, "generated": 6},
    }
    avatar = _avatar(
        mouth_config=json.dumps(config),
        ai_edited={
            "mode": "teeth",
            "model": "m",
            "teeth": {"model": "m"},
            "mouth_shapes": {"model": "m", "generated": 6},
        },
    )
    assert storing.drop(avatar, calls.REBASE_FAILED) == ["motion.json"]
    after = _config(avatar)
    assert "motion_key" not in after
    assert after["kit"] == {"state": "dropped", "dropped": calls.REBASE_FAILED, "generated": 6}
    for key in ("oral_image_key", "oral_rig_key", "teeth", "profile"):
        assert after[key] == config[key], key
    assert avatar.ai_edited == {"mode": "teeth", "model": "m", "teeth": {"model": "m"}}


def test_drop_without_a_motion_does_nothing_and_without_a_kit_records_none():
    still = json.dumps({"renderer": "continuous", "profile": {}, "kit": {"state": "made"}})
    avatar = _avatar(mouth_config=still, ai_edited={"mode": "touchup", "model": "pic"})
    assert storing.drop(avatar, calls.REBASE_FAILED) == []
    assert avatar.mouth_config == still and avatar.ai_edited == {"mode": "touchup", "model": "pic"}
    assert storing.drop(_avatar(), calls.REBASE_FAILED) == []
    bare = _avatar(
        mouth_config=json.dumps(
            {"renderer": "continuous", "profile": {}, "motion_key": "motion.json"}
        )
    )
    assert storing.drop(bare, calls.REBASE_FAILED) == ["motion.json"]
    assert _config(bare) == {"renderer": "continuous", "profile": {}}


def _following(storage: MemoryStorage, kit: bool = True) -> Avatar:
    manifest = {"version": 2, "character": f"{pk.CHARACTER_PREFIX}kit123", "poses": []}
    storage.files[f"{PREFIX}mouth-motion-old.json"] = json.dumps(manifest).encode()
    config = {
        "renderer": "continuous",
        "profile": {},
        "motion_key": f"{PREFIX}mouth-motion-old.json",
    }
    if kit:
        config["kit"] = {"state": "made", "rebased_at": None}
    return _avatar(mouth_config=json.dumps(config))


async def test_following_new_points_writes_the_moved_motion_under_a_fresh_key(monkeypatch):
    seen: list = []

    def rebase(manifest, points, frame, size):
        seen.append((points, frame, size))
        return {**manifest, "moved": True}

    monkeypatch.setattr(pk, "rebase_manifest", rebase)
    storage = MemoryStorage()
    avatar = _following(storage)
    old = f"{PREFIX}mouth-motion-old.json"
    assert await storing.follow_points(avatar, storage, POINTS, [360.0, 450.0]) == [old]
    assert seen == [(POINTS, None, (360, 450))]
    config = _config(avatar)
    key = config["motion_key"]
    assert key != old and key.startswith(f"{PREFIX}mouth-motion-")
    assert json.loads(storage.files[key])["moved"] is True
    assert storage.types[key] == calls.MOTION_TYPE
    assert old in storage.files, "deleted by the caller, after its commit"
    assert config["kit"]["state"] == "made" and config["kit"]["rebased_at"].endswith("+00:00")
    # Without a kit record the motion follows all the same.
    bare = _following(storage, kit=False)
    assert await storing.follow_points(bare, storage, POINTS) == [old]
    assert "kit" not in _config(bare)


async def test_points_that_change_nothing_write_nothing(monkeypatch):
    monkeypatch.setattr(pk, "rebase_manifest", lambda manifest, *rest: dict(manifest))
    storage = MemoryStorage()
    avatar = _following(storage)
    raw = avatar.mouth_config
    assert await storing.follow_points(avatar, storage, POINTS) == []
    assert avatar.mouth_config == raw and list(storage.files) == [f"{PREFIX}mouth-motion-old.json"]


async def test_a_kit_whose_motion_file_is_gone_is_dropped_rather_than_left_on_old_points():
    storage = MemoryStorage()
    avatar = _following(storage)
    storage.files.clear()
    assert await storing.follow_points(avatar, storage, POINTS) == [
        f"{PREFIX}mouth-motion-old.json"
    ]
    config = _config(avatar)
    assert "motion_key" not in config
    assert config["kit"]["state"] == "dropped" and config["kit"]["dropped"] == calls.REBASE_FAILED


async def test_follow_rig_moves_the_kit_only_for_another_rig(monkeypatch):
    """Nothing to follow without both rigs or without a motion; other
    points on a picture of the same size move it with no new size."""
    seen: list = []

    def rebase(manifest, points, frame, size):
        seen.append((points, size))
        return {**manifest, "moved": True}

    monkeypatch.setattr(pk, "rebase_manifest", rebase)
    storage = MemoryStorage()
    avatar = _following(storage)
    rig = {"image_size": [400, 500], "points": POINTS}
    assert await storing.follow_rig(avatar, storage, None, rig) == []
    assert await storing.follow_rig(avatar, storage, rig, None) == []
    assert await storing.follow_points(_avatar(), storage, POINTS) == []
    assert seen == []
    moved = {**rig, "points": [[9.0, 9.0], [8.0, 8.0]]}
    assert await storing.follow_rig(avatar, storage, rig, moved) == [
        f"{PREFIX}mouth-motion-old.json"
    ]
    assert seen == [(moved["points"], None)]


# --- panel: the refusals before a kit starts -------------------------------------------


def test_only_a_ready_photo_of_a_person_with_its_picture_takes_a_kit():
    with pytest.raises(NotFound404) as missing:
        panel.require_person(None)
    assert missing.value.code == "avatar_not_found"
    assert panel.require_person(_avatar()) is None


@pytest.mark.parametrize(
    ("changes", "error", "code"),
    [
        ({"kind": AvatarKind.model3d}, Conflict409, "not_a_photo"),
        ({"status": AvatarStatus.processing}, Conflict409, "not_a_photo"),
        ({"face_type": "animal"}, Validation422, "mouth_not_for_face_type"),
        ({"face_type": "cartoon"}, Validation422, "mouth_not_for_face_type"),
        ({"image_key": None}, Conflict409, "source_gone"),
        ({"rig_key": None}, Conflict409, "source_gone"),
        # The first that applies: a failed animal with no picture is "not a photo".
        (
            {"status": AvatarStatus.failed, "face_type": "animal", "image_key": None},
            Conflict409,
            "not_a_photo",
        ),
    ],
)
def test_the_person_a_kit_is_for_is_checked_in_order(changes, error, code):
    with pytest.raises(error) as refused:
        panel.require_person(_avatar(**changes))
    assert refused.value.code == code


@pytest.mark.parametrize(
    ("changes", "error", "code"),
    [
        ({"face_type": "animal"}, Validation422, "mouth_not_for_face_type"),
        ({"image_key": None}, Conflict409, "source_gone"),
        ({"rig_key": ""}, Conflict409, "source_gone"),
    ],
)
def test_storing_a_kit_needs_a_human_face_with_its_picture(changes, error, code):
    with pytest.raises(error) as refused:
        panel.require_mouth(_avatar(**changes))
    assert refused.value.code == code


def test_storing_a_kit_does_not_ask_the_avatar_to_be_ready_again():
    """However long its calls took: a re-detection running meanwhile does
    not stop the kit, which follows the face."""
    assert panel.require_mouth(_avatar(status=AvatarStatus.processing)) is None


async def test_a_kit_is_refused_while_anything_runs_for_the_avatar():
    other = runner.reserve(ORG, AVATAR_ID, "creation_finish", 0)
    with pytest.raises(Conflict409) as refused:
        panel.start(_avatar(), "consent1")
    assert refused.value.code == "mouth_kit_in_progress"
    assert runner.active_for(AVATAR_ID) is other


async def test_a_start_the_runner_refuses_keeps_how_the_last_kit_ended():
    ended = {"id": "old", "state": FAILED}
    panel.ended[AVATAR_ID] = ended
    runner.reserve(ORG, "other1", "creation_finish", 0)
    runner.reserve(ORG, "other2", "creation_finish", 0)
    with pytest.raises(RateLimit429) as refused:
        panel.start(_avatar(), "consent1")
    assert refused.value.code == "too_many_jobs"
    assert panel.ended[AVATAR_ID] is ended and runner.active_for(AVATAR_ID) is None


async def test_an_accepted_start_forgets_the_last_ending_and_runs_on_its_consent(monkeypatch):
    ran: list = []

    async def run(job, params):
        ran.append((job.id, params))

    monkeypatch.setattr(panel, "run_job", run)
    panel.ended[AVATAR_ID] = {"id": "old", "state": FAILED}
    started = panel.start(_avatar(), "consent1")
    assert AVATAR_ID not in panel.ended
    assert started == {
        "id": started["id"],
        "step": panel.JOB_STEP,
        "state": QUEUED,
        "error": None,
        "started_at": started["started_at"],
        "progress": {"fraction": 0.0, "label": None, "count": None},
        "retryable": False,
    }
    await runner.drain()
    assert ran == [(started["id"], {"consent_id": "consent1"})]


# --- panel: the job view -------------------------------------------------------------------


def _job() -> Job:
    return Job(id="job1", org_id=ORG, subject_id=AVATAR_ID, step=panel.JOB_STEP, revision=0)


def test_the_job_view_is_the_live_kit_job_else_how_the_last_one_ended():
    assert panel.job_view(AVATAR_ID) is None
    other = runner.reserve(ORG, AVATAR_ID, "creation_finish", 0)
    assert panel.job_view(AVATAR_ID) is None, "another step's job is not the kit's"
    ended = {"id": "old", "state": DONE}
    panel.ended[AVATAR_ID] = ended
    assert panel.job_view(AVATAR_ID) is ended
    runner.release(other)
    live = runner.reserve(ORG, AVATAR_ID, panel.JOB_STEP, 0)
    view = panel.job_view(AVATAR_ID)
    assert (view["id"], view["state"], view["error"], view["retryable"]) == (
        live.id,
        QUEUED,
        None,
        False,
    )
    assert view["progress"] == {"fraction": 0.0, "label": None, "count": None}


@pytest.mark.parametrize(
    ("state", "error", "retryable"),
    [
        (FAILED, {"code": "provider_error", "detail": "x"}, True),
        (FAILED, {"code": "consent_not_recorded", "detail": "x"}, True),
        (FAILED, {"code": "safety_refused", "detail": "x"}, False),
        (FAILED, {"code": "image_limit_reached", "detail": "x"}, False),
        (DONE, None, False),
    ],
)
def test_an_ended_job_says_whether_asking_again_could_help(state, error, retryable):
    out = panel.job_out(_job(), state, error)
    assert out["retryable"] is retryable
    assert out["progress"] is None and out["error"] == error and out["state"] == state


def test_only_the_most_recent_endings_are_kept(monkeypatch):
    monkeypatch.setattr(panel, "ENDED_KEPT", 2)
    for subject in ("a1", "a2", "a1", "a3"):
        panel.record_end(
            Job(id=f"j-{subject}", org_id=ORG, subject_id=subject, step=panel.JOB_STEP, revision=0),
            DONE,
        )
    assert list(panel.ended) == ["a1", "a3"], "a1 ended again, so a2 is the oldest"


def test_a_kit_manifests_size_is_its_frames():
    assert panel.manifest_size(_result()) == [400, 500]


def _with_reasons(reasons: list) -> pk.KitResult:
    result = _result(generated=0)
    for shape, reason in zip(pk.SHAPES, reasons, strict=True):
        result.report[shape]["reason"] = reason
    return result


def test_a_kit_that_made_nothing_fails_with_what_stopped_it_first():
    rejected = {"code": "pose_not_reached", "detail": "Not the AA shape"}
    limit = {"code": "image_limit_reached", "detail": "Monthly image generation limit reached"}
    failure = panel.nothing_made(_with_reasons([rejected, None, limit, rejected, None, None]))
    assert type(failure) is AppError and failure.status_code == 500
    assert failure.code == "image_limit_reached"
    assert failure.detail == f"None of the mouth shapes could be made: {limit['detail']}"
    checks = panel.nothing_made(
        _with_reasons([None, rejected, {"code": "registration", "detail": "r"}, None, None, None])
    )
    assert checks.code == "pose_not_reached"
    silent = panel.nothing_made(_with_reasons([None] * 6))
    assert (silent.code, silent.detail) == (
        "provider_error",
        "None of the mouth shapes could be made: The AI service did not return an image",
    )


# --- panel: the job, faked around ---------------------------------------------------------


class PanelWorld:
    """The panel job's world, faked where services.mouth_kit.panel looks it
    up: the database (`loads`: what each read of the avatar returns, in
    turn, then `avatar`), the switch, the image model, the limit, storage
    holding the avatar's picture and rig, and `make` answering `answer`
    (a result, an exception to raise, or a coroutine function)."""

    def __init__(self, monkeypatch):
        self.avatar = _avatar()
        self.loads: list = []
        self.db = FakeDb()
        self.storage = MemoryStorage()
        self.storage.files[self.avatar.image_key] = b"picture"
        self.storage.files[self.avatar.rig_key] = json.dumps(
            {"points": POINTS, "image_size": [400, 500]}
        ).encode()
        self.switched_off = False
        self.configured = True
        self.limit_error: Exception | None = None
        self.answer = None
        self.made: list = []
        monkeypatch.setattr(panel, "get_session_factory", _sessions(self.db))
        monkeypatch.setattr(panel, "load_avatar", self._load)
        monkeypatch.setattr(panel, "ai_switched_off", self._switched_off)
        monkeypatch.setattr(imagegen, "configured", lambda: self.configured)
        monkeypatch.setattr(panel, "check_image_limit", self._check)
        monkeypatch.setattr(panel, "get_storage", lambda: self.storage)
        monkeypatch.setattr(panel, "make", self._make)

    async def _load(self, db, org_id, avatar_id):
        return self.loads.pop(0) if self.loads else self.avatar

    async def _switched_off(self, org_id):
        return self.switched_off

    async def _check(self, db, org_id, incoming=1):
        if self.limit_error is not None:
            raise self.limit_error

    async def _make(self, org_id, picture, points, **kwargs):
        self.made.append((org_id, picture, points, kwargs))
        if isinstance(self.answer, BaseException):
            raise self.answer
        if callable(self.answer):
            return await self.answer()
        return self.answer


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        (lambda w: setattr(w, "switched_off", True), "third_party_ai_disabled"),
        (lambda w: setattr(w, "configured", False), "imagegen_unavailable"),
        (
            lambda w: setattr(w, "limit_error", RateLimit429("limit", code="image_limit_reached")),
            "image_limit_reached",
        ),
        (lambda w: w.storage.files.pop(w.avatar.image_key), "source_gone"),
        (lambda w: w.storage.files.pop(w.avatar.rig_key), "source_gone"),
        (lambda w: setattr(w.avatar, "face_type", "animal"), "mouth_not_for_face_type"),
        (lambda w: w.loads.append(None), "avatar_not_found"),
    ],
    ids=["switch", "unconfigured", "limit", "picture-gone", "rig-gone", "animal", "deleted"],
)
async def test_a_queued_kit_is_refused_as_things_are_when_it_runs(monkeypatch, setup, code):
    """Read again when the job runs (it may have waited behind others):
    refused before anything is sent, and not offered again."""
    world = PanelWorld(monkeypatch)
    setup(world)
    await panel.run_job(_job(), {"consent_id": "consent1"})
    ended = panel.job_view(AVATAR_ID)
    assert ended["state"] == FAILED and ended["error"]["code"] == code
    assert ended["retryable"] is False
    assert world.made == [] and world.db.commits == 0


async def test_the_job_boundary_says_how_the_kit_ended(monkeypatch):
    job = _job()

    async def fine(job, params):
        return None

    monkeypatch.setattr(panel, "make_for_avatar", fine)
    await panel.run_job(job, {"consent_id": "consent1"})
    assert panel.job_view(AVATAR_ID) == {
        "id": "job1",
        "step": panel.JOB_STEP,
        "state": DONE,
        "error": None,
        "started_at": job.started_at,
        "progress": None,
        "retryable": False,
    }

    async def crash(job, params):
        raise KeyError("points")

    monkeypatch.setattr(panel, "make_for_avatar", crash)
    await panel.run_job(job, {"consent_id": "consent1"})
    ended = panel.job_view(AVATAR_ID)
    assert ended["state"] == FAILED and ended["retryable"] is True
    assert ended["error"] == {"code": "job_failed", "detail": "Something went wrong; try again"}


async def test_a_kit_for_an_avatar_deleted_meanwhile_is_not_stored(monkeypatch):
    world = PanelWorld(monkeypatch)
    world.loads = [world.avatar, None]
    world.answer = _result()
    await panel.make_for_avatar(_job(), {"consent_id": "consent1"})
    assert world.made[0][3]["teeth"] is True
    assert world.db.commits == 0 and len(world.storage.files) == 2
    assert world.avatar.mouth_config is None


async def test_a_face_re_marked_while_the_kit_was_made_gets_the_kit_moved_onto_it(monkeypatch):
    world = PanelWorld(monkeypatch)
    moved = [[5.0, 6.0], [7.0, 8.0]]

    async def made_while_re_marked():
        world.storage.files[world.avatar.rig_key] = json.dumps(
            {"points": moved, "image_size": [400, 500]}
        ).encode()
        return _result()

    world.answer = made_while_re_marked
    seen: list = []

    def rebase(manifest, points, frame, size):
        seen.append((points, frame, size))
        return {**manifest, "rebased": True}

    monkeypatch.setattr(pk, "rebase_manifest", rebase)
    job = _job()
    await panel.make_for_avatar(job, {"consent_id": "consent1"})
    assert seen == [(moved, None, (400, 500))]
    config = _config(world.avatar)
    assert json.loads(world.storage.files[config["motion_key"]])["rebased"] is True
    assert config["kit"]["source"] == "mouth_panel"
    assert world.avatar.draft_revision == 1 and world.db.commits == 1
    assert job.progress() == {"fraction": 1.0, "label": calls.SAVE_LABEL, "count": None}


async def test_malformed_points_with_the_owners_teeth_fail_as_kit_unavailable(monkeypatch):
    """With the owner's own teeth the single teeth photo could bring
    nothing, so the kit's refusal is the job's."""
    world = PanelWorld(monkeypatch)
    world.avatar.mouth_config = json.dumps(
        {
            "renderer": "continuous",
            "profile": {},
            "oral_image_key": "t.webp",
            "oral_rig_key": "t.json",
            "teeth": {"source": "upload"},
        }
    )
    message = "base_points must be 478 finite (x, y) pixel positions"
    world.answer = ValueError(message)
    with pytest.raises(Conflict409) as refused:
        await panel.make_for_avatar(_job(), {"consent_id": "consent1"})
    assert (refused.value.code, refused.value.detail) == ("kit_unavailable", message)
    assert world.made[0][3]["teeth"] is False


async def test_teeth_made_alone_that_fail_fail_the_job_with_their_own_reason(monkeypatch):
    world = PanelWorld(monkeypatch)
    world.answer = pk.KitUnavailable("landmarks_unavailable", "Face detection is not available")
    asked: list = []

    async def make_teeth(org_id, picture, on_send=None):
        asked.append((org_id, picture))
        raise mouth_photo.TeethFailure("safety_refused", "The AI declined to make the teeth")

    monkeypatch.setattr(mouth_photo, "make_teeth", make_teeth)
    job = _job()
    with pytest.raises(AppError) as failed:
        await panel.make_for_avatar(job, {"consent_id": "consent1"})
    assert (failed.value.code, failed.value.detail) == (
        "safety_refused",
        "The AI declined to make the teeth",
    )
    assert asked == [(ORG, b"picture")]
    assert job.label == calls.TEETH_LABEL and world.db.commits == 0


# --- performance_kit: registration on stable anchors ----------------------------------------


def _rotation(degrees: float) -> np.ndarray:
    theta = math.radians(degrees)
    return np.array([[math.cos(theta), math.sin(theta)], [-math.sin(theta), math.cos(theta)]])


def test_the_anchors_similarity_is_recovered_exactly_and_carries_every_point():
    rng = np.random.default_rng(7)
    source = rng.random((478, 2)) * 400
    target = source @ _rotation(20) * 1.5 + np.array([10.0, -5.0])
    similarity = pk.similarity_on_anchors(source, target)
    assert similarity.degrees == pytest.approx(20.0)
    assert similarity.scale == pytest.approx(1.5)
    np.testing.assert_allclose(similarity.rotation, _rotation(20), atol=1e-12)
    np.testing.assert_allclose(similarity.source_centre, source[pk.ANCHORS].mean(axis=0))
    np.testing.assert_allclose(similarity.target_centre, target[pk.ANCHORS].mean(axis=0))
    registered = pk.register(source, target)
    np.testing.assert_allclose(registered, target, atol=1e-9)
    assert pk.registration_rms(registered, target) == pytest.approx(0.0, abs=1e-9)


def test_only_the_anchors_decide_the_registration():
    """The mouth and chin are what a pose changes: moving every other point
    leaves the similarity bit for bit as it was; other anchors may be given."""
    rng = np.random.default_rng(3)
    source = rng.random((478, 2)) * 400
    target = source @ _rotation(-3) * 0.9 + 4.0
    others = [i for i in range(478) if i not in pk.ANCHORS]
    moved = target.copy()
    moved[others] += rng.normal(0, 50, size=(len(others), 2))
    a, b = pk.similarity_on_anchors(source, target), pk.similarity_on_anchors(source, moved)
    assert np.array_equal(a.rotation, b.rotation) and a.scale == b.scale
    assert np.array_equal(a.target_centre, b.target_centre)
    own = [0, 1, 2, 3]
    noisy = target.copy()
    noisy[pk.ANCHORS] += 30.0 * rng.normal(size=(len(pk.ANCHORS), 2))
    assert pk.similarity_on_anchors(source, noisy, own).scale == pytest.approx(0.9)


def test_a_reflection_onto_the_anchors_is_refused_as_a_value_error():
    rng = np.random.default_rng(5)
    source = rng.random((478, 2)) * 100
    with pytest.raises(pk.MirroredPose) as mirrored:
        pk.similarity_on_anchors(source, source * np.array([-1.0, 1.0]))
    assert isinstance(mirrored.value, ValueError)


def test_the_registration_rms_is_per_coordinate_over_the_anchors_only():
    """A (3, 4) pixel offset of every anchor is 3.54, not 5: the RMS is
    over coordinates; a point that is not an anchor does not count."""
    target = np.random.default_rng(9).random((478, 2)) * 100
    registered = target.copy()
    registered[pk.ANCHORS] += [3.0, 4.0]
    registered[300] += [100.0, 100.0]
    assert 300 not in pk.ANCHORS
    assert pk.registration_rms(registered, target) == pytest.approx(math.sqrt(12.5))


def test_the_mouth_frame_is_the_rings_extent_its_middle_and_its_mean_height():
    base = np.zeros((478, 2))
    base[[0, 1, 2, 3]] = [(10, 5), (30, 9), (20, 1), (14, 1)]
    assert pk.mouth_frame(base, [0, 1, 2, 3]) == (20.0, 20.0, 4.0)


def _rhombus(across: float, down: float) -> np.ndarray:
    return np.array([[-across, 0.0], [across, 0.0], [0.0, down], [0.0, -down]])


def _triangles(triangles) -> set[frozenset]:
    return {frozenset(t) for t in triangles}


def test_every_pose_shares_the_mean_poses_topology():
    """A tall first pose would join its corners across; the mean of the
    poses is wide, and its triangles join top and bottom instead."""
    poses = [_rhombus(1, 3), _rhombus(5, 1)]
    base = _rhombus(3, 2)
    shared = pk.shared_triangles(poses, base, (0.0, 0.0), 10.0)
    assert _triangles(shared) == {frozenset({0, 2, 3}), frozenset({1, 2, 3})}
    assert _triangles(pk.shared_triangles(poses[:1], base, (0.0, 0.0), 10.0)) == {
        frozenset({0, 1, 2}),
        frozenset({0, 1, 3}),
    }


def test_triangles_away_from_the_mouth_are_left_out():
    near = [(0.0, 0.0), (1.0, 0.2), (0.3, 1.0)]
    far = [(100.0, 0.0), (101.0, 0.5), (100.2, 1.2), (101.4, 1.6)]
    points = np.array(near + far)
    every = _triangles(Delaunay(points).simplices.tolist())
    kept = _triangles(pk.shared_triangles([points], points, (0.0, 0.0), 1.0))
    by_the_mouth = {t for t in every if t & {0, 1, 2}}
    assert kept == by_the_mouth and kept != every


def _reference_manifest(**changes) -> dict:
    manifest = {
        "version": 1,
        "character": pk.REFERENCE_CHARACTER,
        "poses": [{"id": pose, "points": [[0.5, 0.5]] * 478} for pose in pk.POSES],
    }
    manifest.update(changes)
    return manifest


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"version": 2}, "not the Reference's motion manifest"),
        ({"character": f"{pk.CHARACTER_PREFIX}kit123"}, "not the Reference's motion manifest"),
        (
            {"poses": [{"id": p, "points": [[0.5, 0.5]] * 478} for p in pk.POSES[:-1]]},
            "the Reference manifest is incomplete",
        ),
        (
            {"poses": [{"id": p, "points": [[0.5, 0.5]] * 478} for p in reversed(pk.POSES)]},
            "the Reference manifest is incomplete",
        ),
        (
            {
                "poses": [
                    {"id": p, "points": [[0.5, 0.5]] * (468 if p == "oh" else 478)}
                    for p in pk.POSES
                ]
            },
            "the Reference manifest is incomplete",
        ),
    ],
    ids=["version", "character", "missing-pose", "reordered", "short-pose"],
)
def test_only_the_references_own_complete_manifest_is_read_as_it(changes, message):
    with pytest.raises(ValueError, match=message):
        pk.ReferenceMotion.from_manifest(_reference_manifest(**changes))


def test_the_reference_is_read_from_the_path_given_or_not_at_all(tmp_path):
    path = tmp_path / "mouth-motion.json"
    path.write_text(json.dumps(_reference_manifest()))
    reference = pk.load_reference(path)
    assert reference.rest.shape == (478, 2) and tuple(reference.poses) == pk.SHAPES
    with pytest.raises(FileNotFoundError):
        pk.load_reference(tmp_path / "missing.json")


def test_a_base_face_with_no_width_has_no_manifest_frame():
    reference = pk.ReferenceMotion(rest=np.zeros((478, 2)), poses={})
    with pytest.raises(ValueError, match="the base face has no width"):
        pk.ManifestFrame.from_base(np.zeros((478, 2)), (400, 500), reference)


# --- performance_kit: the gates an answer must pass ------------------------------------------


@pytest.mark.parametrize(
    ("shape", "opened", "width", "missed"),
    [
        ("oo", 0.04, 0.7, "the lips parted 0.04 mouth widths, less than 0.06"),
        (
            "oo",
            0.30,
            0.7,
            "the lips parted 0.30 mouth widths, more than 0.244 (2.0 times the Reference's)",
        ),
        (
            "aa",
            0.41,
            1.0,
            "the lips parted 0.41 mouth widths, more than 0.406 (1.4 times the Reference's)",
        ),
        ("ee", 0.10, 0.90, "the mouth is 0.90 of its rest width, narrower than 0.94"),
        ("oo", 0.10, 0.90, "the mouth is 0.90 of its rest width, wider than 0.85"),
        ("oh", 0.13, 0.95, "the mouth is 0.95 of its rest width, wider than 0.92"),
        # The opening is judged before the width.
        ("oo", 0.01, 2.0, "the lips parted 0.01 mouth widths, less than 0.06"),
        ("oo", 0.10, 0.70, None),
        ("ee", 0.10, 1.05, None),
        # A F/V has no floor: lips pressed closer than at rest still make it.
        ("fv", -0.05, 1.0, None),
    ],
)
def test_whether_an_answer_made_the_shape_it_was_asked_for(shape, opened, width, missed):
    assert pk._shape_reached(shape, opened, width) == missed


def _lips(gap: float, width: float) -> np.ndarray:
    points = np.zeros((478, 2))
    points[pk.MOUTH_LEFT], points[pk.MOUTH_RIGHT] = (0.0, 0.0), (width, 0.0)
    points[pk.UPPER_INNER], points[pk.LOWER_INNER] = (width / 2, 0.0), (width / 2, gap)
    return points


def test_a_teeth_answer_must_part_its_lips_as_far_as_an_upload_must():
    assert pk._teeth_shown(_lips(8.0, 100.0)) is None, "exactly the threshold passes"
    assert pk._teeth_shown(_lips(5.0, 100.0)) == (
        "the lips parted 0.05 of their mouth width, too little to show the teeth (at least 0.08)"
    )
    # A mouth under a pixel wide is measured against one pixel, not divided by zero.
    assert pk._teeth_shown(_lips(0.5, 0.0)) is None
    assert pk._teeth_shown(_lips(0.05, 0.0)) is not None


def test_a_face_with_no_width_reads_as_turned_fully_away():
    points = np.zeros((478, 2))
    points[[pk.FACE_LEFT, pk.FACE_RIGHT], 0] = 50.0
    assert pk.signed_yaw(points) == 1.0
    points[pk.FACE_LEFT, 0], points[pk.FACE_RIGHT, 0], points[pk.NOSE_TIP, 0] = 0.0, 100.0, 25.0
    assert pk.signed_yaw(points) == -0.5


def _png(size=(64, 64)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (196, 150, 122)).save(out, format="PNG")
    return out.getvalue()


def test_an_answer_whose_face_was_not_fully_found_is_refused():
    request = pk.PoseRequest("aa", pk.FACE_CROP, "p", b"", "image/jpeg", (0.0, 0.0, 64.0, 64.0))
    frame = pk.ManifestFrame(np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]), (64, 64))
    for detected in (np.full((478, 2), np.nan), np.zeros((468, 2)), np.full((478, 2), np.inf)):
        registration = pk.register_answer(
            _png(),
            request,
            Image.new("RGB", (64, 64)),
            np.zeros((478, 2)),
            frame,
            lambda image, d=detected: d,
        )
        assert registration.reason == {
            "code": "no_face_in_result",
            "detail": "The answer's face was not fully found",
        }
        assert registration.checks == {"aspect": 1.0}
        assert registration.ok is False and registration.answer_points is None
    # A registration is ok only with targets and no reason.
    assert pk.PoseRegistration("aa").ok is False
    assert pk.PoseRegistration("aa", targets=np.zeros((478, 2))).ok is True
    assert pk.PoseRegistration("aa", targets=np.zeros((478, 2)), reason=REFUSED).ok is False


def test_a_base_detection_that_is_not_a_whole_face_is_not_used():
    base = np.random.default_rng(2).random((478, 2)) * 400
    image = Image.new("RGB", (8, 8))
    for detected in (None, np.zeros((468, 2)), np.full((478, 2), np.nan)):
        assert pk._detect_base(lambda img, d=detected: d, image, base) is None
    found = pk._detect_base(lambda img: base.tolist(), image, base)
    assert np.array_equal(found, base)
