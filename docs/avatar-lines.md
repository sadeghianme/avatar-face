# Three avatar lines: human, animal, animation

Status: design v2, 2026-09-24, revised after an adversarial review (backend and
operations, rendering, product and privacy). Owner: avatars.

## Why

Customers bring three kinds of face, and a pipeline tuned for human photographs
serves two of them badly:

| Line | Examples | What goes wrong today |
|---|---|---|
| **Human** | a photo of a person, an AI portrait | works; points are never confirmed by the owner |
| **Animal** | a dog, a cat, a toon animal | nothing detects the face; a placeholder mesh is published automatically; the mouth shows human incisors |
| **Animation** | cartoon, anime, illustrated, 3D-render characters | treated exactly as human; stylised eyes and mouths are misplaced |

SitePal splits its editor the same way: "3D photoface" (human photos pushed onto
a 3D mould from points the user marks) versus "2D Illustrated" (Animals, Cats,
Dogs, Toon Animals, Anime, Toons…). Its illustrated animals and toons are a
**curated character library**, not detected uploads. Parity therefore needs
both a good upload flow and a small catalogue of ready characters.

## Principles

1. **One module per line over a shared core.** A line is configuration plus a
   few functions (detect, analyse, mouth style, AI presets). Storage, fitting,
   marking, publishing and the renderer core are shared.
2. **Nothing goes live on a guess.** Every new avatar passes a "place the
   points" step (one click when the validator is happy). No route publishes a
   first build that was not confirmed. The server enforces this, not the UI.
3. **AI prepares the photo; code animates it.** AI runs once, at creation, is
   never pre-selected, is shown side by side with the original, and is never
   the only copy.
4. **Consent follows the data, not the line.** Any step that sends pixels to a
   third party requires a recorded consent naming that provider. Without it,
   every line still works by hand.
5. **Heavy work never blocks the API**, and survives a deploy (jobs recover or
   fail cleanly after a restart).
6. **Published avatars change only when their owner publishes.** New rendering
   is a versioned *render profile* stored in the rig; a rig without one renders
   exactly as today, whatever its line.

## The creation flow

```
1 Upload + frame   file checks, EXIF rotation, metadata stripped; crop and
                   level pre-filled from the detected face; line suggested
                   (face in a photo → Human, face in artwork → Animation,
                   none → Animal), user can switch
2 AI adjust        optional, never pre-selected, consent required:
                   Touch up eyes & lips · Stylise (→ Animation) · Regenerate
3 Background       Remove · Keep original (applied to the image chosen in 2)
4 Place points     pre-filled; "Looks right" when the validator passes;
                   zoom loupe, keyboard nudging, talking preview
→ Avatar page      built from the confirmed points
```

AI adjust comes before background removal: the model would otherwise see (and
regenerate) the removed background, and removal is cheap to re-apply.
A good photo takes two clicks: Upload → Looks right.

Other entry points (catalogue, generate from text, stock, 3D/GLB) become
creations too, so they pass the same consent and confirmation.

## Backend

### Creations

Table `creations`: `id, org_id, created_by_id, face_type, status
(draft|finishing|finished|expired), revision, steps (JSON: original → adjusted
→ cutout, each {key, width, height, from}), analysis (JSON), anchors (JSON,
bound to the image key they were placed on), consent_id, avatar_id,
updated_at`. Choices are opaque ids (`original`, `adjusted:0`, `cutout`),
never raw storage keys. Every query filters on `id` and `org_id`.

| route | kind | does |
|---|---|---|
| `POST /creations` (file) | job | ingest (pixel cap before decode, EXIF transpose, re-encode without metadata, long edge ≤ 2048), analyse, suggest line |
| `GET /creations?status=draft`, `GET /{id}` | – | resume list; state + job progress |
| `PATCH /{id}` {face_type, crop, roll} | – | switch line / frame; invalidates downstream steps |
| `POST /{id}/adjust` {mode, style?, consent_id} | job | AI adjust, ≤ 2 candidates, local checks |
| `POST /{id}/background` {mode} | job | cut-out of the chosen image, RGB zeroed under alpha 0 |
| `POST /{id}/choose` {choice} | – | pick a step output; clears anchors bound to another image |
| `POST /{id}/detect` | job | the line's detector → anchors (Gemini only with consent) |
| `POST /{id}/preview-rig` {anchors} | – | the rig finish would build, nothing saved |
| `POST /{id}/finish` {name, anchors, image} | job | atomic draft→finishing; idempotent; builds, validates, publishes |
| `DELETE /{id}` | – | removes row and files now |

