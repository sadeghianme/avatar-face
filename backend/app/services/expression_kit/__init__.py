"""AI expression pictures: five pictures of the avatar's own face, happy,
surprised, concerned, thinking and serious, made by the image model for the
engine to blend over its warped mesh (the upper face; the mouth stays the
visemes', and a parted-lips smile shows while the avatar is silent).

What it is to the owner and to visitors (the choice, the files, publishing,
the views) is services.expressions, a leaf. This package makes them:

1. one edit per expression (`prompts`), on the face crop the mouth kit
   sends, through the mouth kit's request loop (performance_kit.Sender);
2. each answer registered on the mouth kit's anchors with its drift guards
   but the eyes' (an expression moves the lids; performance_kit
   .register_face), then held to the expression it was asked for
   (`reached`: what the brows, the lids and the mouth's corners moved);
3. the source's own skin kept in it (`fidelity`: its pores and grain, and
   its colour, which the model redraws a little older and greyer);
4. the manifest (`manifest`): per expression its picture's landmarks (uv)
   and where they go on the avatar's picture (targets), which the engine
   morphs its mesh toward under its mask so the picture lands on the
   moved mesh with nothing ghosting.

An expression that fails any of it is left out: the engine plays it
animated (option 1, the warp). Nothing is retried but a refusal, once, on
the head crop.

**Who may send.** As for the mouth kit: the organization's switch, the
image model, the monthly image limit (five more), the member's current
third_party_ai consent naming Google; the switch and the limit are read
again before every call (mouth_kit.CallGuard), the consent recorded on the
avatar before the first picture leaves.

**When.** From the panel (Make, now), or at Publish when the owner chose AI
pictures and none are made for the avatar's picture: now (a job, about
twenty seconds) or, when the owner chose "cheaper, when ready", as a batch
(`batch`, `batching`: half the price, collected by the sweeper). A
publish's kit completes that publish: published at once when ready
(`saving.republish`), the draft kept in step.

**What it costs.** One usage row per billed call ("expressions"), as each
call ends, or per answer when a batch is collected. Five calls a kit, one
more for each the AI declines; about $0.067 an image at the image model's
1K price, half that in a batch.

**Later edits.** The kit follows its face with no AI call
(`storing.follow_points`): new points on the same picture, the picture
cropped. A new photo makes it stale: the next publish makes it again.

The package:

    constants  versions, names, file types, landmarks
    prompts    1. what each request asks for
    reached    2. the expression reached, measured
    fidelity   3. the source's skin kept
    manifest   4. the manifest, and a kit moved onto new points
    build      build_expressions, the orchestrator
    records    the record a kit leaves on the avatar
    storing    a kit stored on the draft, the choice, following the edits
    saving     a made kit saved however long it took, and republished
    batch      Gemini's batch mode
    batching   a batch sent and collected
    jobs       the job: start, run, what it reports
"""

from __future__ import annotations

from app.services.expression_kit.batching import collect_batches, submit_for_avatar
from app.services.expression_kit.build import ExpressionsResult, Made, build_expressions
from app.services.expression_kit.constants import (
    CONCURRENCY,
    EXPRESSIONS,
    EXPRESSIONS_CALL,
    KIT_VERSION,
    PROMPTS_VERSION,
)
from app.services.expression_kit.jobs import JOB_STEP, job_view, start
from app.services.expression_kit.manifest import is_expressions_manifest, rebase
from app.services.expression_kit.prompts import expression_prompt
from app.services.expression_kit.reached import expression_reached, measures
from app.services.expression_kit.saving import Origin, republish, require_person, save
from app.services.expression_kit.storing import follow_points, follow_rig, store

__all__ = [
    "build_expressions",
    "collect_batches",
    "CONCURRENCY",
    "expression_prompt",
    "expression_reached",
    "EXPRESSIONS",
    "EXPRESSIONS_CALL",
    "ExpressionsResult",
    "follow_points",
    "follow_rig",
    "is_expressions_manifest",
    "JOB_STEP",
    "job_view",
    "KIT_VERSION",
    "Made",
    "measures",
    "Origin",
    "PROMPTS_VERSION",
    "rebase",
    "republish",
    "require_person",
    "save",
    "start",
    "store",
    "submit_for_avatar",
]
