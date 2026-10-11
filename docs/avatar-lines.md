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

### The four-step wizard (2026-09-28, replaces the five steps below)

The owner's flow: **1 Model · 2 Photo · 3 Prepare · 4 Publish**.

```
1 Model     Human avatar | Animal avatar
2 Photo     "Generate with AI" (one description, example chips) or "Upload a
            photo", and a look: Realistic | Animation (3D, animated film) |
            Cartoon (flat 2D). The AI agreement (third_party_ai) and, for a
            person, the statement (depiction for a photo, generated_face for
            a description) are ticked HERE; the statement is recorded for the
            creation as soon as it exists, and finish finds it
            (consent.statement_about). A realistic upload may go without AI.
            "Create my avatar" also fixes the avatar's default name, once, on
            the server (wizard.default_name → `steps.name`, `CreationOut.name`):
            the description's words, or a file name that means something;
            a camera's or an app's ("IMG_1234", "animal-realistic.raw") gives
            null and the dashboard says the plan's own ("Animal avatar",
            "Avatar animal"). Publish shows it and the finish takes it, so a
            reload never renames the avatar.
3 Prepare   automatic, one job (POST /prepare, services.wizard): the AI makes
            the picture in the look on a plain backdrop, it is cut out (the
            person segmenter for a person, else services.backdrop, the
            colour keyer) and the face is found (MediaPipe; the vision
            model's points for an animal or a drawing, on the consent).
            A described character gets all of this inside its generate job.
            Result big, before/after slider; Retry, "Describe a change"
            (mode change, edits the AI picture), "Use my original photo"
            (realistic uploads: framed, cut out, no AI). Six AI tries.
            "Remove this change" (`clear: true`, the plain picture again)
            gives its try back: at most three per creation
            (`FREE_CLEARS_PER_CREATION`, usable even with no tries left); each
            is still a metered image call (monthly limit, usage log), and the
            fourth counts as an ordinary try. A failed removal gives back its
            free one; its Retry is a removal again.
4 Publish   talking preview (preview-rig) with a play button; Publish =
            finish (a realistic person's mouth kit runs inside it, listed as
            stages). The points editor only when the face was not found
            (a template's guess: the owner places and confirms) or on
            "Fix points". Name: a default (the description's words, a
            meaningful file name, else "Human avatar"...), renamed in place
            on the avatar page; the voice is chosen there too.
```

Refused edits (2026-10-03): the real image model declines some whole-frame
portraits at the prompt and edits the same face cropped to head and
shoulders. An upload or a change the model declines is therefore asked ONCE
more on that crop (`wizard.head_crop_source`, 2.2 face widths), when a face
is found and the crop differs from the whole picture; every answered call,
the refusal included, is metered, and a second refusal is `safety_refused`.

Consent wording `third_party_ai` 2026-10-03 describes this flow (the photo
or description sent to make the picture in the chosen style, again at each
retry or change; the picture again for an animal's or a drawing's points; a
realistic person's face crops for their teeth and mouth shapes; results kept
and published with an AI label; never used to train AI) and says nothing of
what the provider does with data. Agreements to 2026-09-26 no longer count:
the Photo screen's box comes up unticked and is agreed once more.

The style thumbnails are real outputs of these prompts, cut out and cropped
(`backend/scripts/build_style_thumbs.py`, `frontend/src/assets/wizard/`).

Model × look → line (services.wizard.line_for, wizard.ts lineFor):

| model \ look | Realistic | Animation | Cartoon |
|---|---|---|---|
| Human | `human` (photographic mouth, own teeth and shapes at publish, layers) | `cartoon` | `cartoon` |
| Animal | `animal` (muzzle) | `cartoon` | `cartoon` |

The plan `{model, look, source, description}` is kept in `steps.plan`; a
creation without one (the old wizard) is carried on with the plan its line
implies. Prompts (services.wizard): frontal head and shoulders (animals:
frontal head, muzzle to the camera), eyes open on the camera, mouth closed
and relaxed, soft even frontal light, sharp eyes and lips, a flat mid-grey
backdrop (soft blue for a grey or white subject) that the keyer takes off;
the owner's words are quoted and cannot move any of it.

### The avatar page (2026-10-06)

Where a built avatar is heard, dressed and published
(`features/avatars/pages/AvatarDetailPage.tsx`). The owner's words: the
avatar three fifths of the width, the settings two fifths, no room wasted
under the character, the top of the page on every arrival, every step of
"New avatar" at its default.

```
page head   back · name (renamed in place) · status · what the AI did
            | Mark the face · Crop · Remove/Restore background · Undo · Test · Delete
            Stuck under the shell header on a wide screen (its height is
            measured into --head-h); one row that scrolls sideways on a phone.
            Delete is quiet (red text) and asks once, in place.
stage 60%   the avatar alone: a square, the shape the widget and the share
            page show, as wide as its column and no taller than the window
            leaves (a wide, short window gets a landscape stage, the square
            letterboxed inside: AvatarPreview `fit="box"`, a 720-point
            backing store), sticky under the page head while the settings
            scroll. Fullscreen as before. The crop studio takes its own room.
settings    the publish state (PublishBar, one strip) · the finish notice
   40%      (one strip, dismissible) · Speak, always open ·
            LOOK: Framing & scene (open by default) · Mouth ·
            PUBLISH & SHARE: Public link · Embed snippet ·
            ADVANCED: Animation tuning, with the face-mesh debug switch
            (it was "mesh" in the page head).
```

The sections are the UI kit's `Disclosure`s (`components/ui/Disclosure.tsx`,
under a `DisclosureGroup` eyebrow for the group): one row each — icon,
name, one line of what it holds or is set to ("Off", "Photographic"), a
chevron. A folded section stays mounted, only hidden: a mouth kit it
follows keeps running, the preview keeps answering the framing panel's
drag. What was unfolded is kept (`liveface.avatarPage.open`, localStorage).
The panels draw no card or title of their own: the section is both.
"Open the Mouth panel" on the finish notice unfolds Mouth before scrolling.
On a phone it is one column, the stage first.

Scroll (`app/scroll.ts`, `ScrollToTop` in the router): a new route starts
at the top — not the browser's Back and Forward (the browser restores the
list where it was), not an anchor, not a change of query alone (the
wizard's `?model=`, `?step=` are one page in another state).

A fresh start (`wizard.FRESH_ENTRY`, `startFresh`): the list's "New
avatar", its empty state and the wizard's "Start a new one" carry
`{ fresh: true }` in their history state; the wizard forgets the last
choices (`liveface.wizard.last`) before its first render and replaces the
state, so Back to that entry is not a fresh start again. A creation's own
choices stay (its steps 3 and 4 read them), and the browser's Back from
step 3 to step 2 still opens step 2 as it was filled in. The last choices
are also forgotten when a creation finishes.

### Phones and tablets (2026-10-06)

The dashboard and the public pages, checked on a real local stack at
360×740, 390×844, 430×932, 844×390 (phones), 768×1024, 1024×1366, 1024×768,
1180×820 (tablets) and 1440×900 (the desktop, unchanged), light and dark.

```
breakpoints   below lg (1024)  one column, the drawer, the avatar page's
                               stage capped: 55% of an upright window
                               (a 768 tablet got a 736px square that put
                               Speak a screen down), the window under the
                               header on a phone on its side; the square
                               is centred.
              lg and up        the rail, the avatar page's 60/40 (a 1024
                               tablet on its side, an iPad Pro upright).
              sm (640)         tables (API keys, members) are tables from
                               here; below it each row is stacked, the
                               name on its own line and cut short
                               (components/ui/stackTable.ts).
              max-height 520   a phone on its side: the wizard's progress
                               scrolls away (as before), the share page's
                               name and composer take less height.
touch         (pointer: coarse), the `coarse:` variant (tailwind.config):
                               44px buttons, fields, header icons, nav
                               links, row actions, sliders; fields at 16px
                               (iOS zooms into smaller ones on focus). A
                               mouse keeps the compact desktop sizes.
drawer        a modal (role=dialog): focus to the current page's link,
                               Tab wraps inside, Esc / backdrop / any
                               route change closes it, the page under it
                               does not scroll, focus back to the menu
                               button; it scrolls on a phone on its side.
fullscreen    an iPhone has no element fullscreen: the stage covers the
                               window instead (fixed, safe areas padded),
                               the same button or Esc leaves.
framing drag  off on a touch screen in one column (TOUCH_ONE_COLUMN): the
                               stage is most of the screen there, and a
                               swipe meant to scroll panned the picture
                               (a draft change). The position pad moves
                               it; beside the settings (lg) a drag pans.
wizard bar    a secondary action shows its short words on a phone ("AI",
                               "Original", "Retry") and its full words
                               from sm: a finger has no hover for a title.
```

Reading text is 14px on a phone (the 13px descriptions are `max-lg:text-sm`);
12px stays for captions, badges, counts and one-line hints. No page scrolls
sideways at any of the sizes (measured: `scrollWidth - innerWidth` is 0
everywhere, before and after).

### The five-step flow (2026-09-25, superseded)

The owner's order (2026-09-25, Step 5 added 2026-09-26): **upload → background
→ AI adjust → points → preparing your avatar**.

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
                   line it ends on), or for a face generated from words;
                   for a person, the AI statement when the member has not
                   agreed to the words in force (asked at that press, as a
                   dialog: "Not now" finishes with the standard mouth)
