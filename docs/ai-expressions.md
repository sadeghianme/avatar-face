# AI expression pictures (option 2, 2026-10-11)

The animated expressions (docs/emotions.md, option 1) move the photo's
pixels: a smile's folds, a surprise's creases and a frown's furrows are
painted cues. For an avatar whose owner chooses them, the image model
draws five photos of the same face making each expression (happy,
surprised, concerned, thinking, serious), and the engine lays the upper
face of the one playing over the moving mesh. The mouth stays the
speech's. A smile with parted lips is also shown at the mouth while the
avatar is silent. An expression with no picture plays animated.

## Who, and what it costs

- **Who may send.** As for the mouth kit: the organization's third-party AI
  switch, the image model configured, the monthly image limit (five more),
  and the member's current `third_party_ai` consent naming Google. The
  switch and the limit are read again before every call
  (`mouth_kit.CallGuard`). The consent is recorded on the avatar before the
  first picture leaves. Human faces only: animals and cartoons stay
  animated.
- **Cost.** Five calls per kit, plus one more for each refused edit (asked
  again on the head crop). Each billed call writes one usage row
  (`"expressions"`), or one row per answer for a batch. At
  `gemini-3.1-flash-image` 1K output that is about $0.067 an image: about
  $0.34 per avatar, about $0.17 as a batch. Measured in the trial: 20 calls,
  all answered, 8.2 to 10.5 s each.

## When

- **The panel's Make**: a job (`POST /avatars/{id}/expressions/make`), about
  twenty seconds. It is a draft edit like the mouth kit; visitors get the
  pictures, and the disclosure, at the next publish.
- **At Publish**, when the owner chose AI pictures (`PUT
  /avatars/{id}/expressions {ai: true}`) and none are made yet, the publish
  starts the job. With `delivery: "now"` the pictures are made at once; with
  `"batch"` they go as a Gemini batch, half the price, collected by the
  sweeper (`expression_kit.batching`, given up after 26 hours).
- **A publish's own kit completes that publish.** When it is ready and the
  snapshot is still that revision, its `expressions` (and the disclosure)
  are rewritten at once (`saving.republish`), and the draft stays in step.
  If the owner published or edited meanwhile, the kit is a draft edit like
  any other. A publish never fails because of the pictures.

## Made (`services/expression_kit`)

1. **Prompts** (`prompts.py`, `expr-prompts@3`). There is one anatomical
   sentence per expression, then what must not change. The keep-list covers
   identity, face shape, skin and its texture, gaze at the camera, head pose,
   framing, light, background and size. It also says the age (no added
   lines, no grain), the skin tone (not darker, greyer, warmer or more
   tanned) and the picture's own medium (a painting or a 3D render stays
   one). The trial's history is in the module's docstring.
2. **Registration** (`performance_kit.register_face`, shared with the mouth
   kit through `performance_kit.Sender`). The answer is checked on the mouth
   kit's anchors with every drift guard except the eyes', because an
   expression moves the lids. Then `reached.expression_reached` reads the
   expression's signature from the brows, the lids and the mouth's corners.
   A frown drawn for concern is refused there.
3. **The source's skin** (`fidelity.keep_skin`). The answer's finest detail
   on the skin is replaced by the source's (pores and grain, under 0.008
   face widths, warped onto the answer's landmarks). Its skin colour is then
   shifted back to the source's (mean Lab over the nose, mid cheeks and
   chin). On the trial this took skin ΔE from 1.2–3.1 to 0.7–3.1, and Sakineh
   smiling from 1.23× the source's fine texture to 0.98×.
