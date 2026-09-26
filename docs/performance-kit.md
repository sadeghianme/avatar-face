# Performance kit: the Reference's mouth kit, from a person's photo

Status: wired, 2026-09-26 (Step 5, "Preparing your avatar"). Finishing a
person makes their kit before the first publish; the Mouth panel makes it
for an existing avatar; publishing serves it to the widget and the share
page. `services/performance_kit.py` makes a kit; `services/mouth_kit.py` is
everything around it (who may send, metering, storage, disclosure, later
edits). See "Wired" below. Revised after review the same day: the teeth
photo is a request of its own, every shape is held to the Reference's size,
and the kit follows crops.

The Reference avatar (see [reference-avatar-lab.md](reference-avatar-lab.md))
talks well because it was built from a kit: a neutral portrait, six photos of
the same face saying AA, EE, OO, OH, F/V and TH registered onto it, a motion
manifest (`performance.json`), and a hand-tuned mouth profile. Every other
continuous-mouth avatar borrows that kit and retargets it by mouth width.
`backend/app/services/performance_kit.py` makes the same kit from an uploaded
photo once its owner has confirmed the points.

## Pieces

| Piece | Function | Notes |
|---|---|---|
| Prompts | `POSE_PROMPTS`, `pose_prompt(shape)`, `teeth_prompt()`, `PROMPTS_VERSION` (`pose-prompts@3`) | same person, pose, framing, light; only mouth and jaw change. @2 after the first run on real Gemini: AA "moderately open, as in normal conversation, not a yawn or a shout" (it came back yawn-wide), TH "only the very tip of the tongue, barely visible between the front teeth", F/V "the upper front teeth pressing gently on the lower lip; the lips otherwise relaxed". @3: EE is the "ee" of speech ("at most the biting edges of the upper front teeth"), and the teeth photo is its own request (`TEETH`) with `mouth_photo.TEETH_PROMPT`, the recipe of `oral-detail-v3`, the photo the Reference renders its teeth from |
| Request | `prepare_pose_request(base_png, base_points, shape, kind)` → `PoseRequest` | AI adjust's face crop (1.6 face boxes, 1024 px), for the six shapes and the teeth alike; after a refusal, its head-and-shoulders crop (`photo_adjust.head_crop_box`) padded to a square (`head_square`, at the photo's own resolution, the photo's edge filled in like the face crop's). Both are square because the model answers a square with a square: the 6:7 head box would come back reframed to the model's own aspect and map back with a scale per axis (`to_base`), the mouth 0.1-0.2 mouth widths off |
| Registration | `similarity_on_anchors`, `register`, `registration_rms` | moved out of `scripts/build_reference_performance.py`, which still writes the identical `performance.json` (tested byte for byte) |
| Checks | `register_answer(...)` → `PoseRegistration` | refuses an answer whose aspect differs from what was sent by more than 1% (`aspect_changed`); detect, map back, register on eye corners + nose bridge onto the detector's own view of the base photo (`base_detected`), RMS ≤ 0.007 in manifest units; refuses head zoom/tilt, moved nose or eyes, a head turned (the nose tip's SIGNED offset between the cheeks, `signed_yaw`), skin ΔE > 8, or a mouth not in the asked shape (`POSE_LIMITS`, below). The teeth answer passes the same drift checks, and must show its teeth (its own lip gap ≥ 0.08 of its mouth width); how far it opens is not played, so not bounded. Targets = confirmed points + (registered − detected base), so the owner's corrections to the marks are kept and never read as motion. A check that raises is a rejected answer (`check_failed`) |
| Size | `normalize_amplitude(base_points, generated, reference)` → `Amplitude` | the person's own shapes at the Reference's conversational size (below) |
| Fallback | `retarget_reference_pose(shape, base_points, reference)` | the Reference's displacement in its levelled mouth frame × this face's mouth width over the Reference's, turned to this face's mouth angle: exactly what the engine does with the bundled motion, so a retargeted pose plays as the bundled one does on the same face, whatever the lips' thickness (tested on a face whose lips are 1.24 × the Reference's height). Baked by the backend: the embed has no retarget code |
| Fit | `fit_profile(base_points, reference, teeth, why_no_teeth)` → `ProfileFit` | teethY, teethScale, from the teeth photo when the embed would draw it, else for the drawn teeth; clamped to `MouthProfile`'s ranges; defaults with a reason when unmeasurable. The jaw range is not fitted (below) |
| Teeth photo test | `dental_photo.accept_teeth_photo(image, points, inner_ring)` → `Acceptance` | the embed's DentalOralSurface test, ported pass for pass (extraction canvas, `extractDentalLayers`, `dentalCrownCoverage`): arch ≥ 110/512 wide, ≥ 180 px of enamel, central crown ≥ 0.10 mouth widths. Pixel-exact against the embed's code (`dental-extraction.json` fixture) |
| Manifest | `build_manifest(...)` | version 2, see below; the kit id is ASCII `[A-Za-z0-9_-]{1,64}` exactly as the embed accepts it |
| Rebase | `rebase_manifest(manifest, base_points, reference, image_size)` | the same kit on the face's points as they are now: re-confirmed, re-detected, or the picture cropped around the face; no AI call (see "Wired") |
| Orchestrator | `build_kit(base_png, base_points, edit_image, *, teeth=True, concurrency=3, per_call_timeout=None, bound_calls=True, on_progress=None, kit_id=None, detect=None, reference=None)` → `KitResult` | seven requests (six with `teeth=False`: the owner's own teeth photo is kept); injected edit function; concurrency bound; refusal → one head-crop retry; nothing else asked twice; the requests run in a task group, so a failure that is not a provider call's cancels and awaits the calls in flight and raises `KitFailed` with every call sent accounted for. `per_call_timeout` defaults to imagegen's own 90 s, and a timeout either way (asyncio's, or httpx's read/write timeout) is `timeout`, billed null; a connect timeout never reached Google (`provider_error`, billed false): `call_billing(error)` is the one classification. With `bound_calls=False` the bound is the edit function's own (`mouth_kit.CallGuard`: waiting for its lock, the database or the consent's record is not the provider's time). `on_progress(fraction, message, done, total)`. `KitResult.teeth_report` says how the teeth request went |

## How far a shape opens

A shape's **opening** is how much further apart the middles of the inner
lips (13, 14) are than at rest, down the face, in rest mouth widths
(`opening`): lips parted in the portrait are not the shape's movement, and
it is linear in the movement. The Reference's own: AA 0.290, EE 0.165, OO
0.122, OH 0.308, F/V 0.096, TH 0.203 (`REFERENCE_OPENINGS`, tested equal to
the bundled motion's).

- **Each answer**, as drawn, must open at least enough to be the shape (AA
  0.6 times the Reference's, EE and TH 0.05, OH 0.12; EE at least 0.94 of
  the rest width, OO at most 0.85, OH at most 0.92) and at most what no
  speech sound reaches: twice the Reference's opening of the same shape
  (`RAW_MAX_OVER_REFERENCE`), and for the AA, which sets the kit's size,
  1.4 times (`MAX_OVER_REFERENCE`). The EE's width floor allows a portrait
  that already smiles: the second real run's relaxed "ee" came back 0.96 of
  a smiling rest.
- **The kit's size.** An image model acts: how far it opens an "ah" is its
  choice, not the person's jaw. So the person's AA sets the scale: every
  shape the model made is moved from rest the Reference's AA opening over
  this AA's times as far as it was made, which puts this AA exactly where
  the Reference's is and keeps the others' sizes relative to it (the AA
  limits keep the scale within 0.71-1.67). Then each is held to 1.4 times
  the Reference's opening of its shape at that size (`MAX_OVER_REFERENCE`).
  The first run on real Gemini (@1 prompts) came back 1.6-2.0 × for TH, F/V
  and EE and 2.2-2.5 × for AA: played, an over-open TH opens every t, d, n
  and k as wide as "ah" (the continuous mouth plays TH for them, and EE for
  "ih", "e" and "s"); those answers are refused and retargeted (tested on
  the spike's measured openings). The second (@3 prompts) came back
  0.7-1.45 × as drawn and 0.6-1.31 × at the kit's size: the model acts
  every shape alike, which is why a shape is judged at the kit's size and
  not as drawn (tested on that run's openings: all six pass). Without an
  AA of the person's, nothing is scaled.
- **The manifest is true at the Reference's jaw range** (0.85), as the
  bundled motion is: the retargeted shapes are the Reference's at that
  size, and the owner's jaw slider means the same with or without a kit.
  The jaw range is no longer fitted: fitted from the AA's absolute gap, a
  portrait with parted lips read its rest gap as jaw movement (0.969 and
  1.086 for 0.04 and 0.08), and a clamped value no longer described the
  geometry.

## Manifest version 2

Everything ContinuousMouth reads keeps the Reference's meaning (seven poses in
`rest, aa, ee, oo, oh, fv, th` order with 478 `points`, `center`,
`mouth_width`, `triangles`, `inner_ring`, `outer_ring`). Added or relaxed:

- `version: 2`, `character: "avatar-v1:<kit id>"` (1–64 of `[A-Za-z0-9_-]`).
- per pose `provenance`: `base` (rest only), `generated` or `retargeted`;
  `image` and `source` are null (pose photos are not delivered, and the
  continuous mouth never reads where the landmarks were in an answer: those
  arrays were half of every visitor's download); `registration_rms` is null
  exactly when retargeted.
- Points in manifest units to five decimals (1/15000 of a mouth width): 69
  KB raw, 25 KB gzipped, where the first version was 152 and 58.
- `jaw_range`: the profile jawRange the geometry is true at (0.85 for every
  kit now). The engine's movement factor is `jawRange / jaw_range`
  (version 1: `jawRange / 0.85`, unchanged).
- `frame`: `{image_size, to_manifest}`, the 2×3 matrix from base pixels to
  manifest units: the base levelled about its mouth and scaled so the face is
  as wide as the Reference's face in its manifest. Every Reference threshold
  (0.007 RMS, the embed's ranges) then means the same for any framing.
- `kit`: `{version, prompts, reference}` (`KIT_VERSION` 2).

The embed accepts it through `validateMotionManifest` (continuous mouth only;
the lab's crossfade player keeps `validatePerformanceManifest`, version 1).
`embed/src/mouth/__tests__/fixtures/avatar-motion.json` and
`avatar-motion-fitted.json` are written by the backend builder and checked by
both test suites (the backend compares them byte for byte but for
`kit.prompts`, provenance the embed never reads, so a new wording of the
prompts does not oblige the embed's fixtures to be rewritten;
`LIVEFACE_WRITE_FIXTURES=1` rewrites them). The fitted fixture is a kit whose
model over-acted AA, OO and F/V by a quarter, brought back to the Reference's
size, with EE, OH and TH retargeted: the embed plays each of its shapes as
the bundled motion plays the same shape on the same face.

## Profile fit, and the Reference

- **The teeth photo** is the teeth request's answer, handed on only if the
  embed would draw it (`dental_photo.accept_teeth_photo`). The embed throws
  on a photo it refuses and the avatar drops to the classic mouth (only the
  motion has a fallback, the bundled one), so a refused photo is not handed
  on (`teeth_source` null; `teeth_report` says why: `teeth_photo_refused`,
  `no_teeth_visible`, a failed check, or the request's own reason) and the
  profile is fitted for the geometric teeth. The Reference's own EE shows
  tips only (central crown 0.070) and would be refused; `oral-detail-v3` is
  accepted (0.115). That is why the teeth are their own request: a spoken EE
  with the crowns the embed needs would lift the upper lip far above speech.
- **teethY** = where the teeth photo's upper arch ends (the bottom of the
  arch the embed extracts, which `dentalPlacement` seats), carried by the
  photo's registration onto the base, measured below the neutral seam
  (`centralMouthAnchors`) in rest mouth widths: skull-fixed, so its lifted
  upper lip is not taken for lower teeth. Plus 0.0243
  (`REFERENCE_TEETH_DROP`), less 0.055 (the renderer's seat). The allowance
  is calibrated on `oral-detail-v3` registered onto the Reference portrait:
  its arch ends 0.0467 below the seam, and the hand-tuned **0.016** draws it
  at 0.071, so v3 fits **0.016**.
- **teethScale** with a teeth photo = its mouth width / rest mouth width
  (teeth at their photographed size; 1.13 for v3, which the Reference
  renders at the untuned default 1.00). Without one = the Reference's
  mouth-to-face width ratio over this face's (1.00 on the Reference).

## Wired (services/mouth_kit.py)

**When.** At Finish, for a person (`services.creations._own_mouth`), and by the
Mouth panel's one AI action (`POST /orgs/{org}/avatars/{id}/mouth-kit`). AI
is allowed exactly as for every step: the organization's switch, the image
model configured, the monthly image limit, the member's current
`third_party_ai` consent. A member who has not agreed to the words in force
is asked when they press "Looks right" / "Save the points" (step 4), before
anything is sent; "Not now" finishes with the standard mouth. Not allowed:
the photographic mouth with generic teeth, the reason in
`mouth_config.teeth.note`, the bundled motion. The kit is made from the
avatar's picture as rigged and the rig's 478 points. A failure to tell
whether AI is allowed (the database) never fails the finish either.

**Calls.** `CallGuard` wraps `imagegen.edit_image`: before each call, under
one lock, the switch and the limit are read again, the limit counting this
kit's calls still in flight (so three concurrent calls never pass its last
unit together); a switch turned off or a limit reached raises
`ImageGenUnavailable` with `code`/`detail`, and every request not yet
answered is given up with that reason, nothing more sent. The consent is
recorded before the first picture leaves: on the avatar for the panel's
job, and for a finish on the creation's row, committed in a transaction of
its own (a finish that fails later, or a restart, deletes the half-built
avatar, and the record must outlive it). Recording it is tried again before
every call until it succeeds; a call that cannot have it recorded is not
sent (`consent_not_recorded`), so nothing ever leaves without the record of
what allowed it. The provider call is bounded by imagegen's timeout inside
the guard, not around it. Each call is metered as it ends (usage source
`mouth_shapes`, classified by `call_billing`: an answer, a timeout and a
cancelled call count; nothing sent or an HTTP failure does not; the single
"ee" photo, `make_teeth`, classifies the same way). Concurrency 3; the whole
kit waits outside the job runner's slot (`JobRunner.outside_slot`), and a
finish holds no database connection while it waits (its rows are read,
built detached, and written in one short transaction at the end).

**Where it lives.** `mouth_config.motion_key` =
`orgs/<org>/avatars/<id>/mouth-motion-<stamp>.json` (compact JSON, a fresh
key each time, beside the teeth photo's `mouth-<stamp>.webp/.json`), when
the kit made shapes of the person's own: one with none plays the bundled
motion (its manifest would only be the Reference's shapes, fitted by mouth
width, which is what the bundled motion plays), and the panel's job fails
rather than replace shapes of an earlier kit. `mouth_config.profile` gets
the kit's teeth fit (teethY, teethScale); with the owner's own teeth photo
nothing (it is kept, and not asked for). The teeth photo is stored through
`mouth_photo.admit_photo`: cut to the lips (`crop_to_mouth`: the renderer and
the teeth test read the photo inside its lips only, so a 1024 px face is
mostly download for nothing), the WebP visitors get, the teeth test on those
bytes; were the WebP refused where the PNG passed, the profile is refitted
for the drawn teeth (`for_drawn_teeth`). Record `{source: "ai", model}`; the
owner's upload is never replaced. `mouth_config.kit` is the owner-facing
record: id, recipe, model, per-shape provenance with the reason a shape was
retargeted, `teeth: {used, reason}` (a photo that failed a check names the
check: the teeth note `teeth_photo_rejected` carries it as `reason`), the
profile values it set (`fitted`), calls, `state` ("made" or "dropped", with
`dropped: {code, detail}`) and `rebased_at`.

**Teeth changed later.** An owner's upload replaces the kit's teeth photo and
its disclosure; removing the photo removes both. Either way the teeth values
the kit fitted (and the owner has not moved since) are refitted for the teeth
drawn now (`mouth_kit.teeth_changed`): an upload's defaults, or the drawn
teeth's fit. Left as they were, the drawn teeth sat 0.05 mouth widths low and
5% large.

**Publish.** The motion is copied to `published/r<rev>/mouth-motion.json`
like the teeth photo (deleted with the avatar, restored into a fresh draft
key by Discard with the kit record, which then deletes the discarded draft's
own mouth files), and `publishing._mouth_view` serves it as
`mouth.motion_url` to the widget and the share page. Every revision but the
two in use is pruned at each publish, found by listing `published/`
(revisions have gaps: the draft revisions that were published), and the
draft's mouth files nothing names any more (a process that died between
writing one and committing the row) are swept. It is fetched cross-origin
from customers' pages: the local storage route is on `PublicCorsMiddleware`'s
public surface (the page's origin reflected, preflights answered). A
published file's URL is the same for every page view within the hour
(`LocalStorage` signs published keys with the end of the next window as
their expiry), and the browser keeps it for as long as the URL is valid, so
a visitor coming back downloads neither the motion nor the teeth photo
again; the draft's JSON stays `no-cache` (the draft rig is rewritten in
place). An S3/R2 bucket needs the same CORS rule for JSON, and its presigned
URLs stay per request. The owner API returns the DRAFT `mouth.motion_url` on
every route that returns one avatar (`api.avatars._SignedMouthRoute`), so the
dashboard previews what visitors will get; the avatar list leaves it null
(it shows no mouth, and signing each would cost a storage round trip per
avatar).

**Disclosure.** `ai_edited.mouth_shapes = {model, generated}` when the kit
has shapes an AI made (retargeted ones are the Reference's movement, not
AI pixels); mode `mouth_shapes` when nothing else was AI-made (teeth win:
`mouth_photo.mouth_disclosure`). Publish drops it unless the published
mouth is continuous and plays its own motion (the teeth entry's rule);
Discard re-derives it from the restored kit record.

**Later edits.** The kit follows its face, with no AI call
(`follow_points`, `rebase_manifest`: the new points are the rest pose, and
every shape moves from it by the displacement it had, in base pixels, with
the frame recomputed; onto the same points and picture it is the identity):
points re-confirmed (Mark the face's save), a re-detection, and a crop, a
crop reset or an undo of either (a crop cuts the same pixels at whole
pixels: in manifest units nothing moves). A background change keeps the kit
as it is. A re-detection (`rig.process_avatar`, a request's background task
that reads its row before detecting and writes it after the layers) moves
the kit under the avatar's edit lock, on the row as it is then, in a
transaction of its own (`mouth_kit.follow_redetection`), so a Mouth panel kit
stored in between is never overwritten; the draft is then marked unpublished.
A kit that cannot follow is dropped (the bundled motion plays, the shapes'
disclosure goes, the record says `rebase_failed`). The teeth photo stays
whatever the portrait: the renderer registers it by its own landmarks.

**The Mouth panel's job.** `POST /orgs/{org}/avatars/{id}/mouth-kit
{consent_id}` → 202 `{job}` (step `mouth_kit`), polled with `GET` on the same
path (`{job}`: live progress, counted over the seven requests, or six with
the owner's own teeth; then done or failed; null when this process ran none).
409 `mouth_kit_in_progress` while one runs. A draft edit: the owner
publishes. It follows the face as it is when it stores (re-marked,
re-detected or cropped meanwhile). A kit that made none of the six shapes
fails with the reason and leaves the draft alone. Where no kit can be made on
the server (no face detector), the single "ee" photo instead
(`mouth_photo.make_teeth`), unless the owner uploaded teeth.

**Step 5's last stage** says whether the person's own mouth was made:
`publishing`, or `publishing with the standard mouth` (no AI allowed after
all, or it failed), so the checklist never ticks a mouth that was not made.

- The continuous mouth's F/V lip-contact correction (tuned for the
  Reference's F/V photo) still applies to every manifest when a teeth photo
  is present.
