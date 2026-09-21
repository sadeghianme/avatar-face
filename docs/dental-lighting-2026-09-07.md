# Reference Avatar — softer dental lighting

The user supplied `liveface-comparison (8).webm` and reported excessive
darkness around the teeth. Its right-hand preview was inspected in a
16-frame contact sheet saved as
`output/reference-proof-dental-lighting/user-before-sheet.jpg`.

## Focused change

The previous renderer painted a nearly black side gradient across the entire
mouth after drawing both dental arches. At the lateral stops its opacity was
68%, rising to 95% at the corners. That dimmed the outer crowns heavily and
compounded the source photograph's existing tooth shading.

The new version separates oral depth from enamel illumination:

- Cavity and corner shading is drawn before the teeth, not over them.
- A warm, bounded oral palette replaces near-black recess colours. With the
  default lip sample the deepest colour is RGB 36/16/19 rather than roughly
  10/4/4. Interior gradients retain colour and a softly lit mouth floor.
- A separate, restrained rear-crown falloff is baked into each arch's own
  alpha using source-atop compositing. Most of the arch gets 0–6% shading;
  even the extreme edge is capped at 26%. Central crowns remain untouched.
- Enamel brightness correction is gentler: about 0.963 rather than 0.90 at
  default warmth. It does not overexpose or replace source detail.
- The narrow lip-contact shadow is slightly lighter, without widening it
  into another stripe.

The previous full-crown image, opaque shading-preserving extraction, tooth
positions, jaw movement, lower-row visibility and vowel occlusion are
unchanged. No new image was generated and no customer photo was transmitted.
The original editor and published widget code are outside this change.

## Verification

113 renderer tests pass, including six new lighting tests. One exercises the
actual draw method and asserts that every broad cavity fill occurs before
the enamel; only narrow lip contact may follow. Tests also bound the palette,
enamel correction and rear-crown shading. Embed and frontend production
builds pass; existing large-chunk warnings remain.

Local Chrome inspection covers the EE side-crown lighting, AA mouth depth and
lower row, rounded OO occlusion and closed P/B/M. Two actual Chrome recordings
use the same 115-character Kokoro Heart speech and native phoneme timing on
both previews. They are exported at 1280×720, 30 fps to
`output/reference-proof-dental-lighting/comparison-mouth.mp4` and
`comparison-portrait.mp4`. The 16-frame `after-contact-sheet.jpg` was inspected
for crown continuity and lighting during speech. Browser error log: empty.
The left-hand recording is the original drawn-mouth engine; the right-hand
recording is the updated reference, not a SitePal comparison.

The supplied recording does not contain a renderer build identifier. Its
appearance is reference evidence, not proof of which bundle that tab ran.
The earlier `reference-proof-dental-repair` recordings remain available as
the known pre-lighting baseline. The user's supplied video is untouched.

## Rollback

Pre-change source/assets backup:
`/root/projects/liveface/backups/dental-lighting-20260907/frontend-before.tgz`.
Previous web image: `liveface-liveface-web:before-dental-lighting-20260907`.

## Deployment

Deployed 2026-09-07 through `personal_server`, rebuilding only the web
container. The live page serves `index-BulXV4AA.js`, matching the local build.
API health is OK, and the read-only avatar count remains 17 → 17. The API
container was not restarted.
The deployed EE close-up was visually rechecked in Chrome and matches the
local lighting result. Browser error log after the live check: empty.

The delivered mouth recording matches local SHA-256:
`e917151ae74f422197ce2e790e86b62be333699fa57a08abcd51ae9eb151d35b`.
The full-crown WebP is unchanged:
`425be912d0211aa272781ca063a9672a8f559f46f51c84cf1d0fcb2d89e90d14`.

Pre-existing build advisories include large chunks and eight dependency
audit findings (four high); no package versions were changed.

This is a targeted shading improvement, not a claim of reconstructed 3D
dentition or independently established premium/SitePal-level quality.
