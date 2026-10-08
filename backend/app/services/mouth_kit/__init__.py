"""The performance kit, wired: a person's own mouth shapes and teeth, made
at Finish (Step 5, "Preparing your avatar") and from the Mouth panel,
stored as the avatar's own motion, fitted, metered and disclosed.

services.performance_kit makes the kit from a picture and its confirmed
points with an injected edit function. This module is everything around
it: which calls may go, what they cost, where the result lives, what the
owner and visitors are told, and how it follows the avatar's later edits.

**Who may send.** As for every AI step: the organization's switch, the
server's image model, the monthly image limit, and the member's current
third_party_ai consent (checked by the caller before anything starts).
`CallGuard` is imagegen.edit_image as the kit calls it: before EACH call
the switch and the limit are read again, so a switch turned off or a limit
reached mid-kit stops it (every shape not yet answered is retargeted,
nothing more is sent), and calls still in flight count against the limit,
so three concurrent calls never pass its last unit together. The consent
is recorded (on the avatar, and for a finish on the creation) before the
first picture leaves, whatever the answers turn out to be; a kit that sent
nothing records nothing, and one whose consent could not be recorded sends
nothing.

**What it costs.** One image-generation usage row per billed call (source
SHAPES_CALL), written as each call ends and classified as the kit
classifies it (performance_kit.call_billing): an answer is billed, a
timeout may have been and counts, a call that never reached Google does
not. Seven calls: the six shapes and the teeth photo (six when the avatar
keeps the owner's own teeth), and one more for each the AI declines.

**Where it lives.** The manifest is stored beside the teeth photo
(`mouth-motion-<stamp>.json`, a fresh key each time) and named by
`mouth_config.motion_key`, when the kit made shapes of the person's own
(one with none plays exactly what the bundled motion plays, so the bundled
motion plays); the teeth fit becomes the draft's; the kit's teeth photo
becomes the avatar's when the embed would draw it (mouth_photo.admit_photo:
the WebP visitors get, the teeth test run on those bytes);
`mouth_config.kit` records what the kit is made of (owner facing:
publishing keeps it beside the files for Discard, never serves it).
Publishing copies the manifest like the teeth photo, and the widget and
share page get it as `mouth.motion_url`.

**What it keeps of the owner's.** Teeth the owner uploaded are never
replaced, and not asked for: the kit brings its shapes only, and the teeth
fit stays theirs. AI teeth from an earlier run stay when a new kit cannot
make teeth the embed would draw. The jaw range is the owner's: the kit's
shapes are made at the Reference's size (performance_kit
.normalize_amplitude), so the slider means the same with or without them.

**Who is told.** AI-made shapes are disclosed as `ai_edited.mouth_shapes`
{model, generated}, with mode "mouth_shapes" when nothing else was
AI-made (disclosure.mouth_disclosure). Retargeted shapes are the
Reference's movement, not pixels an AI drew, and are not counted.

**Later edits.** The kit follows its face with no AI call (`follow_points`,
performance_kit.rebase_manifest): points re-confirmed on the same picture
(Mark the face, a re-detection), and the picture moved under the same
face (a crop, a crop reset, either undone: the same pixels, translated).
A kit that cannot follow is dropped (`drop`), and says why. The teeth
photo stays whatever the portrait: the renderer registers it by its own
landmarks.

The package:

    calls    the labels and notes, CallGuard (who may send, what each call
             costs), progress, and make (performance_kit.build_kit, guarded)
    records  what the avatar's mouth config keeps of a kit, its public view,
             and the AI disclosure of its shapes
    storing  a kit stored on the avatar's draft, and the kit following the
             avatar's later edits (teeth, marks, crops, a re-detection)
    panel    the Mouth panel's job: start, run, what it reports

Everything is re-exported here, so `mouth_kit.X` keeps working.
"""

from __future__ import annotations

from app.services.mouth_kit.calls import (
    CONCURRENCY,
    CONSENT_NOT_RECORDED,
    FIT_LABEL,
    FITTED_WITH_TEETH,
    FITTED_WITHOUT_TEETH,
    GENERATED,
    MOTION_TYPE,
    OWNER_PHOTO,
    REBASE_FAILED,
    RETARGETED,
    SAVE_LABEL,
    SHAPE_COUNT,
    SHAPES_CALL,
    SHAPES_LABEL,
    TEETH_LABEL,
    TEETH_REMOVED,
    CallGuard,
    _note,
    _now,
    _Stopped,
    generated_count,
    kit_model,
    make,
    progress_to,
)
from app.services.mouth_kit.panel import (
    ENDED_KEPT,
    JOB_STEP,
    NOT_RETRYABLE,
    _end,
    _ended,
    _job_out,
    _make_for_avatar,
    _nothing_made,
    _require_mouth,
    _require_person,
    _run,
    _teeth_alone,
    job_view,
    manifest_size,
    start,
)
from app.services.mouth_kit.records import (
    _TEETH_NOTE_CODES,
    _UNCLEAR_CODES,
    _standard_teeth,
    kit_record,
    public_kit,
    teeth_reason,
)
from app.services.mouth_kit.storing import (
    _load_avatar,
    _manifest_bytes,
    drop,
    follow_points,
    follow_redetection,
    follow_rig,
    store,
    teeth_changed,
)

__all__ = [
    "CallGuard",
    "CONCURRENCY",
    "CONSENT_NOT_RECORDED",
    "drop",
    "_end",
    "_ended",
    "ENDED_KEPT",
    "FIT_LABEL",
    "FITTED_WITH_TEETH",
    "FITTED_WITHOUT_TEETH",
    "follow_points",
    "follow_redetection",
    "follow_rig",
    "GENERATED",
    "generated_count",
    "_job_out",
    "JOB_STEP",
    "job_view",
    "kit_model",
    "kit_record",
    "_load_avatar",
    "make",
    "_make_for_avatar",
    "_manifest_bytes",
    "manifest_size",
    "MOTION_TYPE",
    "NOT_RETRYABLE",
    "_note",
    "_nothing_made",
    "_now",
    "OWNER_PHOTO",
    "progress_to",
    "public_kit",
    "REBASE_FAILED",
    "_require_mouth",
    "_require_person",
    "RETARGETED",
    "_run",
    "SAVE_LABEL",
    "SHAPE_COUNT",
    "SHAPES_CALL",
    "SHAPES_LABEL",
    "_standard_teeth",
    "start",
    "_Stopped",
    "store",
    "_teeth_alone",
    "teeth_changed",
    "TEETH_LABEL",
    "_TEETH_NOTE_CODES",
    "teeth_reason",
    "TEETH_REMOVED",
    "_UNCLEAR_CODES",
]
