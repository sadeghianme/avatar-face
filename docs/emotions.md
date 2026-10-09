# Emotions and expressions (design, 2026-10-10)

Step 2 of the roadmap against SitePal: the 2D photo engine and the character
engine show a small set of named expressions, driven by an API, by tags in
the text the avatar speaks, by an optional automatic mode, and by faint idle
micro-expressions. This document is the design; the branch
`proto/emotions-expressions` implements it as a prototype for the owner to
see before anything ships (evidence: `scratchpad/emotions/deliver/`).

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
| `happy` | `smile`, `joy` | lip corners up and out, cheeks raised, lower lids up (a slight squint), outer brows a touch up |
| `surprised` | `wow`, `surprise` | brows up (inner and outer), upper lids up, lower lids a little down, the jaw a little dropped while silent |
| `concerned` | `sad`, `worried` | inner brows up and together, outer brows down, lip corners down, upper lids a little heavy |
| `thinking` | `hmm`, `think` | the picture's right brow up, the left a little down, the gaze up and aside, one lip corner pressed down |
| `serious` | `angry`, `stern` | brows down and together, upper lids lowered, lower lids raised, lip corners pressed down |

Intensity is 0..1. Several expressions can be on at once (a cross-fade, the
idle smile under another); each region sums them and is then capped.

### Regions (the face's own landmark groups)

An expression moves a few **regions**, each a group of the 478 MediaPipe
landmarks the engine already reads (`engine/landmarks.ts`,
`engine/jaw-rig.ts`), on each side of the face:

