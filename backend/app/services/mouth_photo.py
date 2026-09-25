"""The person's own teeth for the photographic mouth: a mouth photo,
uploaded by the owner or made by AI from the avatar's own picture.

Why a photo of teeth at all: the photographic mouth (embed/src/mouth,
"continuous") opens the lips of the one photo it has, and what shows behind
them is either the enamel lifted from a second photo of the same person
saying "ee", or generic drawn teeth. The Reference avatar in the lab looks
as good as it does largely because it has the first. An upload takes that
second photo from the owner; AI makes it for them.

**One path in.** Whatever the source, a mouth photo is admitted by
`prepare_mouth_photo`: the portrait checks every mouth photo has always had
(portrait_photo.prepare_photo: a real detected face, big enough, the mouth
actually open), then `admit_photo`: an encoding for visitors
(`encode_for_visitors`, below) and the browser's own teeth test on exactly
those bytes (services.dental_photo: the upper row wide, dense and tall
enough, or `DentalPhotoError` on every visitor's page); `store` writes it
as the draft's oral photo. The owner upload and the AI paths differ only
in where the bytes come from and in the `teeth` record they leave (below).

**AI teeth come with the mouth shapes.** Finishing a person, and the Mouth
panel's one AI action, make the performance kit (services.mouth_kit): six
photos of the person's mouth, whose "ee" is the teeth photo when the embed
would draw it; it enters at `admit_photo`, found and checked as a shape
already. The single "ee" photo below (`make_teeth`) is what is left when
the kit cannot be made on this server (no face detector for its
registration): a person can still get their teeth.

**The AI "ee" photo** (`make_teeth`). The model is sent the face crop a
touch-up sends (photo_adjust: 1.6 face boxes, square, 1024 px) of the
avatar's final picture, a cut-out on the neutral grey, and asked to change
only the mouth. It is not pasted back into the portrait, because nothing
needs it there: the renderer registers a mouth photo by its own landmarks
(its mouth corners and upper lip), in units of its own mouth width, so a
crop serves exactly as a full frame would, with more pixels on the teeth.
One call; a refusal is asked once more on the head-and-shoulders crop
(photo_adjust.head_crop, the fallback a declined adjust uses), a different
input, never the same request again. Every answered call is metered as an
image generation (source "teeth") after the monthly limit and the
organization's switch are read again, as for every AI step.

**The teeth record** (`mouth_config["teeth"]`, owner-facing only: the
published snapshot keeps it beside the files so Discard can restore it,
and never hands it to a visitor):
`{"source": "ai", "model"}` for AI teeth, `{"source": "upload"}` for the
owner's photo, or `{"source": null, "note": {code, detail}}` when an avatar
was finished with generic teeth, saying why, for the avatar page.

AI-made teeth are disclosed like any AI edit: `ai_edited` gains
`"teeth": {"model"}` (`with_ai_teeth`), and becomes `{"mode": "teeth"}` when
nothing else about the picture was AI-made (`mouth_disclosure` keeps that
mode right as teeth and mouth shapes come and go).

Not fitted from a single photo: the teeth height (`profile.teethY`).
Measured on the lab's two AI "ee" photos of one fictional person
(oral-detail-v2, v3), the upper incisal edge mapped into the portrait
through the skull (stable landmarks, as a touch-up aligns) gives -0.034
and -0.010 mouth widths where the hand fit is 0.016, and the incisal edge
below the upper lip measures 0.080 against 0.143: the value moves with how
much crown the model chose to show, not with the person. A default of 0
sits inside that spread; the Mouth panel's slider is the fit. The kit's
teeth are fitted (performance_kit.fit_profile: where the embed seats the
arch it extracts, calibrated on oral-detail-v3).
"""

from __future__ import annotations

import io
import json
import logging
from dataclasses import dataclass

from collections.abc import Awaitable, Callable

import numpy as np

from app.core.errors import AppError, Validation422

logger = logging.getLogger("liveface.mouth_photo")

# What the teeth photo is recorded as in usage (usage.IMAGE_CALLS).
TEETH_CALL = "teeth"