Races: a job records the `revision` it started from and stores its result only
if the row is unchanged (`UPDATE … WHERE revision = :rev`). One active job per
creation (409), a per-org cap, 503 + Retry-After when the queue is full.
Expiry is by rows: drafts idle for 7 days expire and their prefix is deleted.

### Jobs

`app/services/jobs.py`: in-process runner. CPU sections run in one worker
thread (MediaPipe, matting, compositing), network calls await on the loop.
Thread caps everywhere (ORT 2 threads, `cv2.setNumThreads(1)`,
`OMP_NUM_THREADS=2`). Any ONNX segmenter runs in a separate worker process with
a memory limit, so an out-of-memory kills the worker, not the API. Progress is
held in memory; only state transitions are written. At startup, jobs left
running and avatars stuck in `processing` are marked interrupted and
retryable. Every existing CPU path (process_avatar, set_background, crop,
layers, generate checks) moves onto the same executor.

### Lines

```
app/lines/  base.py (Line config + registry), human.py, animal.py, animation.py
app/services/
  landmarks.py      MediaPipe, loaded once, lock-guarded, versioned model + sha256
  face_template.py  478-point template: MediaPipe's detection of a fictional portrait
  anchor_fit.py     anchors → thin-plate-spline warp of the detected or template
                    mesh → Delaunay again → validator (0 flipped triangles)
  vision_points.py  Gemini vision keypoints (named model, metered, consent-gated)
  photo_analysis.py blur, exposure, size, eyes/mouth state (landmarks + blendshapes)
  photo_adjust.py   touch-up on a face crop with masked paste-back; stylise; regenerate
  background.py     segmenter per line; RGB zeroed under alpha 0
  consent.py        append-only consents table
```

| | human | animal | animation |
|---|---|---|---|
| detect | MediaPipe | Gemini points *if consented*, else template | MediaPipe → validator; Gemini points if consented, else template |
| anchors placed | head, eyes, mouth (as today), pupils | head, eyes, **mouth line** (2 corners + 3 along) + **chin**, no pupils | head, eyes, mouth line + chin, **iris ellipses** |
| confirm step | always shown | always, never one-click | always shown |
| render profile | `human@1` | `animal@1` (muzzle) | `toon@1` (flat art) / `human@1` (shaded renders) |
| mouth renderers allowed | classic, photographic | muzzle | toon, classic |
| layers (head/body split) | yes | no, until the general segmenter passes | no, until then |
| AI presets | touch-up, stylise, regenerate | regenerate (frontal, both eyes, mouth closed) | clean-up, regenerate |

"Confidence" is defined by the validator, not by the detector (MediaPipe gives
none): detected or not, eye/nose symmetry, eye aspect, mouth inside the face,
0 flipped triangles, frontal enough (animals: eye-nose symmetry).

### Fitting (the part that makes animals and cartoons work)

The placeholder mesh used today is not anatomical beyond lips, eyes and nose,
and applying marks region by region folds triangles (37–147 of 918 measured).
Replace it with:

1. A 478-point template, MediaPipe's own detection of a fictional frontal face, so
   every index keeps its meaning (61 is the left mouth corner, 10 the top…).
2. One global thin-plate-spline warp from all anchors at once, always from the
   unmodified detected/template mesh, so re-saving the same marks is stable.
3. The mouth line sets the inner lip ring (inner corners = outer corners) for
   animal and animation; the chin sets the jaw scale. Each corner is drawn
   with its inner-corner landmark (78, 308) on both sides.
4. Marked pupils are placed after the warp (moved and scaled as one piece),
   never pinned in it: the iris lies under the lids, not in the skin.
5. Delaunay after the warp; validator requires 0 flipped triangles outside
   the iris, and each pupil inside its eye.
6. Anchors are stored in the rig in image coordinates with `source: "owner"`;
   every rebuild (crop reset, re-detect) re-applies them. Reset means "back to
   the confirmed marks". Marks saved before M2 (bounding-box extremes) are
   read off a detected rig's own landmarks instead, so a re-save moves nothing.

### AI adjust

- Local analysis first, free: closed eyes, open mouth, tilt, small face, blur,
  exposure. When nothing is wrong, step 2 says so and offers nothing paid.
- **Touch-up** (human): a face crop (≈1.6× face box) at 1024 px, asking for
  open eyes on the camera and relaxed closed lips, nothing else; only the eye
  and lip regions are pasted back, aligned on stable landmarks, feathered,
  colour- and grain-matched. Closed eyes: primary action is "use another
  photo"; the AI fix is secondary and labelled as generated.
- **Stylise** (human → animation): the existing photoreal / illustrated / anime
  / 3D styles; switches the creation's line to animation.
