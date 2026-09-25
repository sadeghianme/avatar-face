# Performance kit: the Reference's mouth kit, from a person's photo

Status: wired, 2026-09-26 (Step 5, "Preparing your avatar"). Finishing a
person makes their kit before the first publish; the Mouth panel makes it
for an existing avatar; publishing serves it to the widget and the share
page. `services/performance_kit.py` makes a kit; `services/mouth_kit.py` is
everything around it (who may send, metering, storage, disclosure, later
edits). See "Wired" below.

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
| Prompts | `POSE_PROMPTS`, `pose_prompt(shape)`, `PROMPTS_VERSION` (`pose-prompts@2`) | same person, pose, framing, light; only mouth and jaw change. EE asks for the upper teeth in full: it doubles as the teeth photo. @2 after the first run on real Gemini: AA "moderately open, as in normal conversation, not a yawn or a shout" (it came back yawn-wide), TH "only the very tip of the tongue, barely visible between the front teeth", F/V "the upper front teeth pressing gently on the lower lip; the lips otherwise relaxed" |
| Request | `prepare_pose_request(base_png, base_points, shape, kind)` → `PoseRequest` | AI adjust's face crop (1.6 face boxes, 1024 px); after a refusal, its head-and-shoulders crop (`photo_adjust.head_crop_box`) padded to a square (`head_square`, at the photo's own resolution, the photo's edge filled in like the face crop's). Both are square because the model answers a square with a square: the 6:7 head box would come back reframed to the model's own aspect and map back with a scale per axis (`to_base`), the mouth 0.1-0.2 mouth widths off |
| Registration | `similarity_on_anchors`, `register`, `registration_rms` | moved out of `scripts/build_reference_performance.py`, which still writes the identical `performance.json` (tested byte for byte) |
| Checks | `register_answer(...)` → `PoseRegistration` | refuses an answer whose aspect differs from what was sent by more than 1% (`aspect_changed`); detect, map back, register on eye corners + nose bridge onto the detector's own view of the base photo (`base_detected`), RMS ≤ 0.007 in manifest units; refuses head zoom/tilt, moved nose or eyes, a head turned (the nose tip's SIGNED offset between the cheeks, `signed_yaw`: unsigned, a turn one way and the same turn the other read the same), skin ΔE > 8, or a mouth not in the asked shape. Targets = confirmed points + (registered − detected base), so the owner's corrections to the marks are kept and never read as motion. A check that raises is a rejected answer (`check_failed`) |
| Fallback | `retarget_reference_pose(shape, base_points, reference, amplitude)` | Reference displacement, horizontal × mouth-width ratio, vertical × upper / lower lip-height ratio (blended across the seam, bounded to 0.6–1.6 × the width ratio), × `amplitude` = fitted jawRange / 0.85 so it is true at the manifest's `jaw_range`. Baked by the backend: the embed has no retarget code |
| Fit | `fit_profile(...)` → `ProfileFit` | teethY, teethScale, jawRange; clamped to `MouthProfile`'s ranges; defaults with a reason when unmeasurable. `teeth_photo` says whether it is fitted for the EE photo (handed on) or the geometric teeth |
| Teeth photo test | `dental_photo.accept_teeth_photo(image, points, inner_ring)` → `Acceptance` | the embed's DentalOralSurface test, ported pass for pass (extraction canvas, `extractDentalLayers`, `dentalCrownCoverage`): arch ≥ 110/512 wide, ≥ 180 px of enamel, central crown ≥ 0.10 mouth widths. Pixel-exact against the embed's code (`dental-extraction.json` fixture) |
| Manifest | `build_manifest(...)` | version 2, see below; the kit id is ASCII `[A-Za-z0-9_-]{1,64}` exactly as the embed accepts it |
| Rebase | `rebase_manifest(manifest, base_points)` | the same kit on re-confirmed points of the same picture, no AI call (see "Wired") |
| Orchestrator | `build_kit(base_png, base_points, edit_image, *, concurrency=3, per_call_timeout=None, on_progress=None, kit_id=None, detect=None, reference=None)` → `KitResult` | injected edit function; concurrency bound; refusal → one head-crop retry; nothing else asked twice; the shapes run in a task group, so a failure that is not a provider call's cancels and awaits the calls in flight and raises `KitFailed` with every call sent accounted for. `per_call_timeout` defaults to imagegen's own 90 s, and a timeout either way (asyncio's, or httpx's read/write timeout) is `timeout`, billed null; a connect timeout never reached Google (`provider_error`, billed false): `call_billing(error)` is the one classification. `on_progress(fraction, message, shapes_done)` |

