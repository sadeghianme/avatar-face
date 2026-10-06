"""The four-step creation wizard: Model, Photo, Prepare, Publish.

The owner's flow (2026-09-28, docs/avatar-lines.md "The creation flow"):

1. **Model**: a human avatar or an animal avatar.
2. **Photo**: "Generate with AI" (one description) or "Upload a photo",
   and a look: Realistic, Animation (a 3D animated-film version) or
   Cartoon (a flat 2D drawing).
3. **Prepare**, automatic: the background comes off, and the AI makes the
   picture in the chosen look, frontal, evenly lit, eyes open on the
   camera and the mouth closed: ready to speak. Retry, "describe a change",
   and for a realistic upload "use my original photo" (cut out, no AI).
4. **Publish**: the eyes, lips and head are found by themselves, the
   avatar talks in a preview, and Publish builds it (services.creations
   finish, with a person's own mouth kit, step 5 of the old flow, folded
   into it).

This module is the wizard's plan and its one job, "prepare". Everything
else (ingest, finish, consents, the step and revision rules) is
services.creations', unchanged: a creation made by the new wizard is an
ordinary creation whose `steps` also carry the `plan`.

**Model × look → line.** The three lines (human, animal, cartoon) and their
render profiles stay what they are; a plan picks one:

    human  + realistic  → human    photographic mouth, own teeth and mouth
                                   shapes at publish (the mouth kit)
    animal + realistic  → animal   muzzle mouth, no human teeth
    any    + animation  → cartoon  toon / classic mouth
    any    + cartoon    → cartoon

**Prepare.** One job, one write: the AI's picture is stored as
"adjusted:N" (the look's opaque answer, on the plain backdrop the prompt
asks for), its cut-out as "cutout:N" (the person segmenter for a person,
the backdrop keyer, services.backdrop, for anything; a picture neither can
cut is kept as it is), and the anchors found on it (MediaPipe, and for a
face MediaPipe cannot see, the vision model's points on the member's
consent). A realistic upload's "original" mode does the same with the
photo itself, framed on its face, and no AI. Nothing here decides for the
owner: the upload stays, and every result is a step they can go back from.

**Prompts.** Written once here, for every model and look: what the rig
needs (frontal, level, eyes open on the camera, mouth closed and relaxed,
even soft light, sharp eyes and lips, the head inside the frame) and a
plain flat backdrop the keyer can take off. The owner's words describe the
character; they are quoted, and cannot move the framing or the backdrop.
"""

from __future__ import annotations

import copy
import hashlib
import io
import logging
import re
from typing import Literal
from uuid import uuid4

from PIL import Image

from app.core.errors import AppError, Conflict409, Validation422
from app.services.jobs import Job, run_cpu, runner

logger = logging.getLogger("liveface.wizard")

MODELS = ("human", "animal")
LOOKS = ("realistic", "animation", "cartoon")
SOURCES = ("upload", "generate")
# Where the plan lives in a creation's `steps`.
PLAN = "plan"

# AI runs per creation on step 3 (prepare, retry, each change). Each is one
# paid image call, and the monthly image limit holds them all as well; a
# picture that needs more than this needs a new photo or a new description.
PREPARE_ROUNDS_PER_CREATION = 6
# "Remove this change" (the plain picture again) gives its try back: the
# owner is undoing something, not shopping for a result. It is still a paid
# image call, so it stays metered (the monthly image limit counts it) and
# only this many per creation are free; after that each one counts as a try.
FREE_CLEARS_PER_CREATION = 3
# How long a change or a description may be (the owner's words, quoted).
MAX_WORDS = 300

# Prepare modes (the job's `mode`): the AI in the plan's look from the
# upload; a change of the current AI picture; a new picture from the
# description (a generated creation's Retry); the photo itself, no AI.
AI = "ai"
CHANGE = "change"
GENERATE = "generate"
ORIGINAL = "original"
MODES = (AI, CHANGE, GENERATE, ORIGINAL)
# What a version keeps on its own step item: the anchors found on it, and
# the record of the try that made it (`ai.last_prepare`'s shape).
KEPT_ANCHORS = "anchors"
KEPT_RECORD = "prepare"