# Modelled on photo_adjust.TOUCHUP_PROMPT (change one thing, keep every
# other pixel) and on the oral-detail-v3 prompt of the Reference avatar
# (docs/dental-rendering-repair-2026-09-07.md), whose teeth the renderer was
# tuned on: whole upper crowns from the gum to the edge, one continuous
# arch, a dark gap between the rows, soft light with no stripe across them.
TEETH_PROMPT = (
    "Edit this close-up portrait photograph. Make exactly one change: the person "
    "says a long, broad \"ee\", lips drawn back and slightly apart, so that the "
    "ENTIRE upper front teeth are clearly visible from the gumline to the biting "
    "edge, with a thin band of gum above them, all the upper front teeth in one "
    "continuous natural arch, a small dark gap between the upper and lower teeth, "
    "and the top edge of the lower front teeth just visible. These are this "
    "person's own natural teeth: natural shape, spacing and shade for them, with "
    "no whitening, veneers or brightening beyond their natural tone. Change "
    "NOTHING else: keep the same person, the same face shape, skin, skin texture, "
    "pores, makeup, eyes, eye colour, eyebrows, hair, lighting, colours, framing, "
    "head position, head angle and image size. Do not beautify, smooth, sharpen, "
    "relight, restyle or crop. Soft, even light on the teeth with no dark stripe "
    "across them. Photorealistic, indistinguishable from the original photo "
    "except for the mouth."
)

# Every visitor of the avatar downloads the mouth photo before the
# photographic mouth attaches, and presigned URLs change with each config
# fetch, so neither the browser nor a CDN keeps it between visits. As the
# PNG ingest_photo makes, a 1024 px "ee" face crop is about 1.3 MB; as
# WebP at this quality, about 160 KB, with the enamel's edges intact for
# the teeth test and the renderer (which samples only inside the lips).
MOUTH_PHOTO_TYPE = "image/webp"
MOUTH_PHOTO_QUALITY = 90

TEETH_UNCLEAR = (
    "The mouth photo needs a clearer view of the upper teeth: the whole upper front "
    "teeth, from the gum to the edge, lit evenly"
)


class TeethFailure(Exception):
    """No AI teeth, and why: a code the dashboard translates, a detail in
    English, and the HTTP status the refusal would answer with."""

    def __init__(self, code: str, detail: str, status: int = 422):
        self.code = code
        self.detail = detail
        self.status = status
        super().__init__(detail)

    def note(self) -> dict:
        return {"code": self.code, "detail": self.detail}


# --- Records --------------------------------------------------------------------


def default_config(face_type: str) -> dict | None:
    """The mouth a NEW avatar of this line starts with: the photographic one
    where it is allowed (a person), else None, the classic drawn mouth.
    Existing avatars keep whatever they have."""
    from app.services.mouth import renderer_allowed

    if renderer_allowed("continuous", face_type):
        return {"renderer": "continuous", "profile": {}}
    return None


def ai_teeth_record(model: str | None) -> dict:
    return {"source": "ai", "model": model}


def upload_teeth_record() -> dict:
    return {"source": "upload"}


def generic_teeth_record(note: dict | None) -> dict:
    return {"source": None, "note": note}


# The disclosure's modes that say only the MOUTH was AI-made, the picture
# itself not: its teeth photo (`teeth`), its mouth shapes (`mouth_shapes`,
# services.mouth_kit). Every other mode is the picture's own (touchup,
# stylise, regenerate, generate) and outranks them.
MOUTH_MODES = ("teeth", "mouth_shapes")


def mouth_disclosure(ai_edited: dict | None) -> dict | None:
    """`ai_edited` with its mode re-derived when only the mouth was AI-made:
    "teeth" while there is a teeth entry, else "mouth_shapes" while there is
    a shapes entry, else nothing to disclose (None). The model is that
    entry's. A picture's own mode is left as it is."""
    if not ai_edited:
        return None
    if ai_edited.get("mode") not in MOUTH_MODES:
        return ai_edited
    teeth, shapes = ai_edited.get("teeth"), ai_edited.get("mouth_shapes")
    if teeth:
        derived = {"mode": "teeth", "model": teeth.get("model"), "teeth": teeth}
        return {**derived, "mouth_shapes": shapes} if shapes else derived
    if shapes:
        return {"mode": "mouth_shapes", "model": shapes.get("model"), "mouth_shapes": shapes}
    return None


def with_ai_teeth(ai_edited: dict | None, model: str | None) -> dict:
    """The disclosure once AI made the teeth (a new dict: JSON columns are
    replaced, never mutated)."""
    if not ai_edited:
        return {"mode": "teeth", "model": model, "teeth": {"model": model}}
    return mouth_disclosure({**ai_edited, "teeth": {"model": model}})


def without_ai_teeth(ai_edited: dict | None) -> dict | None:
    """The disclosure once AI-made teeth are gone (replaced or removed):
    whatever else AI did, to the picture or to the mouth's shapes, stays
    disclosed."""
    if not ai_edited:
        return None
    return mouth_disclosure({k: v for k, v in ai_edited.items() if k != "teeth"})