## Manifest version 2

Everything ContinuousMouth reads keeps the Reference's meaning (seven poses in
`rest, aa, ee, oo, oh, fv, th` order with 478 `points`, `center`,
`mouth_width`, `triangles`, `inner_ring`, `outer_ring`). Added or relaxed:

- `version: 2`, `character: "avatar-v1:<kit id>"` (1–64 of `[A-Za-z0-9_-]`).
- per pose `provenance`: `base` (rest only), `generated` or `retargeted`;
  `image` is null (pose photos are not delivered); `source` is the answer's
  landmarks as fractions of the answer, null when retargeted;
  `registration_rms` is null exactly when retargeted.
- `jaw_range`: the profile jawRange the geometry is true at. The engine's
  movement factor is `jawRange / jaw_range` (version 1: `jawRange / 0.85`,
  unchanged), so at the fit the person's poses play as photographed.
- `frame`: `{image_size, to_manifest}`, the 2×3 matrix from base pixels to
  manifest units: the base levelled about its mouth and scaled so the face is
  as wide as the Reference's face in its manifest. Every Reference threshold
  (0.007 RMS, the embed's ranges) then means the same for any framing.
- `kit`: `{version, prompts, reference}`.

The embed accepts it through `validateMotionManifest` (continuous mouth only;
the lab's crossfade player keeps `validatePerformanceManifest`, version 1).
`embed/src/mouth/__tests__/fixtures/avatar-motion.json` is written by the
backend builder and checked by both test suites (the backend compares it
byte for byte but for `kit.prompts`, provenance the embed never reads, so a
new wording of the prompts does not oblige the embed's fixtures to be
rewritten; `LIVEFACE_WRITE_FIXTURES=1` rewrites them).

## Profile fit, and the Reference

- **The teeth photo** is the EE answer only if the embed would draw it: a lip
  gap of at least 0.08 (the mouth-photo upload's threshold), then
  `dental_photo.accept_teeth_photo`. The embed throws on a photo it refuses
  and the avatar drops to the classic mouth (the bundled-motion fallback
  reuses the same photo), so a refused EE stays a generated pose but is not
  handed on (`teeth_source` null, reason `teeth_photo_refused`) and the
  profile is fitted for the geometric teeth. The Reference's own EE shows
  tips only (central crown 0.070) and is refused; `oral-detail-v3`, the photo
  the Reference renders its teeth from, is accepted (0.115). The EE prompt
  asks for full crowns for this reason.
- **teethY** = where the teeth photo's upper arch ends (the bottom of the
  arch the embed extracts, which `dentalPlacement` seats), carried by the EE
  registration onto the base, measured below the neutral seam
  (`centralMouthAnchors`) in rest mouth widths: skull-fixed, so a smile's
  lifted upper lip is not taken for lower teeth. Plus 0.0243
  (`REFERENCE_TEETH_DROP`), less 0.055 (the renderer's seat). The allowance
  is calibrated on `oral-detail-v3` registered onto the Reference portrait:
  its arch ends 0.0467 below the seam, and the hand-tuned **0.016** draws it
  at 0.071, so v3 fits **0.016**. (A lip-relative measure would have put
  v3's teeth at the 0.06 limit, 0.044 mouth widths too low.)
- **teethScale** with a teeth photo = EE mouth width / rest mouth width (teeth
  at their photographed size; 1.13 for v3, which the Reference renders at the
  untuned default 1.00). Without one = the Reference's mouth-to-face width
  ratio over this face's (1.00 on the Reference).
- **jawRange** = 0.85 × this face's AA lip opening / the Reference's (0.85 on
  the Reference). The manifest records it as `jaw_range`, and every
  retargeted pose is baked × jawRange / 0.85, so at any profile a retargeted
  pose plays as the same Reference pose does through the bundled motion,
  and keeps its size relative to the person's own shapes (tested through
  the real `ContinuousMouth` with `avatar-motion-fitted.json`).

## Wired (services/mouth_kit.py)

**When.** At Finish, for a person (`services.creations._own_mouth`), and by the
Mouth panel's one AI action (`POST /orgs/{org}/avatars/{id}/mouth-kit`). AI
is allowed exactly as for every step: the organization's switch, the image
model configured, the monthly image limit, the member's current
`third_party_ai` consent. Not allowed: the photographic mouth with generic
teeth, the reason in `mouth_config.teeth.note`, the bundled motion. The kit
is made from the avatar's picture as rigged and the rig's 478 points.

**Calls.** `CallGuard` wraps `imagegen.edit_image`: before each call, under
one lock, the switch and the limit are read again, the limit counting this
kit's calls still in flight (so three concurrent calls never pass its last
unit together); a switch turned off or a limit reached raises
`ImageGenUnavailable` with `code`/`detail`, and every shape not yet
answered is retargeted with that reason, nothing more sent. The consent is
recorded on the avatar (and the creation) once, as the first picture
leaves. Each call is metered as it ends (usage source `mouth_shapes`,
classified by `call_billing`: an answer, a timeout and a cancelled call
count; nothing sent or an HTTP failure does not). Concurrency 3; the whole
kit waits outside the job runner's slot (`JobRunner.outside_slot`).

**Where it lives.** `mouth_config.motion_key` =
`orgs/<org>/avatars/<id>/mouth-motion-<stamp>.json` (compact JSON, a fresh
key each time, beside the teeth photo's `mouth-<stamp>.webp/.json`).
`mouth_config.profile` = the kit's fit (with the owner's own teeth photo:
only `jawRange`; the teeth fit stays theirs). The kit's EE is stored as the
teeth photo through `mouth_photo.admit_photo` (the WebP visitors get, the
teeth test on those bytes; were the WebP refused where the PNG passed, the
profile is refitted for the drawn teeth: `for_drawn_teeth`) with the record
`{source: "ai", model}`; the owner's upload is never replaced. No teeth
photo: standard teeth with a note, never a second call. `mouth_config.kit`
is the owner-facing record: id, recipe, model, per-shape provenance with
the reason a shape was retargeted, `teeth: {used, reason}`, calls, `state`
("made" or "dropped", with `dropped: {code, detail}`) and `rebased_at`.

**Publish.** The motion is copied to `published/r<rev>/mouth-motion.json`
like the teeth photo (pruned with its revision, deleted with the avatar,
restored into a fresh draft key by Discard with the kit record), and
`publishing._mouth_view` serves it as `mouth.motion_url` to the widget and
the share page. It is fetched cross-origin from customers' pages: the
local storage route is on `PublicCorsMiddleware`'s public surface (the
page's origin reflected, preflights answered), and a published copy's JSON
is cached like its images (`private, max-age=300`; the draft's JSON stays
`no-cache`, since the draft rig is rewritten in place). An S3/R2 bucket
needs the same CORS rule for JSON. The owner API returns the DRAFT
`mouth.motion_url` on every route that returns an avatar
(`api.avatars._SignedMouthRoute`), so the dashboard previews what
visitors will get.

**Disclosure.** `ai_edited.mouth_shapes = {model, generated}` when the kit
has shapes an AI made (retargeted ones are the Reference's movement, not
AI pixels); mode `mouth_shapes` when nothing else was AI-made (teeth win:
`mouth_photo.mouth_disclosure`). Publish drops it unless the published
mouth is continuous and plays its own motion (the teeth entry's rule);
Discard re-derives it from the restored kit record.

**Later edits.** Points re-confirmed on the same picture (Mark the face's
save, Re-detect): `rebase_manifest` makes the new points the rest pose and
moves every shape from it by the displacement it had (in base pixels,
through the old frame), with the frame recomputed; onto the same points it
is the identity. A new picture (a crop, a crop reset, an undo that puts
another picture back: a rig of another size) drops the kit: the motion is
deleted (the bundled one plays), the shapes' disclosure goes, the record
says `picture_changed`. The teeth photo stays: the renderer registers it
by its own landmarks, whatever the portrait. A background change keeps the
kit (no pixel of the face moves).

**The Mouth panel's job.** `POST /orgs/{org}/avatars/{id}/mouth-kit
{consent_id}` → 202 `{job}` (step `mouth_kit`), polled with `GET` on the same
path (`{job}`: live progress, then done or failed; null when this process
ran none). 409 `mouth_kit_in_progress` while one runs. A draft edit: the
owner publishes. A kit that made none of the six shapes fails with the
reason and leaves the draft alone. Where no kit can be made on the server
(no face detector), the single "ee" photo instead (`mouth_photo.make_teeth`),
unless the owner uploaded teeth.

- The continuous mouth's F/V lip-contact correction (tuned for the
  Reference's F/V photo) still applies to every manifest when a teeth photo
  is present.
