# ruff: noqa  (a one-off trial script, kept for reproducibility)
"""AI expression trial (phase A). Runs INSIDE the API container, read-only:
reads two avatars' rigged pictures + rigs from storage and the key through the
app's own credential overlay (never printed), calls imagegen.edit_image, and
writes answers + measurements to /tmp/aiexpr only. No DB writes, no /data writes.

Prompts expr-prompts@2 (the 2026-10-11 trial; see the trial report).

usage (in the container, PYTHONPATH=/app/backend):
  python trial_ai_expressions.py <max_calls> <avatar_id>:<expr>[,<expr>...] ...
"""

from __future__ import annotations

import asyncio
import io
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image

from app.db import get_session_factory
from app.core.credentials import credentials
from app.models.avatar import Avatar
from app.services import imagegen, photo_adjust
from app.services.storage import get_storage
from app.services.performance_kit.registration import (
    MAX_REGISTRATION_RMS,
    ManifestFrame,
    MirroredPose,
    load_reference,
    registration_rms,
    similarity_on_anchors,
)
from app.services.performance_kit.requests import (
    FACE_CROP,
    PoseRequest,
    crop_picture,
    load_base_image,
)
from app.services.performance_kit.answers import (
    EYE_GUARD,
    MAX_ASPECT_CHANGE,
    MAX_NOSE_SHIFT,
    MAX_POSE_SKIN_DELTA_E,
    MAX_ROTATION_DEGREES,
    MAX_SCALE_CHANGE,
    MAX_YAW_CHANGE,
    NOSE_GUARD,
    mouth_width,
    opening,
    signed_yaw,
)
from app.services.performance_kit.constants import FACE_LEFT, FACE_RIGHT, MOUTH_LEFT, MOUTH_RIGHT

OUT = "/tmp/aiexpr"

# In the style of performance_kit.prompts._KEEP, for the upper face + mouth.
KEEP = (
    "Change ONLY the facial expression: the eyebrows, the eyelids, the cheeks and the mouth. "
    "Keep exactly the same person and identity, the same face shape, skin, skin tone, skin "
    "texture, pores and makeup, the same eye colour, the eyes looking straight at the camera "
    "as before, the same nose, hair, ears and clothing, the same head position, head angle "
    "and head size in the frame, the same framing, lighting, colours, background and image "
    "size. Keep the same apparent age: add no wrinkles or lines beyond the few the "
    "expression itself makes, and keep the skin exactly as smooth or textured as it is. "
    "Keep the picture's own medium and rendering style exactly: if it is a painting, an "
    "illustration or a 3D render it stays one, with the same shading and colour palette; "
    "if it is a photograph it stays the same photograph. Do not beautify, smooth, sharpen, "
    "relight, restyle, zoom or crop. A natural, genuine moment in a friendly conversation, "
    "not a caricature, not a grimace, not an exaggerated or theatrical expression."
)

EXPRESSIONS = {
    "happy": (
        "smiling a genuine, warm smile (a Duchenne smile): the corners of the mouth drawn up "
        "and back, the lips parted to show the upper front teeth, the cheeks raised and "
        "rounded, the lower eyelids pushed up so the eyes narrow a little, with fine creases "
        "at their outer corners; the eyebrows relaxed, at most a little lowered at the outer ends"
    ),
    "surprised": (
        "pleasantly surprised, as on hearing unexpected good news: both eyebrows raised high "
        "and arched, a few horizontal creases across the forehead, the upper eyelids raised so "
        "the eyes look wider open, the jaw dropped slightly so the lips part softly; not "
        "shocked or frightened"
    ),
    "concerned": (
        "concerned and sympathetic, as when hearing that someone is having a hard time: the "
        "INNER ends of both eyebrows LIFTED UPWARD, so each eyebrow slants up towards the "
        "middle of the forehead (sad, worried eyebrows), the outer ends staying where they "
        "are, a few short horizontal creases in the middle of the forehead only, the eyes "
        "soft and open, the lips closed and relaxed with the corners of the mouth turned "
        "slightly down. The eyebrows must NOT be lowered, knitted or frowning: no vertical "
        "furrows between them, no anger; not crying"
    ),
    "thinking": (
        "thoughtful, pondering a question: an asymmetric look, the eyebrow on the right "
        "side of the picture clearly RAISED and arched, the eyebrow on the left side of the "
        "picture relaxed and slightly lowered, so the two eyebrows are at visibly different "
        "heights; the lips closed and pressed together and pulled slightly to one side, one "
        "corner of the mouth tucked in; still looking at the camera. Not frowning, not "
        "angry, not worried"
    ),
    "serious": (
        "serious and focused: the inner ends of the eyebrows lowered and drawn together, two "
        "short vertical furrows between the brows, the upper eyelids a little lowered, the "
        "lips closed and pressed together, the mouth straight; firm but calm, not angry"
    ),
}