5 Preparing your   the finish job gives a person's photo the Reference
  avatar           avatar's quality before the first publish: their own
                   teeth, their own six mouth shapes and a mouth profile
                   fitted to them (the performance kit, made from the
                   chosen picture and the confirmed points; AI, on the
                   member's consent, never without it). Progress counts the
                   requests ("making the mouth shapes", n of 7: the teeth
                   photo and the six shapes), then "fitting the mouth", then
                   "publishing" (or "publishing with the standard mouth")
→ Avatar page      built from the confirmed points
```

"If required" AI runs by itself when a check finds a need (the lip touch-up
of step 3, the mouth of step 5), and only on the member's own consent: never
silently without it, and never agreed to on their behalf. Step 3 asks for it
inline; a member who reaches step 4 without it is asked when they press
"Looks right", since step 5 needs it.

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
| `POST /{id}/finish` {name, anchors, image} | job | atomic draft→finishing; idempotent; builds, validates, prepares a person's mouth (step 5), publishes |
| `DELETE /{id}` | – | removes row and files now |
| `GET /consents/mine?scope=third_party_ai` | – | the caller's latest AI consent under the current wording, or null (asked once per person and wording) |
| `POST /consents` {scope, text_version, providers?, creation_id?} | – | records a statement; one about a face names its creation and counts for it only |
| `POST /{id}/retry` {consent_id?} | job | runs a failed job again; one that sends pixels out needs the retrying member's own consent |
| `POST /creations` +{model, look} | job | the four-step wizard's upload: the line from the plan, kept as `plan` |
| `POST /creations/generate` +{model, look} | job | the wizard's character prompt; cut-out and anchors in the same job |
| `POST /{id}/prepare` {mode: ai\|change\|generate\|original, instruction?, consent_id?, again?, clear?} | job | step 3: the picture in the look (adjusted:N), its cut-out (cutout:N) and anchors, in one write; six AI tries (`clear` redoes the plain picture without taking one, three per creation) |

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
  anchor_fit/       anchors → thin-plate-spline warp of the detected or template
                    mesh → Delaunay again → validator (0 flipped triangles)
  vision_points.py  Gemini vision keypoints (named model, metered, consent-gated)
  photo_analysis.py blur, exposure, size, eyes/mouth state (landmarks + blendshapes)
  photo_adjust/     touch-up on a face crop with masked paste-back; stylise; regenerate
  background.py     segmenter per line; RGB zeroed under alpha 0
  consent.py        append-only consents table
```

| | human | animal | animation |
|---|---|---|---|
| detect | MediaPipe | Gemini points *if consented*, else template | MediaPipe → validator; Gemini points if consented, else template |
| anchors placed | head (8-point outline), eyes, mouth (as today), pupils | head (8-point outline), eyes, **mouth line** (2 corners + 3 along) + **chin**, no pupils | head (8-point outline), eyes, mouth line + chin, **iris ellipses** |
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
7. The head is an outline of eight marks, drawn as a smooth closed curve
   (uniform Catmull-Rom) through them rather than a diamond through four. With
   all eight marked, every face-oval landmark between them is placed on that
   same curve (keeping its offset from the base's own curve, scaled with the
   head), so the mesh's edge is the outline the owner sees; pinning only the
   eight folded the cheek of the "toon big grin" layout. The validator refuses
   an outline that crosses itself (`outline_crossed`) or goes round the face
   out of order (`outline_out_of_order`).

The anchors, in MediaPipe landmark indices ("left" and "right" are the
image's). The head means the face: forehead to chin, cheek to cheek, not the
hair or the ears.

| mark | landmarks |
|---|---|
| head: top, right, bottom, left | 10, 454, 152, 234 |
| head: upper left / upper right (temples) | 54 / 284 |
| head: lower right / lower left (jaw corners) | 365 / 136 |
| eye on the left: left, right, top, bottom | 33, 133, 159, 145 |
| eye on the right: left, right, top, bottom | 362, 263, 386, 374 |
| mouth (human): left, right, top, bottom; centre | 61, 291, 0, 17; the seam 13/14 |
| mouth line (animal, animation): corners; seam | commissures 61…78 and 291…308; inner lip rings |
| chin (animal, animation) | 152 |
| pupils | iris 468–472, 473–477 (placed after the warp) |

The four head diagonals are the face-oval landmarks nearest the diagonals of
the head's box, seen from its centre, on the face template: on an ellipse the
point halfway between two edges lies exactly there, so the eight marks are an
ellipse's eight points (`tests/test_anchor_fit.py` pins them). Each is
optional in the rig-fit and creation schemas: marks saved with a four-point
head keep fitting exactly as before (the diagonals are not pinned and follow
the warp); rig-anchors opens them where that fit put them, and the Mark the
face panel sends a head it did not touch without its diagonals, so saving it
unchanged changes nothing. A head sent without diagonals keeps the saved ones.

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
  `generated_face` instead ("made by AI, not a real, identifiable person"),
  except an animal the wizard drew in an animated or cartoon look, whose
  detected "face" (MediaPipe on a cartoon dog) is a false positive: nothing
  is asked of it. A realistic animal read as a face still gets it. A photo
  uploaded under an "Animal" plan on which the detector read a human face
  keeps `depiction` (someone may pick Animal and upload a real person), but
  the dashboard words it for the plan (`wizard.statementKey`,
  `createDepictionStatement_animal`): "This photo shows an animal, not a
  real person — or, if it shows a person, I am that person or have their
  permission, and they are 18 or older." The same statement about any
  person in it, made conditional, so the same scope and version are
  recorded; the plan on the creation says which form was shown. An animal
  upload with no face found is asked nothing.
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

### A new person's mouth (2026-09-26)

Why an uploaded photo looked worse than the Reference avatar (`/reference-avatar`):
it spoke with the classic drawn mouth, generic teeth, a cue clock started at
`play()` and never re-read, and cues stretched to the audio's length; the
Reference has the photographic mouth, a photo of its own teeth, the audio
position read every frame, and the model's own phoneme timings. Now, for
NEW human avatars (existing avatars and published snapshots are unchanged,
except for the clock, a bug fix every avatar gets):

- **Photographic mouth by default.** Finish writes `mouth_config
  {renderer: "continuous", profile: {teethY: 0.016, teethScale: 1.0}}` for
  a line allowed it (human): the standard teeth's seat and size (below);
  every other line keeps the classic mouth (null). The Mouth panel still
  switches.
- **Their own teeth, made by AI, before the first publish**
  (`services.mouth_photo`; since Step 5, below, the performance kit's teeth
  photo, and this single photo only where the kit cannot be made). When the
  organization allows third-party AI and the finishing member has a current
  `third_party_ai` consent, the finish job sends the chosen picture's face
  crop (the touch-up's: 1.6 face boxes, 1024 px, a cut-out on grey) with
  a prompt modelled on the touch-up's and on oral-detail-v3's ("ee", whole
  upper crowns, the person's own natural shade, change nothing else). A
  refusal is asked once more on the head-and-shoulders crop. The answer is
  admitted exactly like an uploaded mouth photo: `prepare_photo(…,
  "mouth")`, then the browser's own teeth test ported to the server
  (`services.dental_photo`: `DentalPhotoError`'s width, count and crown
  coverage), so no photo is stored that the widget would drop. It is not
  pasted back into the portrait: the renderer registers a mouth photo by its
  own landmarks, in its own mouth widths. Metered as an image generation
  (source `teeth`), under the monthly limit and the org switch; disclosed as
  `ai_edited.teeth` (`{mode: "teeth"}` when nothing else was AI-made).
  Its consent is added to the avatar's and the creation's as the picture
  is sent (`make_teeth(on_send=…)`; the generate endpoint does the same),
  so a refusal or a rejected answer still leaves the record of what let
  the photo out, and a finish that sent nothing records nothing. The calls wait outside the job runner's slot
  (`JobRunner.outside_slot`), so a finish waiting on Google never holds
  another person's upload queued. Anything short of that (no consent,
  AI off, the limit, a refusal, a photo the teeth test rejects, a crash)
  publishes with the standard teeth (below) and records why in
  `mouth_config.teeth.note`, which the Mouth panel shows. Never fails the
  finish.
- **Stored as WebP, cut to the lips** (`mouth_photo.crop_to_mouth`, then
  `encode_for_visitors`, quality 90): every visitor downloads the mouth
  photo before the photographic mouth attaches, and a 1024 px crop is about
  1.3 MB as PNG, about 160 KB as WebP, mostly face the renderer never reads
  (it draws the photo clipped to its inner lips). Cut to the lips with a
  margin at whole pixels, the rig moved with it, it reads exactly as before
  and weighs a fraction of that. The teeth test runs on the WebP bytes, so
  what passed is what is served.
- **The consent covers it.** `third_party_ai` wording 2026-09-26 says that
  pictures also go without a further question for the wizard's lip
  touch-up and a person's teeth at Finish, and that those teeth are kept
  and published with the finished avatar; the Settings switch hint and the
  landing FAQ say the same. Agreements to the 2026-09-25 text no longer
  count, so everyone is asked the new question before anything is sent.
- **Disclosure follows what is shown.** Publish drops `teeth` from the
  disclosure (a teeth-only one entirely) unless the published mouth is the
  photographic one with the photo; the draft keeps both, so switching back
  restores both. The published mouth carries its `teeth` record (never
  served to visitors), and Discard restores it with the photo, and
  `ai_edited` from the snapshot's disclosure, with the teeth entry exactly
  when the restored photo is AI-made: a discarded upload, removal or AI
  generation never leaves AI teeth unlabelled or a label on teeth that are
  gone.
- (Step 5 replaced the single "ee" photo at Finish and its synchronous
  generate endpoint with the performance kit, below; the "ee" photo remains
  what is made where the kit cannot be.) An owner's own photo (`POST
  …/mouth-photo`, refused by the teeth test with 422 `mouth_teeth_unclear`)
  replaces AI teeth and their disclosure; removing the photo removes both.
- **Teeth height is not fitted from the photo.** On the lab's two AI "ee"
  photos of one person, the upper incisal edge mapped into the portrait
  through the skull (stable landmarks) gives teethY −0.034 and −0.010 where
  the hand fit is 0.016, and the edge below the upper lip measures 0.080
  and 0.143 mouth widths: the value follows how much crown the model drew,
  not the person. A new person starts at the Reference's seat (0.016), where
  the standard teeth and the kit's teeth photo are drawn, and an AI "ee"
  photo stays there; the slider is the fit.
- **Parted lips are fixed without a press.** When the current image of a
  person shows `teeth_showing` (a touch-up), `ai.auto_adjust` offers it and
  the wizard starts it (`POST /adjust {mode: "touchup", auto: true}`) on
  the member's own remembered consent, never asking on their behalf: 409
  `auto_adjust_not_applicable` unless the offer stands, once per photo
  however it is re-cropped (`ai_usage.auto_adjusted`, by source photo),
  never on an AI picture or one already adjusted. With the eyes flagged too
  (closed, half closed, looking away) the same touch-up, which the check
  recommends for both, closes the lips and fixes the eyes; the wizard says
  so while it runs. The owner still chooses the result.
- **Finish warns** (`warnings: [{code, detail}]`, `mouth_open` or
  `teeth_showing`) when the picture still shows them; it is not a refusal.
- **Dashboard.** Step 5 lists the finish's stages in plain words
  (`creation.finishRows`: building your avatar, your teeth and mouth shapes
  counted "3 of 7", fitting the mouth, publishing), ticks nothing that was
  not seen to happen, and shows the mouth as not made ("skipped") when the
  finish publishes with the standard one; an unknown label shows no stage.
  A finish that fails goes back to the points with its reason at the top,
  where focus goes; its Retry waits for what the main button waits for (the
  statement is ticked again). The points step says the mouth warning before
  the press, from the current image's check (`expectedMouthWarnings`, with
  the way back to AI adjust), and the finish answer's warnings while it
  builds; they are kept for the tab (sessionStorage, `rememberFinishNotice`)
  and shown on the avatar's page (`FinishNotice`: what step 5 gave the
  mouth, its own shapes and teeth or standard ones and why), until
  dismissed. The mouth warnings (`mouth_warnings`, mouth_open and
  teeth_showing) are the human line's only: they are about the photographic
  mouth, the picture's own lips; the animal and cartoon lines draw their
  mouth over the picture, and the landmarker's "open mouth" on a dog's
  muzzle (a published realistic dog once carried the note) says nothing.
  An avatar step 5 is still preparing is listed as Processing;
  its page links to the wizard's step 5 (`preparing_creation_id`) instead of
  the rig job's stepper, and its Retry is refused (409 `avatar_preparing`).
  The Mouth panel says where the shapes come from (all six, some, or
  standard, with why) and whose teeth are shown (the AI's, your photo, or
  standard, with why: a photo that failed a check names it); its one AI
  action, "Make mouth shapes and teeth from this photo", runs as a job it
  follows (`useMouthKit`), on the member's consent (`useConsent.withAi`),
  keeping keyboard focus on the button while it runs; a compare switch
  plays the standard shapes in the preview only. The disclosure badge reads
  "AI touch-up · AI teeth · AI mouth shapes" as they apply. AI adjust starts
  the offered touch-up by itself (`autoAdjustToStart`) and says why while it
  runs.

### The standard teeth (2026-09-26)

Step 5 gives every new person the photographic mouth, and many of them
have no teeth photo of their own: the member did not agree to send photos,
the organization's AI switch is off, the AI's teeth were refused or
failed, or the owner removed them. Such a mouth used to draw geometric
teeth, and rendered with the real engine on a fictional bearded man next
to the lab Reference they read as a denture: flat grey-beige slabs with a
dark seam down the middle, no gum line, a tongue blob in "oo" and "th".
The Reference's own photographed teeth (`oral-detail-v3`) borrowed onto
the same face were clean, complete and symmetric, a little whiter and
wider than his own, and far better. So they are now the **standard teeth**:

- **The file.** `backend/scripts/build_standard_teeth.py` admits the lab's
  delivery photo and its rig exactly as every mouth photo is admitted
  (`mouth_photo.admit_photo`: cut to the lips, WebP, the embed's own teeth
  test), into `embed/assets/mouth-teeth.webp` (376 × 281 px, 23 KB) and
  `mouth-teeth.rig.json` (8 KB), which the embed's build copies to `dist`
  and the API serves as `/mouth-teeth.webp` and `/mouth-teeth.rig.json`,
  as `/mouth-motion.json` is (revalidated, readable from any origin).
- **Loaded beside the motion.** The embed's one loader (`loadAvatarMouth`,
  for the widget, the share page and the dashboard alike) loads them from
  beside the bundled motion it is given when an avatar's config names no
  teeth photo: `${apiBase}/mouth-teeth.webp` for the widget,
  `/api/mouth-teeth.webp` for the dashboard and the share page (the dev
  proxy maps `/api` to the backend as well). Whatever keeps them from
  being drawn (the network, a decode, the teeth test) leaves the drawn
  teeth, never a failed mouth, and they are not asked for again. An avatar
  whose own teeth photo fails keeps failing to the classic mouth, as
  before: the standard teeth never stand in for the owner's. The landing
  demo passes its own teeth (the Reference's, as it always showed) and so
  never looks for them.
- **Seated as the Reference's.** A mouth without its own teeth has the
  profile values the Reference draws the same photo with: teethY 0.016,
  teethScale 1.00 (`performance_kit.for_standard_teeth`), set at Finish
  (`mouth_photo.default_config`), by a kit whose teeth are not drawn, and
  after the owner removes a kit's teeth photo (values the owner moved are
  kept). The geometric fit (teethScale by the Reference's mouth-to-face
  proportion over the face's) went with the drawn teeth. An existing
  photographic mouth without a teeth photo draws them too, at the profile
  it was saved with: the loader goes by the config it is served.
- **What they are.** The fictional lab sample's AI-made teeth
  (reference-avatar-lab.md), the same for every avatar and not made from
  its picture; the disclosure (`ai_edited`) does not list them. The Mouth
  panel calls them standard teeth, as before.

### Teeth in another face's light (2026-10-05)

Rendered with the real engine on three published people (a soft scan, a
3D-style render, a warm saturated photo) with the production cue track,
the photographic mouth with the standard teeth opened about twice as far
as the classic mouth and was clearly better on all three, with two tells:

- **A white line between words.** Between words and on /p/ /b/ /m/ the
  lips settle 0.02 to 0.06 of a mouth apart, and the upper teeth drawn at
  full strength through that slit were a bright line between the lips (a
  glint, a false tooth line, worst on dark lips); 8 or 9 of 50 frames a
  sentence. Lips only just apart show the dark of the mouth, not enamel.
  `embed/src/mouth/lip-occlusion-model.ts` now ramps three things over the
  gap as a share of the mouth's width: the teeth (`enamelReveal`, 0 at
  0.03 → 1 at 0.09), the dark interior (`cavityReveal`, 0.025 → 0.07, the
  classic mouth's own range; whole from the first pixel it was a hard dark
  slot cut into the lips), and a soft dark seam in the lips' own shadow
  colour (`contactSeam`, in as the lips part, out as the teeth arrive).
  Both the teeth-photo path and the geometric one take them; rest
  (gap < 0.008 W) is untouched, so the Reference's authored "sil" is
  pixel-identical. The character mouth's jaw-driven teeth band takes the
  same reveal (lip retraction, as on "fifty", unchanged).
- **Teeth pasted in.** The Reference's teeth on another face were whiter
  and cooler than anything in a warm photo and cleaner than a soft scan.
  What a photograph's teeth share with its skin is the light, so
  `enamel-match-model.ts` fits the arch textures to the face once, on the
  first painted frame (cached on the sampled values): the enamel's cast is
  moved to 0.31 of the face's cheek cast (the share the Reference's own
  teeth carry of its skin's), luma-neutral; its brightest crowns are capped
  at the face's own highlight (`face-light.ts`: the 97th-percentile luma
  inside the face oval, from a box-filtered copy, so a glint cannot set
  it) × 1.04 + 6, floor 0.78, as a multiplier so the cream stays; and it is
  blurred until its edges are as wide as the picture's (`look.soft`, in
  quadrature with the enamel's own measured edge width; none on a crisp
  picture). A face's own teeth photo (its kit, the lab Reference) gets the
  same at 0.4 strength (`TeethOrigin`, set by `withStandardTeeth`). The
  warmth slider is unchanged: its middle is "as the face lights them".
  Measured on a held EE at 1200 px, enamel over the face's highlight: scan
  +58 → +21, render +36 → +19, warm photo +26 → +19; the Reference's own
  EE identical. Still weak: scan grain is not a blur, and the hard aperture
  edge against a soft lip remains the strongest cut-out tell.

### The aperture's edge (2026-10-05)

The interior of the photographic mouth (cavity, teeth, geometric fallback)
was drawn inside a pixel-hard clip of the inner lip ring. On a soft picture
every edge is 2 to 5 px wide and the cavity ended in a 1 px cut, so the
interior read as pasted in: measured in the rendered 1200 px frame, the
aperture's edge was 2 to 3 px wide (contrast over the steepest 1 px step of
the luma profile across the lip line, the measure `character-mouth.ts`
reads the picture with) against the pictures' own 4 to 6 (`look.soft` ×
mouth width) and 5 to 9 (their outer lips, read the same way).
`embed/src/mouth/aperture-feather.ts` now does for the photographic mouth
what `character-paint.ts` does for a render:

- **The interior is feathered, not clipped.** It is painted into a layer of
  its own (`FeatheredLayer`: two small canvases, made once, grown when the
  mouth needs more, the face's transform carried over so the painting code
  is unchanged) and brought back through a mask: the aperture filled,
  eroded by half the feather (a destination-out stroke of the feather's
  width) and blurred by 0.4 of it (`destination-in`), so the interior fades
  out INSIDE the lip's edge and is nothing (< 1/255) a feather outside it.
  The feather is the picture's own edge width in the mouth's pixels
  (`look.soft` × W, as `MouthSurfaceFrame.soft`), floor 1.2 px, ceiling
  0.03 W. The model of the mask (`featherAlpha`) and the clamp are tested;
  a context without `filter` support (decided once) gets the same profile
  as nine stepped rings. One blur per frame on a mouth-sized canvas: at a
  300 px mouth the paint pass is 1.7 to 2.4 ms in software raster, and the
  whole frame costs what it did (the old path's blur-filtered strokes on
  the full canvas were as dear, only deferred).
- **The inner lip.** Just inside the edge, bands in the layer (one blur
  pass, on the mask's canvas first): under the upper lip, which overhangs,
  its shadow on the top of the teeth (`dentalLighting(lip).recess`, as deep
  as 0.14 of the opening, at most 0.05 W); on the lower lip, its wet inner
  tone (the lip half way to `tissue`), narrower. Both with the feather and
  the gap; nothing under 0.01 W, where the contact seam owns the aperture.
- **The rim.** Outside the edge, a faint dark halo (`cavity` tone, alpha
  ≤ 0.13 at full) scaled by how soft the picture is (`edgeSoftness`: 0 at
  `soft` 0.01, 1 at 0.03) and by the cavity reveal squared, so lips only
  just apart show a slit, not a halo.

Measured on the three published people and the lab Reference (its own
teeth and the standard ones), held AA/EE/OO and a mid-speech frame, the
aperture's edge went from 2.0–3.4 px to 4.3–7.6 (0.95–1.49 × `look.soft` ×
W; with the character mouth's own ±5 px window, 0.65–1.1 × everywhere but
the scan's OO at 1.38), never past the pictures' own outer-lip edges. The
Reference's EE enamel luma moved 2 (198/218 → 196/216); the standard
teeth's p50 on the render and the warm photo 3 to 5 lower, which is the
upper lip's shadow on them. Outside the aperture, near-closed frames
(gap < 0.045 W) changed by at most 6 levels; at 0.055 W a 1 px line along
the edge darkens 10. Rest and the classic and character mouths are
untouched; the human and character goldens are unchanged. Still weak: the
corners of a wide smile go soft on a smooth render (its own corners are),
and the contact seam's blur-filtered stroke is still drawn on the full
canvas, the one whole-canvas filter pass left between words.

### The picture's sharpness, the corners, the seam (2026-10-05)

Three things the feather above got wrong, measured and put right:

- **The lip seam is the wrong edge to read.** The feather (and the enamel
  blur) followed `look.soft`, the character mouth's measure of the picture:
  the width of the luma step across the closed lips' seam, clamped 1–4 px.
  The seam of a closed mouth is a shadow in a crease, a rounded shading, 3
  px wide in the lab Reference as in the soft scan (3.0 and 3.2 of their
  own pixels), so the crisp photo got the same feather as the scan and its
  teeth were blurred to it. The edge the aperture stands for is a depth
  edge, and a picture's depth edges are as sharp as its sharpest strong
  edges anywhere near. `embed/src/face-sharpness.ts` reads those: in a box
  round the mouth (2.2 × 1.6 W) and one round each eye (1.8 × 1.2 of the
  eye's width), the gradients above the box's 90th percentile, kept where
  the edge is a crest and keeps its direction for 2 px each way along
  itself, each measured along its own gradient as the 10–90% rise of the
  luma profile (sub-pixel, over the monotone run through the edge), and
  only above 50 levels of contrast: grain is not an edge, and on these four
  pictures the scan's grain stops under 50 while the lashes against the
  sclera, the iris and the lip corners carry 80 to 150. Each box's
  sharpness is the 15th percentile of its widths (40 edges at least), the
  picture's the sharpest box: for a closed-mouth portrait that is an eye,
  where its real depth edges are. Nothing is clamped in pixels, so a 4K
  photograph's wider edges give a wider feather in the same pixels. The
  engine samples it once beside the highlight, on the texture's own pixels,
  and hands it to the mouth as `MouthSurfaceFrame.sharpness` (texture px)
  with `pixelScale`; the feather is that width in the frame (floor 1.2 px,
  ceiling 0.03 W as before), the enamel blur uses it in place of `soft`,
  and the rim halo scales by it. `look.soft` and the character mouth are
  exactly as they were (the character mouth could adopt the measure later).
  Synthetic: a hard step reads 0.8 px, Gaussian edges of σ 1/2/3 read
  2.7/5.2/7.6 (10–90% is 2.56 σ), in order with and without grain, and a
  flat box, grainy or not, returns null (the feather then sits at its
  floor). Measured, in texture px: the Reference 2.42, the scan 3.44, the
  render 1.80 (its eyes are crisp; its mouth is soft shading, with no depth
  edge to read), the painterly render 1.50; the five real character crops
  1.1 to 1.2 for the drawn lines, 4.6 for the soft human animation. In the
  1200 px frame that is a feather of 3.9 / 4.6 / 3.6 / 3.0 px (was 4.9 /
  4.3 / 6.1 / 4.5). The honest finding: the Reference is not a 1-px-crisp
  picture at 1254 px, its lashes rise in about 2.4 px (σ ≈ 0.9), so its
  feather comes down to 3.9 px and not to the hard clip's 2–3, and its
  teeth photo, a closer shot, keeps a small blur (own 1.09 → 0.78, standard
  2.69 → 1.93 in the 512 px enamel space, under 1.2 px in the frame).
- **The corners stay crisp.** Eroded by half the feather and blurred
  everywhere, the mask rounded off the acute tips of a wide smile. Now the
  mask is blurred in place (drawn over itself through the filter, `copy`),
  and at each mouth corner the hard aperture is stamped back through a
  radial weight (`CORNER_REACH`: whole at the corner, gone 0.2 W inward,
  a smoothstep), composited over the feathered mask, so the alpha is whole
  where either is and the stamp adds nothing outside the hard edge
  (`featherAlphaAt`, tested on the model; on a rendered mask the alpha a
  feather outside is 0 everywhere, corners included, and the tip error goes
  3.5 → 0.5 px at a 4.5 px feather). Each stamp is clipped to its own box
  (0.06 ms the pair, not 0.26). On the renders, the dark's reach from the
  corner along the aperture's axis: the render 8.0 → 1.2 px (AA), 9.2 → 1.2
  (EE); the scan 5.2 → 0.2, 8.0 → 0; the Reference 7.8 → 1.5. The ring
  probes by the corners: the render 10.5 → 4.6–6.9.
- **The seam without a filter.** The contact seam was one round-capped
  stroke, 0.018 W wide, through `blur(0.006 W)` on the face's canvas: a
  whole-canvas filter pass between words, 8 ms at 1200 px in software
  raster. It is now three stacked strokes (`SEAM_STROKES`: 0.8, 1.5 and
  2.3 of the width at 0.417, 0.323 and 0.10 of the alpha, fitted by least
  squares to the blurred profile: RMS 7.4% of the peak, the area 99.2%,
  the peak 90%), 0.01 ms. Pixel for pixel against the blurred stroke the
  difference is at most 4.6 levels (RMS 1.6 where either darkens the lip).

Measured on the three published people and the lab Reference as before
(before = the feather at `look.soft`): the aperture's edge at the lip
middles went on the Reference from 6.7 / 6.7 / 7.3 / 6.4 px (AA / EE / OO /
mid) to 4.2 / 5.8 / 5.2 / 5.6, within its own lips' edges (4.0 to 7.4); on
the render from 6.9–7.6 to 4.9–5.5; on the painterly render from 4.3–5.5
to 3.6–5.2; on the scan it stayed (5.2–5.8). EE enamel luma unchanged on
the Reference (196/216), the render's up 4 (180 → 184), the painterly
render's up 5. Outside the aperture, near-closed frames changed by at most
7 levels and no pixel by 8 (the seam's stair against its blur). The paint
pass costs 0.1 to 0.3 ms more a frame at these sizes (the mask copied
through its blur, the stamps); the whole frame is the same at held AA and
through the open frames of a sentence, and the frames between words (gap
0.015–0.07 W, the seam's range) cost 6 to 8 ms less at 1200 px in software
raster (53.7 → 47.9, 50.2 → 42.7, 46.2 → 37.8 ms on the scan, the render
and the Reference): the filter pass is gone. Still weak: a crisp tip on a very
soft scan is crisper than the scan's own corners (the stamp does not
scale with the picture's softness); the measure needs a strong edge
somewhere, so a flat, low-contrast portrait falls to the feather's floor;
and the Reference's standard teeth keep a 1 px blur because its portrait
is softer than its teeth photo.

### Step 5: preparing your avatar (2026-09-26)

What makes the Reference avatar look as it does is its kit: its own mouth
shapes, its own teeth, a fitted mouth profile (docs/performance-kit.md).
Finishing a person now makes theirs, from the chosen picture and the points
they just confirmed, before the first publish (`services.creations._own_mouth`,
`services.mouth_kit`):

- **When.** A person (the photographic mouth), the organization's switch
  on, the image model configured, the monthly limit not reached, and the
  finishing member's current `third_party_ai` consent (asked at step 4's
  press when the member has not agreed to the words in force). Anything
  short of that: the photographic mouth with the standard teeth and the
  bundled motion, the reason in `mouth.teeth.note`. Where the kit cannot
  be made on the server (no face detector), the single "ee" photo, so a
  person still gets their teeth.
- **What.** Seven image edits of the face crop: the six shapes (AA, EE, OO,
  OH, F/V, TH) and the teeth photo (the recipe of the photo the Reference
  renders its teeth from), three at a time, the switch and the limit read
  again before each one (a switch turned off or the limit reached mid-kit
  stops it: the shapes not yet made are the Reference's, retargeted). Each
  answer is registered and checked, and no shape may open more than 1.3
  times the Reference's same shape; the person's own AA sets the kit's size,
  so the shapes play at the Reference's conversational size, however far
  the model acted them; a refused or failed shape is the Reference's. The
  teeth photo is kept when the embed would draw it (cut to the lips, stored
  as WebP, the teeth test on those bytes); otherwise standard teeth, with
  the reason. The teeth photo is drawn at the Reference's seat and size
  (teethY 0.016, teethScale 1.00): where the model drew its teeth is its
  choice, not the person's (docs/performance-kit.md); the jaw range stays
  the owner's.
- **Cost and consent.** One image generation per billed call (source
  `mouth_shapes`; a timeout counts), metered as each call ends. The consent
  is recorded before the first picture leaves, for good (a finish that fails
  afterwards, or a restart, deletes the half-built avatar; the creation
  keeps the record); a call whose consent cannot be recorded is not sent.
  The finish waits for Google outside the job runner's slot, and without a
  database connection.
- **Stored and published.** `mouth_config.motion_key` (the avatar's own
  motion manifest, beside the teeth photo), `profile`, `teeth` and `kit`
  (the owner-facing record); published as a copy, served to the widget and
  the share page as `mouth.motion_url` (fetched cross-origin, cached like
  the other published files). Disclosed as `ai_edited.mouth_shapes
  {model, generated}` while visitors see the shapes.
- **Never fails the finish.** Any error of the kit: standard teeth, the
  bundled motion, the finish goes on.
- **Existing avatars.** The Mouth panel's one AI action, "make mouth shapes
  and teeth from this photo": `POST /orgs/{org}/avatars/{id}/mouth-kit
  {consent_id}` → 202 `{job}`, polled with `GET` on the same path; a draft
  edit the owner publishes; the owner's uploaded teeth are kept.
- **Later edits.** Re-marked points (Mark the face, Re-detect) move the
  kit onto them without AI, and so do a crop, its reset and an undo of
  either (the same face's pixels, translated). Re-detect moves it under the
  avatar's edit lock, so a Mouth panel kit stored meanwhile is kept.
- **The consent's wording** (`third_party_ai` 2026-09-26, not yet released,
  edited in place) covers the mouth shapes as well as the teeth: what is
  sent (crops of the face, one for the teeth and one per speech sound), why,
  and that they are kept and published with the avatar, labelled as
  AI-made.

### Migrating classic mouths (2026-10-05)

A new person gets the photographic mouth; a person made before 2026-09-26
still speaks with the classic drawn mouth, draft and snapshot alike, and
principle 6 (nothing changes until its owner publishes) would leave them
there for good. `backend/scripts/migrate_classic_mouths.py` is the one-off
move of those avatars onto exactly what a new person gets today without AI:
`mouth_photo.default_config("human")` (the photographic mouth, the standard
teeth's seat and size) plus the teeth record `{source: null, note: {code:
"migrated_standard", detail}}`, which the Mouth panel words
(`mouthTeethNote_migrated_standard`: standard teeth, moved from the older
drawn mouth, make your own in the Mouth panel).

- **Which avatars.** Photo avatars of the human line, ready, whose
  `mouth_config` is null or names the classic renderer with no character
  settings, and that have no mouth files of their own (no teeth photo, no
  kit or motion). Never a 3D model, an animal or an animation, an avatar
  mid-build, or one that already has the photographic mouth.
- **Both sides, nothing else.** The draft gets the new config; the live
  snapshot's `mouth` key is rewritten from it exactly as Publish writes it
  (`publishing.republish_mouth`, the mouth part of `publish` shared as
  `publish_mouth`), and nothing else in the snapshot moves: not the
  revision, the files, the disclosure or the publish date. So an avatar in
  step with its snapshot stays in step (no Publish bar appears), and one
  with unpublished edits keeps them unpublished with its mouth moved on both
  sides. Visitors see it on their next page load; owners republish nothing.
- **Safe and reversible.** Dry run by default (a table: id, name, current
  renderer, published, what would change). `--apply --yes --backup-dir DIR`
  first writes a JSON backup of every touched avatar's previous
  `mouth_config` and `published_config` (and the values written), then
  moves each avatar in its own transaction, writing nothing for a row that
  changed since the plan was made; exit 1 if any failed, the rest done.
  `--revert <backup.json>` puts the exact previous values back, skipping an
  avatar edited since unless `--force`. Idempotent: a moved avatar is not
  selected again. The operator takes a database backup first
  (`deploy/backup_db.py`, a consistent copy through the WAL).

## Embed engine

- Render profile lives in rig.json (`render_profile: "animal@1"`); published
  with the rig, so the widget, share page and previews get it with no extra
  wiring. Absent → today's behaviour, pinned by golden tests (human, and a
  legacy animal rig and legacy cartoon rig).
- `KindProfile` stays narrow: mouth style (human / muzzle / toon), gaze on/off,
  blink style (mesh / lid), jaw parameters, contact line on/off, allowed mouth
  extensions. Profile scalars multiply inside the engine; host `tune()` stays
  on top. Unused brow code is deleted rather than made configurable.
- **Muzzle** (`animal@1`, the first muzzle, kept for rigs fitted with it): dark
  cavity and tongue, no incisors, on the classic mouth's geometry.
- **Character mouth** (`toon@1`: Animation and Cartoon looks; `animal@2`:
  animals; embed/src/character-mouth.ts, character-paint.ts, blink-lid.ts).
  Chosen only by the rig's `render_profile`, written by a fit, so widget,
  share page and dashboard preview get it with no wiring. It replaces the
  classic mouth's field and painter for those rigs:
  - *Mesh*: the jaw is a hinge down to the chin and the muzzle (the lower lip
    drops by the jaw, the chin keeps 72% of it, the lower face tapers wider
    with distance), the lips move as one band (one falloff for all rows, so a
    drawn lip line cannot crumple), retraction opens the lips a little for
    /s/ /ee/ /f/.
  - *Opening*: read off the moved inner lip rings, not synthesised.
  - *Paint*: flat colours with the picture's own line for cel art, soft shading
    and a halo rim for a render or a photograph, told by the picture's palette
    (a few colours cover the area round the mouth) and the darkest tone on its
    own mouth seam; an upper-teeth band (toons; none on a muzzle; never on a
    rounded mouth), a bottom-anchored tongue that rises for /th/ and /d/
    (eased, the sounds are discrete); on a render whose lips are of the
    tongue's red, a tongue that lies low behind the lower lip (2026-10-09,
    below).
  - *Blink*: `blink: "lid"` paints a lid over the eye from the skin beside it,
    lash line on its edge, clipped to the eye, and leaves the mesh still (the
    mesh blink pinches a drawn or rendered iris). Honours `tune({blink: 0})`.
    Polish round 2 (same profile names; their golden snapshots were
    regenerated, human/classic and `animal@1` goldens are untouched): the lid
    is built on a smoothed ellipse fitted to the eye's width and height (loose
    marks cannot make it ragged or wander), clones the fur or skin just below
    the eye on a shaded picture (flat fill and a crisp lash on cel art), is
    tinted towards the skin above (the lighter end of what both sides give,
    since a brow can sit where "above" is read), has a soft crease and a lash
    that tapers to the corners, settles into a gentle curve when shut, and the
    eye squashes a little before the lid arrives.
  - */f/ /v/* (`tuckAmount`: lips together and drawn back, a little jaw, not
    rounded): with teeth on, the opening is the upper teeth resting on a lower
    lip that rolls up over them; with teeth off the lips close to one clean
    seam (the jaw barely drops), so no slit and no white line.
  - *Soft mouths*: a render or photograph's opening has an edge as soft as the
    picture's own (`look.soft`: the picture's sharpness, since 2026-10-06
    below; the mouth seam only for a picture without one), a ring of inner-lip
    tone inside it, darker gum at the corners, warmth towards the throat, and a
    tongue with a centre groove and a shine sized to the tongue that is there
    (between lips of its red, only once it has lifted: 2026-10-09, below).
  - *Cel art or not* is told by the palette (top eight 16-level colour bins
    cover at least 70% of the mouth area) AND by the MEDIAN step between
    neighbouring pixels being at most 4 levels. Measured on the five real
    AI-made characters (crops are test fixtures, `fixtures/real-crops/`):
    cartoons 0.85 to 0.87 in the top bins with median step 1 to 2; renders and
    fur 0.33 to 0.42 with median step 2 to 8. A stricter "70% of pixel pairs
    near-identical" test (the first version) called both real cartoons renders:
    AI-made flat art carries light noise and soft gradients. A noise-free smooth
    gradient still counts as flat; fur of a narrow range of browns does not.
  - *Lid on a real eye*: `eyeExtent` reads how far the eye reaches from the
    picture (rays from its middle until the colour has matched the surround in
    that direction for four pixels, held between the marked ellipse and half
    as much again), so the lid has no slivers at the corners and a drawn
    outline is covered. On a shaded face the lid is painted apart and let in
    through a soft mask of that reach, so its edge fades into the fur or skin;
    cel art keeps a crisp edge. The clone of the skin below the eye is made
    only where that patch is one surface (a plain patch of fur or skin), never
    on cel art.
  - *Triangle seams*: in a character profile each warped triangle overlaps its
    neighbours by a pixel (less on the lips, where a thin drawn line crosses
    them), which closed the faint wire and the "v" under the chin that a moved
    jaw showed on flat art.
  - *Owner settings* (`mouth_config.character`, PATCH `character`): `style`
    ("character", or "classic": the profile the line had before), `teeth`
    ("upper" | "none"), `tongue`, `jaw` (0.5 to 1.6). Served to visitors in the
    published mouth as `{renderer: "classic", character}` and applied with
    `engine.setCharacterTraits`.
  - *Migration*: a fit and a face-type change write the line's current profile
    (cartoon `toon@1`, animal `animal@2`, human none), so new avatars get the
    character mouth by default. A rig fitted before keeps what it names
    (`animal@1`, or none) through every unrelated edit and publish; it changes
    when its owner fits the face again or chooses "Character mouth" in the
    Mouth panel (which says so for such avatars). The classic style survives a
    re-fit.
- Performance: cap mouth subdivision by face size; share one downscaled
  sampling canvas.
- Speech clock (2026-09-26, every avatar): `playAudio` without a
  `cueClock` times the cues by the audio element (`media-clock.ts`): held
  at 0 until `playing`, re-anchored on `playing` and `seeked`, following
  `currentTime` every frame (at most 250 ms of frame-clock extrapolation
  between its updates, never backwards within a run), and closing the mouth
  while the element is paused. Before, the clock started at `play()`, so
  the whole utterance ran ahead of the voice by its start-up delay. Golden
  renders are unchanged (no frame depends on the clock). Every avatar means
  the 3D (GLB) engine too: Step 5 gives it the same audio-locked clock.
- Speech clock in real browsers (2026-10-09; `media-clock.ts`,
  `embed/browser-tests/speech-timing.test.ts`). Review 3 (R1) asked whether
  cached speech, MP3 since the speech cache moved to storage, plays where
  its cues say: an MP3 starts late by its encoder's delay (46 ms at 24 kHz)
  unless the decoder honours the LAME header. Measured with a click track
  encoded by the production encoder (`speech_codec.py`) and played as the
  widget plays it, in Chromium 153, Firefox 155 and WebKit 26.6
  (Playwright, on macOS and in CI on Linux): it does not. decodeAudioData
  puts every mark on its source sample in all three; through the audio
  element the MP3 comes out within 4 ms of its WAV (WebKit on Linux can be
  checked by decodeAudioData only; docs/process.md has the table). The
  clock itself was the fault, at the start of every line: browsers fire
  `playing` before the position (and the sound) moves (macOS: Firefox
  30-300 ms, WebKit 16-265; CI's Linux with a null sound sink: Firefox
  1.4 s, WebKit 1.9 s), and the clock ran on from `playing` up to its
  250 ms limit, then stood still until the voice caught up: the mouth ahead
  of the voice by 51-222 ms in Firefox and 122-236 ms in WebKit for up to
  half a second (macOS), by 250 ms for up to two seconds (CI). Now it
  stands at the element's position until that position moves after
  `playing` or `seeked`, and `started` (the engine waiting for the voice, so
  that the silence at 0 is no pause) waits for the same. After, on macOS:
  Firefox 2-9 ms ahead at most; WebKit 104-105 ms for about 360 ms;
  Chromium 38-82 ms for 40-170 ms, as before. In CI: Firefox 1-3 ms,
  WebKit 0, Chromium 55-60 ms for about 90 ms, as before. *Still weak*:
  that remainder is the browsers' own position, which runs ahead of their
  sound while the output starts and then stands still until the sound
  catches up (WebKit on macOS about 100 ms, Chromium about 20, which the
  frame clock carries across the stand-still); the clock cannot see it.
  Real Safari and iOS are untried (Safari's WebDriver is not enabled on
  the machine measured); Playwright's WebKit uses the same AVFoundation
  stack on macOS.
- Native timing in production (2026-09-26): the Kokoro provider speaks with
  the timestamped model when it is installed and serves its own phoneme
  spans as cues (`lab_timing.native_cues`), falling back to the stretched
  table on any error; see docs/lip-sync-lab.md.
- The character mouth's edge from the picture's sharpness (2026-10-06):
  `look.soft` was the width of the luma step across the closed lips' seam,
  clamped 1 to 4 px, over the mouth's width, and the seam is the wrong edge
  to read for a character as for a person (the photographic mouth, above): a
  crisp cel-art drawing has 1 px lines but a 3 px seam, a smooth render has
  soft lines and a soft seam, and the seam told them apart only by accident.
  `softness` (character-mouth.ts) now takes the picture's sharpness
  (face-sharpness.ts, texture px, the crispest strong edges round the mouth
  and the eyes) over the mouth's width, never past 0.03 W (the photographic
  mouth's ceiling); the seam's step, clamped as before, only when the
  sharpness is null (a flat or tainted picture); `DEFAULT_LOOK.soft` last.
  The engine reads the sharpness in `sampleLipColour`, which runs before
  `sampleCharacterLook` in the constructor and again in `setTexture`, so a
  texture upgraded from its thumbnail rebuilds the look from its own
  sharpness, and the value is cleared before each read so an unreadable
  texture leaves nothing stale. The feather itself (`max(1.2, soft × W)`:
  the inner-lip ring, the rim halo) and cel-art detection are unchanged, and
  flat art never uses the feather (its rim is the drawn line), so the two
  real cartoons render pixel for pixel as before. Measured on the five real
  characters with the real engine at 2 canvas px per texture px (and at
  1:1): sharpness 1.83 (the soft human animation: its eyes), 1.47 (the dog
  photograph), 1.45 (the rendered animal), 1.14 and 1.07 (the cartoons'
  lines) texture px; `soft × W` 4.7 → 3.7, 4.7 → 2.9 and 7.2 → 2.9 px on the
  three shaded ones (the rendered animal's seam had read 3.6 px against its
  1.45 px lines), the feather at held AA 4.9 → 3.8, 4.8 → 3.0, 7.4 → 3.0.
  Every pixel that changed lies within the old halo's reach of the opening's
  ring (feather × 2.75 outside, × 3 inside; p95 equal to it, max 1 to 3 px
  past the strokes' round joins), nothing elsewhere. The ring-probe edge
  width (the feather harness's measure, contrast over the steepest step at
  12 points of the ring) moves little (medians at AA 3.3 → 3.2, 2.3 → 3.1,
  3.7 → 3.9 px): the character painter's edge is a hard clip flanked by the
  upper lip's gap-scaled shadow strokes and the feather's rings, so what the
  feather sets is the halo's reach outside the lip and the tone ring inside
  it (on the rendered animal's EE the ring over the teeth went from 24 to 10
  px, and the teeth read whiter). Goldens: the `toon@1` and `animal@2` cases
  on the position-dependent texture regenerated (9 of 28; its sawtooth wraps
  read 0.80 px, the feather at its floor; the diff of the recorded draw
  calls is six `lineWidth` values a case), the flat-art cases, rest and
  blink unchanged, the human and `animal@1` snapshot byte-identical. Still
  weak: the edge is not a true feather (the photographic mouth's mask is);
  on the soft human render the eyes are 1.83 px but the lips 3.6 to 4.5, so
  the opening is crisper than its own lips, as the measure intends (a depth
  edge is as sharp as the picture's crispest edges) but not what that
  render's own mouth shows; and the seam fallback is still the old measure.
- The warp on the GPU (2026-10-06, every photo engine; `embed/src/warp-gl.ts`).
  *The measured problem*: on the owner's M1 Max in GPU Chrome, the live share
  page of "Sakineh hero white 1536" (canvas 1440×1440 at dpr 2, texture
  1264×843, 2318 triangles, layers background/body/head) ran its animation
  frame in 3.4 ms of JavaScript (p50, max 6) and still got frames 8, 8, ~55 ms
  apart: 45 fps with a 50–60 ms stall every third frame, speaking or idle.
  Disabling every `ctx.filter` changed nothing, the classic mouth instead of
  the photographic one nothing, the canvas at 720×720 ran a clean 121 fps with
  no stall. The cost was the raster of ~2300 `save / clip(triangle) /
  transform / drawImage(texture) / restore` calls a frame on a 1440² canvas,
  which Chrome does off the JavaScript thread. Reproduced in headless Chrome
  (Metal): 2315 `drawImage` and 2312 `clip` a frame, 3.2 ms of JavaScript,
  56.7 ms once each frame is forced to raster. *The design*: `WarpRenderer`
  owns an offscreen WebGL 1 canvas the engine's size (antialias on,
  premultiplied alpha, no depth or stencil). The picture goes up once as a
  texture (LINEAR, CLAMP_TO_EDGE, no mipmaps; again on `setTexture`, never
  on `setLayers`, since the triangles always sample the picture), the texture
  coordinates and the triangle list once per geometry (with the mesh:
  `setTexture`, `setScene`), the deformed positions every frame; one
  `drawElements`. The triangle list is the engine's own in its draw order,
  mouth subdivision and neck band included, minus the source-degenerate
  triangles the 2D path skips (|det| < 1e-6). The body sway and breath and
  the head's rigid transform are the same translate/rotate/translate the 2D
  path puts on its context, composed as an affine beside it
  (`applyBodyTransform`, `applyHeadTransform`) and given to the vertex shader,
  so the GL canvas is in canvas pixels and is drawn under the identity: the
  picture is resampled once, not twice. Blending is source-over on
  premultiplied texels, as `drawImage` composites, so a cut-out's edge and a
  fold in the mesh come out as before. The frame: the scene background, the
  full frame(s) and the head layer as before, then the mesh's bounding box of
  the GL canvas in ONE `drawImage` where the loop was, then the eyes, lids,
  lashes and mouth in 2D on top, untouched. No seam pads: the GPU rasterizes
  shared edges exactly, and the pads exist to hide the half-pixel hairlines
  adjacent 2D clips leave. *The fallback*: the 2D path is intact and taken,
  frame by frame, where there is no WebGL (none in Node: the golden tests take
  it, byte-identical), while the context is lost (`webglcontextlost`,
  default prevented; `webglcontextrestored` uploads the texture and the mesh
  again), when the texture cannot be uploaded (tainted, past
  MAX_TEXTURE_SIZE), and when asked: the `warp: "2d"` option, `setWarp("2d" |
  "auto")` live, `warpPath()` to read which, the widget's `data-warp="2d"`.
  One context per engine, freed in `destroy()` (WEBGL_lose_context). The
  dashboard previews, the lab and the share page construct the engine as
  before and get it. Bundle 83.8 → 92.0 KB minified, 31.4 → 34.4 KB gzipped.
  *Parity* (headless Chrome, Metal and SwiftShader, 1440² face framing; one
  engine rendered twice per frame from one state, 18 frames: rest, held
  AA/EE/OO, 12 frames of the production cue track, a blink mid-sweep, a
  sway/breath/head-turn frame; bita, mehdi, mehdi_avatar, the Reference,
  human-animation and human-cartoon `toon@1`, animal-realistic `animal@2`):
  PSNR over the mesh's box away from the triangle edges (±1.5 px), worst
  frame per subject, 51.6–57.5 dB (bita 54.4, mehdi 57.5, mehdi_avatar 52.7,
  Reference 55.3, human-animation 56.7, human-cartoon 51.9, animal-realistic
  51.6); edges included 44.0–54.9; the whole frame 48.7–55.2; the mouth
  44.6–57.4 (the animal's held AA: the 2D pads' mitres spike on the sliver
  triangles at the mouth corner, which GL does not draw); the eyes 40.8 (the
  cartoon's drawn lines) to 54.1; chin and neck band 41.4–56.0. Pixels off by
  more than 16 levels away from the edges: at most 37 per million. Hairlines
  along the triangle edges (the luma on the edge against the mean of both
  sides, over 10 levels): 2D-only 6–230 against GL-only 2–151 per subject of
  0.4–0.94 million edge samples, and none of either is a seam in the 3×
  zooms: they are the picture's own lines crossing an edge under sub-pixel
  differences in resampling. In the sheets (mouth, eyes, chin and neck at
  1:1, jaw line and mouth corner at 3×) the two rows are indistinguishable;
  the diff shows up to a pixel of edge shift on flat art, where the 2D pads
  overlap, and the spikes above. *Performance* (headless, Metal; the 2D
  canvas in headless is software-rasterized, a scaled full-frame `drawImage`
  costs 6 ms at any quality and a same-size canvas copy 0.9 ms, so these are
  not the owner's Chrome's numbers): per frame 2D 2315 `drawImage` + 2312
  `clip`, GL 4 `drawImage` + none; JavaScript 3.2 → 0.1 ms (p50); the frame
  forced to raster 56.7 → 22.3 ms, of which the GL mesh draw is 1.1 ms, its
  composite 3 ms and the three full-frame layers 18.8 ms. Frame spacing on
  the engine's own loop at 1440², bita, 3 s each idle and speaking: 2D p50
  66.6 / p90 116.7 / max 216.6 ms (15 fps, 30 of 47 frames over 30 ms); GL
  p50 33.3 / p90 33.4 / max 66.7 ms (32 fps, every frame two vsyncs: the
  software full-frame draws of the three layers). The Reference at 1440²
  (one full frame, a PNG): 2D idle 60 fps without a stall (a still mesh
  draws every triangle through one matrix, which Skia serves from a cache;
  bita's JPEG-backed picture stalled idle too), speaking p50 16.7 / p90
  33.3 / max 50 ms, 48 fps, 34 frames over 20 ms; GL 60 fps idle and
  speaking, p90 16.7, max 16.8, no frame over 20 ms. At 720² both paths sit
  at the 60 Hz headless cap. The owner's GPU Chrome re-measures with
  `__liveface.setWarp("2d")` and `("auto")`. *Still weak*: no measurement
  on an accelerated 2D canvas; on a software one the full-frame layer draws
  are now the frame's largest cost, untouched here; MSAA and the composite
  cost per canvas pixel; no GPU timer; GL magnifies bilinearly where Skia's
  "high" filter is what the pixel of edge difference is; Safari and iOS
  untried.
- The motion of speech (2026-10-06). Measured with the real engine in
  headless Chrome on a virtual clock stepped at exactly 60 fps, the
  production cue track (native Kokoro timing, 59 events for one sentence)
  on three published people and the lab Reference (its own kit and the
  standard motion move identically: one chain, one geometry), the
  photographic mouth's lip gap lagged the blend by 42 ms (cross-correlation
  of the jaw's blend at the audio clock against the gap; the median vowel's
  peak 67 ms after its bell's, the latest 133: a voice leading its mouth by
  more than about 45 ms is what people see as out of sync), moved up to
  0.081 of the mouth's width in one frame (every /p/ /b/ /m/: the pose
  spring switched from 65 to 125 mid-flight), re-mixed more than half its
  pose mass in one frame 17 times in the sentence (inverse-square mixing
  makes a small move of the weights a large move of the mixture) and
  popped the teeth on whole in one frame 11 times (an opening after a
  closure crosses the enamel ramp, 0.03 to 0.09 W, in a frame). Not the
  cause: the 25 to 50 ms `sil` events between syllables (prepareCues folds
  the ones under its floors; this sentence keeps only its three pauses),
  the head's beats (three nods, 0.46 px a frame at most), or the clock
  (steps of 16.0 to 17.7 ms with a finely refreshed `currentTime`; a
  browser that quantises it to 20 ms would step 3 to 30 ms, which
  media-clock.ts does not yet slew). Now: the blend reads the track ahead
  of the audio clock by the articulation's own delay (`ARTICULATION_LEAD_MS`
  50, `articulationLead`: the filter's half scaled by `tune({smoothness})`,
  the spring's not); a silence shorter than `SHORT_SILENCE_MS` (110)
  between two voiced cues pulls toward rest in proportion to its length,
  since a mouth closes on /p/ /b/ /m/ and at phrase ends, not between
  syllables; the pose spring is softer (`SPRING_OMEGA` 65 to 35) and
  stiffens toward a bilabial smoothly by the mixture's own seal
  (`CLOSURE_OMEGA` 125 to 80, `bilabialSeal`); and the teeth and cavity
  reveals rise over at least `REVEAL_RISE_MS` (60) and fall at once
  (`RevealRamp`, in continuous-mouth.ts's paint). A second-order weight
  filter with the same delay was tried and measured worse (the gap's
  acceleration up 7%, its jerk up 13%), so TAU_OPEN/TAU_CLOSE stay.
  Measured after, same track: lag 9 ms (median vowel peak 42, latest 83),
  the largest step 0.063 W (a bilabial closing: a /p/ still shuts in 50 ms,
  as it should), half-mass re-mixes 4, teeth pops none (0.28 a frame at
  most), the gap's acceleration −34% and its jerk −48%, the peak opening
  −1%, a 127 ms comma pause now a near-closure (0.055 W) rather than a shut
  mouth; the classic mouth's gap is the same shape 17 ms early (it has no
  spring to wait for; video leading sound is seen only past ~125 ms).
  Every live photographic mouth moves this way (the avatar-motion digests,
  which hash every frame between the poses, re-recorded; the held poses,
  rest, blink and the single-frame goldens are unchanged, a first frame
  taking its reveal whole). Pinned by `articulation.test.ts`: the lead, a
  vowel's peak within 40 ms of its centre and begun before its sound, the
  short-silence rule, and on the production track a largest step under
  0.07 W, acceleration under 0.04, teeth rising at most 0.28 a frame and
  closures only on bilabials, in pauses and at the end. Still weak: a long
  pause after a vowel dilutes that vowel's peak (its bell is as wide as
  the pause); the bilabial snap is still the largest step; the clock is
  not slewed; and the people the owner named (Sakineh, Tareq) were stood
  in for by published people with the same motion, their own published
  assets needing a signed URL this measurement did not have.
- A cut-out moves as one picture (2026-10-07; `embed/src/engine/render2d.ts`,
  `mesh-warp.ts`, `geometry.ts`). The owner, after seeing seams on the
  cut-out cartoon "Sakineh Animesh": "we decided not to cut the photo". A
  cut-out without published layers used to cut its head out as a feathered
  layer, erase it from the picture and draw it moved; the feather band is a
  cross-fade of two positions of the same strands, and it showed through
  the hair, the neck and the collar whenever the head moved (a doubled
  collar edge on a turn, a band across the neck at the bottom of a nod),
  however exactly the two halves summed at rest. Now a cut-out is composed
  as an opaque picture always was: ONE picture, the body's sway and breath
  and the head's motion applied to the whole of it, the face mesh's
  deformation on top with its edge at rest, so there is no second copy and
  no boundary to show. The head's motion on a whole bust
  (`applyBustTransform`) is a lean from a pivot low on the chest
  (`HeadGeom.bustPivotY`: 1.9 face heights below the chin, never below
  the picture; `bustReach` from the face's centre to it, at least a face
  height): sideways a shear (the face travels dx, the shoulders' line a
  fraction of it and stays level; a rotation by dx / reach, tried first,
  see-sawed the shoulders' ends by 8 px on a 960 stage), up and down a
  foreshortening about the pivot (1 - dy / reach: the brow dips a little
  more than the chin, as a pitch looks from in front, and the picture's
  lower edge never rises into view), the roll a rotation (the head's tilt,
  which the face must show; it tilts the bust's cut bottom edge by the
  same angle in the full framing). Measured on Sakineh, full framing, 960
  stage, at the deepest nod: brow +13, chin +8, shoulders +3 px (the head
  layer: +9.5, +9.5, +0.5); at a full turn: eyes +13.5, chin +8.5,
  shoulders +1.5 px (head layer: +11, +10, +2.5). Travel is the cut-out's
  as before (head 1, body 1). Opaque pictures and layered avatars draw
  exactly as before (the bita and Reference frames and the human and toon
  goldens are byte-identical); the layered path stays a deliberately
  separated rig. The head layer is kept as an opt-in for comparison:
  `new AvatarEngine(..., { cutOutHeadLayer: true })`, or live
  `setCutOutHeadLayer(true)` (on the debug handle:
  `__liveface.setCutOutHeadLayer(true)`). Two seams that were not the head
  layer's went with it. *The 2D warp over a cut-out* laid moved triangles
  over the picture, so a half-transparent pixel composited over itself
  (alpha x (2 - alpha)) wherever the face moved: the neck band, stretched
  by the jaw while speaking, drew a light line down Sakineh's hair fringe
  (54 to 115 detector seams on every 2D configuration of her). Each moved
  triangle now REPLACES what is under it, through its own padded clip:
  the clip's coverage erased ("destination-out", a fill of the clip's own
  box) and the triangle added ("lighter"), so both draws share one
  coverage, the "copy" no composite operation does portably. Erasing the
  moved region whole and adding unpadded triangles was tried and fails in
  2D: two triangles' coverages along a shared edge do not sum to one in
  Chrome (a bright wire along every edge); and a fill of a million pixels
  a side erased whole boxes round the face on Linux Chromium's software
  canvas. *A sliver hole*: a rig without one triangle folded at rest (the
  human-animation fixture lacks (435, 361, 288), a pixel past its
  opposite edge) has, once the neck band hangs from the jaw line, a hole
  in the mesh whose corners move with the jaw: a gap 15 px long opened at
  the jaw corner while speaking, the still picture's old jaw showing
  through (23 to 30 tears). `refineMesh` closes every 3-cycle of open
  edges (`closeSlivers`, the mouth subdivision's T-junctions excepted);
  no whole rig changes. *Measured* with the seam detector (every mesh,
  neck-band and GL-box boundary, each frame of rest, idle, forced sway,
  head turn, sway + head, 8 frames of the production cue track, 12 of a
  nod and 12 of a turn; headless Chrome, Metal, GPU raster), its
  reference now drawn as the engine's own canvas is (a GPU canvas, then
  over the stage colour; the old CPU reference flagged 4-6 level
  "lines" where two rasterizers resample hair differently, at rest too):
  Sakineh GL and 2D, face 960 and 1440, full 960 and 1440: 0 seams
  (main 2D 85 to 115); mehdi_avatar without layers, 960 and 1440, both
  paths: 0; the toon and animal fixtures: 0, but animal-realistic, 1 to 2
  in one speech frame, a crease where the jaw stretches the fur against
  the mesh's still edge, the same on main. The layered mehdi_avatar (not
  changed) keeps its 4 to 5 seams and 6 tears. Goldens: only the cut-out
  animal's change (every frame, darwin-arm64 and linux-x64, Skia and
  Chromium): the whole picture now leans where the head layer moved;
  GPU against 2D 46.3 dB min on macOS, 46.9 on Linux (was 45.1, 45.5).
  *Still weak*: the roll tilts a full-framed bust's cut edge (0.8 degrees
  at a forced 0.7 roll); a nod foreshortens the face a few percent rather
  than pitching it; the animal crease above.
- The head turns in depth, stage 1 (2026-10-08; `embed/src/engine/head-turn.ts`,
  `head-personality.ts`, `neck-blend.ts`, `kind-profile.ts`, `render2d.ts`,
  `mesh-warp.ts`). The owner approved the prototype (the face turned inside
  the mesh about a pivot between the ears, depth from MediaPipe's canonical
  face fitted to the rig, a seeded personality) on conservative angles,
  every seam at 0, on by default for photos only; hair and the outline
  following the turn is a later stage. *Defaults*, by the avatar's
  published face type (`kind-profile.ts` `defaultHeadMotion`; the embed
  and share responses carry `face_type`, the engine takes it as `faceType`): a
  person ("human") turns in depth ("3d"), whether opaque, layered or cut
  out; an animal or a cartoon keeps the rigid layer ("2d") whatever its
  rig names. The rig alone cannot tell: one fitted before profiles existed
  names none (in production a cat and two cartoons), and so does a
  cartoon's with the classic mouth. A host that passes no face type (one
  from before it was served) falls back to the rig: no render profile
  turns in depth, `toon@1`, `animal@1` and `animal@2` keep the layer. The
  layer draws exactly what it drew once the cut-out moved as one (every
  frame of the six character and animal subjects hashes the same on both
  paths; their goldens are untouched). The engine's `headMotion` option,
  `setHeadMotion()` live and the widget's `data-head-motion="2d"|"3d"`
  still choose over the default; `headMotion()` says which runs.
  *Angles*: at most 7 degrees of yaw, 5 of pitch and 3 of roll, each axis
  easing into its limit past 70% of it
  (`softLimit`, a tanh knee) rather than cut off; the personality's drift,
  postures, glances and nods at about 0.6 of the prototype's. An hour of
  simulated idle and speech (the production sentence, energy varied) peaks
  at 5.7, 4.3 and 2.3 degrees (p95 4.1, 1.7, 1.3); the 11 s clips of the
  sentence reach 3.4, 1.5 and 1.3. *The turn* no longer fades every
  landmark's displacement to nothing over a band 0.42 IOD inside the mesh's
  edge: in a real turn the forehead and the temples travel too (at 7
  degrees the forehead's top a tenth of an IOD), and the band undid all of
  it, so it sheared and stretched: the temples and the forehead at the
  larger turns, and the lower face on every nod, where the jaw line was
  held. Now the outline (the rig's boundary less the jaw line) stays where
  the rigid motion puts it, and only the outline's own travel is taken out
  of the turn: its displacement extended inside as the harmonic function of
  the mesh (inverse-length edge weights; the free landmarks' Laplacian
  factored once per rig, an envelope Cholesky after a reverse
  Cuthill-McKee ordering, about 18 ms, the same weights at every viewport).
  Every difference of the turn between the face's parts is kept (the nose
  sweeping over the cheeks, the far cheek widening) and the share of the
  whole face's travel the outline cannot take is spread over the face
  instead of a band. A 0.3 IOD band still eases out what is left beside the
  outline (the face's side foreshortening toward its silhouette, which a 2D
  mesh can only crush). The jaw line is inside the drawn mesh (the neck
  band hangs from it), so the chin turns and nods with the face and the
  band's neck skin takes up the difference; only the jaw line's two
  landmarks below each ear are outline. The roll is the rigid motion's
  alone: inside a held outline it can only be a shear (3 degrees swung the
  chin 20 px under a still brow on a 960 stage), so the tilt the face shows
  is the layer's or the picture's: 40% of the roll on a layered head, 30% on
  a cut-out's bust, 20% on an opaque photo, which tilts its own edge in the
  whole framing (0.6 degrees at most, as today's motion does). The rigid
  motion takes half the skull's travel on a layered head and a cut-out's
  bust, a third on an opaque photo. Each eye moves as one piece (a
  stretched eye reads as a glance) and so do the lips, so the mouth the
  speech shaped keeps its shape. A triangle the turn would crush below a
  fifth of its area is first eased (its free corners halfway to its own
  mean move, at most six passes); only a turn that still folds one is
  scaled back whole. At the corners of the pose box easing happens on
  mehdi_avatar at -7 degrees of yaw (the nose's side, 3 of 8 corners) and
  nowhere else; the scale-back never; in the speech clips neither. Turned,
  the mesh's outer edges are left unpadded in 2D (`unpadOutline`): a seam
  pad there painted a pixel past the picture the mesh meets, and on a
  layered collar that pixel stepped the lapel's edge. *A layered avatar's
  neck*: the collar tear (the neck band, moved with the head, drew the
  photo's collar a head's shift off the body layer's: 153 detector tears
  on mehdi_avatar on main, a white wedge of collar over the lapel at a
  turn, in either head motion) came from the layered picture itself. Its
  head layer is the head, the neck and the top of the collar, fading out
  down the neck or cut sharp along a collar, and it moved rigidly over the
  still body, so below the chin the picture was two positions of the same
  neck, cross-faded or stepped. Now the head layer and the body layer are
  drawn through one warp (a grid of triangles, each replacing what is under
  it on a scratch canvas the stage's size, the scratch then laid over once,
  pixel for pixel; triangles off the stage skipped): a point resting at
  (x, y) takes a share s of the head's motion relative to the body, 1 down
  to the chin, eased to 0 at the band's bottom, level as far out as the
  band reaches and rising toward the shoulders beyond it; the neck band's
  vertices are placed by the same map, so band, collar and body agree and
  nothing is drawn in two positions. *Measured* with the seam detector
  (rest, idle, forced sway and turn, eight frames of the production
  sentence, a full nod, a full turn and the six corners of the pose box;
  headless Chrome on Metal, GPU raster; 960 and 1440 stages), against what
  the canvas held just before the mesh was drawn (a layered picture is a
  warp now, which the old references, the still picture through each
  rigid transform, do not model): sakineh, mehdi_avatar (layered, and as a
  cut-out), bita and the Reference, both paths, both sizes: 0 seams and 0
  tears on the face's outline, the neck band's bottom and the GPU copy
  box. Main, the same detector: sakineh 4 to 23 seams, mehdi_avatar 29 to
  35 (and 153 to 168 tears against the old references), bita 0 to 3. The
  layers' warp along each of its rows, against the still picture read
  where the warp took each sample from, where the layers cover: 0 seams, 0
  tears (the worst run 3.6 levels of line, 2.7 of step). The prototype's
  "GPU copy box tears" were the layered picture's own cross-fade under the
  box's edge, never the copy. Lip-sync on Sakineh, mehdi_avatar and bita:
  with the head still, every mouth landmark of every frame the same in
  either mode; turning, the mouth's shape after similarity alignment within
  0.05% of its width and its opening to its width unchanged to 1e-4 (the
  prototype: 0.8% and 0.0017). Goldens: the human subject's every frame
  changes (darwin-arm64 and linux-x64, Skia and Chromium) and it gains two
  frames, the turn held at two corners of its limits; the draw-call goldens
  (a frame at rest) are unchanged; toon and animal are byte-identical. GPU
  against 2D on the human: 45.7 dB min on macOS, 47.3 on Linux. CI holds
  the seams on the committed photo with a striped collar, opaque and as a
  layered avatar, at every corner and mid-sentence, on Skia
  (`seams.test.ts`) and in Chromium on both paths
  (`browser-tests/seams.test.ts`): no seam, no tear, no run stepped by more
  than 3 levels (an unpinned band steps it by 10 to 20; freeing the jaw's
  ends fails both). Frame cost (the tick's and the render's JavaScript,
  960 stage, headless Metal, the production sentence, median and p95): on
  the GPU path a layered avatar 0.5 to 1.0 or 1.1 ms (p95 0.7 to 1.3 or
  1.4; the layers drawn through the warp are most of it; bita, whose
  picture the face framing mostly crops, 0.4 to 0.6), the Reference 0.2 to
  0.3, the toon unchanged at 0.3; on the 2D path a layered avatar 2.2 to
  4.6 or 5.0 ms, the Reference 3.3 to 3.4. *Still weak*: hair and the
  outline do not turn (a later stage); mehdi_avatar's nose side eases at
  the largest yaw; bita's shoulders lie within the band's reach and take a
  share of the head's motion, and her background layer's halo shows along
  the left shoulder at the largest turns (main shows a darker double edge
  there); the animal crease above is unchanged, as all animal output is.
- The hair, the ears and the head's outline turn with the face, stage 2
  (2026-10-08; `embed/src/engine/head-field.ts`, `head-turn.ts`,
  `head-personality.ts`, `mesh-warp.ts`, `warp-gl.ts`, `picture.ts`,
  `engine.ts`). Stage 1 turned the face inside a still head: the outline
  (the forehead's hairline, the temples) was held where the head's rigid
  motion put it, so the face slid under its own hair. Now a *head field*
  carries the turn out over the hair and the ears to the head's silhouette.
  It is part of the face mesh, not a second warp: a ring of triangles whose
  inner edge is the face's outline (the rig's boundary from 234 over the
  top to 454) and whose ends are the neck band's end columns, along spokes
  from the skull's centre (canonical (0, 2.5, -4.3) cm through the photo's
  fitted camera), one per outline landmark, four vertices each out to where
  the field ends. The face and the field share every vertex they meet at
  and are drawn in the same pass (on the GPU, the same draw), so there is
  no seam and nothing moves twice. *Where it ends* is read off the
  picture once (its pixels at most 768 a side): on a cut-out (sakineh,
  mehdi_avatar) 0.12 IOD past the alpha silhouette, into the clear, short
  of anything opaque beyond, so the silhouette itself moves with its alpha
  (the warp replaces what is under a moved triangle); on an opaque photo
  (the Reference, bita) where the background starts, told by the colour the
  picture shows well away from the head (one colour: a plain backdrop) or by
  a layered avatar's own background layer, 0.08 IOD past it over a flat
  background and 0.05 IOD inside the hair over anything else, so a busy
  background is never stretched; where the background cannot be told, the
  canonical skull's outline, the field fading inside 85% of it; never past
  what a layered avatar's head and body layers cover (its background layer
  stays still), never within 0.03 IOD of the picture's edge. A picture that
  cannot be read (a cross-origin texture) gets no field and turns as in
  stage 1. *How it moves*: the outline from 234 to 454 turns with the face
  as far as its band of hair takes (30% of the band's width, eased into past
  70% of it), easing in over 0.6 IOD from its held ends below the ears
  (moving whole beside a held 234 crushed the temple's thin triangles at a
  9 degree turn and a nod); the harmonic correction takes out only what the
  outline does not travel. The field's own vertices turn on the skull: a
  depth along each spoke on an ellipse through the outline's depth and the
  silhouette, where the depth is the skull centre's, rotated by the same yaw
  and pitch about the same pivot, the rigid motion undone, their share
  falling from halfway along the spoke to 0 where the field ends. A sphere
  turned about its centre keeps its silhouette, and so does the head: the
  hair slides over it, compressing on the side the face turns toward and
  opening on the other; the hairline goes with the forehead. The ears, near
  the pivot's depth, move as the head's rigid motion moves them, as they
  did. *Drawn* only where it moved, on both paths and over any picture
  (laid over an opaque one, replacing what is under a cut-out): at rest the
  field is the picture under it, pixel for pixel, and it is laid only for
  the turn in depth, so an animal, a cartoon or `headMotion: "2d"` has none
  and draws exactly as before. On the GPU the triangles before the field's
  are drawn as one prefix when none of it moved, else the face's and the
  field's moved ones as a subset. *The 2D path*, turning, now pads every
  triangle (stage 1 padded only where the lower face's rig moves the mesh):
  unpadded, a software canvas's anti-aliased clips let the picture under
  the eyes and the forehead, shifted by the turn, through every edge, a
  faint wireframe (42 dB against the GPU path at a 9 degree turn in
  Playwright's Chromium); and the mouth subdivision's T-junctions are no
  longer taken for the mesh's outer edge (each of a split edge's three
  pieces is in one triangle, so all three lost their pads while turning: a
  jagged ring round the mouth on Skia). *The yaw* is now at most 9 degrees
  (`POSE_LIMIT_DEG`), the personality's yaw drives (the drift, a phrase's
  shift, a glance) 9/7 of what they were; the roll a turn brings, and the
  head's rigid travel (`engine.ts` headFrame3d), are the 7 degree turn's,
  so the body, the shoulders and an opaque picture's edge move no more than
  in stage 1: the two degrees more are the face's and the hair's. Twenty
  simulated minutes per person (idle and the production sentence, 30 fps):
  yaw peaks at 7.3 degrees (p95 5.0; stage 1 5.7, 3.9), past the soft
  limit's knee 0.64% of frames as before; the face's fold easing on 1.7% of
  mehdi_avatar's frames (stage 1 0.01%: its nose's side) and 0.07% of bita's,
  never anyone else's; the scale-back never; the field's band cap on 0.64%
  of bita's frames (keeping at least 97% of the outline's travel), never
  anyone else's; the field's smallest triangle at 53% of its area.
  *Measured* with stage 1's seam detector, its boundary now the field's
  outer edge, against the references and what the canvas held before the
  mesh was drawn, and a new leak test inside the mesh (each frame's mesh
  drawn again over a magenta and over a green backdrop in place of the
  picture: a pixel inside the drawn triangles, 2 px from their edge, where
  the two differ shows the backdrop through a gap or a pixel drawn twice);
  rest, idle, forced sway and turn, eight frames of the sentence, a full
  nod, a full turn and the six corners of the pose box at 9 degrees (stage
  1 at 7); headless Chrome on Metal; sakineh, mehdi_avatar (layered and as
  a cut-out), bita, the Reference and the cartoon, both paths, 960 and 1440
  face framings and sakineh's and mehdi_avatar's published whole-picture
  framing: 0 seams, 0 tears and 0 leaking pixels everywhere (stage 1 the
  same, without a field), the layers' neck grid 0 and 0 at the face
  framings (see below for the whole picture). CI holds it on the
  committed photo, opaque and layered: on Skia (`seams.test.ts`) and in
  Chromium on both paths (`browser-tests/seams.test.ts`) no seam, no tear,
  no run stepped by more than 3 levels along the field's outer edge and the
  neck band's bottom, the field moved in every frame, no pixel of it
  showing the backdrop, and at most 200 pixels of the face's own triangles
  (a software raster leaves a few: Skia and Linux Chromium's 2D path about
  a hundred where padded clips meet at a sharp angle, at most 14 of the
  backdrops' 255 levels; Linux's SwiftShader GPU path 9 to 24 single pixels
  at the mouth subdivision's T-junctions; macOS none. Before the turn
  padded every triangle, eight and a half thousand on Skia, a wireframe;
  with the T-junctions unpadded, eight hundred, a ring). At the
  whole-picture framing mehdi_avatar's neck-grid probe reports about 200
  lines in either stage: its rows fall across the lips there, under the
  face mesh, which the probe does not see (the frame is clean). Lip-sync,
  the production sentence, sakineh, mehdi_avatar, bita and the Reference:
  with the head still every mouth landmark of every frame is stage 1's;
  turning,
  the mouth's shape after similarity alignment within 0.05% of its width
  (stage 2 0.048% worst, stage 1 0.049%) and its opening to its width
  unchanged. Goldens: the human subject's every frame (darwin-arm64 and
  linux-x64, Skia and Chromium); toon and animal byte-identical; the
  draw-call goldens keep the face mesh's digest and drawing, and add the
  field's vertices' digest. GPU against 2D on the human: 45.3 dB min on
  macOS (mean 48.0), 48.4 on Linux (51.5). Frame cost (the tick's and the
  render's JavaScript, 960 stage, face framing, the production sentence,
  frames paced at 60 Hz, three rounds interleaved with stage 1's on a
  machine shared with other work; median and p95): the GPU path unchanged
  within 0.1 ms (sakineh 1.3 and 1.6 ms, mehdi_avatar 1.3 and 1.6, bita 0.9
  and 1.3, the Reference 0.5 and 0.7, the cartoon 0.4 and 0.7). The 2D path
  (no WebGL) takes 0.2 to 0.3 ms more at the median (sakineh 4.9,
  mehdi_avatar 4.8, bita 4.0, the Reference 3.6; the cartoon 2.6, as
  before) but rasterizes 45 to 70% more pixels a frame (the hair, redrawn;
  5% more triangles), and on the two cut-outs, where each moved triangle
  erases and redraws, its p95 (the frames that wait for the raster) rose:
  sakineh 23 to 24 ms against stage 1's 6 to 17, mehdi_avatar 19 to 24
  against 6 to 18 (bita 7 against 27, the Reference 4.4 against 4.1; on
  this machine one run's p95 differs from the next's by up to 35 ms).
  Erasing a field triangle's own outline instead of its box did not help.
  *Still weak*: the silhouette of long hair below the ears (the field ends
  at the ears' level, the neck band's end columns) moves only rigidly; the
  ears are the rigid motion's; the hair's texture shears a little where the
  hairline travels far and the silhouette does not (a sphere's surface
  sliding, but read on a flat picture); mehdi_avatar's nose side still
  eases at the largest yaw, now a little more often; bita's shoulders lie
  within the neck band's level reach and take a share of the head's rigid
  motion (no more than in stage 1), her background layer's halo along the
  left shoulder at the largest turns; the 2D fallback's raster stalls on
  cut-outs; the animal crease above is unchanged.
- One lower lip on a rendered character's open mouth (2026-10-09;
  `embed/src/engine/character-paint.ts`, `character-mouth.ts`,
  `paint-mouth.ts`). *The report*: the live "Sakineh Animesh" (`toon@1`, a
  smooth render) speaking, "below the lips is weird and double": under the
  upper teeth and a dark band, a pink crescent with a crease down its middle,
  a dark line, then the picture's lower lip. *The cause*, measured on her
  published rig and picture with the real engine at the dashboard's 960 px
  stage, 4x on the mouth with the mesh, the inner lip rings, the opening and
  the tongue drawn over it: the crescent is the painted tongue. It lay along
  the lower lip, `here × (0.3 + 0.58 × raise)` tall (a third of the opening
  on "aa", nearly half on "E", and the eased raise sits at 0.3 to 0.45
  through most of a sentence), as red as her lips (shaded 190, 82, 86 against
  a lip of 175, 87, 77), lighter at its top with a light wet line along it,
  its top parallel to the lip line and a groove down its middle: a lip, its
  edge's shine and its crease. Under it the lower lip's shadow, one crisp
  stroke along a quadratic smoothing of the lip ring, cut the ring's curve
  and so lay 3 to 9 px inside the opening, a dark line between the tongue
  and the lip. Not the mesh: every row of the lower lip moves by the same
  amount (held E: 60.5 px, inner to outer), the skin below takes 52 and the
  chin 47, and the picture's own lip and outline move with it, whole. Not
  new: the tongue's painting is the same since the character mouth's polish
  (2026-10-04), and a build of that day draws the same frame; the classic
  mouth on the same picture has no such band. With the tongue off the lower
  lip read as one. Read along the lip's normal at five places across its
  middle (the brightest luma inside the opening, from a tenth of its height
  above the edge to the teeth, over the darkest within 3 px of the edge):
  67 to 82 levels on held aa, E, ou, ih and oh, the band 0.85 to 1.2 times
  the lip's brightest, on her and on the rendered human; a second lip (over
  40 levels, at least 0.75 of the lip) in 22 and 20 of the production
  sentence's 43 open frames with the tongue low. *The fix*: where a render's
  lips are of the tongue's red (`lipLikeTongue`: the lip colour's hue under
  18 degrees from red, or nearly grey; lips measured 6 to 10, fur 25 to 31),
  the tongue lies behind the lower lip (`paintTongueBehindLip`): an ellipse
  the opening clips, wider than tall, so its top is a shallow arch that meets
  the lip at an angle and goes behind it; its top 12% of the opening above
  the lip's middle at rest, the floor of the mouth, and up to 62% only as
  `tongueLift` rises (0 for every vowel and /r/, nearly 1 for /th/, /d/ /t/
  and /n/ /l/, from the same eased raise); half in the mouth's shade and a
  little dulled at rest, darker and duller than the lip, into the light as it
  lifts; its top fading into the dark over most of a resting sliver, its own
  colour going clear (a darker colour in the fade drew a line); its groove
  and shine only as it lifts. The lower lip's shadow follows the clip's own
  curve (`lowerEdgePath`) and fades in five strokes from 0.27 at the edge to
  nothing a tenth of the opening in, with no edge of its own, on every
  shaded mouth. Cel art keeps its tongue and its drawn line, pixel for
  pixel; so does a muzzle (fur round the mouth: a photographed dog, a
  rendered animal), whose tongue lying along the jaw is plainly a tongue,
  with only the softer shadow. *Measured* (the same harness, main against
  this): on her held vowels the band over the edge 67 to 71 → 0 to 4 levels
  (0.85 to 1.07 of the lip → 0.33 to 0.47), on the rendered human 77 to 82
  → 4 to 12; in the sentence, frames with a second lip (over 40 levels, at
  least 0.75 of the lip) 22 → 4 and 20 → 2 of 43, the rest being /f/ /v/'s
  tuck, the lower lip rolled under the teeth by design, which a closing "aa"
  into /p/ reaches; raised, /th/ and /d/ show the tongue's tip as a mound in
  the middle, not a band across. The human cartoon (cel art) is unchanged in
  every frame, the classic mouth on the same picture is unchanged in every
  frame, the animals keep their tongues. CI holds it (`toon-lower-lip.test.ts`,
  Skia): on the toon subject's held aa, E and ou, nothing inside the opening
  stands more than 20 levels over the edge's dark at the lip's middle (main:
  61). *Goldens*: the character golden's render cases of `toon@1` and
  `animal@2` (aa, oh, E, TH: the lower shadow, 4 draw calls fewer; the
  synthetic render's lip is not of the tongue's red), and 14 new cases on a
  render with red lips (the tongue behind the lip); the flat-art cases, rest,
  FF and blink unchanged. The toon subject's Skia and Chromium frames where
  the mouth is open (held aa, E, ou, the sentence at 20, 60 and 80%: the
  tongue band gone) or barely parted (held PP, the sentence at 40%: at most 6
  levels, the shadow), darwin-arm64 and linux-x64; the human (photo) and
  animal (`animal@1`) frames byte-identical on both. Still weak: the resting
  tongue is nearly invisible on a wide "aa" (the mouth reads as a dark
  hollow); the tuck's rolled lower lip, reached by "aa" closing into /p/
  with the jaw still open, fills the opening with enamel and a pale band
  for a frame or two; a render with orange or tan lips past 18 degrees
  keeps the tongue that lies along the lip.
- The mouth turns with the head (2026-10-10; `embed/src/engine/mouth-pose.ts`,
  `embed/src/mouth/dental-arch.ts`, `head-turn.ts`, `head-placement.ts`,
  `paint-mouth.ts`, `mouth/dental-oral-surface.ts`, `mouth-extension.ts`).
  *The report*: while the head turned in depth, the teeth stayed where the
  mouth is at rest. The landmarks are turned inside the mesh, the lips as
  one piece, but every mouth was handed the rest pose as its frame
  (`neutral: mesh.basePoints`), so its cavity and teeth were placed from
  the mouth at rest: at 7 degrees of yaw the upper incisors' midline sat
  16% of the mouth's width off the lips (sakineh; 11 to 14% on
  mehdi_avatar and bita), and a 5 degree nod hid the upper row under the
  upper lip. The owner approved the prototype (`proto/mouth-turns-with-head`);
  this is it rebuilt. *The frame*: `MouthPose` reads the turn's last apply
  (`HeadTurn.applied()`: each landmark's shift, the pose, the share the fold
  clamp kept, the rigid motion taken out) and hands the mouth the rest pose
  moved by each landmark's own shift as `neutral`, so the corners, width and
  angle every mouth reads (the continuous mouth and its drawn-teeth
  fallback, the classic mouth, the character mouth) are the turned lips';
  null when the face did not turn in depth, so frontal frames and the "2d"
  motion are untouched. The speech still deforms the lips in the rest frame,
  before the turn. *The contract* grows without breaking anyone:
  `MouthSurfaceFrame.turn` (optional, typed `MouthTurn`: yaw, pitch, px per
  mm, `behindLips(out, x, y, depth)`, where a point that deep behind the
  lips is seen: (x, y) itself at depth 0 and at no turn, continuous in
  both); an extension that ignores it draws in `neutral`'s frame, as on the
  lips. *The teeth in depth* (`dental-arch.ts`): the upper incisors 10 mm
  behind the lips' line, the lower 12, each arch curving back toward the
  molars (0.031 mm per mm² off the midline: the canines 9 mm further back,
  the first molars 19), `ARCH_MM`. The photo is the arch seen from in front,
  so each column is given its depth and seen through the turn: the arch
  lags the lips a little (about 3% of the mouth's width at 7 degrees, on
  purpose), the side coming toward the camera widens, the far side
  foreshortens. Drawn so that the turned path is the frontal one at no turn,
  pixel for pixel, and moves from it continuously: the turn is split into a
  frame (the frontal rectangle onto the box the turned arch spans, through
  the context's transform) and a bend applied to the arch's own picture in
  24 affine strips, each in a band of whole pixels (the bands tile it: every
  pixel drawn once, no seam), and the bent picture's box is drawn exactly as
  the frontal arch is (the same box, rectangle, clip, alpha, filter). The
  prototype drew overlapping strips on a scratch canvas and that canvas onto
  the face, a second path that differed from the frontal one by up to 31
  levels on about 160 px at 0.001 degrees; a window over the picture growing
  with the turn would not be continuous either (Skia draws a whole-pixel
  source rectangle's edges unlike a fractional one's). *Measured* (the
  turn-mouth harness, real engine in headless Chrome, 1920 px, face
  framing; frames whose teeth show; the worst frame per sequence, % of the
  mouth's width): the incisors' midline against the turned lips' frame,
  the line swept -9 to +9 degrees nodding to 5, held visemes at +-7 and a
  nod, the line at +-7 and nodding, the engine's own motion: sakineh 17.8%
  -> 3.5%, mehdi_avatar 12.8 -> 3.2, bita 15.8 -> 3.5 (the prototype 3.5,
  3.3, 3.5); against the inner opening's centre along the mouth 17.6 -> 3.9,
  12.3 -> 4.0, 15.7 -> 4.1. Frontal and "2d": every frame of the production
  line held frontal (GPU and 2D warp), held aa, E and oh, and the line with
  the "2d" head motion, on all three, hashes as main's (1188 frames, 0
  differ). Small turns in Chrome, the teeth drawn turned against the frontal
  drawing at the same lips: 0.001 degrees at most 2 levels, no pixel over 2,
  mean 0.0002 to 0.0005; 0.01 degrees mean 0.002 to 0.003; 0.1 degrees
  0.014 to 0.023 (the whole face moves more: at 0.001 degrees against the
  frame at 0, up to 29 levels on up to 32 px). On Skia (CI,
  `dental-arch.test.ts`) the drawing at no turn is byte-identical, within 2
  levels to a thousandth of a degree, its mean difference grows with the
  turn from 0.0001 levels at 1e-5 degrees, and what the bend adds over the
  arch moved by its frame starts at nothing (Skia's raster moves an image's
  antialiased edge in steps: a frontal arch moved 0.003 px moves an edge
  pixel by 23 levels, whatever draws it). The seam detector (rest, idle,
  sway, the line, a nod, a turn, the pose box's corners; all three, both
  paths): the same counts as main and the prototype, 0 under-layer seams
  and tears, 0 on the head. Render time (`render()` synced by a 1 px read,
  960 px, the line swept and nodding, frames whose teeth show, three
  alternating rounds): sakineh median 12.6 ms on both (p90 24.9 -> 26.0),
  mehdi_avatar 12.9 -> 13.0 (25.1 -> 25.4). *Goldens*: the
  human's Skia frames that turn or open (9 of 13: held aa, E, ou, the line
  at 20 to 80%, both turned frames; the classic mouth follows the turn, its
  mouth cells up to 9 levels, the whole frame 1) and its Chromium grids
  (mouth cells up to 3), darwin-arm64 and linux-x64 (Playwright
  v1.63.0-noble, linux/amd64); rest and blink unchanged; toon and animal
  byte-identical on both. *Still weak*: the cavity, the tongue and the
  contact shadow stay in the lips' frame, without depth; the classic mouth's
  drawn teeth follow the lips' frame without parallax; a turned arch is
  resampled twice (its picture bent, then drawn), a softening of under a
  picture pixel (the photo has 512 per mouth width) that a frontal one does
  not have.
- Expressions (2026-10-10, prototype on `proto/emotions-expressions`;
  docs/emotions.md is the design; `engine/expression-table.ts`,
  `expression-rig.ts`, `expression-mixer.ts`, `src/expression-markup.ts`).
  Six named expressions (neutral, happy, surprised, concerned, thinking,
  serious) at 0..1, as displacements of six landmark regions per side (inner
  and outer brow, upper and lower lid, cheek, mouth corner) in IODs in the
  face's frame, one typed table for every avatar, scaled per line
  (`KindProfile.expression`). Laid on in `deformFace` after the lower face
  and before the turn, read at each landmark's REST position and the inner
  lips of a column given one weight, so the speech's opening is carried
  exactly; the outline never moves (no seam), the iris centres never move,
  their rims go with the lids; a per-face fold calibration lowers a shape's
  ceiling where it would fold (none needed on any face measured). Driven by
  `engine.setExpression(name, intensity, {attackMs, holdMs, releaseMs})`,
  `Liveface.express`, `[happy]`/`[happy:0.6]` tags stripped before the voice
  and timed by word marks the synthesize routes answer on request
  (`word_marks`), an automatic mode and seeded idle micro-expressions
  (`data-expressions="auto"`), off by default: every golden byte-identical.
  Measured: docs/emotions.md, "Measured".

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
  `backend/app/core/client_ip.py` takes it from Cloudflare's
  CF-Connecting-IP when the request came through Caddy (TRUSTED_PROXIES)
  and Cloudflare's published ranges (TRUST_CLOUDFLARE), as production
  configures it; see docs/process.md, "Client addresses".

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

A new animal-like character (the wizard's plan says "Animal") starts with the
character mouth's teeth off (services.creations._animal_character_mouth): the
line is plain `cartoon` for an animation or cartoon of any subject, so only
the plan can tell a dog from a woman. The owner can turn teeth on in the
Mouth panel; settings already made are never overwritten.
