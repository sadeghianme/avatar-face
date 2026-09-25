# Performance kit: the Reference's mouth kit, from a person's photo

Status: building blocks, 2026-09-26. Not wired into the finish job, the API or
the UI yet; the creation finish job orchestrates them in a later step.

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
| Prompts | `POSE_PROMPTS`, `pose_prompt(shape)`, `PROMPTS_VERSION` | same person, pose, framing, light; only mouth and jaw change. EE asks for the upper teeth in full: it doubles as the teeth photo |
| Request | `prepare_pose_request(base_png, base_points, shape, kind)` → `PoseRequest` | AI adjust's face crop (1.6 face boxes, 1024 px); after a refusal, its head-and-shoulders crop (`photo_adjust.head_crop_box`). `to_base(answer_size)` maps answer pixels back |
| Registration | `similarity_on_anchors`, `register`, `registration_rms` | moved out of `scripts/build_reference_performance.py`, which still writes the identical `performance.json` (tested byte for byte) |
| Checks | `register_answer(...)` → `PoseRegistration` | detect, map back, register on eye corners + nose bridge onto the detector's own view of the base photo (`base_detected`), RMS ≤ 0.007 in manifest units; refuses head zoom/tilt, moved nose or eyes, turned head, skin ΔE > 8, or a mouth not in the asked shape. Targets = confirmed points + (registered − detected base), so the owner's corrections to the marks are kept and never read as motion |
| Fallback | `retarget_reference_pose(shape, base_points, reference, amplitude)` | Reference displacement, horizontal × mouth-width ratio, vertical × upper / lower lip-height ratio (blended across the seam, bounded to 0.6–1.6 × the width ratio), × `amplitude` = fitted jawRange / 0.85 so it is true at the manifest's `jaw_range`. Baked by the backend: the embed has no retarget code |
| Fit | `fit_profile(...)` → `ProfileFit` | teethY, teethScale, jawRange; clamped to `MouthProfile`'s ranges; defaults with a reason when unmeasurable. `teeth_photo` says whether it is fitted for the EE photo (handed on) or the geometric teeth |
| Teeth photo test | `dental_photo.accept_teeth_photo(image, points, inner_ring)` → `Acceptance` | the embed's DentalOralSurface test, ported pass for pass (extraction canvas, `extractDentalLayers`, `dentalCrownCoverage`): arch ≥ 110/512 wide, ≥ 180 px of enamel, central crown ≥ 0.10 mouth widths. Pixel-exact against the embed's code (`dental-extraction.json` fixture) |
| Manifest | `build_manifest(...)` | version 2, see below |
| Orchestrator | `build_kit(base_png, base_points, edit_image, *, concurrency=3, per_call_timeout=120, on_progress=None, kit_id=None, detect=None, reference=None)` → `KitResult` | injected edit function; concurrency bound; refusal → one head-crop retry; nothing else asked twice |

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
backend builder and checked by both test suites.

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

## For the integration (finish job)

- Pass `imagegen.edit_image` wrapped: check the organisation's AI switch and
  the image limit before each call and raise `imagegen.ImageGenUnavailable`
  to stop (nothing more is sent; the shape and all later ones are
  retargeted). Requires the `third_party_ai` consent: face crops leave the
  server.
- `build_kit` raises `KitUnavailable` (no detector) before any call, and
  `ValueError` for points that are not 478 finite pixels. `base_points` must be
  the rig's points on `base_png` (the published rig, as the owner confirmed
  them), so the manifest's rest pose is the engine's neutral. `build_kit`
  detects `base_png` itself once; `KitResult.base_detected` says whether that
  detection was used (false: no face found, or one far from the confirmed
  points, and the answers were registered on the confirmed points).
- Meter from `KitResult`: `billed_calls` (answered: image, refusal, or no
  image) and `call_log` (per call `billed: true | false | null`; null is a
  timeout that may have been billed).
- Store and publish: the manifest JSON, the teeth photo (`teeth_source.png`,
  `teeth_source.rig`, present only when the embed accepts it) as the existing
  `oral_image_key` / `oral_rig_key`, and `profile`. The mouth config needs a new key for the manifest (for example
  `motion_key`), copied on publish like the teeth photo, and served by
  `publishing._mouth_view` as `motion_url` (a presigned URL; the storage
  bucket must allow cross-origin `fetch` of JSON, not only images). The
  embed reads `mouth.motion_url`; absent, it plays the bundled motion as
  today, and it falls back to it if the avatar's manifest fails to load.
- The dashboard previews through the same loader and must get the same
  config: `useAvatarMouth` passes `motion_url` on (reloading only when its
  path changes, not on a re-signed URL), the share page gets it from the
  published `mouth`, and the owner's detail page takes it from
  `avatar.mouth.motion_url` (`draftMouthConfig`). So the owner API's avatar
  detail must return the DRAFT `mouth.motion_url` as well, or the owner tunes
  the profile against the bundled motion while visitors get the kit.
- A re-confirmed set of points changes the rest pose: rebuild the manifest,
  moving each pose by what it moved from the old points (targets − old
  confirmed points, recoverable through `frame.to_manifest`) onto the new
  ones.
- The continuous mouth's F/V lip-contact correction (tuned for the
  Reference's F/V photo) still applies to every manifest when a teeth photo
  is present.
