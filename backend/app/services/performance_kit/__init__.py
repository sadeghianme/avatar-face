"""The performance kit: the Reference's mouth kit, made from a person's photo.

The Reference avatar talks well because it was built from a KIT
(docs/reference-avatar-lab.md): a neutral portrait, six photographs of the
same face saying AA, EE, OO, OH, F/V and TH, each registered onto the
portrait on landmarks the mouth cannot move, a motion manifest built from
them (performance.json), and a mouth profile tuned by hand. Every other
avatar borrows that kit: the continuous mouth retargets the Reference's lip
movement onto their face by mouth width alone.

This module makes the same kit from an uploaded photo, after its owner has
confirmed the points:

1. one image edit per shape (`POSE_PROMPTS`), on the face crop AI adjust
   sends (photo_adjust.face_crop_box / crop_face), asking for that mouth and
   nothing else, and one more for the teeth photo (`TEETH`, with the recipe
   of the photo the Reference renders its teeth from);
2. each answer detected (services.landmarks), mapped back through the crop,
   registered on the eye corners and nose bridge (the Reference's ANCHORS,
   the same function scripts/build_reference_performance.py uses) onto the
   detector's own view of the base photo, and refused when the
   registration is poor or the face drifted: a picture of another shape
   than the (square) one sent, eyes or nose moved, head scaled, rotated or
   turned, skin relit, or the mouth is not in the shape that was asked
   for, or opens further than speech does. What an answer moved is then
   added to the owner's confirmed points (`register_answer`), so a
   corrected mark is never mistaken for motion;
3. the person's shapes brought to the Reference's conversational size by
   their own AA (`normalize_amplitude`: a model acts, and asked for "ah" it
   opens as it pleases), a shape that still opens too far for its sound
   refused, the teeth fitted from the teeth photo (`fit_profile`), and that
   photo handed back (`TeethSource`) only when the embed would draw it
   (services.dental_photo);
4. any shape that is missing or refused filled from the Reference's pose,
   retargeted to this face by its mouth width (`retarget_reference_pose`),
   exactly as the bundled motion plays it;
5. a per-avatar manifest in the format ContinuousMouth loads (version 2,
   character "avatar-v1:<kit id>", see `build_manifest`).

`build_kit` runs all of it with an INJECTED edit function, so the creation
finish job and the Mouth panel's job (services.mouth_kit) pass
imagegen.edit_image, guarded, and tests pass fakes. Nothing here stores,
meters or publishes: the caller does, from what `KitResult` reports.
`rebase_manifest` moves a stored kit onto the face's points as they are
now (re-confirmed on the same picture, or the picture cropped around the
same face), with no AI call.

Coordinates. Registration works in base-photo pixels. The manifest is in
"manifest units": the base photo levelled about its mouth (the corner line
horizontal, as the Reference's is) and scaled so that the face is exactly
as wide as the Reference's face is in its manifest. The engine uses only
displacements relative to the mouth width, so any similarity frame renders
the same; this one makes every threshold the Reference was measured with
(the 0.007 registration gate, the embed validator's ranges) mean the same
thing for every face, whatever its framing.

The package, in the order of the steps above:

    constants     versions, the shapes, the landmark indices
    prompts       1. what each request asks the image model for
    registration  2a. similarity on stable anchors (shared with the
                  Reference's build script), the Reference, the manifest frame
    requests      1b. the crops and requests sent
    answers       2b. an answer registered onto the confirmed points, or
                  refused by the drift and shape gates
    profile       4. the retarget fallback, 3. the mouth profile fit, 3b. the
                  kit's own size (normalize_amplitude)
    manifest      5. the manifest, and a kit moved onto new points
    sending       1c. the requests sent, once each (and once more on the head
                  crop after a refusal), every call accounted for
    kit           6. build_kit, the orchestrator, and what it reports

The public names are re-exported here, so `performance_kit.X` keeps
working; what the modules share among themselves (requests.crop_picture,
answers.make_reason, …) is imported from its module. Nothing private is
re-exported.
"""

from __future__ import annotations