# --- Admission --------------------------------------------------------------------


def teeth_verdict(photo: bytes, rig: dict):
    """services.dental_photo.accept_teeth_photo of a prepared mouth photo:
    the embed's own test, so the performance kit's teeth and these pass the
    same way. CPU work."""
    from PIL import Image

    from app.services import dental_photo

    with Image.open(io.BytesIO(photo)) as image:
        image.load()
        return dental_photo.accept_teeth_photo(
            image, np.asarray(rig["points"]), rig["inner_lip_ring"]
        )


def encode_for_visitors(photo: bytes) -> bytes:
    """`photo` (a clean PNG from ingest_photo) as the WebP visitors are
    served: the same pixel size, so the rig stays valid, and the same colour
    profile. CPU work."""
    from PIL import Image

    with Image.open(io.BytesIO(photo)) as image:
        image.load()
        icc = image.info.get("icc_profile")
        out = io.BytesIO()
        image.save(
            out, format="WEBP", quality=MOUTH_PHOTO_QUALITY, method=4,
            **({"icc_profile": icc} if icc else {}),
        )
    return out.getvalue()


def prepare_mouth_photo(data: bytes) -> tuple[bytes, dict]:
    """(photo, rig) of a mouth photo fit to store, or Validation422 saying
    what is wrong with it. The one admission of every mouth photo, uploaded
    or AI-made: the portrait checks, then `admit_photo`. CPU work."""
    from app.services import portrait_photo

    photo, rig, _note = portrait_photo.prepare_photo(data, "mouth")
    return admit_photo(photo, rig)


def admit_photo(png: bytes, rig: dict) -> tuple[bytes, dict]:
    """The end of every mouth photo's admission, for a clean PNG whose face
    is already found and landmarked (`rig`: rig.build_rig of its own
    points): the WebP visitors get, and the teeth test run on it, not on
    the lossless original, so what passed is what is shown. Validation422
    mouth_teeth_unclear otherwise.

    The performance kit's "ee" photo enters here (services.mouth_kit): it
    was detected and checked as a mouth shape already, with the same
    detector, and is admitted exactly as the rest from this point. CPU work."""
    photo = encode_for_visitors(png)
    verdict = teeth_verdict(photo, rig)
    if not verdict.accepted:
        raise Validation422(
            TEETH_UNCLEAR,
            code="mouth_teeth_unclear",
            extra={
                "upper_width": verdict.arch_width,
                "upper_count": verdict.arch_pixels,
                "coverage": round(verdict.crown_coverage, 4),
            },
        )
    return photo, rig


async def store(avatar, storage, photo: bytes, rig: dict, teeth: dict) -> list[str]:
    """Make `photo` the draft's mouth photo (the caller commits and marks the
    draft dirty). Returns the keys of the photo it replaced, to delete
    after the commit: the published snapshot has its own copies."""
    from app.services.mouth import load

    config = load(avatar.mouth_config) or {"renderer": "continuous", "profile": {}}
    previous = [k for k in (config.get("oral_image_key"), config.get("oral_rig_key")) if k]
    image_key, rig_key = await put_photo(avatar, storage, photo, rig)
    config.update(oral_image_key=image_key, oral_rig_key=rig_key, teeth=teeth)
    avatar.mouth_config = json.dumps(config)
    return previous


async def put_photo(avatar, storage, photo: bytes, rig: dict) -> tuple[str, str]:
    """Write an admitted mouth photo and its rig under fresh keys, and
    return them (image, rig); the config is the caller's to change. Fresh
    keys per photo: the published snapshot may still point at copies of
    the old ones, and browsers cache presigned URLs by path."""
    from uuid import uuid4

    from app.services.mouth import oral_keys

    image_key, rig_key = oral_keys(avatar.org_id, avatar.id, uuid4().hex[:8])
    await storage.put_bytes(image_key, photo, MOUTH_PHOTO_TYPE)
    await storage.put_bytes(rig_key, json.dumps(rig).encode(), "application/json")
    return image_key, rig_key


# --- The AI "ee" photo ---------------------------------------------------------------


@dataclass
class Request:
    payload: bytes
    mime: str


