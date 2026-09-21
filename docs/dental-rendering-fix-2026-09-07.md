# Reference avatar: dental rendering correction

> Superseded: the user's subsequent EE close-up exposed black cracks, a
> horizontal crown seam and fragmented lower teeth in this release. The
> original visual approval below was too broad. See
> [the follow-up repair](dental-rendering-repair-2026-09-07.md).

Deployed 2026-09-07 via `personal_server`. Live frontend bundle:
`index-DiykVh-_.js`. Live page and API health checks passed; all 17 avatar
records remain present. Only the frontend container was rebuilt/restarted.
The deployed AA close-up and new controls were visually checked in Chrome;
no browser errors were reported on the live page.

## What changed

The old renderer copied a fixed open-mouth photograph into each aperture. Only
a few tooth tips were present, and the oral opening and shading were baked into
the same image. That made pale rectangular incisors and clipped side teeth
stand out against the portrait.

The reference now extracts enamel from a dedicated mouth-detail image into
separate upper and lower layers. Neither layer stretches with vowel width or
mouth opening. Source mouth width, not the cropped enamel bounding box,
determines tooth scale. The upper row stays fixed; the lower row translates
with measured lower-lip/jaw displacement. Source lips and frozen cavity pixels
are excluded. Small isolated highlights are rejected.

Hidden upper crown continuation prevents black seams as the lip lifts. Soft
upper-lip contact shadows, shaded corners, enamel warmth, and a separate mouth
floor replace the uniform interior. Rounded vowels reuse the lab's continuous
enamel-occlusion approximation. F/V lip contact is adjusted toward the fixed
incisal edge with a smooth local falloff.

Photo-based mouths now expose tooth size, vertical fit and warmth controls.
An unsuitable mouth-detail photo receives an actionable message and can be
removed with **Use fitted mouth instead**. Own portraits never receive the
fictional sample's teeth. Their optional detail image is processed in the
browser after the existing private server upload; no image-generation service
is called for customer photos.

## Asset provenance

The built-in image-generation tool edited the fictional sample's existing
`assets/reference-performance/performance-ee.png` to create
`assets/reference-performance/oral-detail-v2.png`. The original remains intact.
Only the generated enamel is used at runtime, not the generated face or lips.
Delivery files are `frontend/public/lab/reference/oral-detail-v2.webp` and
`oral-detail-v2.rig.json`. The detected rig has 478 landmarks.

Final generation prompt (built-in mode, not CLI):

> Use case: identity-preserve. Asset type: photographic oral-detail source for a realtime fictional avatar. Image 1 is the edit target, a fictional generated woman. Preserve her identity, frontal camera, full head-and-shoulders framing, skin pores, hair, background, clothing and lighting. Change only the mouth expression and dental detail. She gently says an open 'eh': upper lip raised just enough to reveal a continuous natural upper dental arch of eight distinct teeth, from premolar to premolar; mouth moderately open with a clearly dark gap between upper and lower teeth. Anatomically plausible small adult teeth, central incisors slightly broader than lateral incisors, subtle rounded irregular incisal edges, natural ivory enamel with fine surface texture, translucent edges, warm contact shadows. Upper teeth anchored in the maxilla, rear teeth recede and become softly shaded; a small separate lower tooth row visible behind the lower lip. No giant rectangular front teeth, no fused white slab, no dentures, no glowing white teeth, no duplicated teeth, no exaggerated grin, no artificial black flat hole. Photorealistic, natural texture. Return one high-detail square photographic portrait, no text or diagram. This image will supply only enamel texture, not replace the neutral portrait.

## Verification and limits

102 renderer tests pass, including eight new dental extraction/placement tests.
The production build is checked separately from browser visual inspection.
The private portrait and mouth-detail HTTP upload checks both returned 201,
478-point rigs and readable signed images; the disposable library stayed 1 → 1.
Browser inspection covers AA, EE, OO, F/V and complete P/B/M closure. The
115-character speech test uses Kokoro Heart with native phoneme timing and
the same audio in both previews.

Two actual browser recordings are saved in `output/reference-proof-dental/`:
`comparison-mouth.mp4` and `comparison-portrait.mp4` (1280×720, exported at
30 fps, with shared audio). A mouth contact sheet samples the recording every
half-second. The sampled frames show a single tooth row, closure and rounded
occlusion without crossfaded duplicates. Public proof files use these new
recordings; earlier proof directories remain untouched. A transient dev-server
reload error during editing was corrected before these tests and builds.

Deployment is frontend-only. The previous source/assets are backed up at
`/root/projects/liveface/backups/dental-20260907/frontend-before.tgz`, and the
previous image is tagged `liveface-liveface-web:before-dental-20260907`.

Live/local SHA-256 matches:

- Oral detail: `586d9dae580ec0ec38099e1e76e1f2fc2f3f64a6df81fd41ca8ed0561e7afbfd`
- Mouth proof: `e9b5f440dc5b8a85c52c5bfd95c7d7bf094f5232227368903711d6e359acfe3f`

Existing build advisories remain: large frontend chunks and eight dependency
audit findings (four high). No dependency versions or lockfiles were changed
as part of this rendering correction.

This is still a frontal photographic approximation, not reconstructed 3D
dentition or a tongue simulation. Side crowns and F/V remain approximations;
different photos require fitting. No 9/10 score or SitePal superiority is
established by these changes. Original editor, published avatars, widget
behavior and backend data are outside this deployment.