from app.services.performance_kit.answers import (
    EYE_GUARD,
    MAX_ASPECT_CHANGE,
    MAX_EYE_SHIFT,
    MAX_NOSE_SHIFT,
    MAX_OVER_REFERENCE,
    MAX_POSE_SKIN_DELTA_E,
    MAX_ROTATION_DEGREES,
    MAX_SCALE_CHANGE,
    MAX_YAW_CHANGE,
    MIN_AA_OF_REFERENCE,
    NOSE_GUARD,
    POSE_LIMITS,
    RAW_MAX_OVER_REFERENCE,
    REFERENCE_OPENINGS,
    TEETH_PHOTO_MIN_GAP,
    Detector,
    FaceRegistration,
    PoseRegistration,
    opening,
    register_answer,
    register_face,
    signed_yaw,
)
from app.services.performance_kit.constants import (
    CHARACTER_PREFIX,
    FACE_LEFT,
    FACE_RIGHT,
    INNER_LIP_RING,
    KIT_ID,
    KIT_VERSION,
    LOWER_INNER,
    MANIFEST_VERSION,
    MOUTH_LEFT,
    MOUTH_RIGHT,
    NOSE_TIP,
    OUTER_LIP_RING,
    POSES,
    PROMPTS_VERSION,
    REFERENCE_CHARACTER,
    SHAPES,
    TEETH,
    UPPER_INNER,
)
from app.services.performance_kit.kit import (
    MAX_BASE_DETECTION_SHIFT,
    KitFailed,
    KitResult,
    KitUnavailable,
    Progress,
    TeethSource,
    build_kit,
)
from app.services.performance_kit.manifest import (
    BASE,
    GENERATED,
    MANIFEST_DECIMALS,
    RETARGETED,
    SAME_POINTS_PX,
    PoseEntry,
    build_manifest,
    is_kit_manifest,
    manifest_to_base,
    rebase_manifest,
)
from app.services.performance_kit.profile import (
    REFERENCE_JAW_RANGE,
    REFERENCE_TEETH_DROP,
    REFERENCE_TEETH_SCALE,
    REFERENCE_TEETH_Y,
    UPPER_SEAT,
    Amplitude,
    ProfileFit,
    TeethPhoto,
    fit_profile,
    for_standard_teeth,
    neutral_seam,
    normalize_amplitude,
    reference_openings,
    retarget_reference_pose,
)
from app.services.performance_kit.prompts import (
    POSE_PROMPTS,
    pose_prompt,
    request_prompt,
    teeth_prompt,
)
from app.services.performance_kit.registration import (
    ANCHORS,
    MAX_REGISTRATION_RMS,
    ManifestFrame,
    MirroredPose,
    ReferenceMotion,
    Similarity,
    load_reference,
    mouth_frame,
    register,
    registration_rms,
    shared_triangles,
    similarity_on_anchors,
)
from app.services.performance_kit.requests import (
    FACE_CROP,
    HEAD_CROP,
    PoseRequest,
    head_square,
    prepare_pose_request,
)
from app.services.performance_kit.sending import (
    EditedImage,
    EditImage,
    Sender,
    call_billing,
    stop_reason,
)

__all__ = [
    "Amplitude",
    "ANCHORS",
    "BASE",
    "build_kit",
    "build_manifest",
    "call_billing",
    "CHARACTER_PREFIX",
    "Detector",
    "EditedImage",
    "EditImage",
    "EYE_GUARD",
    "FACE_CROP",
    "FACE_LEFT",
    "FACE_RIGHT",
    "fit_profile",
    "for_standard_teeth",
    "GENERATED",
    "HEAD_CROP",
    "head_square",
    "INNER_LIP_RING",
    "is_kit_manifest",
    "KIT_ID",
    "KIT_VERSION",
    "KitFailed",
    "KitResult",
    "KitUnavailable",
    "load_reference",
    "LOWER_INNER",
    "MANIFEST_DECIMALS",
    "manifest_to_base",
    "MANIFEST_VERSION",
    "ManifestFrame",
    "MAX_ASPECT_CHANGE",
    "MAX_BASE_DETECTION_SHIFT",
    "MAX_EYE_SHIFT",
    "MAX_NOSE_SHIFT",
    "MAX_OVER_REFERENCE",
    "MAX_POSE_SKIN_DELTA_E",
    "MAX_REGISTRATION_RMS",
    "MAX_ROTATION_DEGREES",
    "MAX_SCALE_CHANGE",
    "MAX_YAW_CHANGE",
    "MIN_AA_OF_REFERENCE",
    "MirroredPose",
    "mouth_frame",
    "MOUTH_LEFT",
    "MOUTH_RIGHT",
    "neutral_seam",
    "normalize_amplitude",
    "NOSE_GUARD",
    "NOSE_TIP",
    "opening",
    "OUTER_LIP_RING",
    "POSE_LIMITS",
    "pose_prompt",
    "POSE_PROMPTS",
    "PoseEntry",
    "PoseRegistration",
    "PoseRequest",
    "POSES",
    "prepare_pose_request",
    "ProfileFit",
    "Progress",
    "PROMPTS_VERSION",
    "RAW_MAX_OVER_REFERENCE",
    "rebase_manifest",
    "REFERENCE_CHARACTER",
    "REFERENCE_JAW_RANGE",
    "REFERENCE_OPENINGS",
    "reference_openings",
    "REFERENCE_TEETH_DROP",
    "REFERENCE_TEETH_SCALE",
    "REFERENCE_TEETH_Y",
    "ReferenceMotion",
    "register",
    "register_answer",
    "register_face",
    "FaceRegistration",
    "Sender",
    "registration_rms",
    "request_prompt",
    "retarget_reference_pose",
    "RETARGETED",
    "SAME_POINTS_PX",
    "SHAPES",
    "shared_triangles",
    "signed_yaw",
    "Similarity",
    "similarity_on_anchors",
    "stop_reason",
    "TEETH",
    "TEETH_PHOTO_MIN_GAP",
    "teeth_prompt",
    "TeethPhoto",
    "TeethSource",
    "UPPER_INNER",
    "UPPER_SEAT",
]