def face_request(data: bytes) -> Request:
    """The face crop a touch-up sends, of `data` (a cut-out on the neutral
    grey). TeethFailure when there is no frontal face to crop. CPU work."""
    from app.services import landmarks, photo_adjust as pa

    image = pa._rgb(data)
    try:
        points = pa._detect(image)
    except landmarks.LandmarkerUnavailable as exc:
        raise TeethFailure(
            "landmarks_unavailable", "Face detection is not available on this server", 409
        ) from exc
    if points is None:
        raise TeethFailure("no_face_for_teeth", "No face was found to make the teeth from")
    if pa.yaw_offset(points) > pa.MAX_TOUCHUP_YAW:
        # The renderer places the teeth frontally; a turned "ee" photo would
        # give it a foreshortened arch.
        raise TeethFailure(
            "face_turned", "The head is turned too far to make teeth for it"
        )
    crop = pa.crop_face(image, pa.face_crop_box(points))
    return Request(pa._jpeg(crop, pa.CROP_QUALITY), "image/jpeg")


def fallback_request(data: bytes) -> Request | None:
    """The same photo as a head-and-shoulders crop, for one more try after
    a refusal; None when that crop would be the same picture. CPU work."""
    from app.services import imagegen, photo_adjust as pa

    image = pa._rgb(data)
    try:
        points = pa._detect(image)
    except Exception:
        return None
    if points is None:
        return None
    crop = pa.head_crop(image, points)
    if crop is None:
        return None
    return Request(pa._jpeg(crop, imagegen.SOURCE_QUALITY), "image/jpeg")


@dataclass
class AiTeeth:
    photo: bytes
    rig: dict
    model: str | None


async def _may_call(org_id: str) -> None:
    """The organization's switch and the monthly image limit, read again
    right before a provider call (a queued finish can wait minutes)."""
    from app.db import get_session_factory
    from app.services.consent import ai_switched_off
    from app.services.usage import check_image_limit

    if await ai_switched_off(org_id):
        raise TeethFailure(
            "third_party_ai_disabled",
            "Your organization turned off third-party AI, so nothing was sent",
            403,
        )
    try:
        async with get_session_factory()() as db:
            await check_image_limit(db, org_id)
    except AppError as exc:
        raise TeethFailure(exc.code, exc.detail, 429) from exc


async def _meter(org_id: str) -> None:
    from app.db import get_session_factory
    from app.services.usage import record_generation

    async with get_session_factory()() as db:
        await record_generation(db, org_id, "gemini", TEETH_CALL)


async def make_teeth(
    org_id: str, source: bytes, on_send: Callable[[], Awaitable[None]] | None = None
) -> AiTeeth:
    """An "ee" photo of the person in `source` (the avatar's final picture),
    made by the image model and admitted like an upload, or TeethFailure.

    The caller has checked consent: this only sends what it is given.
    `on_send` is awaited once, right before the first picture leaves, so
    the caller can record the consent that let it go whatever the answer
    (a refusal, an answer the teeth test rejects, an error), and not when
    nothing was sent at all (no face, the limit, AI switched off)."""
    from app.services import imagegen
    from app.services.jobs import run_cpu

    if not imagegen.configured():
        raise TeethFailure(
            "imagegen_unavailable", "AI editing is not configured on this server", 409
        )
    request = await run_cpu(face_request, source)
    tried_crop = False
    while True:
        await _may_call(org_id)
        if on_send is not None:
            await on_send()
            on_send = None
        try:
            generated = await imagegen.edit_image(TEETH_PROMPT, request.payload, request.mime)
        except imagegen.ImageGenRefused as exc:
            await _meter(org_id)  # answered, so billed
            if not tried_crop:
                tried_crop = True
                fallback = await run_cpu(fallback_request, source)
                if fallback is not None:
                    logger.info("teeth refused (%s); asking once more with the head crop",
                                exc.reason)
                    request = fallback
                    continue
            raise TeethFailure(
                "safety_refused", "The AI declined to edit this photo, so it was not asked again"
            ) from exc
        except imagegen.ImageGenNoImage as exc:
            await _meter(org_id)
            raise TeethFailure(
                "no_image", "The AI answered without an image, so it was not asked again"
            ) from exc
        except imagegen.ImageGenUnavailable as exc:
            raise TeethFailure(
                "imagegen_unavailable", "AI editing is not configured on this server", 409
            ) from exc
        except Exception as exc:
            logger.exception("teeth: the provider call failed")
            raise TeethFailure(
                "provider_error", "The AI service did not return an image", 502
            ) from exc
        break
    await _meter(org_id)
    try:
        photo, rig = await run_cpu(prepare_mouth_photo, generated.image)
    except Validation422 as exc:
        raise TeethFailure(exc.code, exc.detail) from exc
    return AiTeeth(photo, rig, generated.model)
