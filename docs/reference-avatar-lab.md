# Reference avatar lab

Latest improvement: see [low-delay speech and photo testing](speech-streaming-2026-09-07.md).
The preceding [lip-driven tooth visibility work record](lip-coverage-2026-09-07.md) is retained.
The preceding [softer dental-lighting work record](dental-lighting-2026-09-07.md) is retained.
The preceding [broken-teeth repair](dental-rendering-repair-2026-09-07.md) is retained.
The earlier continuous renderer and private previews were deployed 2026-09-06
via `personal_server`; its verification is retained below as historical evidence.
A 9/10 rating or
superiority over SitePal has not been established by a blinded viewer test.

Open `/reference-avatar` after signing in. This is separate from the original
avatar editor, Photoface HD, and the timing comparison lab. A bundled fictional
photographic character works without creating or publishing an avatar record.
Saved ready photo avatars can also be selected.

## Continuous renderer and own-photo uploads — current

The previous multi-photo crossfade could show two sets of teeth or lips while
changing poses. The default is now `ContinuousMouth`: one original face/lip
texture, moving geometry, and one stable mouth interior. It does not dissolve
between expression photographs. A continuous geometry interpolator replaces
closest-edge switching; critically damped motion retains velocity when a sound
interrupts the previous sound. Bilabial closure has a faster settling rate.

The seven authored shapes still supply landmark movement, retargeted in each
portrait's mouth coordinate system. The nose and eyes stay outside this local
deformation. The fictional sample now uses its dedicated `oral-detail-v3` photo
for separate, fixed-scale enamel arches, with independent mouth shading and
lower-arch movement. A personal portrait defaults to adjustable
oral geometry; the sample's teeth are never put into a customer's face.

How to test a photo:

1. Open Reference avatar and choose **Upload a photo** (or drop an image).
2. Use a clear, front-facing, closed-mouth JPEG/PNG/WebP, up to 15 MB and
   24 megapixels. The server corrects EXIF orientation and resizes to 1600px.
3. Inspect AA/EE/OO/P-B-M, adjust movement/teeth, then **Generate and compare**.
4. Optionally add a second photo of the same person saying “ee”, with clear
   upper teeth, a small inter-arch gap and matched lighting/angle, via **Add
   mouth photo**. This supplies their enamel texture. **Use fitted mouth
   instead** removes it from the preview.
5. Replay or record the comparison without generating speech again.

The new authenticated `POST /orgs/{org_id}/lab/reference/preview` endpoint reuses
existing face detection, rig construction, signed storage and candidate cleanup.
It refuses synthetic/no-face results, undersized faces and wrong mouth poses.
It creates no avatar database record and cannot publish anything. Files use
UUID keys under the authenticated organisation's candidate directory and have
the existing 24-hour cleanup policy; signed links have their usual expiry.
These are temporary in-page tests, lost on reload, not library saves. Processing
uses this application's server, not a third-party AI image provider.

Verification for the earlier 2026-09-06 continuous-renderer revision:

- 94 renderer tests: continuous transitions across every pose pair, exact
  anchors, closure, interrupted velocity, frame-rate-independent integration,
  face-boundary preservation, malformed oral rigs and existing engine tests.
- Production frontend and embed builds pass (existing large-bundle advisory).
- 88 targeted backend tests pass across preview validation/security, lab timing,
  candidate cleanup, existing uploads, avatars, rig fitting, envelopes, widget
  bundles and face types.
- Real portrait and mouth-detail HTTP uploads both returned 201 with 478-point
  rigs and readable signed assets. The disposable avatar library stayed 1 → 1.
- Browser inspection: AA/OO close-ups, actual speech, two completed downloadable
  recordings, no browser errors. New proof is under
  `output/reference-proof-continuous/`; public comparison videos now use this
  renderer. The 76-character Kokoro test lasts about five seconds.
- Automated browser file selection was blocked by the Chrome extension's file
  permission. Actual upload processing was verified via HTTP, not falsely
  reported as a completed browser file-picker test.
- Live page displays the upload button and new renderer. Both portrait and
  mouth-detail processing also passed inside the deployed production container,
  returning 478 landmarks with no quality warning. The new public mouth video's
  SHA-256 matches the local recording:
  `cb3b44c07ae99f8e55bbb091b6ce29a925cb72a50a34a8ada2716f14d98f457e`.

Remaining limitations: single-photo lips still deform rather than reconstruct
true volume; photo-derived enamel does not reconstruct a true 3D mouth;
different faces and lighting need individual fitting. Recorded close-ups show
one tooth row rather than crossfaded rows, but do not establish a perceptual
score or SitePal superiority. The original editor/widgets remain opt-out.

## Earlier multi-photo performance — historical implementation

