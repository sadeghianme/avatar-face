"""The creation wizard's work: images, analysis, marks, jobs and finishing.

A creation (app.models.creation) is one photo's way to an avatar, in the
owner's order (docs/avatar-lines.md, "The creation flow"):

    ingest   → [frame] → [background] → [AI adjust]  → detect → finish
    generate
    original    framed     cutout         adjusted:N     anchors   avatar, published
                                          (→ cutout:N)

Each image the wizard makes is a new STEP with its own storage key; nothing
overwrites the upload, and clients name steps by id ("original", "framed",
"cutout", "adjusted:0", "cutout:0"), never by key. AI adjust works on the
current image, usually a cut-out by then: the model is shown it on a flat
grey (never the removed background), a touch-up is pasted back into the
cut-out and stays one, and a regenerated picture, opaque, is cut out again
("cutout:N") when the owner chose to remove the background.

Every image carries its photo CHECK (photo_analysis.check_photo), made when
the image is: what step 3 recommends is the check of the current image, so
it follows every change of image (framing, an AI result, going back).

Three rules carry the module.

**A result lands only on the state it was computed from.** Every job records
the creation's revision when it was accepted, and stores its result with
`UPDATE … WHERE revision = :rev`. If the owner re-framed, switched line or
chose another image meanwhile, the result describes a state that no longer
exists; it is discarded, and its files deleted, rather than grafted on.

**Marks belong to a pixel frame.** Anchors are stored with the key of the
image whose pixels they were placed on. Framing makes a new frame and clears
them, and so does choosing an AI result (its pixels moved); a cut-out does
not (no pixel moves), so they survive background removal and choosing
between an image and its cut-out.

**Finishing is the owner's confirmation.** It is the only way a creation
becomes an avatar, it is atomic (draft → finishing happens once), repeatable
(a second press answers with the same avatar), and it publishes: the owner
has just looked at the points and said they are right, which is exactly the
confirmation a first build otherwise waits for. Before it publishes a
person, it prepares their mouth from the picture and those points (the
wizard's step 5, "Preparing your avatar": `_own_mouth`).

The package, by what each part does:

    rules     limits, what each line does, the storage layout
    steps     the images made and their lineage (the current image, its
              frame and check, the statement finishing asks for)
    records   the row's job record, a job's state and result writes, the
              AI budget
    runs      starting a job and running its work (WORKS)
    ingest    the upload cleaned and analysed; a background removal
    detect    the face found, the vision model's points, the fit of marks
    adjust    AI adjust rounds and the touch-up the wizard starts itself
    generate  an original made by the image model
    finish    the avatar built from the confirmed marks, and its undo
    mouth     a finished person's own mouth, before the first publish
    recovery  creations stranded by a restart, idle drafts expired

and what the owner's requests do (api.creations), each checked before
anything is written or a job admitted:

    repo      the rows: read as stored, a revision-checked change, the
              draft limit, the list, deletion
    guards    the state a request needs, marks that fit the line and image
    new       a creation from an upload, or with a generated original
    edits     framing and line, the image chosen, the background answer
    requests  face detection, AI adjust, step 3 and its versions, Finish,
              and a retry of whichever job failed

The job side is re-exported here, so `services.creations.X` keeps working;
the request side is imported by module.
"""

from __future__ import annotations