| Region | Anchors (picture's left / right) | Reach (IOD) | Mask |
|---|---|---|---|
| `browInner` | 107 66 55 65 / 336 296 285 295 | 0.30; 1.7x upward (the forehead follows), 0.6x down | nothing at or below 0.03 IOD above the upper lid, thinning from the brow's line |
| `browOuter` | 70 63 46 53 / 300 293 276 283 | as `browInner` | as `browInner` |
| `upperLid` | the upper lid row (`UPPER_LIDS`) | 0.14 | above the eye's corner line only, fading out toward both corners |
| `lowerLid` | the lower lid row (`LOWER_LIDS`) | 0.14 | below the corner line only, fading out toward both corners |
| `cheek` | 50 101 118 117 205 36 / 280 330 347 346 425 266 | 0.32 | nothing above the lower lid, coming in over 0.08 IOD |
| `mouthCorner` | 61 78 76 62 / 291 308 306 292 | 0.28; 1.2x down | nothing above the nose's base |

And for every region:

- **The outline is still**: every weight fades to 0 within 0.2 IOD of the
  face's outline (`FACE_OVAL`), so the mesh's edge, the neck band, the
  head's field (the hair), a cut-out's silhouette and a layered avatar's neck
  never move: there is no boundary for a seam to show at.
- **A side stays a side**: each side's weight fades out over 0.1 IOD across
  the face's midline, so `thinking` raises one brow, not both.
- **The irises**: their centres never move (the painted gaze reads them);
  their rims move with the lids' regions only, so a rim point hidden under
  a lid goes with it (Sakineh's upper lid on a surprise folded the triangles
  between them before this).
- **The inner lips move in pairs**: the upper and the lower inner lip of
  each column take one weight (their mean), so the opening the speech makes
  at every place along the mouth is carried exactly, on a mouth slightly
  open at rest too.

The weight of a landmark is a smooth bump of its distance to the region's
nearest anchor, `(1 - d²)²` with d the distance over the reach (the bump
`head-turn.ts browLift` uses), times the masks. Weights are computed once
per face from the rest mesh (`ExpressionRig`), and only when an expression
first comes on (`ExpressionRigs`).

### Units: face-relative

Displacements are in **IODs** (the distance between the eye centres) in the
**face's frame**: x along the eye line, positive OUTWARD from the midline
(one number mirrors itself across the face), y down the face. A tilted
photo, a small face and a 4K face read the same table.

### The table (`engine/expression-table.ts`)

```ts
happy:     { mouthCorner: [0.06, -0.08], cheek: [0.02, -0.035], lowerLid: [0, -0.03], browOuter: [0, -0.012] }
surprised: { browInner: [0, -0.1], browOuter: [0.006, -0.09], upperLid: [0, -0.035], lowerLid: [0, 0.008] }, jaw 0.16
concerned: { browInner: [-0.02, -0.08], browOuter: [0, 0.02], upperLid: [0, 0.012], mouthCorner: [0, 0.06] }
thinking:  { "browOuter.right": [0, -0.09], "browInner.right": [0, -0.04], "browInner.left": [-0.012, 0.03],
             "mouthCorner.left": [0, 0.025], lowerLid: [0, -0.012] }, gaze [0.22, -0.16]
serious:   { browInner: [-0.04, 0.06], browOuter: [0, 0.025], upperLid: [0, 0.015], lowerLid: [0, -0.025],
             mouthCorner: [0, 0.025] }
browFlash: { browInner: [0, -0.06], browOuter: [0, -0.045] }      (internal: the idle flash)
```

A region key is `"browInner"` (both sides, mirrored) or `"browInner.right"`
(one side: the picture's right), typed as a template literal, so a typo is a
compile error. `jaw` is a jaw opening (the cue blend's `jawOpen`), `gaze` an
offset of the eyes in eye widths. No mouth corner moves inward: with a
rounded vowel's own narrowing that crushed the corner's triangles.

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
  brows 0.11, upper lid 0.04, lower lid 0.035, cheek 0.06, mouth corner 0.11.
  The table itself stays inside them; they bound the sums.
- **Per-face fold calibration**: when a face's rig is built, each expression
  at 1 is laid on the rest mesh, and if any of the rig's triangles would fold
  or fall below a fifth of its area (`head-fold.ts FoldCheck`, the turn's own
  test), that expression's ceiling on that face is lowered (bisection) until
  none does. On every face measured it stays 1 (after the iris rims moved
  with the lids); it is there for a face nobody has seen.
- **The outline is still** (above).
- **Glasses and fringes** sit where the brows are. There is no detector for
  either; the caps are the mitigation, and `tune({ expression })` scales
  every expression (0 turns them off) for a photo where they still read
  wrong, as `tune({ blink: 0 })` does for blinks.
- **Lids**: the upper lid moves at most 0.04 IOD, fading to nothing at the
  eye's corners; a blink still sweeps down from wherever the lid is.

### Characters and animals (`toon@1`, `animal@1`, `animal@2`)

The same 478-landmark rig is fitted to every character, so the same table
drives it: the mesh moves the drawn brows, lids and mouth line. Each profile
scales the regions (`KindProfile.expression`):

| Profile | Brows | Lids | Cheek | Mouth corners |
|---|---|---|---|---|
| human | 1 | 1 | 1 | 1 |
| `toon@1` | 1.1 | 1 | 0.8 | 1.2 |
| `animal@1`, `animal@2` | 0.6 | 0.7 | 0.5 | 0.5 |

A toon's smile is its drawn mouth line bent up at the corners; the character
mouth paints its opening from the moved inner lips, so a smile while
speaking opens a smiling mouth. Limits: a toon whose fit put the brow marks
off its drawn brows moves its forehead instead; an animal's "lip corners"
are a fit's anchors on a muzzle, so its smile is faint by design; ears,
muzzles and painted brow shapes are not modelled. The painted lid of a
character's blink (`blink-lid.ts`) is fitted to the moved eye.

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

### Idle micro-expressions (with the automatic mode, or `setIdleExpressions`)

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
| `embed/src/engine/expression-table.ts` | 245 | names, aliases, regions, the table, caps, per-line gains: data and types |
| `embed/src/engine/expression-rig.ts` | 394 | a face's region weights (rest mesh), the masks, the fold calibration, `apply`, the lazy per-mesh cache |
| `embed/src/engine/expression-mixer.ts` | 293 | the envelope, the mixer (set, state, jaw, gaze), the timed track, the idle micro-expressions |
| `embed/src/expression-markup.ts` | 193 | the tag parser and stripper, the automatic mode, the alignment of tags to word times |
| `engine/deform.ts`, `state.ts`, `animation.ts`, `motion.ts`, `kind-profile.ts`, `options.ts`, `types.ts` | +8, +5, +30, +5, +9, +7, +5 | the hooks: the field after the lower face, the mix in the face state, the track on the speech clock and the jaw floor, the gaze offset, the gains, the option, the tuning scale |
| `engine.ts` (502), `widget.ts`, `widget/handles.ts`, `speech.ts`, `browser-tts.ts`, `index.ts` | | `setExpression`, `expression`, `setIdleExpressions`, the track on `playAudio`/`playCues`; `Liveface.express`, `data-expressions`; tags through both voices; the package exports |
| `backend/app/services/tts/answer.py` (new), `timing.py`, `schemas/tts.py`, `api/embed.py`, `api/tts.py` | | `word_marks` on request, one answer builder for both synthesize routes |

## Tests

- `engine/__tests__/expression-table.test.ts`: every name has a shape, every
  key a real region, every displacement inside its cap, aliases, gains.
- `engine/__tests__/expression-rig.test.ts` (human and animal fixtures): the
  outline and the iris centres never move; the brows' and the mouth's
  regions never reach the eye; the inner-lip pairs share a weight; nothing on
  moves nothing; no expression at 1 folds a triangle; mirroring and the
  one-sided `thinking`; the caps; the calibration lowers a ceiling where a
  shape would fold; the cache; under the head's turn: untouched by a zero
  turn, no fold and no scale-back at the four corners of the pose box, the
  raised brows kept through a turn.
- `engine/__tests__/expression-mixer.test.ts`: attack/hold/release values,
  holding forever, a change mid-flight without a jump, the cross-fade per
  frame, neutral, clamping, the track walked and re-sought, a text's
  neutral never releasing a page's expression, the jaw and the gaze, the idle
  layer seeded and under an explicit expression.
- `__tests__/expressions.test.ts` (a live engine): on a photo (classic
  mouth), a toon (character mouth) and an animal, the inner-lip gap of held
  aa, E and oo under every expression equal to without it (to 1e-4); nothing
  drawn differently until an expression is on, nothing at `tune({expression:
  0})`; the jaw floor only while silent; the track on the speech clock, a
  stop releasing it, a page's expression outliving a text; no extra
  `Math.random` with the idle layer on.
- `__tests__/expression-markup.test.ts`, `__tests__/speech-expressions.test.ts`,
  `__tests__/widget.test.ts`: tags, intensities, aliases, unknown brackets,
  escapes, spacing, places, timing with and without word marks, the lead,
  the automatic mode; chunks keep a decimal tag whole, carry a tag-only
  chunk, release at the end; the queue asks for word marks only when needed
  and calls the player exactly as before for a text without tags;
  `Liveface.express` per widget, a no-op on 3D, tags never reach the voice.
- Backend: `test_timing.py` (word marks retimed to the audio, empty text),
  `test_embed.py` and `test_tts.py` (both synthesize routes answer
  `word_marks` only when asked).
- Goldens: unchanged, every one (no expression is on by default).

## Measured (prototype, 2026-10-10)

The real engine of the branch in headless Chrome (Metal), 960 px stage, face
framing, each avatar's own mouth: sakineh (her own kit), mehdi_avatar and
bita (standard teeth), Sakineh Animesh (`toon@1`).

- **Lip-sync**: held aa, E and oo under every expression at 1, the inner
  opening at the centre and the quarter points against neutral with the same
  viseme: 0.00% on all four. The tagged line, expressions on against off,
  every frame of the engine's own 3D motion: the inner opening identical
  (largest difference 0.00000 of the mouth's width).
- **Folds**: no expression at 1 folds or crushes a rig triangle at rest on
  any of the four (every ceiling 1), nor under the turn at the pose box's
  corners (the fold clamp eases exactly the corners it eases without). With
  a held viseme, no fold the viseme does not make alone, except bita's
  surprise at rest: one inner-lip triangle under the surprise's silent jaw
  drop through the photographic mouth (the mouth's own small-opening fold).
  The tagged clips: no new folded triangle-frame.
- **Seams** (the stage-2 detector; rest, idle, sway, turn, speech, a nod, a
  turn, the pose box's corners; three people × GL and 2D): with no
  expression and with each held at 1, 0 seams and 0 tears against what lay
  under the mesh, 0 on the head's field, 0 leaking pixels, no turn scaled
  back.
- **Cost**: the deformation 0.045-0.05 ms → 0.05 ms median with an
  expression on (+5 µs); the whole frame the same within noise.

Before the iris rims went with the lids, Sakineh's surprise folded the
upper lid over the iris's hidden rim (the calibration capped it at 0.31);
before the lids faded toward the eye's corners, a smile on a spread vowel
crushed the inner corner's triangles; before the inner lips were paired,
mehdi_avatar's slightly open rest mouth changed a quarter-point opening by
3.7% under a smile on "oo"; a mouth corner pressed inward crushed it on a
rounded vowel. Each is a rule above now.

## Open questions for the owner

1. Defaults: tags on everywhere (they must be stripped anyway), the automatic
   mode and the idle micro-expressions off until approved per avatar?
2. The amplitudes in the sheets: too strong, too weak, per expression? (They
   are one table: a change is a number.)
3. Should the dashboard's Speak panel accept tags too? Today a tag typed
   there is read aloud (it does not go through the widget's queue).
