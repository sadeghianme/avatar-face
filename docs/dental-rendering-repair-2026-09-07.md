# Reference Avatar — broken-teeth repair

## Defect and repair

The previous dental release was not visually acceptable. Brightness-based
opacity erased shaded enamel; opaque single-column root extensions created
vertical bars and a horizontal join; a heavily clipped lower row became white
fragments. A broad lip shadow made the crown seam more conspicuous.

The repaired extractor uses colour only to identify tooth seeds. It retains
original, opaque source shading within each arch, bridges short interdental
shadows and preserves small gum-contact notches. It does not whiten or blur
away the source detail. The artificial root extensions have been removed
entirely. Contact shadow is much narrower and lighter.

The fictional reference now uses a full-crown source, version 3. Upper teeth
remain skull-fixed and keep their scale across vowels. The lower arch follows
the jaw and fades out continuously when the lip opening would expose only a
thin strip. Photos with insufficient central crown coverage receive an
actionable error rather than fabricated roots. Updated English/French upload
instructions request full upper front teeth, not just tips.

This changes only the Reference Avatar/lab implementation. Original avatar
editing and published widgets remain unchanged. No customer photo was sent to
image generation, and the sample teeth are never substituted into an uploaded
user portrait.

## Verification

- 107 renderer tests pass, including 13 dental extraction/placement tests.
- New regressions cover opaque internal shading, short interdental notches,
  absent root extensions, continuous lower-row exposure and crown coverage.
- Embed build and frontend structure/type/production build pass. Existing
  large-chunk advisories remain; dependency versions are unchanged.
- Actual Chrome pose checks: EE has no extended bars, horizontal crown join
  or fragmented lower strip; AA has a continuous lower arch; OO conceals teeth;
  F/V meets the upper incisal area; P/B/M closes without visible enamel.
- Local portrait and optional mouth-detail HTTP uploads return 201 with
  detected 478-point rigs; the disposable avatar library remains 1 → 1.
  This checks upload transport, not universal renderer suitability.
- Two actual 7.8-second Chrome recordings use the same local Kokoro Heart
  audio and native phoneme cues on both previews. Files are in
  `output/reference-proof-dental-repair/`: `comparison-mouth.mp4`,
  `comparison-portrait.mp4` and a 16-frame `mouth-contact-sheet.jpg`.
  Recordings are exported at 1280×720, 30 fps. The left-hand comparison is
  the original drawn-mouth engine, not the defective reference release.
  The sampled repaired frames have no extended bars, crown join or broken
  lower strip. These recordings replace the two public lab proof videos.
  Browser error log after recording: empty.

The photo-based renderer is still a frontal approximation. This repair does
not establish a 9/10 quality score or a win against SitePal. F/V contact, depth,
and fitting across different photographs still require visual judgement.

## Asset provenance

Generated with the built-in image tool, editing the existing fictional
`assets/reference-performance/oral-detail-v2.png`; no customer image was used.
Only dental surfaces are used by the app, not the generated skin or lips.

- Master: `assets/reference-performance/oral-detail-v3.png`
- Delivery: `frontend/public/lab/reference/oral-detail-v3.webp`
- Detected rig: `frontend/public/lab/reference/oral-detail-v3.rig.json`

Final generation prompt:

> Use case: identity-preserve. Image 1 is the edit target, a fictional generated portrait. Asset: full-crown dental texture source for a realtime avatar. Keep identity, head position, camera, hair, clothes, background and skin unchanged. Change only mouth expression: lift the upper lip into a broad open EE smile so that the ENTIRE natural upper incisor crowns are visible from the gumline to the incisal edge, plus a small band of pink gum above them. The upper central incisors should have their full vertical height, slightly taller than their width, not just short tips below the lip. Show all eight upper teeth in a continuous curved dental arch, with softly shaded premolars, no black spaces between adjacent teeth. Mouth open enough for a clearly separated dark inter-arch gap. Lower lip lowered to reveal the full upper half of the lower front crowns as one coherent lower arch. Natural warm ivory enamel, fine tonal gradients and translucent edges, subtle rounded incisal contours. Photorealistic, soft frontal lighting with no horizontal shadow stripe across the crowns. Full original square portrait framing, no crop, no diagram or text. Only teeth will be used in the renderer; source lips and skin are not used.

## Deployment record

Pre-repair server backup:
`/root/projects/liveface/backups/dental-repair-20260907/frontend-before.tgz`.
Previous container image:
`liveface-liveface-web:before-dental-repair-20260907`.
Pre-deployment read-only avatar count: 17.

Deployed 2026-09-07 with `personal_server`, rebuilding only `liveface-web`.
The API container was not restarted. Live HTML serves the matching production
bundle `index-CeljzbQZ.js`; `/api/health` returns OK. Post-deployment read-only
avatar count is still 17.
The live EE mouth close-up was rechecked in Chrome after deployment and
matches the repaired local render; no browser errors were reported.

Live/local SHA-256 matches:

- Dental WebP: `425be912d0211aa272781ca063a9672a8f559f46f51c84cf1d0fcb2d89e90d14`
- Mouth recording: `3515208c96652f5a1e5450ddd7e5f7019560b6d5ad89952c9db66329026c097a`

The build retains eight pre-existing dependency audit findings (four high).
This rendering repair does not upgrade dependencies.
