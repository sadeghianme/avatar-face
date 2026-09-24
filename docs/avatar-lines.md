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
3. **AI prepares the photo; code animates it.** AI runs once, at creation,
   when the photo check finds something to fix (recommended, with reasons;
   the owner can keep their photo), is shown side by side with the original,
   and is never the only copy.
4. **Consent follows the data, not the line.** Any step that sends pixels to a
   third party requires a recorded consent naming that provider. Without it,
   every line still works by hand.
5. **Heavy work never blocks the API**, and survives a deploy (jobs recover or
   fail cleanly after a restart).
6. **Published avatars change only when their owner publishes.** New rendering
   is a versioned *render profile* stored in the rig; a rig without one renders
   exactly as today, whatever its line.

## The creation flow

The owner's order (2026-09-25): **upload → background → AI adjust → points**.

```
1 Upload + frame   file checks, EXIF rotation, metadata stripped; crop and
                   level pre-filled from the detected face (local, free);
                   line suggested (face → Human; none → Animal or Animation),
                   user can switch
2 Background       Remove · Keep original
3 AI adjust        the photo is checked locally (free): eyes closed or not on
                   the camera, mouth open or teeth showing, head turned or
                   tilted, face small, poor light. When something needs
                   fixing, the fix is RECOMMENDED and pre-selected, with the
                   reasons: Touch up eyes & lips (human), or Regenerate in the
                   best position (frontal, level, well lit). One consent,
                   remembered per user; then it runs, before/after, "Use this"
                   or "Keep my photo". Nothing to fix → "No AI needed",
                   Continue (AI stays available). Stylise (→ Animation) is
                   always offered for human photos.
4 Place points     pre-filled; "Looks right" when the validator passes;
                   the uploader statement for a person's photo (whatever
                   line it ends on), or for a face generated from words
→ Avatar page      built from the confirmed points
```

AI after background removal: the model is sent the person on a flat neutral
backdrop (never the removed background), and so is an avatar used as the
source of a generation. A touch-up pastes eyes and lips back
into the cut-out, so its transparency is untouched; a regenerated or
stylised result comes back opaque on a plain backdrop, and when the owner
chose Remove it is cut out again automatically.

A photo that needs nothing takes: Upload → Continue → Continue → Looks right.

Other entry points (catalogue, generate from text, stock, 3D/GLB) become
creations too, so they pass the same consent and confirmation.

## Backend

### Creations

Table `creations`: `id, org_id, created_by_id, face_type, status
(draft|finishing|finished|expired), revision, steps (JSON: original → framed
→ cutout → adjusted:N → cutout:N, each {key, width, height, from, check};
plus `background`, the step 2 answer), analysis (JSON, the upload's),
anchors (JSON, bound to the image key they were placed on), consent_ids,
avatar_id, updated_at`. Choices are opaque ids (`original`, `framed`,
`cutout`, `adjusted:0`, `cutout:0`), never raw storage keys. Every query
filters on `id` and `org_id`.

Every image carries its photo check (`photo_analysis.check_photo`: eyes
closed or half closed, gaze off the camera, mouth open or teeth showing,
head turned or tilted, face small, low resolution, dark, bright, blurred)
with a recommendation per line; `analysis.recommendation` is the current
image's, `{image, mode: touchup | regenerate | none, reasons}`. Eyes and
parted lips → touch-up; an open mouth (closing it raises the jaw, which a
paste of new lips cannot follow), pose, light, size → regenerate (which
fixes eyes and mouth too); animations → regenerate only when the face is
not found or not frontal; animals only when a found face is not frontal
(MediaPipe finds no face on almost any animal, and would not on a
regenerated one either). Choosing an AI result clears the points (new pixels);
choosing a regenerated result when the background is removed cuts it out
again (a chained background job, `cutout:N`).

