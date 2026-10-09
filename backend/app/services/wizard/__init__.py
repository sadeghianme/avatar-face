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

The package:

    plan      the plan (model × look → line), the step 3 modes and budgets,
              and the default name
    prompts   what every picture is asked for
    prepare   the prepare job: the AI's picture (or the photo), its cut-out
              and the face found on it, in one write
    versions  going back to any picture step 3 made

The public names are re-exported here, so `wizard.X` keeps working. Nothing
private is: each module's helpers stay in it.
"""

from __future__ import annotations

from app.services.wizard.plan import (
    AI,
    CHANGE,
    FREE_CLEARS_PER_CREATION,
    GENERATE,
    KEPT_ANCHORS,
    KEPT_RECORD,
    LOOKS,
    MAX_WORDS,
    MODELS,
    MODES,
    NAME,
    NAME_MAX,
    ORIGINAL,
    PLAN,
    PREPARE_ROUNDS_PER_CREATION,
    SOURCES,
    STYLE_OF_LOOK,
    TECHNICAL_WORDS,
    default_name,
    inferred_plan,
    line_for,
    make_plan,
    name_of,
    plan_of,
    technical_file_name,
)
from app.services.wizard.prepare import (
    cut_out,
    head_crop_source,
    prepare_job,
    settle,
)
from app.services.wizard.prompts import (
    AVOID,
    BACKDROP,
    DEFAULT_SUBJECT,
    FRAMING,
    LIGHT,
    LOOK_WORDS,
    PREPARE_SUBJECT,
    change_prompt,
    character_prompt,
    prepare_prompt,
)
from app.services.wizard.versions import (
    use_version,
    version_of,
)

__all__ = [
    "AI",
    "AVOID",
    "BACKDROP",
    "CHANGE",
    "change_prompt",
    "character_prompt",
    "cut_out",
    "default_name",
    "DEFAULT_SUBJECT",
    "FRAMING",
    "FREE_CLEARS_PER_CREATION",
    "GENERATE",
    "head_crop_source",
    "inferred_plan",
    "KEPT_ANCHORS",
    "KEPT_RECORD",
    "LIGHT",
    "line_for",
    "LOOK_WORDS",
    "LOOKS",
    "make_plan",
    "MAX_WORDS",
    "MODELS",
    "MODES",
    "NAME",
    "NAME_MAX",
    "name_of",
    "ORIGINAL",
    "PLAN",
    "plan_of",
    "prepare_job",
    "prepare_prompt",
    "PREPARE_ROUNDS_PER_CREATION",
    "PREPARE_SUBJECT",
    "settle",
    "SOURCES",
    "STYLE_OF_LOOK",
    "technical_file_name",
    "TECHNICAL_WORDS",
    "use_version",
    "version_of",
]
