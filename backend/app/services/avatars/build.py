"""Building an avatar: the background job that turns its stored picture (or
GLB) into a rig, a thumbnail, the fit base and the layers, and publishes a
first build that needs no one to look at it. And, at startup, the builds a
restart cut short.

What a rig IS, and the CPU work of making one, is services.rig; this is the
job around it, which reads and writes the row and storage.
"""

from __future__ import annotations

import json
import logging
from uuid import uuid4

from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.errors import Validation422
from app.db import get_session_factory
from app.models import Avatar, AvatarKind, AvatarStatus
from app.services import photo_io
from app.services import rig as rigging
from app.services.anchor_fit import fit_base_key, fit_base_record, write_fit_base
from app.services.avatars import kits
from app.services.jobs import run_cpu
from app.services.layers import store_layers
from app.services.model3d import build_model_rig, make_model_thumbnail
from app.services.photo_io import ingest_photo
from app.services.publishing import publish as publish_snapshot
from app.services.riggable import check_landmarks
from app.services.storage import STORAGE_ERRORS, Storage, get_storage

logger = logging.getLogger("liveface.rig")


async def _ingest_upload(avatar: Avatar, storage: Storage, db, data: bytes) -> bytes:
    """Replace a first build's upload with its clean, upright PNG.

    The presigned upload path stores whatever the browser sent — EXIF, GPS
    and all — under the extension the client declared. The clean copy goes
    to a key of its own, never the upload's: the presigned URL stays valid
    for an hour, and a second PUT through it must land beside the live image,
    not replace it with raw bytes nothing would ever clean again.

    The switch is committed before the raw object is deleted, so a restart
    at any point leaves the row naming a file that exists, and Retry can
    rebuild from it.
    """
    # Seconds of decoding and PNG encoding for a phone photo; on the event
    # loop, every embed on every customer's site would wait for it.
    clean = await run_cpu(ingest_photo, data, photo_io.STORED_MAX_EDGE)
    upload_key = avatar.image_key
    assert upload_key is not None  # process_avatar builds only an avatar with its photo
    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-{uuid4().hex[:8]}.png"
    await storage.put_bytes(key, clean, "image/png")
    avatar.image_key = key
    avatar.content_type = "image/png"
    await db.commit()
    await storage.delete(upload_key)
    return clean