def line_for(model: str, look: str) -> Literal["human", "animal", "cartoon"]:
    """The line (face_type) a plan is rigged and rendered on."""
    if look == "realistic":
        return "animal" if model == "animal" else "human"
    return "cartoon"


# The generation style recorded on a step (services.creations' existing
# vocabulary, which the avatar's disclosure and older clients read).
STYLE_OF_LOOK = {"realistic": "photoreal", "animation": "render3d", "cartoon": "illustrated"}


def make_plan(model: str, look: str, source: str, description: str = "") -> dict:
    return {
        "model": model,
        "look": look,
        "source": source,
        "description": description.strip()[:MAX_WORDS] or None,
    }


def plan_of(steps: dict | None) -> dict | None:
    plan = (steps or {}).get(PLAN)
    return dict(plan) if isinstance(plan, dict) else None


def inferred_plan(face_type: str | None, generated: bool) -> dict:
    """The plan of a creation the old wizard started (no `plan`): read off
    its line, so the new wizard can carry it on."""
    model = "animal" if face_type == "animal" else "human"
    look = "cartoon" if face_type == "cartoon" else "realistic"
    return make_plan(model, look, GENERATE if generated else "upload")


# --- The default name --------------------------------------------------------------
#
# The name the wizard proposes is decided ONCE, when the creation is made,
# and kept in its `steps` beside the plan: every screen and the finish say
# the same, whatever tab or reload shows them. (It used to be worked out
# again by each screen from what the tab remembered of the file name, so a
# reload renamed the avatar.)

NAME = "name"
NAME_MAX = 40
# Words a camera or an app puts in a file name: they say nothing about who
# is in the picture, and a name made of them ("Animal realistic raw") is
# worse than the plan's own ("Animal avatar").
TECHNICAL_WORDS = frozenset(
    "img image dsc dscn dscf pxl mvimg photo picture pic screenshot screen shot capture "
    "scan scanned raw copy final export edit edited crop cropped resized untitled "
    "download downloaded received whatsapp signal telegram file new tmp temp test "
    "sample".split()
)
_ARTICLE = re.compile(r"^(a|an|the|un|une|le|la|les|des|l')\s+", re.IGNORECASE)
_SEPARATORS = re.compile(r"[\s_\-.]+")


def _as_name(text: str) -> str:
    """At most NAME_MAX characters, cut at a word boundary when one is near,
    the first letter up."""
    if len(text) > NAME_MAX:
        head = text[: NAME_MAX + 1]
        space = head.rfind(" ")
        text = (head[:space] if space > NAME_MAX / 2 else text[:NAME_MAX]).strip()
    return text[:1].upper() + text[1:]


def technical_file_name(stem: str) -> bool:
    """Is this file name (its extension off) a camera's or an app's rather
    than someone's words? Yes for one of TECHNICAL_WORDS or a digit anywhere
    in it ("IMG_1234", "animal-realistic.raw", "Screenshot 2026-10-05"), for
    a slug (separators and digits are a third or more of it: "a-b-c"), and
    for fewer than two letters ("p", "")."""
    words = [w for w in _SEPARATORS.split(stem) if w]
    if sum(c.isalpha() for c in stem) < 2:
        return True
    if any(w.lower() in TECHNICAL_WORDS or any(c.isdigit() for c in w) for w in words):
        return True
    heavy = sum(1 for c in stem if c in "_-." or c.isdigit())
    return heavy * 3 >= len(stem)


def default_name(*, file_name: str | None = None, description: str | None = None) -> str | None:
    """A first name for the avatar, from what the owner gave (renamed on its
    page in one click): the description's own words ("a cheerful baker with
    flour on her apron" → "Cheerful baker with flour on her apron"), or a
    file name that means something ("maria_headshot.jpg" → "Maria headshot").
    None when neither does (no description; a technical file name): the
    dashboard then names it after the plan ("Human avatar", "Avatar animal")
    in the member's language, which the server does not know."""
    words = _ARTICLE.sub("", re.sub(r"\s+", " ", description or "").strip())
    words = words.rstrip(".,;:!?").strip()
    if words:
        return _as_name(words)
    stem = re.sub(r"\.[^.]+$", "", (file_name or "").strip()).strip()
    if stem and not technical_file_name(stem):
        return _as_name(re.sub(r"\s+", " ", _SEPARATORS.sub(" ", stem)).strip())
    return None