from app.services.creations.adjust import (
    ADJUST_CALLS,
    AUTO_ADJUST_REASON,
    _adjust,
    _refund_round,
    auto_adjust_of,
    mouth_warnings,
    source_photo_key,
)
from app.services.creations.detect import (
    VISION_CACHE_SIZE,
    _ai_points,
    _detect,
    anchors_are_current,
    detect_anchors,
    fit_from_anchors,
    source_on_backdrop,
    vision_cache_hit,
    wants_ai_points,
)
from app.services.creations.finish import (
    UNDO_FINISH_BACKOFF_SECONDS,
    _build_avatar,
    _finish,
    _over,
    _undo_finish,
    _undo_finish_retrying,
)
from app.services.creations.generate import (
    _generate,
)
from app.services.creations.ingest import (
    _background,
    _ingest,
    _stored_analysis,
)
from app.services.creations.mouth import (
    PUBLISH_LABEL,
    PUBLISH_STANDARD_LABEL,
    TEETH_FAILED,
    _ai_allowed,
    _animal_character_mouth,
    _own_mouth,
    _record_finish_consent,
    _single_teeth,
    _teeth_consent,
)
from app.services.creations.records import (
    NOT_RETRYABLE,
    SUPERSEDED,
    _ai_disabled_error,
    _ai_switched_off,
    _load,
    _store_result,
    _update_ai_usage,
    _write_job,
    ai_usage_of,
    error_record,
    job_record,
    retryable,
)
from app.services.creations.recovery import (
    INTERRUPTED_ERROR,
    expire_idle,
    recover_interrupted,
    recover_stranded,
)
from app.services.creations.rules import (
    ADJUSTED_PREFIX,
    AI_DETECTIONS_PER_CREATION,
    BEFORE_STYLISE,
    CHECK_KEYS,
    CUTOUT,
    CUTOUT_PREFIX,
    ENDED_RETENTION,
    FULL_FRAME,
    IDLE_EXPIRY,
    LINES,
    MAX_DRAFTS_PER_ORG,
    MAX_ROLL_DEGREES,
    MAX_UPLOAD_BYTES,
    MIN_CROP_FRACTION,
    STEP_ORDER,
    LineRules,
    avatar_prefix,
    creation_prefix,
    incoming_key,
    required_marks,
    rules_for,
    step_key,
)
from app.services.creations.runs import (
    WORKS,
    _prepare,
    _run,
    launch,
    start_job,
)
from app.services.creations.steps import (
    _detected_a_person,
    _remove_steps,
    _through_cutouts,
    adjusted_index,
    ai_edited_of,
    background_source,
    check_of,
    copied,
    current_step,
    cutout_id_for,
    drop_adjusted,
    drop_cutouts,
    frame_key,
    is_cut_out,
    is_cutout_id,
    lineage,
    ordered_step_ids,
    recommendation_of,
    round_source,
    statement_for,
    step_check,
    step_items,
    stylised,
)

__all__ = [
    "_adjust",
    "ADJUST_CALLS",
    "adjusted_index",
    "ADJUSTED_PREFIX",
    "_ai_allowed",
    "AI_DETECTIONS_PER_CREATION",
    "_ai_disabled_error",
    "ai_edited_of",
    "_ai_points",
    "_ai_switched_off",
    "ai_usage_of",
    "anchors_are_current",
    "_animal_character_mouth",
    "auto_adjust_of",
    "AUTO_ADJUST_REASON",
    "avatar_prefix",
    "_background",
    "background_source",
    "BEFORE_STYLISE",
    "_build_avatar",
    "CHECK_KEYS",
    "check_of",
    "copied",
    "creation_prefix",
    "current_step",
    "CUTOUT",
    "cutout_id_for",
    "CUTOUT_PREFIX",
    "_detect",
    "detect_anchors",
    "_detected_a_person",
    "drop_adjusted",
    "drop_cutouts",
    "ENDED_RETENTION",
    "error_record",
    "expire_idle",
    "_finish",
    "fit_from_anchors",
    "frame_key",
    "FULL_FRAME",
    "_generate",
    "IDLE_EXPIRY",
    "incoming_key",
    "_ingest",
    "INTERRUPTED_ERROR",
    "is_cut_out",
    "is_cutout_id",
    "job_record",
    "launch",
    "lineage",
    "LineRules",
    "LINES",
    "_load",
    "MAX_DRAFTS_PER_ORG",
    "MAX_ROLL_DEGREES",
    "MAX_UPLOAD_BYTES",
    "MIN_CROP_FRACTION",
    "mouth_warnings",
    "NOT_RETRYABLE",
    "ordered_step_ids",
    "_over",
    "_own_mouth",
    "_prepare",
    "PUBLISH_LABEL",
    "PUBLISH_STANDARD_LABEL",
    "recommendation_of",
    "_record_finish_consent",
    "recover_interrupted",
    "recover_stranded",
    "_refund_round",
    "_remove_steps",
    "required_marks",
    "retryable",
    "round_source",
    "rules_for",
    "_run",
    "_single_teeth",
    "source_on_backdrop",
    "source_photo_key",
    "start_job",
    "statement_for",
    "step_check",
    "step_items",
    "step_key",
    "STEP_ORDER",
    "_store_result",
    "_stored_analysis",
    "stylised",
    "SUPERSEDED",
    "_teeth_consent",
    "TEETH_FAILED",
    "_through_cutouts",
    "_undo_finish",
    "UNDO_FINISH_BACKOFF_SECONDS",
    "_undo_finish_retrying",
    "_update_ai_usage",
    "vision_cache_hit",
    "VISION_CACHE_SIZE",
    "wants_ai_points",
    "WORKS",
    "_write_job",
]
