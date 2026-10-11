# Emotions and expressions (design, v2.1 2026-10-11)

Step 2 of the roadmap against SitePal: the 2D photo engine and the character
engine show a small set of named expressions, driven by an API, by tags in
the text the avatar speaks, by an optional automatic mode, and by faint idle
micro-expressions. This document is the design; the branch
`proto/emotions-expressions` implements it as a prototype for the owner to
see before anything ships. The owner chose v2 ("do #1"); v2.1 is its
polish for shipping (evidence: `scratchpad/emotions3/deliver/`; v2's:
`scratchpad/emotions2/deliver/`; the rejected v1's:
`scratchpad/emotions/deliver/`).

## Goals and non-goals

- A face that smiles, looks surprised, concerned, thoughtful or serious, at
  an intensity from 0 to 1, without breaking the lip-sync, the head's turn,
  the seams or the look of the photo.
- One model for every 2D line: a person's photo (opaque, layered, cut-out),
  a drawn or rendered character (`toon@1`), an animal (`animal@1`, `animal@2`).
- Data, not code per avatar: one typed table of displacements in units of
  the face, laid on each face's own landmarks.
- Nothing changes until asked: with no expression on, every frame is the
  frame it was (every golden is byte-identical; the rig is not even built).
- Not in scope: the 3D (GLB) engine (its ARKit morphs are the natural target,
  a later step: `Liveface.express` is a no-op there), new photo synthesis
  (wrinkles, teeth a smile would bare), ears and muzzles.

## The expression model

### Names

| Name | Tag aliases | What the face does |
|---|---|---|
| `neutral` | `rest` | releases whatever is on |
| `happy` | `smile`, `joy` | lip corners up and out with the cheeks, lower lids pushed up a little, brows hardly; the fold from the nose deepens, the cheeks catch the light |
| `surprised` | `wow`, `surprise` | both brows up whole and arched, upper lids up, the jaw a little dropped while silent; forehead creases |
| `concerned` | `sad`, `worried` | the inner third of the brows up (not together), the outer ends level, lip corners down; a faint crease mid-forehead |
| `thinking` | `hmm`, `think` | the picture's right brow up, the left a little down, the gaze up and aside, one lip corner pressed down |
| `serious` | `angry`, `stern` | the brows' inner ends down and knit, the lips pressed; the furrows between the brows |

Intensity is 0..1. Several expressions can be on at once (a cross-fade, the
idle smile under another); each region and each brow control sums them and
is then capped.

### Version 2 (2026-10-11): why the brows were rebuilt

The owner rejected the first prototype: "Emotions and expressions is very
bad. need to improve and enhance eyebrow especially." What was wrong with
it, measured on its own renders: the brows were two smooth weight bumps
round the brow landmarks, so a move stretched the hair (in 13 to 17 of 20
measurements per photo the brow's thickness changed by more than 3%, up to
33% on mehdi_avatar, whose brow landmarks sit off his hair), and the bumps
reached the lids, so concern, thinking and anger changed the eyes' opening
by up to 25% (a squint nobody asked for) and a smile closed them by 18%;
and a photo showed no skin change at all, so a stretched face read as
warped rather than as an emotion. Version 2 changes all three:

- **The brows move as rigid strips** (`expression-brows.ts`), placed on the
  hair the picture actually shows (`expression-brow-band.ts`), not on the
  mesh's brow landmarks (on mehdi_avatar those sit 0.1 IOD up the forehead).
- **The lids are the lids'**: a brow moves nothing within 0.06 IOD of the
  lid, so only a smile (the lower lid, pushed up by the cheek) and a
  surprise (the upper lid) change the eyes' opening. A brow's rise is a
  share of its own brow-to-lid distance, with inner, middle and outer
  controls, so concern raises the inner third and anger knits and lowers it.
- **Skin cues**: faint luminance-relative folds and lifts shaded over the
  warped photo (`expression-shading.ts`).

### Regions (the lids, the cheeks, the mouth's corners)

Everything but the brows moves by **regions**, each a group of the 478
MediaPipe landmarks on each side of the face:

| Region | Anchors (picture's left / right) | Reach (IOD) | Mask |
|---|---|---|---|
| `upperLid` | the upper lid row (`UPPER_LIDS`) | 0.14 | above the eye's corner line only, fading toward both corners |
| `lowerLid` | the lower lid row (`LOWER_LIDS`) | 0.14 | below the corner line only, fading toward both corners |
| `cheek` | 50 101 118 117 205 36 / 280 330 347 346 425 266 | 0.32 | nothing above the lower lid; the lid over the iris held |
| `mouthCorner` | 61 / 291 | its own field | nothing at the lips' middle, rising smoothly to the corner and carrying the cheek beyond it |
| `lipPress` | the lips' rows | its own field | the upper lip's red weighted down and the lower's up by how far out the row is (the outer edge 1, the inner lip 0), fading at the corners: pressed lips |

For every region:

- **The outline is still**: every weight fades to 0 within 0.2 IOD of the
  face's outline (`FACE_OVAL`), so the mesh's edge, the neck band, the
  head's field (the hair), a cut-out's silhouette and a layered avatar's neck
  never move, and there is no boundary for a seam to show at.
- **A side stays a side**: each side's weight fades out over 0.1 IOD across
  the midline, so `thinking` raises one brow, not both.
- **The irises**: their centres never move (the painted gaze reads them). A
  rim point hidden under the upper lid moves with the upper lid only; a
  rim point under the lower lid follows the nearest lower-lid landmark; the
  part of the lower lid over the iris is held (`lidHeld`), so a smile's
  lower-lid push never cuts a notch into the iris (it did on three faces).
- **The inner lips move in pairs** (one weight per column), so the opening
  the speech makes at every place along the mouth is carried exactly.
- **The mouth's corners** use a field with no anchors: nothing at the lips'
  middle (the v1 corner bump pinched the cupid's bow on a silent mouth),
  rising to the corner, and carrying the cheek beyond it, so a smile's
  corners rise with the cheek and a concerned mouth turns down smoothly.

### The brows

**Where the hair is** (`expression-brow-band.ts`). When the expressions are
first laid on a face, each brow's hair is measured once from the texture:
13 columns across the brow (a little past both landmark ends), a vertical
luminance profile in each from 0.15 IOD above the landmarks' brow line to
just above the lid, its dark runs (darker than halfway between the column's
skin and its darkest), split where a run brightens between two darker parts
(a brow over a lid crease is two runs), trimmed to the hair's core (a
painted brow over a shaded socket is one run at halfway; the socket is
skin). From the middle column outward, each next column takes the run most
like its neighbour (thickness, position along the slope, overlap, depth).
At least 7 columns must agree, or the brow is not trusted and its landmark
band stands in. The band is then extended to the landmarks' tail where the
hair fades out. Reading the texture is one `getImageData` over the brow
region, once per face; a tainted (cross-origin) canvas, a transparent
cut-out pixel or a flat picture all fall back to the landmarks.

**A strip moves rigidly** (`expression-brows.ts`). Every vertex of every
triangle that holds hair (padded 0.025 IOD round the band) moves as one
column of the strip: the same vertical move at every height of that column
(its share along the brow), so the hair keeps its thickness and texture.
Above the hair the forehead follows and fades to nothing at the hairline or
the outline (it compresses or stretches there, where skin has no feature);
below it the lid's fold stretches, fading to nothing at the lash line
(within 0.06 IOD of the lid nothing moves, so the eye's aperture never
changes because of a brow). The ends fade over 0.16 of the brow.

Each brow has three controls, inner, middle and outer, each `[knit, rise]`;
the rise is in the brow's own **brow-to-lid distance** (the mean over both
brows, kept within 0.12-0.4 IOD), the knit in IODs toward the midline; the
strip's move along it is the quadratic through the three. So a surprise is
`[-0.4, -0.46, -0.38]` (the whole brow up, arched), concern
`[-0.65, -0.16, 0.05]` (the inner third up, the outer end level or a touch
down), anger `[0.42, 0.2, 0.04]` with a knit `[-0.035, -0.012, 0]`.

**How far a brow may move on this face** (`expression-brow-caps.ts`). A
rise or a knit moves each landmark by a fixed field times an amount, so each
triangle's area is linear in it and the amount at which a triangle loses
`PRESS` of its area (0.55 for a rise, 0.2 for a knit, together at most 0.7)
or grows by `STRETCH` (0.6) is one division. Each landmark takes the least
of its triangles', both brows' moves summed (the glabella is moved by
both), smoothed along the brow (`CAP_SLOPE` 0.05 IOD from end to end) so
the strip stays rigid. A drawn face's `slack` (2 for `toon@1`) lets it
stretch further: its flat skin shows a stretch less than a photo's. This
replaces v1's flat region caps for the brows; `BROW_CAP` (rise 0.5, knit
0.05) bounds the sum of expressions, and a table value may exceed it by up
to `1/BROW_SATURATES` (concern's inner end reaches the cap at 0.77, so it
already reads at 0.6).