def name_of(steps: dict | None) -> str | None:
    """The name kept with the creation, or None (the plan's default)."""
    name = (steps or {}).get(NAME)
    return name.strip() if isinstance(name, str) and name.strip() else None


# --- Prompts -----------------------------------------------------------------------

# The plain backdrop every picture is made on, for the keyer: flat grey, or
# a soft blue when the subject is itself grey or white (a grey jacket on a
# grey backdrop cannot be told apart by colour).
BACKDROP = (
    "Backdrop: a perfectly plain, flat, uniform mid-grey studio backdrop (#808080) edge to "
    "edge, with no gradient, no vignette, no texture, no floor, no horizon and no shadow "
    "cast on it. If the subject's hair, fur or clothing is grey, silver or white, use a "
    "flat, uniform soft blue backdrop (#8FB3D9) instead. Nothing else in the scene."
)

FRAMING = {
    "human": (
        "Composition: a single subject, a front-facing head-and-shoulders portrait, the face "
        "square to the camera, the head upright and level (no tilt, no turn), centred "
        "horizontally, with clear space above the hair and the shoulders cut by the bottom "
        "edge; the face fills about 45% of the image width. "
        "Face: both eyes fully open and looking straight into the camera, clearly visible "
        "and unobstructed (no hair across the eyes, no sunglasses, no glare on glasses), "
        "the mouth closed with the lips relaxed and gently together, a calm, friendly, "
        "neutral expression, no teeth showing."
    ),
    "animal": (
        "Composition: a single animal, its head and upper chest facing the camera "
        "directly, the muzzle pointing straight at the viewer, the head upright and "
        "level, centred horizontally, with both ears and all the fur inside the frame and "
        "clear space around them; the head fills about half the image width. No full body. "
        "Face: both eyes open, clearly visible and looking into the camera, the mouth "
        "closed and relaxed (no tongue out, no teeth or fangs showing), a calm, friendly "
        "expression."
    ),
}

LIGHT = (
    "Lighting: soft, even, frontal studio light (a large soft key light and a gentle fill), "
    "no harsh or coloured light, no deep shadows across the face. "
    "Detail: sharp focus on the eyes and the mouth, clean crisp edges around the hair, "
    "fur and silhouette."
)

AVOID = (
    "Do not include: text, letters, logos, watermarks, borders or frames, hands, "
    "microphones, props or anything in front of the face, other people or animals."
)

LOOK_WORDS = {
    ("human", "realistic"): (
        "Style: a photorealistic professional studio headshot photograph, natural skin "
        "texture, true-to-life colours, shot on an 85 mm portrait lens at f/8 so the whole "
        "head is in focus. Not an illustration, not a 3D render."
    ),
    ("animal", "realistic"): (
        "Style: a photorealistic professional studio pet portrait photograph, natural fur "
        "texture, true-to-life colours, shot on an 85 mm lens at f/8 so the whole head is "
        "in focus. A real animal, not a person in costume, not an illustration."
    ),
    ("human", "animation"): (
        "Style: a high-end 3D animated feature film character in the manner of modern "
        "Pixar and Disney animation: appealing stylised proportions, slightly larger "
        "expressive eyes, smooth softly subsurface-scattered skin, soft global "
        "illumination, a clean cinematic render. Clearly a 3D rendered character, not a "
        "photograph."
    ),
    ("animal", "animation"): (
        "Style: a high-end 3D animated feature film animal character in the manner of "
        "modern Pixar and Disney animation: appealing stylised proportions, large "
        "expressive eyes, soft groomed fur, soft global illumination, a clean cinematic "
        "render. Clearly a 3D rendered character, not a photograph."
    ),
    ("human", "cartoon"): (
        "Style: a flat 2D cartoon illustration: bold, clean dark outlines of even weight, "
        "flat areas of solid colour with at most one simple cel-shadow tone, simplified "
        "shapes, clearly drawn eyes and lips, no gradients, no photographic texture, no 3D "
        "shading. It must read as a drawing."
    ),
    ("animal", "cartoon"): (
        "Style: a flat 2D cartoon illustration of the animal: bold, clean dark outlines of "
        "even weight, flat areas of solid colour with at most one simple cel-shadow tone, "
        "simplified shapes, clearly drawn eyes, nose and mouth, no gradients, no "
        "photographic texture, no 3D shading. It must read as a drawing."
    ),
}