| route | kind | does |
|---|---|---|
| `POST /creations` (file) | job | ingest (pixel cap before decode, EXIF transpose, re-encode without metadata, long edge ≤ 2048), analyse, suggest line |
| `GET /creations?status=draft`, `GET /{id}` | – | resume list; state + job progress |
| `PATCH /{id}` {face_type, crop, roll} | – | switch line / frame; invalidates downstream steps |
| `POST /{id}/background` {mode} | job | cut-out of the current image, RGB zeroed under alpha 0; the answer is remembered |
| `POST /{id}/adjust` {mode, style?, consent_id} | job | AI adjust of the current image (a cut-out on grey), ≤ 2 candidates, local checks |
| `POST /{id}/choose` {choice} | – / job | pick a step output; clears anchors bound to another image; an opaque AI result is cut out when the background is removed (202) |
| `POST /{id}/detect` {use_ai?, consent_id?} | job | the line's detector → anchors (Gemini only with consent) |
| `POST /creations/generate` {face_type, style, prompt, source_avatar_id?, consent_id?} | job | the image model makes the original; the wizard continues as for an upload |
| `POST /{id}/preview-rig` {anchors} | – | the rig finish would build, nothing saved |
| `POST /{id}/finish` {name, anchors, image} | job | atomic draft→finishing; idempotent; builds, validates, publishes |
| `DELETE /{id}` | – | removes row and files now |
| `GET /consents/mine?scope=third_party_ai` | – | the caller's latest AI consent under the current wording, or null (asked once per person and wording) |
| `POST /consents` {scope, text_version, providers?, creation_id?} | – | records a statement; one about a face names its creation and counts for it only |
| `POST /{id}/retry` {consent_id?} | job | runs a failed job again; one that sends pixels out needs the retrying member's own consent |

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

- Local analysis first, free: closed or half-closed eyes, gaze, open mouth or
  teeth, turned or tilted head, small face, blur, exposure. The fix is
  recommended and pre-selected with its reasons; when nothing is wrong,
  step 3 says so and pushes nothing paid.
- **Touch-up** (human): a face crop (≈1.6× face box) at 1024 px, asking for
  open eyes on the camera and relaxed closed lips, nothing else; only the eye
  and lip regions are pasted back, aligned on stable landmarks, low-passed
  before any shrink (the crop too), feathered short of the eyebrows,
  colour- and grain-matched robustly (median, MAD) on a ring of skin that
  leaves out the brows and anything outside either face. An answer whose
  chin moved more than 4% of the face height is refused (`jaw_moved`). Closed eyes: primary action is "use another
  photo"; the AI fix is secondary and labelled as generated.
- **Stylise** (human → animation): the existing photoreal / illustrated / anime
  / 3D styles; switches the creation's line to animation.
- **Regenerate**: full edit to a frontal, well-lit, plain-backdrop portrait.
- Checks: the result must re-detect and pass the validator; skin-tone drift
  guard for humans. No face-recognition identity check (biometric processing
  is not needed: the owner compares side by side).
- Metering: every provider call is a usage event with its kind and cost; a
  per-creation budget (2 adjust rounds, 1 detection); detection cached by image
  hash. Safety refusals are shown with a reason and never retried; an
  answer with no image (NO_IMAGE, text only) is billed, so it is metered,
  spends the round and is not asked again in it. The organization's switch
  is read again before every provider call, so a job queued before it was
  turned off sends nothing.
- Disclosure: `ai_edited {mode, model}` on the avatar and in the published
  config; widget and share page show a default-on "AI avatar" label (the
  widget's turns off with `data-ai-label="off"` for a site that discloses
  it another way; a snapshot from before disclosures shows none).

### Consent and privacy

- `consents` table (append-only): org, user, scope (`third_party_ai`), provider
  list, text version, timestamp. Referenced by creation and avatar.
- Wording is the uploader's statement: "I am this person or have their
  permission, and they are 18 or older". Required before finishing an
  avatar made from a person's photo, AI or not, decided by where the pixels
  came from, not by the line: a human line, or a human face the photo check
  found on the upload, its framing or its cut-out (so a stylised or
  line-switched photo still needs it). A face generated from words takes
  `generated_face` instead ("made by AI, not a real, identifiable person").
  Both are recorded for one creation (`subject_id`, migration 025) and
  accepted for it only; neither is remembered across creations.
- Choosing a stylised version remembers the line and background answer it
  replaces; going back to a picture that is not stylised ("Keep my photo")
  restores them (cutting the photo out again when the background was
  removed), unless the owner has chosen a line since.
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
- Migration 023: `creations`; `avatars.upload_image_key` (the untouched
  upload); SQLite WAL + busy timeout.
- Migration 024 (M4): `consents` (append-only; address kept only as a keyed
  hash), `organizations.third_party_ai_enabled` (owners and admins),
  `avatars.ai_edited` and `avatars.consent_ids`, `creations.consent_ids` and
  `creations.ai_usage` (AI budget, last adjust round, point-finder cache).
- Migration 025 (M4): `consents.subject_id`, the creation a statement about
  a face was made for. The address hash needs the visitor's address:
  production sets uvicorn's `FORWARDED_ALLOW_IPS` to the docker ranges, so
  Caddy's X-Forwarded-For is trusted.

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