PROMPTS_VERSION = "expr-prompts@2"


def expression_prompt(name: str) -> str:
    return (
        "Edit this close-up portrait photograph so that the same person is "
        f"{EXPRESSIONS[name]}. {KEEP}"
    )


# Brows (MediaPipe upper brow lines): picture-left brow 70,63,105,66,107; picture-right
# 336,296,334,293,300. Inner ends 107/336 (+66/296), outer ends 70/300 (+63/293).
BROW_L = [70, 63, 105, 66, 107]
BROW_R = [336, 296, 334, 293, 300]
LIDS = {"L": (159, 145), "R": (386, 374)}


def measures(reg: np.ndarray, base: np.ndarray) -> dict:
    """What the expression moved, in face widths (y down: negative = up)."""
    face = float(np.linalg.norm(base[FACE_RIGHT] - base[FACE_LEFT]))
    d = (reg - base) / face

    def up(ids):
        return round(float(-d[ids, 1].mean()), 4)

    out = {
        "brow_inner_L": up([107, 66]),
        "brow_outer_L": up([70, 63]),
        "brow_inner_R": up([336, 296]),
        "brow_outer_R": up([300, 293]),
        "brow_knit": round(
            float(
                (np.linalg.norm(reg[107] - reg[336]) - np.linalg.norm(base[107] - base[336])) / face
            ),
            4,
        ),
        "corner_up_L": up([MOUTH_LEFT]),
        "corner_up_R": up([MOUTH_RIGHT]),
        "mouth_width": round(mouth_width(reg) / mouth_width(base), 3),
        "opening": round(opening(reg, base), 3),
        "cheek_up": up([50, 280, 205, 425]),
    }
    for side, (a, b) in LIDS.items():
        out[f"eye_open_{side}"] = round(
            float(np.linalg.norm(reg[a] - reg[b]) / max(np.linalg.norm(base[a] - base[b]), 1e-6)), 3
        )
    return out


def register(answer: bytes, req: PoseRequest, base_image, base_view, frame) -> dict:
    r = {"checks": {}, "reason": None}
    c = r["checks"]
    image = Image.open(io.BytesIO(answer)).convert("RGB")
    c["answer_size"] = image.size
    aspect = image.width / image.height
    c["aspect"] = round(aspect / req.aspect, 4)
    if abs(aspect / req.aspect - 1) > MAX_ASPECT_CHANGE:
        r["reason"] = "aspect_changed"
        return r
    pts = photo_adjust.detect_points(image)
    if pts is None:
        r["reason"] = "no_face_in_result"
        return r
    pts = np.asarray(pts, dtype=np.float64)
    r["answer_points"] = pts.tolist()
    to_base = req.to_base(image.size)
    mapped = pts @ to_base[:, :2].T + to_base[:, 2]
    try:
        sim = similarity_on_anchors(mapped, base_view)
    except MirroredPose:
        r["reason"] = "mirrored"
        return r
    c["scale"], c["rotation"] = round(sim.scale, 4), round(sim.degrees, 2)
    reg = sim.apply(mapped)
    # answer px -> base px, as one 2x3 (for warping the answer into the base frame)
    A = to_base[:, :2].T @ sim.rotation * sim.scale  # row-vector form
    t = (to_base[:, 2] - sim.source_centre) @ sim.rotation * sim.scale + sim.target_centre
    r["answer_to_base"] = np.vstack([A.T[0].tolist() + [t[0]], A.T[1].tolist() + [t[1]]]).tolist()
    rms = registration_rms(reg, base_view) * frame.units_per_px
    face = float(np.linalg.norm(base_view[FACE_RIGHT] - base_view[FACE_LEFT]))
    c["rms"] = round(rms, 5)
    c["nose"] = round(
        float(np.linalg.norm(reg[NOSE_GUARD] - base_view[NOSE_GUARD], axis=1).max()) / face, 4
    )
    c["eyes"] = round(
        float(np.linalg.norm(reg[EYE_GUARD] - base_view[EYE_GUARD], axis=1).mean()) / face, 4
    )
    c["yaw"] = round(abs(signed_yaw(pts) - signed_yaw(base_view)), 4)
    drift = photo_adjust.skin_drift(base_image, base_view, image, pts)
    c["skin_delta_e"] = None if drift is None else round(drift, 2)
    # Rigid outline (temples + upper face oval): identity/shape proxy.
    oval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 234, 127, 162, 21, 54, 103, 67, 109]
    c["oval"] = round(float(np.linalg.norm(reg[oval] - base_view[oval], axis=1).mean()) / face, 4)
    r["measures"] = measures(reg, base_view)
    r["registered_points"] = reg.tolist()
    fails = []
    if abs(sim.scale - 1) > MAX_SCALE_CHANGE or abs(sim.degrees) > MAX_ROTATION_DEGREES:
        fails.append("head_moved")
    if rms > MAX_REGISTRATION_RMS:
        fails.append("registration")
    if c["nose"] > MAX_NOSE_SHIFT:
        fails.append("nose_moved")
    if c["yaw"] > MAX_YAW_CHANGE:
        fails.append("head_turned")
    if drift is not None and drift > MAX_POSE_SKIN_DELTA_E:
        fails.append("skin_tone_changed")
    r["kit_gate_fails"] = fails
    r["reason"] = fails[0] if fails else None
    return r