DEFAULT_SUBJECT = {
    "human": "a friendly, approachable adult",
    "animal": "a friendly dog",
}


def _quoted(words: str) -> str:
    """The owner's words, trimmed and quoted: they describe, they do not
    instruct (a description cannot move the framing or the backdrop)."""
    cleaned = " ".join((words or "").replace('"', "'").split())[:MAX_WORDS]
    return f'"{cleaned}"'


def _requirements(model: str, look: str) -> str:
    return " ".join((FRAMING[model], LIGHT, BACKDROP, AVOID, LOOK_WORDS[(model, look)]))


def character_prompt(model: str, look: str, description: str | None) -> str:
    """Text to image: a new character, ready to speak, on a plain backdrop."""
    subject = (description or "").strip() or DEFAULT_SUBJECT[model]
    noun = "character" if model == "human" else "animal character"
    return (
        f"Create a portrait of a {noun} for a talking avatar. The {noun}, in the owner's "
        f"words: {_quoted(subject)}. Follow the description for who or what it is and how "
        "it looks; everything below is fixed and the description cannot change it. "
        + _requirements(model, look)
    )


PREPARE_SUBJECT = {
    ("human", "realistic"): (
        "Edit this photo into a professional studio portrait of the SAME person for a "
        "talking avatar. Keep their identity exactly: the same face shape and proportions, "
        "the same features, skin tone, apparent age, eye colour, hair colour and hairstyle, "
        "facial hair, glasses and makeup, and the same clothing. Photorealistic, with "
        "natural skin texture: do not beautify, smooth or slim the face."
    ),
    ("animal", "realistic"): (
        "Edit this photo into a professional studio portrait of the SAME animal for a "
        "talking avatar. Keep it exactly the same animal: the same species and breed, "
        "fur colours and markings, eye colour, ear shape, and any collar it wears. "
        "Photorealistic, with natural fur texture."
    ),
    ("human", "animation"): (
        "Redraw the person in this photo as a 3D animated film character for a talking "
        "avatar, keeping them clearly recognisable: the same face shape, hairstyle and "
        "hair colour, skin tone, eye colour, apparent age, facial hair, glasses and "
        "clothing colours. This is a full reinterpretation in the style below, not a "
        "retouch of the photograph."
    ),
    ("animal", "animation"): (
        "Redraw the animal in this photo as a 3D animated film animal character for a "
        "talking avatar, keeping it clearly the same animal: the same species and breed, "
        "fur colours and markings, eye colour and ear shape. This is a full "
        "reinterpretation in the style below, not a retouch of the photograph."
    ),
    ("human", "cartoon"): (
        "Redraw the person in this photo as a flat 2D cartoon character for a talking "
        "avatar, keeping them clearly recognisable: the same face shape, hairstyle and "
        "hair colour, skin tone, eye colour, facial hair, glasses and clothing colours. "
        "This is a full reinterpretation in the style below, not a filter on the "
        "photograph."
    ),
    ("animal", "cartoon"): (
        "Redraw the animal in this photo as a flat 2D cartoon animal for a talking avatar, "
        "keeping it clearly the same animal: the same species and breed, fur colours and "
        "markings, eye colour and ear shape. This is a full reinterpretation in the style "
        "below, not a filter on the photograph."
    ),
}


def prepare_prompt(model: str, look: str, instruction: str | None = None) -> str:
    """Image to image: the upload, in the plan's look, ready to speak."""
    extra = ""
    if instruction and instruction.strip():
        extra = (
            f" The owner also asks for this change, in their words: {_quoted(instruction)}. "
            "Apply it without changing anything that follows."
        )
    return f"{PREPARE_SUBJECT[(model, look)]}{extra} " + _requirements(model, look)


def change_prompt(model: str, look: str, instruction: str) -> str:
    """Image to image: one change to the avatar picture made already."""
    return (
        "Edit this avatar portrait. Apply only this change, in the owner's words: "
        f"{_quoted(instruction)}. Keep everything else exactly as it is: the same "
        f"{'person' if model == 'human' else 'animal'} and identity, the same style, "
        "pose, framing and lighting, both eyes open looking into the camera, the mouth "
        "closed and relaxed. " + _requirements(model, look)
    )