- **Regenerate**: full edit to a frontal, well-lit, plain-backdrop portrait.
- Checks: the result must re-detect and pass the validator; skin-tone drift
  guard for humans. No face-recognition identity check (biometric processing
  is not needed: the owner compares side by side).
- Metering: every provider call is a usage event with its kind and cost; a
  per-creation budget (2 adjust rounds, 1 detection); detection cached by image
  hash. Safety refusals are shown with a reason and never retried.
- Disclosure: `ai_edited {mode, model}` on the avatar and in the published
  config; widget and share page show a default-on "AI avatar" label.

### Consent and privacy

- `consents` table (append-only): org, user, scope (`third_party_ai`), provider
  list, text version, timestamp. Referenced by creation and avatar.
- Wording is the uploader's statement: "I am this person or have their
  permission, and they are 18 or older". Required before finishing any human
  avatar, AI or not.
- Org switch: disable third-party AI entirely.
- Removed backgrounds: RGB set to 0 under alpha 0 (today the room stays in the
  published file). Ingest strips EXIF/GPS on every path.
- Deleting an avatar deletes its whole prefix, published copies included
  (`Storage.delete_prefix`).
- Share page and widget get a "Report" link that can revoke the share and
  unpublish.
- No customer photos are kept for training.
- The Gemini project must be on the paid tier (inputs not used for training);
  consent text and the landing FAQ state what is actually true.

## Embed engine

- Render profile lives in rig.json (`render_profile: "animal@1"`); published
  with the rig, so the widget, share page and previews get it with no extra
  wiring. Absent → today's behaviour, pinned by golden tests (human, and a
  legacy animal rig and legacy cartoon rig).
- `KindProfile` stays narrow: mouth style (human / muzzle / toon), gaze on/off,
  blink style (mesh / lid), jaw parameters, contact line on/off, allowed mouth
  extensions. Profile scalars multiply inside the engine; host `tune()` stays
  on top. Unused brow code is deleted rather than made configurable.
- **Muzzle** (`animal@1`): dark cavity and tongue, no incisors, optional canines,
  no gaze patch, no brow lift.
- **Toon** (`toon@1`, flat art only): flat cavity, one tooth band, flat tongue;
  full blinks as a lid painted from a sampled lid band, falling back to the
  mesh blink when the band is not flat.
- Performance: cap mouth subdivision by face size; share one downscaled
  sampling canvas.

## Data changes

- The stored value `cartoon` stays; only the label becomes "Animation" (no
  rename migration, no alias).
- Migration 023: `creations`, `consents`; `avatars.upload_image_key` (the
  untouched upload), `avatars.ai_edited`; SQLite WAL + busy timeout.

## Fixes to ship first (existing bugs)

1. Embed and share serve the published snapshot even while the draft is
   rebuilding (today a re-detect takes customer sites offline).
2. First publish only when detected, validated and human; otherwise the avatar
   waits for "Mark the face" and an explicit Publish.
3. Cut-outs zero RGB under alpha 0; ingest strips metadata on every path.
4. Saving marks commits the draft change (the Publish bar appears).
5. Crop reset keeps the line and the marks (translate back; no re-detect).
6. Plain uploads are no longer counted as AI generations.
7. MediaPipe loaded once (≈0.2 s saved per call), lock-guarded, pinned download.
8. The photographic (human-teeth) mouth is refused for animal and animation.
9. Avatars stuck in `processing` after a deploy become retryable.
10. Atomic writes in local storage; delete removes the whole avatar prefix.
11. The landing FAQ's privacy answer is corrected.

## Milestones (each ships to production after tests and review)

| # | Delivers | Visible result |
|---|---|---|
| M1 | fixes above, render-profile plumbing, goldens | nothing unconfirmed goes live; no removed background leaks |
| M2 | face template, anchor fit, mouth line + chin marks, better Mark the face (zoom, keys) | animals and cartoons rig without tears |
| M3 | jobs, creations, the wizard (steps 1, 3, 4), resume, old paths retired | the new creation flow, all three lines |
| M4 | consent, AI adjust (touch-up, stylise, regenerate), disclosure, Gemini points | step 2; faster point placement |
| M5 | muzzle and toon mouths, lid blink | animals and toons look native |
| M6 | character catalogue: 20–40 animals, toons, anime, confirmed by hand | SitePal-style ready characters |

Later: our own keypoint model (only with a separate opt-in data programme), a
licensed face parser for lip contours, the general segmenter after measurement
on the production box, WebGL renderer and 2.5D head turns, and the liveness
work (audio clock, cursor gaze, brows).