### Skin cues (`expression-shading.ts`)

Painted on the frame's 2D canvas after either warp path has drawn the mesh,
so the GPU path and the 2D fallback show the same pixels, along curves
placed by this frame's landmarks (they move and turn with the face):

| Cue | Expression | What |
|---|---|---|
| `foreheadLines` | surprise 1, concern 0.5 | 2-3 broken, gently wavy folds between the brows and the hairline following the brows' rise; for concern only a short one in the middle |
| `glabellaLines` | serious | two short vertical furrows between the brows |
| `nasolabial` | happy | the fold from the nose deepened, with a light band on its cheek side |
| `cheekLift` | happy | the cheek's apple lifted into the light |
| `crowsFeet` | happy 0.8 | faint fans at the eyes' outer corners |

Luminance-relative, never a painted colour: a fold is "multiply" with a
warm shadow tone (150, 96, 82) at a low alpha, so each channel becomes a
share of itself (blue and green a little more than red, as light lost under
skin is; a fold in black read grey and drawn); a lift is "color-dodge" with
a dark grey (26), a gain of about a ninth, so no channel clips. Capped: a
fold takes at most 16% of the light at its core, a lift adds at most 10%.
Feathered by elliptical dabs on a bell profile laid along the curve.

**Sprites, not dabs, every frame (v2.1).** v2 stamped about 400
radial-gradient dabs a frame for a smile or a surprise (1.5-1.8 ms on a
960 px canvas, measured with a readback). Now everything one shape shades
in one ink (a smile's folds; its lifts) is rasterised ONCE per face into
one alpha sprite (`SkinCuePainter`, half the canvas's resolution: the folds
are soft), laid on the rest face with that shape at full, normalised to
its peak; each frame it is drawn with ONE `drawImage`, carried by an
affine least-squares fit of the landmarks it was laid on (the brows' tops
and the forehead's row for the forehead, the nose's wing, the mouth's
corner and the cheek for the nasolabial fold, ...), at the shape's weight
as `globalAlpha`. Both inks are linear in alpha, so a weight is exactly a
strength. A frame costs one or two `drawImage` calls per shape on; a
sprite is laid at most one a frame (a cue's first frames are its faintest),
and a face laid anew (a viewport, a texture) lays them anew. Pixels match
v2's dabs within 2 levels (99.9th percentile) on sakineh's smile and
surprise. Cost: below, "Measured".

**Only photographs take them (v2.1, `expression-look.ts`).** A cartoon
(`faceType` "cartoon", or a `toon@1` rig) and an animal (`faceType`
"animal", or an `animal@N` rig) take none: on a drawn face's flat skin a
fold read as a line drawn across it. A person's picture that is not a
photograph (a stylised 3D character, a cartoon uploaded as a person) takes
none either, read once from the picture when the rig is built:

- the eyes' opening at rest, lid to lid: a photograph's is 0.13-0.19 IOD
  (the 9 photos of the 17 development and production faces), a stylised
  face's large drawn eyes 0.21-0.27 (and a cat's 0.59): at
  `APERTURE_DRAWN` (0.2) or above the face is not a photograph's...
- ...unless its cheeks' skin has a photograph's grain (each texel's
  luminance against its 3x3 neighbourhood's mean, as a share of the
  skin's light, median over four cheek patches) of `SKIN_GRAIN` (2%) or
  more: a wide-eyed person. Grain alone does not tell them apart (a 3D
  render's skin reads 1.4%, a smoothed small photo's 0.3%), so it only
  rescues a photograph the eyes would have refused.

On the held-out production avatars this keeps the cues on all 7 photos and
takes them off the 3D anime girl (8c23), the Pixar-styled "mehdi" (200e)
and the drawn "bab", all three published as people.

### Units: face-relative

Regions in **IODs** in the **face's frame**: x along the eye line, positive
OUTWARD from the midline (one number mirrors itself), y down the face. Brow
rises in each brow's brow-to-lid distance. A tilted photo, a small face and
a 4K face read the same table.

### The table (`engine/expression-table.ts`)

```ts
happy:     regions { mouthCorner: [0.05, -0.075], cheek: [0.02, -0.045], lowerLid: [0, -0.028] }
           brows both [-0.03, -0.05, -0.05]; cues nasolabial 1, cheekLift 1, crowsFeet 0.8
surprised: regions { upperLid: [0, -0.025] }; brows both [-0.4, -0.46, -0.38] (outer knit 0.005)
           cues foreheadLines 1; jaw 0.16
concerned: regions { mouthCorner: [0, 0.07] }; brows both [-0.66, -0.2, 0.1] knit [0.008, 0, 0]
           cues foreheadLines 0.5
thinking:  regions { "mouthCorner.left": [0, 0.035], "mouthCorner.right": [0.01, -0.015] }
           brows right [-0.22, -0.42, -0.36], left [0.12, 0.08, 0.04] knit [-0.01, 0, 0]; gaze [0.3, -0.2]
serious:   regions { mouthCorner: [-0.008, 0.012], upperLid: [0, 0.01], lipPress: [0, 0.022] }
           brows both [0.5, 0.24, 0.04] knit [-0.04, -0.014, 0]; cues glabellaLines 1
browFlash: brows both [-0.25, -0.28, -0.22]       (internal: the idle flash)
```

**Concern against anger (v2.1).** Judges swapped the two on mehdi_avatar
in every v2 round. They are now opposite at every part the face shows:
concern lifts the inner brows (further, 0.66 of the brow-to-lid distance)
and slants them (the outer end a touch DOWN), never knits them (the inner
ends drift a little apart) and turns the corners down; anger lowers and
knits the inner ends (further), lowers the upper lids a little (a hard,
level look: the eyes' opening 5-7% smaller at 1) and presses the lips thin
(`lipPress`: the red of both lips drawn toward the mouth's line, the
inner lips untouched, so the speech's opening is kept exactly).

(brow values: `[inner, mid, outer]` rise, negative up.) A region key is
`"cheek"` (both sides, mirrored) or `"mouthCorner.right"` (one side: the
picture's right), typed as a template literal, so a typo is a compile
error. Only happy lifts the lower lid, only surprise lifts the upper and
only anger lowers it a little; no other expression changes the eye's
opening (tested: under 3%).

### Layered on speech, additively, in rest space

`deformFace` (`engine/deform.ts`) runs: the mouth driver (the classic field,
the character field or the photographic mouth's poses), the blink, the
brows' rest, the mouth extension's pass, the lower face (jaw, chin, cheeks),
**then the expression** (`ExpressionRig.apply`), then the head's turn in
depth, then the derived vertices. So:

- **Speech keeps the lips.** The expression's displacement of a landmark is
  read at its REST position and added to wherever the speech put it, and the
  inner lips of a column move together: every opening the speech makes is
  carried, not changed. A smile while talking moves the corners up and out
  around the viseme's opening. The photographic mouth's poses, which write
  the lips absolutely, run before it and cannot undo it.
- **The jaw** is the only shared channel: an expression's `jaw` (surprise's)
  is a floor on the cue blend's jaw opening only while nothing is being
  said and no mouth driver poses (`FaceAnimation.step`). While speaking, the
  voice owns the jaw.
- **The turn composes.** The expression is in the face's rest frame; the
  head's turn (`head-turn.ts`) then turns the face it made, the eyes and the
  lips as one piece each, with its fold clamp. The mouth's frame
  (`mouth-pose.ts`) is the rest pose moved by the turn only, so the teeth
  sit where they would without the expression (a smile does not move the
  teeth). In the "2d" motion the rigid layer moves the whole.
- **The 3D personality's brow flash** (`head-turn.ts browLift`) is unchanged
  and adds to the brows.

### Safety for photos

- **Per-region caps** (`REGION_CAP`, IODs), however many expressions sum:
  upper lid 0.035, lower lid 0.03, cheek 0.05, mouth corner 0.1, pressed
  lips 0.03. The brows have their per-face caps (above) and `BROW_CAP`.
- **Room for the turn (v2.1, `ExpressionRig.relieve`)**: for each shape at
  1, every rig triangle the regions alone press below half its rest area
  has its most moved landmark's region weights eased (a tenth at a time,
  the lips never), until none is. The head's turn squeezes the far cheek to
  about half again: in v2 a smile pressed a thin triangle under
  mehdi_avatar's lower lid (449-448-347) to 0.4 at rest and the turn took
  it below a fifth for 5 frames of the tagged line (a crushed patch by the
  face's edge). Now it keeps 0.54 at its worst in the same clip; no
  expression adds a crushed triangle in the tagged clips of the four
  development faces.
- **Per-face fold calibration**: when a face's rig is built, each expression
  at 1 is laid on the rest mesh, and if any of the rig's triangles would fold
  or fall below a fifth of its area (`head-fold.ts FoldCheck`), that
  expression's ceiling on that face is lowered (bisection) until none does.
  It stays 1 on the four development faces and on 11 of 13 held-out
  production avatars; it lowers a cartoon's anger to 0.47 (mehdi_1501's
  low drawn brows) and img_6108's to 0.99.
- **The outline is still** (above): no pixel outside the face's oval changes
  for any expression but surprise, whose silent jaw drop moves the chin as
  speech does.
- **Glasses and fringes** sit where the brows are. The band reader rejects a
  brow it cannot read (it falls back to the landmarks) but there is no
  detector for glasses; `tune({ expression })` scales every expression (0
  turns them off) for a photo where they still read wrong.

### Characters and animals (`toon@1`, `animal@1`, `animal@2`)

The same 478-landmark rig is fitted to every character, so the same table
drives it. Each profile scales the parts (`KindProfile.expression`,
`ExpressionGains`):

| Profile | Upper lid | Lower lid | Cheek | Mouth corners | Pressed lips | Brows | Skin cues | Brow slack | Silent jaw |
|---|---|---|---|---|---|---|---|---|---|
| human | 1 | 1 | 1 | 1 | 1 | 1 | 1 (photographs only) | 1 | 1 |
| `toon@1` | 1.5 | 1 | 0.8 | 1.2 | 1 | 1 | 0 | 2 | 1 |
| `animal@1`, `animal@2` | 0.35 | 0.35 | 0.5 | 0.5 | 0.5 | 0.35 | 0 | 1 | 0 |

The avatar's published face type wins over its rig's profile
(`expressionGains`, `EngineOptions.faceType`): an animal takes the animal's
gains whatever its rig (the cat in production was fitted with the human
profile: its smile took a fold-calibration cap of 0.37 and its warp drew
ghost arcs by the muzzle and a crack over one eye), and a cartoon takes no
skin cues. A toon's drawn eyes widen more in surprise; its flat skin
stretches without showing it (slack 2). An animal's "lip corners" are a
fit's anchors on a muzzle, its eyes and lids sit inside large drawn eyes,
and its jaw is a fit's: its expressions are faint and safe by design (no
silent jaw drop, the brows and lids at a third), and on the cat every
ceiling is 1 and no expression folds a triangle at rest. Ears, muzzles and
painted brow shapes are not modelled.

## Driving

### The API

```ts
engine.setExpression("happy", 0.6, { attackMs: 300, holdMs: 2000, releaseMs: 600 });
engine.setExpression("neutral");          // release what is on
engine.expression;                        // { name, intensity, level, source, weights }
engine.setIdleExpressions(true);          // EngineOptions.idleExpressions
engine.tuning.expression = 0.5;           // scale all of it; 0 off
engine.playAudio(b64, mime, cues, onEnd, track);   // a text's expression track
engine.playCues(cues, track);

Liveface.express("happy", 0.6);           // the widget: the first widget
Liveface.get("AVATAR_ID")?.express("surprised", 1, { holdMs: 1200 });
```

The envelope (`engine/expression-mixer.ts`): an attack from wherever the
face is (no pop) to the intensity over `attackMs` (default 300), held for
`holdMs` (default: until changed), released over `releaseMs` (default 500),
each segment eased (smoothstep). Setting another expression cross-fades:
the one that was on releases over the new one's attack. Every envelope is a
function of the frame time (reproducible on a virtual clock).
`engine.expression` reports what was asked, its intensity, how far it is in
(`level`), who asked (`"api"` or `"text"`), and every shape's weight.

### Tags in text (the primary syntax)

```
Hello! [happy] I'm so glad you're here. [concerned] But I have to tell you
something… [surprised:0.8] Really?!
```

- `[name]` or `[name:intensity]`, intensity 0..1 or a percentage
  (`[happy:60%]`); names and aliases in any case.
- An expression set by a tag holds until the next tag or the end of the
  text, then releases. `[neutral]` releases it earlier; it releases only
  what a text set, never what the page set with `express`.
- Only known names are tags: `[1]`, `[sic]` and any other bracket stay in
  the text as before; `\[happy]` is the literal text.
- Tags are stripped before the text reaches the TTS (the server never sees
  them; the speech cache keys the spoken text) and become a timed
  **expression track** `[{t, name, intensity, holdMs?}]` on the speech's own
  clock, walked every frame, re-placed on a seek.
- Why brackets and not SSML (`<express name="happy"/>`): customer CMSs and
  sanitizers strip or escape angle brackets, the same text goes to browser
  voices that would read SSML aloud, and brackets are how people already
  write stage directions. One syntax; no second one.

**Timing.** A tag points at the character where it stood in the stripped
text (the start of the next word). With `word_marks: true` the synthesize
endpoints (`POST /embed/v1/synthesize`, `POST /tts/orgs/{id}/synthesize`)
answer each word's start, ms, from the same planner that times the cues
(`timing.plan_utterance`), retimed to the audio's duration
(`timing.word_marks_for_duration`, as `cues_for_duration` retimes the
cues); the browser voice already gets them from `/embed/v1/cues`. The
expression starts `EXPRESSION_LEAD_MS` (150) before its word (faces lead
speech). Without marks (an older server), the time is proportional to the
character's place in the text. The flag is sent only for a chunk with an
expression to place, so every other request and answer is byte-identical;
the field is optional in the schema (no default), so the generated clients
never have to send it.

**Where it is parsed**: client-side (`src/expression-markup.ts`), in the
widget's `SpeechQueue` (server voices) and `BrowserTTS` (browser voices). A
long text is split into sentences with its tags held out of the split
(`[happy:0.5]` holds a full stop), and each chunk carries its own marks; a
chunk of tags alone passes them to the next. When a chunk's voice ends,
whatever of its track was not reached is applied (so an expression carries
on into the next chunk, and the last chunk's closing release always lands);
a stop releases what the text set.

### Automatic mode (off by default; `data-expressions="auto"`)

Light heuristics over the stripped text, never when the text has a tag of
its own (the author is in control):

- a greeting opening the text (hello, hi, hey, welcome, good morning,
  thanks…): happy 0.45 over its sentence;
- a sentence ending in `!`: happy 0.35 over it;
- a question: the brows up (surprised 0.3, held 0.5 s) on its last word;
- a small lexicon sets a sentence's expression: sorry/unfortunately/bad news
  → concerned 0.5; hmm/let me think/I wonder/maybe → thinking 0.6;
  wow/really/amazing → surprised 0.5; great/wonderful/glad/love/excited →
  happy 0.5;
- each sentence's expression is released where the next sentence starts.

The lexicon is English (`locale` starting "en"); elsewhere only the
punctuation rules apply. `data-expressions="off"` strips tags and expresses
nothing; the default `"tags"` reads tags only.

**Defaults (v2.1, the owner's).** Tags are on everywhere a text is
spoken: the widget (server and browser voices), the share page (its
server voice and its browser fallback) and the dashboard's Speak panel
(its streamed server voice and the browser's): the tags are taken out
before the text reaches any voice (`spokenText`) and drive the face. The
automatic mode and the idle micro-expressions are off unless a page asks
(`data-expressions="auto"`, `data-idle-expressions="on"`).

**A streamed voice** (the Speak panel's `POST /tts/orgs/{org}/stream`)
gives no word times, so `streamSpeech({ expressions })` places the tags in
proportion to the text over the speech's length: a guess from the text
(`STREAM_MS_PER_CHAR`, 65 ms a character) until audio arrives, then no
shorter than what was heard, then the length the stream says at its end;
each re-placing moves the same cues in time (`engine.retimeExpressions`:
a cue already fired is not fired again). A provider that answers with one
recording plays its tags on that recording's length.

### Idle micro-expressions (off by default: `data-idle-expressions="on"`, the automatic mode, or `setIdleExpressions`)

`IdleExpressions`, on its own seeded random source (it never draws on
`Math.random`, so turning it on moves no other part's sequence: tested): a
faint resting smile (happy 0.06 to 0.14, re-picked every 6 to 12 s, eased
over 2 s), halved while speaking, under any explicit expression in
proportion to it; in the "2d" head motion, a brow flash (0.8 of `browFlash`,
160 ms up, 120 held, 320 down, at most every 1.5 s) on the speech's emphasis
beats. The "3d" personality flashes the brows itself.

## Module map

| File | Lines | What |
|---|---|---|
| `embed/src/engine/expression-table.ts` | 281 | names, aliases, regions, the table, caps, per-line gains: data and types |
| `embed/src/engine/expression-rig.ts` | 437 | a face's rig: region weights, the brows, the room for the turn, the fold calibration, the lip press's room, `apply`, the look and the skin cues' painter, the lazy per-mesh cache (reads the texture once) |
| `embed/src/engine/expression-weights.ts` | 334 | the face frame, the outline distances, the region masks, the lips' press field, the lids' lines, the held lid over the iris, the paired inner lips |
| `embed/src/engine/expression-brow-band.ts` | 375 | where each brow's hair is in the picture: column profiles, dark runs, tracking, the landmark fallback, the texture sampler (the brows and the cheeks) |
| `embed/src/engine/expression-brows.ts` | 386 | the brows as rigid strips: hair triangles, forehead and lid-fold weights, the three controls, `apply` |
| `embed/src/engine/expression-brow-caps.ts` | 134 | how far a brow may move on a face: the area-linear press and stretch limits |
| `embed/src/engine/expression-look.ts` | 101 | whether a person's picture is a photograph: the eyes' opening, the skin's grain |
| `embed/src/engine/expression-shading.ts` | 788 | the skin cues: strengths, curves, the dabs, the pieces, the sprites (rasterised once, carried by an affine fit), `SkinCuePainter` |
| `embed/src/engine/expression-mixer.ts` | 305 | the envelope, the mixer (set, state, jaw, gaze), the timed track and its retiming, the idle micro-expressions |
| `embed/src/expression-markup.ts` | 206 | the tag parser and stripper, `spokenText`, the automatic mode, the alignment of tags to word times |
| `embed/src/speech-stream/index.ts`, `player.ts` | +40 | a streamed voice's tags placed over the speech's length, retimed as it is learnt |
| `frontend/src/features/voices/hooks/useSpeakPanel.ts`, `features/share/hooks/useShareSpeech.ts` | +20 | the Speak panel and the share page: tags out of what is sent, played on the face |
| `engine/kind-profile.ts` (`expressionGains`), `engine.ts`, `animation.ts`, `paint-features.ts`, `widget.ts` | small | the face type's gains, the silent jaw's gain, the cue pass through the rig, `data-idle-expressions`, `idleExpressions()`, `retimeExpressions` |

## Tests

- `engine/__tests__/expression-table.test.ts`: every name has a shape, every
  key a real region, every displacement inside its cap, brow controls within
  the cap over `BROW_SATURATES`, the anatomy of the brow shapes (a surprise
  lifts the whole brow, concern the inner end with the outer level, anger
  lowers and knits it), cues real and at most 1, gains.
- `engine/__tests__/expression-rig.test.ts` (human and animal fixtures): the
  outline and the iris centres never move; the regions never reach the eyes
  and the brows never move the lids; the inner-lip pairs share a weight;
  nothing at scale 0; every ceiling 1; the brows' thickness kept column by
  column (human within 4%, animal 6%); surprise, concern and anger
  amplitudes and the knit; the eyes' opening unchanged (within 3%) by all
  but a smile (closes) and a surprise (opens); mirroring and the one-sided
  `thinking`; the caps; the band read from a picture and the landmark
  fallback on a flat one; the calibration lowering a ceiling; the cache;
  under the head's turn.
- `engine/__tests__/expression-brow-parts.test.ts`: a column's dark runs on
  synthetic profiles (edges, a brow split from a crease, the hair's core over
  a shaded socket, nothing in a flat or faint column); a band following hair
  placed off the landmarks, giving up on a flat or unreadable picture; the
  caps keep every triangle round a lifted brow above a quarter of its area,
  change along the brow no faster than their slope, grow with slack.
- `engine/__tests__/expression-look.test.ts` (v2.1): a photograph's eyes
  and grain read as a photograph (and a smoothed or unreadable one still
  does); a stylised face's large eyes on flat skin do not (a wide-eyed
  person with a photograph's grain does); the rig gives the cues only to
  the photograph and paints nothing on the other; the face type's gains (a
  cartoon none, an animal the animal's, whatever its rig).
- `engine/__tests__/expression-rig.test.ts` (v2.1 additions): a smile and
  concern keep half of every triangle (room for the turn); anger lowers
  the lids a little (1-10%), and no other expression but a smile and a
  surprise changes the opening.
- `speech-stream/__tests__/stream.test.ts`, `engine/__tests__/expression-mixer.test.ts`,
  `__tests__/widget.test.ts` (v2.1): a stream's tags guessed, then placed
  on the heard and the final length; a whole recording's on its own; a
  retimed track fires no cue twice and misses none; the idle
  micro-expressions off unless asked.
- `frontend` `SpeakPanel.test.tsx`, `SharePage.test.tsx` (v2.1): a tagged
  line reaches the voice without its tags and the face with them.
- `engine/__tests__/expression-shading.test.ts` (Skia pixels): nothing
  painted with no cue or no gain; a fold or a lift changes the light by a
  capped share of the skin's own (at most 20% darker, 12% lighter), the
  same share on dark and on light skin; surprise on the forehead, a smile
  below the nose, anger between.
- `engine/__tests__/expression-mixer.test.ts`, `__tests__/expressions.test.ts`
  (a live engine: inner lips under every expression equal to without, to
  1e-4, on a photo, a toon and an animal), `__tests__/expression-markup.test.ts`,
  `__tests__/speech-expressions.test.ts`, `__tests__/widget.test.ts`: as v1.
- Goldens (pixel and GL warp): unchanged, every one (no expression is on by
  default); seams in Chromium, GL and 2D: none.

## Measured (v2.1, 2026-10-11)

The real engine in headless Chrome (Metal), 960 px stage, face framing,
each avatar's own mouth: sakineh (her own kit), mehdi_avatar and bita
(standard teeth), Sakineh Animesh (`toon@1`). The full table is
`scratchpad/emotions3/deliver/numbers.txt`; v2's is
`scratchpad/emotions2/deliver/numbers.txt`.

- **Recognition** (blind, fresh judges, 3 per set, shuffled, majority per
  picture): sakineh 6/6 at 1.0 and 6/6 at 0.6, mehdi_avatar 5/6 and 5/6
  (v2: 4/6 and 2/6, concern and anger swapped), bita 6/6 and 4/6 (v2: 6/6
  and 6/6; at 0.6 one judge in three swapped anger and thinking), the
  cartoon 6/6 and 6/6. A stronger anger (inner end 0.62, knit 0.042, lips
  0.026) was tried: mehdi_avatar 6/6 and 4/6, but sakineh fell to 4/6 at
  1.0 (concern and anger swapped), so it was not kept.
- **Skin cues' cost**: v2's own measure (the pass at 1 on a 960 px canvas,
  20 passes per 1 px readback): a smile 1.0-1.2 ms -> 0.13 ms, a surprise
  1.2-1.35 -> 0.11, concern 0.46-0.5 -> 0.11, anger 0.07-0.09 -> 0.11; with
  Chrome's CPU throttled 4x (a phone's proxy) 4.3-5.6 ms -> 0.29-0.36 ms.
  In that harness one `drawImage` of anything (a 1 px canvas) already costs
  0.10 ms (0.29 at 4x): the sprites add 0-0.03 ms over it. Main-thread time
  of the pass (no readback): median 0.01 ms, 95th percentile 0.03 ms (0.12
  at 4x). On the engine's own canvas, whole frames with the cues on and
  off differ by no more than the noise (0.06 ms) on the GPU path and in 2D.
  Laying a face's sprites, once per shape: 0.2-0.6 ms (1.1-3 ms at 4x), one
  sprite a frame.
- **Brows, eyes, lip-sync**: as v2 (thickness within 3% in 20 of 20 on
  sakineh, bita and the cartoon, 3.7% at worst on mehdi_avatar); concern
  and thinking change the eyes' opening by 0.0%; at 1, anger closes it
  5-7% (by design), a smile 6-10%, and a surprise opens it 13-16%. Inner-lip openings
  unchanged (difference 0) under every expression, with a held viseme and
  in the tagged clips of all four faces.
- **Folds**: none at rest on the four faces; no new crushed triangle in the
  tagged clips of the four (v2: 5 frames on mehdi_avatar and on the
  cartoon). Known: bita's surprise (her mouth's own small-opening fold
  under the silent jaw), and one more of the 'ou' viseme's own 15 under
  anger on bita.
- **Held-out production avatars** (13): skin cues on all 7 photographs, off
  the 3 stylised people (8c23, mehdi_200e, bab) and the 3 cartoons and the
  cat; ceilings 1 everywhere but mehdi_1501's anger (0.47, a cartoon) and
  img_6108's (0.99); the cat has every ceiling 1 and no fold at rest.

## Open issues

1. Recognition is from one model's judges; bita's anger at 0.6 is the
   weakest picture (1 judge in 3 calls it thinking or neutral).
2. Surprise lifts less than the anatomical target on photos (the caps); a
   larger lift needs the forehead to fold (a crease cue moving with it), not
   to stretch further.
3. A streamed voice (the Speak panel) places tags in proportion to the
   text, not at their words (the phrase stream has no word times); a
   buffering gap mid-speech releases the expression until the next tag.
4. The look reader is two thresholds on 17 faces: a wide-eyed person on a
   heavily smoothed photo loses the cues (the safe side), and a stylised
   face with small eyes keeps them.
5. The cat's blinks still move its lower lids with the blink tuned to 0
   (deform.ts `blinkLids`, not expressions).

## Open questions for the owner

1. The amplitudes in the sheets: too strong, too weak, per expression? (They
   are one table: a change is a number.)
2. The automatic mode and the idle micro-expressions stay opt-in: should
   the dashboard offer them per avatar?