# --- The prepare job ----------------------------------------------------------------


def _png(data: bytes) -> tuple[bytes, int, int]:
    """An answer as the creation stores images: upright PNG, no metadata,
    long edge at most photo_io.STORED_MAX_EDGE."""
    from PIL import Image

    from app.services.photo_io import STORED_MAX_EDGE, ingest_photo

    clean = ingest_photo(data, STORED_MAX_EDGE)
    with Image.open(io.BytesIO(clean)) as image:
        return clean, image.width, image.height


def cut_out(png: bytes, face_type: str) -> bytes | None:
    """The subject of `png` on transparency, or None when it cannot be cut
    cleanly (the picture is then kept as it is). A person goes through the
    person segmenter when this server has one; everything, and a person the
    segmenter cannot take, through the backdrop keyer. CPU work."""
    from app.services import backdrop, segment

    if face_type == "human":
        try:
            return segment.remove_background(png)
        except segment.SegmentationUnavailable:
            pass
        except Exception:
            logger.exception("segmenting a prepared picture failed; keying its backdrop")
    try:
        return backdrop.cut_backdrop(png)
    except Exception:
        logger.exception("keying a prepared picture's backdrop failed")
        return None


async def settle(
    job: Job,
    creation,
    steps: dict,
    opaque_id: str,
    png: bytes,
    consent_id: str | None,
    new_keys: list[str],
) -> tuple[dict, bool]:
    """Cut out the opaque step `opaque_id` (already in `steps`, its bytes
    `png`), make the cut-out current, and find the face on it.

    Returns (anchors, cut). `steps` is edited in place; every key written
    is added to `new_keys` (deleted if the result is discarded).
    """
    from app.services import creations as svc
    from app.services.storage import get_storage

    face_type = creation.face_type
    storage = get_storage()
    items = steps["items"]
    job.report(0.72, "removing the background")
    cut = await run_cpu(cut_out, png, face_type)
    current = opaque_id
    if cut is not None:
        cut_id = svc.cutout_id_for(opaque_id)
        key = svc.step_key(job.org_id, job.subject_id, cut_id.replace(":", ""))
        await storage.put_bytes(key, cut, "image/png")
        new_keys.append(key)
        item = items[opaque_id]
        items[cut_id] = {
            "key": key, "width": item["width"], "height": item["height"], "from": opaque_id,
            "cutout": True,
        }
        current = cut_id
        steps["background"] = "remove"
    else:
        steps["background"] = "keep"
    steps["current"] = current

    job.report(0.85, "finding the face")
    shown = cut if cut is not None else png
    found = await run_cpu(svc.detect_anchors, shown, face_type)
    source = "mediapipe" if found["detected"] else "template"
    if consent_id and svc.wants_ai_points(face_type, found["detected"]):
        digest = await run_cpu(lambda: hashlib.sha256(shown).hexdigest())
        ai, warning = await svc._ai_points(
            job, {"sha256": digest, "charged": False}, shown, face_type,
            tuple(found["image_size"]),
        )
        if ai is not None:
            found, source = ai, "ai"
        elif warning is not None:
            found["validation"]["warnings"].append(warning)
    anchors = {
        "id": uuid4().hex,
        "frame": svc.frame_key(steps, current),
        "face_type": face_type,
        "source": source,
        **found,
    }
    # Kept with the version too: going back to it later (POST /version)
    # opens these points again rather than finding them anew.
    items[opaque_id][KEPT_ANCHORS] = copy.deepcopy(anchors)
    return anchors, cut is not None


def _refund(usage: dict) -> None:
    usage["prepare_rounds"] = max(0, int(usage.get("prepare_rounds") or 0) - 1)


def _refund_free(usage: dict) -> None:
    usage["free_clears"] = max(0, int(usage.get("free_clears") or 0) - 1)