The fictional reference now has seven registered photographic keyframes:
rest, AA, EE, OO, OH, F/V and TH. Eight inspection buttons include an explicit
P/B/M seal. Each expression brings its own lips, teeth, tongue and shadows.
No generic white tooth drawings are added on this path.

`PhotographicPerformance` uses 478 detected landmarks and 655 shared triangles.
Stable eye/nose-bridge anchors register each expression to the neutral portrait
with a rotation/scale/translation fit, without affine shear. Geometry and
texture use the same articulation coefficients. A soft, spatially limited mask
keeps the source portrait outside the mouth region; the nose is explicitly
protected from the old pucker warp. Interior texture weights are sharpened to
reduce double teeth, while the outer lips transition smoothly. Fast closure
settling protects P/B/M from anticipatory rounding.

The authoring tool is `backend/scripts/build_reference_performance.py`.
Source PNG masters are preserved in `assets/reference-performance/`; six
compressed WebP delivery poses and the manifest live in
`frontend/public/lab/reference/`. The neutral portrait remains the original PNG.
Delivery images total roughly 1.4 MB in addition to the 2.2 MB neutral portrait.
No image-generation service is called during playback.

The original photo editor and published avatars do not use this renderer.
Other uploaded portraits retain the geometry prototype: these particular
mouth photographs must never be transferred to another person's identity.
The original geometry version remains selectable as “Previous prototype.”

## Earlier multi-photo verification and benchmark

- 86 renderer tests pass, including exact authored poses, normalized sparse
  interpolation, bilabial closure, preserved face boundaries, shared media
  attachment and recorder-failure cleanup. Embed and frontend production
  builds pass; the existing large-bundle advisory remains. The asset compiler
  passes Ruff and all six expression registrations are below the RMS threshold.
- An actual 1280×720 video with the shared speech audio can be recorded and
  downloaded directly from the page. It captures both canvases at once.
  No microphone, server upload, or additional speech generation is involved.
  Interrupted recordings fail visibly instead of being presented as complete.
- The 115-character English test phrase was synthesized by local Kokoro Heart
  with native phoneme timing (7,760 ms). Both Liveface previews use the same
  audio, cue sequence and clock. Mouth and portrait recordings were exported.
- The final mouth recording is in
  `output/reference-proof-final/comparison-mouth.mp4`. Earlier six-pose
  recordings and the reproducible UI report are under `output/reference-proof-v2/`.
  Those historical files are retained locally. Public mouth/portrait comparison
  URLs now contain the newer continuous-renderer recordings described above.
- The six-pose 1440×1000 desktop check measured static paired-preview frame
  intervals of 16.7 ms median and 16.8 ms p95. This is not a mobile or speech
  performance claim. The 390×844 layout had no horizontal overflow; no browser
  errors were observed in that run. The final OH shape was separately inspected.
- SitePal's public editor was tested with the same words and its Julie (US)
  voice. Successive speech screenshots showed integrated lips/teeth and modest
  articulation. This is a different character and different synthesized audio,
  not an objective synchronization or blinded preference comparison.
- The new photographic mouths are visibly more coherent than Liveface's
  original drawn interior, especially rounded vowels. Remaining risks include
  interpolated tooth texture stretch, brief transition softness, weak TH contact,
  frontal-only geometry and limited character coverage. Unit tests cannot award
  a perceptual score or establish a product-wide win.

Reproduce the asset manifest from the repository root:

```sh
backend/.venv/bin/python backend/scripts/build_reference_performance.py
```

`frontend/scripts/reference-proof.mjs` contains the disposable-local-account
regression scenario. It rejects non-local targets and takes test credentials
from environment variables rather than storing production credentials.

## Earlier geometry prototype (still selectable)

- Seven silent inspection poses: rest, P/B/M, AA, EE, OO, F/V, TH.
- Portrait and mouth close-up views. Zoom changes only presentation; playback
  is not restarted.
- Side-by-side original interior and a new software-projected 3D oral model.
  Both use the same photographic texture and existing face warp.
- Skull-fixed upper teeth and a lower arch rigidly rotated about a posterior
  jaw hinge; individual curved tooth surfaces with directional shading.
- A tongue surface with smoothed contact lift, local lip-mound projection,
  upper-lip retraction on F/V, clipping by the existing lip aperture.
- Calibratable teeth size/height, enamel warmth, lip projection, movement range.
  The bundled portrait has an initial tooth-height fitting of 0.016 mouth widths.
- Explicit local draft saving, scoped by organisation and avatar, with range
  validation and storage-error feedback. No rig/API/database writes.
- Speech reuses the timing lab endpoint and player. In this page BOTH engines
  receive the same cues and audio clock, isolating rendering differences.
  Replay uses the already-generated recording. Head/body motion and blinks are
  disabled for inspection; the existing gaze machinery is still active.

## Isolation and ownership