async def process_avatar(avatar_id: str) -> None:
    """Background job: image -> landmarks -> rig JSON + thumbnail -> storage.

    Runs as a request's background task, on the event loop; every CPU step
    (decode, detection, triangulation, thumbnail, layers) is handed to the
    shared CPU thread (services.jobs.run_cpu), so building one avatar never
    stalls the widgets this process serves.
    """
    factory = get_session_factory()
    storage = get_storage()

    async with factory() as db:
        avatar = (
            await db.execute(select(Avatar).where(Avatar.id == avatar_id))
        ).scalar_one_or_none()
        if avatar is None or avatar.image_key is None:
            return
        avatar.status = AvatarStatus.processing
        await db.commit()

        try:
            # Set before the branch: only the photo path computes one, and a
            # 3D avatar reaching the assignment below would raise.
            quality_note: str | None = None
            # Whether a first build may go live without its owner looking at
            # it. A GLB carries its own rig; a photo only when a human face
            # was actually detected and passed every check — a guessed mesh
            # published unseen is a mouth moving on a customer's site in the
            # wrong place.
            confident = avatar.kind == AvatarKind.model3d

            image_bytes = await storage.get_bytes(avatar.image_key)
            if avatar.kind == AvatarKind.model3d:
                rig = await run_cpu(build_model_rig, image_bytes)
                thumb, thumb_type = await run_cpu(make_model_thumbnail), "image/jpeg"
            else:
                if avatar.rig_key is None:
                    image_bytes = await _ingest_upload(avatar, storage, db, image_bytes)
                points, blendshapes, size, detected = await run_cpu(
                    rigging.landmarks_from_image, image_bytes
                )
                points = await run_cpu(
                    rigging.starting_mesh, points, size, detected, avatar.face_type
                )

                # An undetected face is NOT a failure: the fallback mesh (the
                # face template, or the synthetic mesh for a human) is a
                # complete 478-point rig, iris ring included, which is
                # exactly what the manual marking panel needs as a starting
                # point. Failing here used to dead-
                # end stylised art, mascots and animal faces that Mark the
                # face can rescue in a minute. The note tells the user the
                # mouth is a guess until they place it.
                animal = avatar.face_type == "animal"
                if get_settings().rig_model_path and not detected:
                    quality_note = (
                        "The muzzle could not be located automatically — no "
                        "detector is trained on animal faces. Open “Mark the "
                        "face” and place the head, eyes and mouth by hand."
                        if animal
                        else "No face was detected in this image, so the animation "
                        "points are a guess. Open “Mark the face” and place "
                        "the head, eyes, mouth and pupils by hand."
                    )
                elif animal:
                    # The riggable checks measure HUMAN proportions — face
                    # fraction, nose-offset frontality. A muzzle fails them
                    # for being a muzzle, and warning about that would be
                    # noise the user can do nothing with.
                    quality_note = None
                else:
                    verdict = check_landmarks(points, size, detected)
                    # Geometry problems are a warning, not a failure: the
                    # avatar works, it just will not look its best, and the
                    # thresholds are heuristics that should not veto a
                    # picture the user chose.
                    quality_note = None if verdict.ok else verdict.reason
                    confident = avatar.face_type == "human" and detected and verdict.ok

                rig = await run_cpu(
                    rigging.build_rig, points, size, blendshapes, face_type=avatar.face_type
                )
                await carry_crop_origin(avatar, storage, rig)
                thumb, thumb_type = await run_cpu(rigging.make_thumbnail, image_bytes)
                # What every later fit starts from (services.anchor_fit),
                # beside the rig and never in it: rig.json is published.

                await write_fit_base(
                    storage,
                    fit_base_key(avatar.org_id, avatar.id),
                    fit_base_record(rigging.fit_base_mesh(points, size, detected), rig, detected),
                )

            rig_key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/rig.json"
            thumb_key = rigging.write_thumbnail_key(avatar.org_id, avatar.id, thumb_type)
            await storage.put_bytes(rig_key, json.dumps(rig).encode(), "application/json")
            if avatar.kind != AvatarKind.model3d:
                # Re-detecting the same picture (Re-detect, a retry) moves
                # the rig's points: the mouth kit's rest pose follows them,
                # with no AI call. Under the avatar's edit lock, on the row
                # as it is now, and committed on its own: this row was read
                # before the detection and is written back after the layers,
                # and a mouth edit in between must not be undone by it
                # (services.mouth_kit.follow_redetection).

                await kits.follow_redetection(avatar.org_id, avatar.id, rig["points"])
            await storage.put_bytes(thumb_key, thumb, thumb_type)

            avatar.rig_key = rig_key
            avatar.thumbnail_key = thumb_key
            avatar.status = AvatarStatus.ready
            avatar.error = None
            avatar.quality_note = quality_note

            # Layer decomposition, photo avatars only. Optional by contract:
            # a failure (no segmenter, odd geometry) leaves a working
            # single-photo avatar.
            avatar.has_layers = False
            if avatar.kind != AvatarKind.model3d and rig.get("face_box"):
                avatar.has_layers = await store_layers(
                    avatar, storage, image_bytes, rig["face_box"]
                )
            # A confident brand-new avatar publishes itself, so creating one
            # and pasting the snippet works immediately. Only the FIRST build:
            # re-running the pipeline on an existing avatar (retry, re-detect)
            # is an edit, and edits wait for Publish like every other change.
            # Anything less than confident waits for its owner to check the
            # points and publish; embed and share answer 404 until then.
            #
            # The note keeps only the reason. "Not live yet — check the points,
            # then publish" is said by the dashboard's Publish bar, translated,
            # from `published`; repeating it here in English said it twice.
            if not avatar.published_config and confident:
                try:
                    await publish_snapshot(avatar, storage)
                except Exception:
                    # Broad on purpose: the avatar is built either way; its
                    # owner publishes it by hand when this failed.
                    logger.exception("first publish failed for avatar %s", avatar.id)
        except (rigging.NoFaceDetected, Validation422) as exc:
            # Expected, and the user can act on it — no stack trace.
            logger.info("avatar %s rejected: %s", avatar_id, exc)
            avatar.status = AvatarStatus.failed
            avatar.error = str(exc)
        except Exception as exc:
            # Broad on purpose: the background job's boundary; the avatar
            # says it failed, and why.
            logger.exception("rig pipeline failed for avatar %s", avatar_id)
            avatar.status = AvatarStatus.failed
            avatar.error = str(exc)[:1000]
        await db.commit()


async def carry_crop_origin(avatar: Avatar, storage: Storage, rig: dict) -> None:
    """Keep the crop origin across a re-detection.

    Re-detecting a cropped photo yields points in the same cropped
    coordinates as before, so where that crop sits in the uncropped photo is
    unchanged — and crop reset needs it to put the rig back exactly.
    """
    if not avatar.rig_key:
        return
    try:
        previous = json.loads(await storage.get_bytes(avatar.rig_key))
    except STORAGE_ERRORS:
        return  # nothing readable to carry; crop reset falls back
    if previous.get("crop_origin"):
        rig["crop_origin"] = previous["crop_origin"]


# Shown on an avatar whose job a restart cut short. The retry endpoint (the
# button beside this message) re-runs it from the stored image.
INTERRUPTED_ERROR = "Processing was interrupted by a server restart. Press Retry to run it again."


async def fail_interrupted(db) -> int:
    """Mark avatars left `processing` by a previous process as failed.

    The job ran in a background task of a process that no longer exists, so
    nothing will ever finish it, and the dashboard would poll a spinner
    forever. Failed with a retryable message is the honest state. Anything
    already published keeps being served meanwhile (embed and share read the
    published snapshot, not the draft's status).
    """
    result = await db.execute(
        update(Avatar)
        .where(Avatar.status == AvatarStatus.processing)
        .values(status=AvatarStatus.failed, error=INTERRUPTED_ERROR)
    )
    await db.commit()
    return result.rowcount or 0