def head_crop_source(data: bytes) -> tuple[bytes, str] | None:
    """The head-and-shoulders crop of the picture about its face, as it may
    be sent to the model (opaque, shrunk, JPEG), or None when there is no
    face to crop around or the crop is the whole picture. CPU work.

    Measured against the real model (2026-09-25 and again 2026-10-03): a
    whole-frame portrait is declined at the prompt (promptFeedback OTHER)
    and the same face cropped to 2.2 face widths is edited under the same
    prompt. So a declined edit is asked once more on this: a different
    input, never the same request repeated (photo_adjust.head_crop)."""
    from app.services import imagegen, landmarks, photo_adjust
    from app.services.photo_io import on_backdrop

    image = on_backdrop(Image.open(io.BytesIO(data)))
    try:
        points = photo_adjust._detect(image)
    except landmarks.LandmarkerUnavailable:
        return None
    if points is None:
        return None
    crop = photo_adjust.head_crop(image, points)
    if crop is None:
        return None
    return photo_adjust._jpeg(crop, imagegen.SOURCE_QUALITY), "image/jpeg"


async def _ask_ai(
    job: Job, prompt: str, source: bytes | None, mode: str
) -> tuple[bytes, str]:
    """The call to the image model, metered as it is answered. Raises the
    wizard's own errors: safety_refused (never asked a third time), no_image,
    imagegen_unavailable, provider_error, third_party_ai_disabled, and the
    monthly limit.

    An edit the model declines (an upload, a change) is asked ONCE more on
    the picture's head-and-shoulders crop when it has one that differs from
    the whole picture (head_crop_source); every answered call, the refusal
    included, is metered, and the switch and the monthly limit are read
    again before the second. A character made from words has no picture to
    crop and is asked once."""
    from app.db import get_session_factory
    from app.services import creations as svc
    from app.services import imagegen
    from app.services.usage import check_image_limit, record_generation

    session = get_session_factory()
    sends: list[tuple[bytes, str] | None]
    if source is None:
        sends = [None]
    else:
        sends = [await run_cpu(svc.source_on_backdrop, source)]
    tried_crop = source is None
    refusal: imagegen.ImageGenRefused | None = None
    index = 0
    while index < len(sends):
        if await svc._ai_switched_off(job.org_id):
            raise svc._ai_disabled_error()
        async with session() as db:
            await check_image_limit(db, job.org_id)
        send = sends[index]
        index += 1
        try:
            # The wait on Google (tens of seconds) is not work on this box:
            # the running slot goes back for it, so other people's uploads
            # are not held at "waiting for a free worker" behind it.
            async with runner.outside_slot(job):
                if send is not None:
                    answer = await imagegen.edit_image(prompt, send[0], send[1])
                else:
                    answer = await imagegen.create_image(prompt)
        except imagegen.ImageGenRefused as exc:
            async with session() as db:
                await record_generation(db, job.org_id, "gemini", mode)
            refusal = exc
            if not tried_crop:
                tried_crop = True
                crop = await run_cpu(head_crop_source, source)
                if crop is not None:
                    logger.info(
                        "prepare %s refused (%s); asking once more on the head crop",
                        job.id, exc.reason,
                    )
                    sends.append(crop)
            continue
        except imagegen.ImageGenNoImage as exc:
            async with session() as db:
                await record_generation(db, job.org_id, "gemini", mode)
            raise AppError(
                "The AI answered without a picture; try again", code="no_image"
            ) from exc
        except imagegen.ImageGenUnavailable as exc:
            raise Conflict409(
                "AI image making is not configured on this server", code="imagegen_unavailable"
            ) from exc
        except AppError:
            raise
        except Exception as exc:
            logger.exception("prepare %s: the provider call failed", job.id)
            raise AppError(
                "The AI service did not return a picture; try again", code="provider_error"
            ) from exc
        async with session() as db:
            await record_generation(db, job.org_id, "gemini", mode)
        return answer.image, answer.model
    if source is None:
        detail = "The AI declined to make this character; change the description"
    else:
        detail = "The AI declined to edit this photo; try another photo or change"
    raise Validation422(detail, code="safety_refused") from refusal