async def main():
    max_calls = int(sys.argv[1])
    jobs = []
    for arg in sys.argv[2:]:
        aid, exprs = arg.split(":")
        for e in exprs.split(","):
            jobs.append((aid, e))
    assert len(jobs) <= max_calls, "over budget"
    os.makedirs(OUT, exist_ok=True)
    storage = get_storage()
    reference = load_reference()
    async with get_session_factory()() as db:
        await credentials.load(db)  # read-only
        avatars = {aid: await db.get(Avatar, aid) for aid in {j[0] for j in jobs}}
    ctx = {}
    for aid, a in avatars.items():
        png = await storage.get_bytes(a.image_key)
        rig = json.loads(await storage.get_bytes(a.rig_key))
        points = np.asarray(rig["points"], dtype=np.float64)
        base_image = load_base_image(png)
        base_det = photo_adjust.detect_points(base_image)
        base_view = points if base_det is None else np.asarray(base_det, dtype=np.float64)
        frame = ManifestFrame.from_base(points, base_image.size, reference)
        crop = crop_picture(base_image, points, FACE_CROP)
        with open(f"{OUT}/{aid}_neutral_crop.jpg", "wb") as f:
            f.write(crop.payload)
        with open(f"{OUT}/{aid}_base.json", "w") as f:
            json.dump(
                {
                    "name": a.name,
                    "box": crop.box,
                    "size": base_image.size,
                    "base_detected": base_view.tolist(),
                    "rig_points": points.tolist(),
                },
                f,
            )
        ctx[aid] = (base_image, base_view, frame, crop)

    sem = asyncio.Semaphore(3)

    async def one(aid, expr):
        base_image, base_view, frame, crop = ctx[aid]
        prompt = expression_prompt(expr)
        req = PoseRequest(expr, crop.kind, prompt, crop.payload, "image/jpeg", crop.box)
        stamp = f"{aid}_{expr}_{int(time.time() * 1000) % 10**7}"
        rec = {
            "avatar": aid,
            "expr": expr,
            "prompts_version": PROMPTS_VERSION,
            "prompt": prompt,
            "file": stamp + ".png",
        }
        async with sem:
            t0 = time.time()
            try:
                gen = await imagegen.edit_image(prompt, crop.payload, "image/jpeg")
            except Exception as exc:
                rec["error"] = f"{type(exc).__name__}: {getattr(exc, 'reason', '')}"
                rec["billed"] = isinstance(
                    exc, (imagegen.ImageGenRefused, imagegen.ImageGenNoImage)
                )
                print(json.dumps(rec))
                return rec
            rec["seconds"] = round(time.time() - t0, 1)
            rec["model"] = gen.model
            rec["billed"] = True
        with open(f"{OUT}/{stamp}.png", "wb") as f:
            f.write(gen.image)
        rec.update(register(gen.image, req, base_image, base_view, frame))
        summary = {
            k: rec.get(k)
            for k in (
                "avatar",
                "expr",
                "file",
                "seconds",
                "reason",
                "kit_gate_fails",
                "checks",
                "measures",
            )
        }
        print(json.dumps(summary))
        with open(f"{OUT}/{stamp}.json", "w") as f:
            json.dump(rec, f)
        return rec

    results = await asyncio.gather(*(one(a, e) for a, e in jobs))
    print("CALLS", len(results), "BILLED", sum(1 for r in results if r.get("billed")))


asyncio.run(main())