`embed/src/mouth-extension.ts` defines an optional typed renderer seam. The
stable engine imports its types and a small neutral-seam coordinate helper,
never the implementation under `lab/`.
Its defaults remain unchanged when `mouthExtension` and `pose` are omitted.
The original avatar editor and widgets do not opt in. The lab can adjust skin
points before midpoint subdivision and draw under the engine's measured mouth
aperture. Canvas save/restore is owned by the engine.

The lab renderer and pure geometry/profile model live under `embed/src/mouth/` (graduated from `lab/` when it became selectable on real avatars).
The frontend lab feature owns controls, local drafts, sample metadata and page
composition, following the existing feature boundaries and EN/FR locales.

## Earlier geometry prototype limits

This is NOT a person-specific reconstructed mouth, a full 3D face or verified
SitePal parity. Tooth and tongue assets are still generic, shaded geometry.
The lip texture and most facial motion still come from a single-photo warp.
The inner lip funnel is not reconstructed: rounded-lip enamel occlusion uses
an explicit approximation to avoid showing teeth through OO. Front views only;
there is no promise of correct head turns. TH and F/V require further visual
calibration, not merely passing geometry tests.

Production promotion requires recorded, matched-audio evaluation on the target
portrait and devices: closures, F/V contact, AA/EE/OO distinction, transitions,
stable identity, lighting/texture match and viewer preference. Do not derive a
quality score from the number of passing tests.

## Reference asset provenance

`frontend/public/lab/reference/portrait.png` is a fictional portrait generated
with the built-in image-generation tool on 2026-09-06. It does not depict a
known customer. `rig.json` contains 478 landmarks detected using the existing
local MediaPipe model; the builder refuses synthetic fallback. Reproduce with
`backend/.venv/bin/python backend/scripts/build_reference_rig.py` from the repo
root (macOS may require graphics access for MediaPipe).

Generation prompt:

> Use case: photorealistic-natural. Asset type: neutral reference portrait for a talking-photo avatar rendering experiment. Create one fictional adult woman approximately 35 years old, natural dark brown hair tucked behind ears, brown eyes, wearing a simple matte charcoal crew-neck top. Square photographic head-and-shoulders composition, entire head and hair visible with a little margin. Face centered, perfectly front-facing, camera at eye height, zero head tilt, eyes looking straight at camera. Lips gently fully closed, no visible teeth, relaxed neutral-friendly expression, no broad smile. Even soft frontal studio light with very subtle shading, plain warm light gray background. High-detail realistic skin pores, natural lip texture, subtle asymmetry, crisp eyes. This must look like a natural professional portrait photo, not CGI, not a beauty-filter face, not an illustration. No hair across eyes or lips, no glasses, no earrings, no props, no text, no watermark. The face should fill most of the square while keeping all hair and shoulders in frame.

Expression edits used the built-in image-generation skill and the neutral image
as their identity/framing reference. The authoring brief specified the same
camera, light, face and skin, changing only speech anatomy: open relaxed AA;
horizontal EE; visibly open pursed OO; relaxed rounded OH; upper incisors against
the lower lip for F/V; tongue contact for TH. The first closed-pucker OO was
rejected and regenerated with a visible oral opening. The generated source
masters are retained, not synthesized from SitePal imagery.

Generated-image source identifiers, all in the thread's `generated_images`
directory, on 2026-09-06:

| Pose | Source file |
| --- | --- |
| AA | `exec-534c7175-a9a7-4ede-b7cc-de494e9dc439.png` |
| EE | `exec-103c564b-c121-45c1-a957-d7845f6fee57.png` |
| OO | `exec-2f731e37-6efc-4596-a27a-18d1f9f47224.png` |
| OH | `exec-ae78d0ed-e459-4b20-a51e-e6397531f58c.png` |
| F/V | `exec-e3bec260-1ede-432e-a4de-1a29a15e5dae.png` |
| TH | `exec-65af291f-25e9-4864-ac4a-2f30f4462cbf.png` |

## Earlier geometry verification record

- 79 renderer unit tests pass; embed and frontend production builds pass.
  The existing large-bundle warning remains. Python rig builder passes Ruff.
- Geometry invariants: rigid jaw distances, neutral coordinate projection,
  finite arch vertices, tongue lift, bounded projection, draft validation,
  rounded-lip occlusion, explicit closed poses.
- Local browser: generated portrait, pose changes and close-ups, fitted tooth
  position. The close-up exposed a corner-chord anchoring error; oral geometry
  now uses the measured central lip seam's vertical offset.
- A 7.8-second Kokoro recording played with native timing on both previews;
  replay, pause and resume were exercised through the UI.
- Local draft persistence was verified by changing enamel warmth to 0.65,
  saving, reloading and observing 0.65. Controls were then reset to the sample
  fitting and saved again. Final closed P/B/M and tooth-free OO close-ups were
  inspected. No mobile performance or viewer-rating benchmark was performed.

No customer avatar records are created or modified by the reference character.