async def prepare_job(job: Job, params: dict) -> None:
    """Step 3: make the picture the avatar is built from (see the module
    docstring), cut it out and find its face, in one write."""
    from app.services import creations as svc
    from app.services.storage import get_storage

    creation = await svc._load(job)
    if creation is None:
        return
    mode = params["mode"]
    plan = plan_of(creation.steps) or inferred_plan(creation.face_type, False)
    model, look = plan["model"], plan["look"]
    items = svc.step_items(creation.steps)
    original = items.get("original")
    if original is None or creation.face_type is None:
        await svc._write_job(job, svc.FAILED, params, svc.SUPERSEDED)
        return
    storage = get_storage()
    steps = svc.copied(creation.steps)
    new_keys: list[str] = []
    old_keys: list[str] = []
    consent_id = params.get("consent_id")

    if mode == ORIGINAL:
        # The photo itself, framed on its face when the check found one,
        # cut out: no AI. Replaces an earlier framing and its cut-out.
        from app.services.photo_analysis import check_photo
        from app.services.photo_io import frame_photo, png_bytes

        job.report(0.1, "preparing the photo")
        # The photo's own framing and cut-out, from an earlier "use my
        # original photo": made again (AI results made since stay).
        old_keys.extend(svc._remove_steps(steps, {"framed", svc.CUTOUT}))
        data = await storage.get_bytes(original["key"])
        framing = (creation.analysis or {}).get("suggested_framing")
        opaque_id, png = "original", data
        if framing:
            def frame() -> tuple[bytes, tuple[int, int], dict]:
                image = frame_photo(data, framing["crop"], framing.get("roll") or 0.0)
                return png_bytes(image), image.size, svc.step_check(check_photo(image))

            png, (width, height), check = await run_cpu(frame)
            key = svc.step_key(job.org_id, job.subject_id, "framed")
            await storage.put_bytes(key, png, "image/png")
            new_keys.append(key)
            steps["items"]["framed"] = {
                "key": key, "width": width, "height": height, "from": "original",
                "crop": framing["crop"], "roll": framing.get("roll") or 0.0, "check": check,
            }
            opaque_id = "framed"
        record = {"mode": ORIGINAL, "look": look, "instruction": None, "step": opaque_id}
    else:
        from app.services.photo_analysis import check_png

        instruction = (params.get("instruction") or "").strip() or None
        if mode == GENERATE:
            source, prompt = None, character_prompt(model, look, plan.get("description"))
            base_id = "original"
            call = "generate"
        elif mode == CHANGE:
            base_id = svc._through_cutouts(creation.steps, svc.current_step(creation.steps))
            if params.get("again"):
                # Retry of the last change: from what that try started from,
                # so the change is not applied on top of its own result.
                last = (svc.ai_usage_of(creation).get("last_prepare") or {}).get("step")
                tried = items.get(last) if last is not None else None
                base_id = (tried or {}).get("from") or base_id
            if base_id is None or base_id not in items:
                base_id = "original"
            source = await storage.get_bytes(items[base_id]["key"])
            made = svc.adjusted_index(base_id) is not None or bool(
                items[base_id].get("generated")
            )
            prompt = (
                change_prompt(model, look, instruction or "")
                if made else prepare_prompt(model, look, instruction)
            )
            call = "prepare"
        else:
            base_id = "original"
            source = await storage.get_bytes(original["key"])
            prompt = prepare_prompt(model, look, instruction)
            call = "prepare"

        job.report(0.15, "creating your avatar")
        try:
            answer, made_by = await _ask_ai(job, prompt, source, call)
        except AppError as exc:
            if exc.code in (
                "imagegen_unavailable", "third_party_ai_disabled", "image_limit_reached",
                "provider_error",
            ):
                # Nothing was sent, or nothing answered: the try is given back.
                # (A refusal or an answer without a picture was billed.)
                give_back = _refund_free if params.get("free") else _refund
                await svc._update_ai_usage(job, give_back)
            raise
        job.report(0.6, "checking the picture")
        png, width, height = await run_cpu(_png, answer)
        check = svc.step_check(await run_cpu(check_png, png))
        usage = svc.ai_usage_of(creation)
        number = usage["next_adjusted"]
        opaque_id = f"{svc.ADJUSTED_PREFIX}{number}"
        key = svc.step_key(job.org_id, job.subject_id, f"adjusted{number}")
        await storage.put_bytes(key, png, "image/png")
        new_keys.append(key)
        steps["items"][opaque_id] = {
            "key": key, "width": width, "height": height, "from": base_id, "cutout": False,
            "check": check,
            "adjust": {
                "mode": "generate" if mode == GENERATE else (
                    "regenerate" if look == "realistic" else "stylise"
                ),
                "style": STYLE_OF_LOOK[look],
                "model": made_by,
                "generated_eyes": False,
                "rejected": None,
                "checks": {},
                "look": look,
                "instruction": instruction,
            },
        }

        def advance(u: dict) -> None:
            u["next_adjusted"] = max(int(u.get("next_adjusted") or 0), number + 1)

        await svc._update_ai_usage(job, advance)
        record = {"mode": mode, "look": look, "instruction": instruction, "step": opaque_id}

    anchors, cut = await settle(job, creation, steps, opaque_id, png, consent_id, new_keys)
    record["cut"] = cut
    steps["items"][opaque_id][KEPT_RECORD] = dict(record)

    def remember(u: dict) -> None:
        u["last_prepare"] = record

    job.report(0.95, "saving")
    await svc._update_ai_usage(job, remember)
    if await svc._store_result(job, params, {"steps": steps, "anchors": anchors}, new_keys):
        for key in old_keys:
            await storage.delete(key)