4. **The manifest** (`manifest.py`, `kind: "liveface-expressions"`, version 1).
   Per expression it holds the picture's size, `uv` (the picture's own
   pixels for each landmark) and `targets` (where each goes on the avatar's
   picture: the owner's confirmed points plus what the answer moved). `uv`
   is the targets taken back through the registration, so a mark the owner
   corrected samples the picture where the corrected feature is. mehdi_avatar's
   marks are a sixth of a face from the detection, and without this its brow
   was drawn smeared.

## Stored, published, followed (`services/expressions.py`, a leaf)

- `avatars.expressions` (migration 030) holds
  `{ai, consent_id, consent_user_id, delivery, kit, pending}`. The files sit
  beside the avatar's others: `expr-<stamp>-<name>.webp` and
  `expr-<stamp>.json`.
- **Publish** copies the manifest and the pictures while `ai` is on and some
  were made; the snapshot's `expressions` holds `{manifest_key, image_keys,
  kit}`. Visitors get `expressions: {manifest_url, image_urls}`. **Discard**
  restores them into fresh draft keys. The sweep removes expression files
  the draft no longer names.
- **The disclosure** gains `expressions: {model, made}`, mode `"expressions"`
  when nothing else was AI-made. Its rank is below teeth and mouth shapes,
  and the picture's own mode outranks all of them.
- **Later edits.** An avatar's face never changes; crops, cut-outs and undo
  only re-frame it. So the kit follows every edit with no AI call
  (`kits.follow_points`, with the mouth kit). The targets move with the
  points; the pictures and their `uv` are their own. A kit that cannot follow
  is dropped and wanted again at the next publish.

## Laid on the face (`embed/src/engine/expression-*`)

- **The masks** (`expression-picture-masks.ts`) are an alpha field on a
  128-cell grid over the picture, read off its own landmarks.
  - The upper mask is the face's oval held in from its outline. It excludes
    the eyes' openings, the lips grown 1.3× with a band round them, and
    everything below the mouth's middle.
  - The mouth mask (smiling pictures only) is the lips grown 1.45×.
- **The geometry** (`ExpressionPictureLayer.apply`, called from `deform.ts`
  in place of the rig's pass):
  - expressions without a picture move by the rig as before;
  - for those with one, each landmark moves by the picture's displacement
    times the mask there, plus the rig's own displacement times what the
    mask leaves.
  
  So the two meet without a seam, and the mouth's corners stay the warp's.
- **The colour** (`ExpressionPictureLayer.draw`, right after the warped
  photo, before the eyes and the mouth are painted). The picture with its
  mask as alpha is drawn through the moved mesh at its `uv`, at the
  expression's weight:
  - on the GPU, by a second `WarpRenderer` that keeps the pictures uploaded
    (`setTexture` switches among them);
  - in 2D, triangle by triangle.
  
  The picture's features land where the mesh put them. This is what removed
  mehdi_avatar's doubled smile fold, which a plain cross-fade drew.
- **The animation's amplitude as a floor** (`floor`, 1): where the animated
  expression moves a covered landmark further the same way than the
  picture does, the landmark goes as far as the animation. A picture drawn
  timidly still reads as its expression: Sakineh's surprise (brows up 0.02
  of the face, the eyes not widened) went from losing to the animated one
  in both orders to a split, and every other expression kept its wins.
- **A surprise keeps the source's under-eyes** (`UNDER_EYE_KEPT`): a
  surprise does not change the cheeks under the eyes, and the picture's
  darker, puffier ones read as tired (the judges' note on that loss).
- **The silent smile** (`PauseSmile`) eases in after 250 ms with no
  articulation, over 300 ms, and out over 90 ms as soon as the speech's
  target opens the mouth. The target leads the mouth, so the smile is gone
  before the first sound.
- **Skin cues**: an expression a picture shows paints none of option 1's
  cues, because the picture has real folds.
- **Arrival**: the animated expressions play until the pictures load, then
  the pictures come in over 150 ms. If loading fails, the animated
  expressions stay.
- **Pages**: the widget loads the published set, the share page the same,
  and the dashboard preview the draft's (`useExpressionPictures`).

## Dashboard

An **Expressions** section under Look, for a person's photo avatar
(`ExpressionsPanel`, `useExpressionsPanel`, `api/expressions.ts`). It
explains what AI pictures are and has:

- the switch, which asks for consent;
- how a publish makes the pictures (right away, or cheaper within hours);
- Make now, followed until it ends;
- the five pictures, or why one stays animated;
- Remove.

It is in English and French.

## Measured

`scratchpad/aiexpr/final/` holds the trial, the before/after sheets and the
clips (neutral, option 1, option 2), with the numbers in its report.