# --- Versions ----------------------------------------------------------------------
#
# Every try on step 3 is kept: the upload (a realistic one, framed and cut
# out by "use my original photo") and each AI result, with the cut-out made
# of it. The owner may go back to any of them (POST /version): the newest
# is not better for being newest.


def version_of(steps: dict | None, step_id: str | None) -> str | None:
    """The version the image `step_id` belongs to: "original" for the
    upload, its framing and their cut-out; "adjusted:N" for an AI result
    and its cut-out."""
    from app.services import creations as svc

    source = svc._through_cutouts(steps, step_id)
    return "original" if source == "framed" else source


def use_version(steps: dict | None, version: str, plan: dict) -> tuple[dict, dict | None, dict]:
    """The steps with `version` current (its cut-out when it has one), the
    anchors kept with it (None when it has none: they are found again), and
    the record of the try that made it, for `ai.last_prepare`, so Retry and
    "describe a change" carry on from the version chosen.

    Raises: unknown_version, candidate_rejected, original_not_for_look (the
    upload of a stylised plan is not a picture the avatar is made of),
    version_not_prepared (an upload never framed and cut out: "use my
    original photo" makes it).
    """
    from app.services import creations as svc

    items = svc.step_items(steps)
    if version not in items or version_of(steps, version) != version:
        raise Validation422("There is no such version", code="unknown_version")
    item = items[version]
    adjust = item.get("adjust") or {}
    if adjust.get("rejected"):
        raise Validation422(
            "This result failed its checks and cannot be used", code="candidate_rejected"
        )
    opaque = version
    if version == "original" and plan["source"] == "upload":
        if plan["look"] != "realistic":
            raise Validation422(
                "Your own photo is used as it is only for a realistic avatar",
                code="original_not_for_look",
            )
        opaque = "framed" if "framed" in items else "original"
        prepared = (
            "framed" in items
            or (items.get(svc.CUTOUT) or {}).get("from") == "original"
            or KEPT_RECORD in item
        )
        if not prepared:
            raise Conflict409("Your photo has not been prepared yet", code="version_not_prepared")
    out = svc.copied(steps)
    cut = svc.cutout_id_for(opaque)
    if cut in items and items[cut].get("from") == opaque:
        out["current"], out["background"] = cut, "remove"
    else:
        out["current"], out["background"] = opaque, "keep"
    record = dict(items[opaque].get(KEPT_RECORD) or {})
    if not record:
        # A version made before records were kept: read off the step.
        if version == "original":
            mode = GENERATE if plan["source"] == GENERATE else ORIGINAL
        elif adjust.get("mode") == GENERATE:
            mode = GENERATE
        else:
            mode = CHANGE if adjust.get("instruction") else AI
        record = {
            "mode": mode,
            "look": adjust.get("look") or plan["look"],
            "instruction": adjust.get("instruction"),
            "step": opaque,
        }
    record["cut"] = out["current"] != opaque
    kept = items[opaque].get(KEPT_ANCHORS)
    return out, copy.deepcopy(kept) if kept else None, record
