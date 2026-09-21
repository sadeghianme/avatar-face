# Reference Avatar — lip-driven tooth visibility

## Defect and scope

The user showed grey and nearly invisible teeth inside an open mouth.
`DentalOralSurface` multiplied both arches' opacity by `enamelExposure` using
input blend weights, while `ContinuousMouth` moved the lips with a separately
spring-integrated pose mixture. Teeth could therefore fade before the lips
covered them. Lower-row exposure also used a whole-row fade.

This change is confined to the Reference Avatar lab and its comparison
recordings. The original avatar editor, published widget rendering, speech
generation, audio clock and database schema are unchanged.

## Implementation

- Reconstruct rendering weights from the exact integrated pose mixture used
  for lip geometry. No second independently timed visibility transition.
- Keep photographic teeth opaque, with their existing colours, shading,
  size and upper-arch anchoring. Remove both whole-row opacity fades.
- Clip the teeth against an inner-lip opening derived from the current lip
  ring in its rotated mouth coordinates. The lower lip rolls inward farther
  during rounding; its back opening can close over the dental plane while
  the front opening is still visible. The outer lip clip is retained.
- Clip the lower row below a small upper-incisor clearance instead of
  dissolving it into a bright strip across a nearly closed mouth.
- Use the same moving opening and integrated weights for fitted geometry
  when an uploaded portrait has no mouth-detail photograph. The optional
  mask leaves the separate Previous prototype mode's behaviour unchanged.
- Stamp new comparison videos and filenames with `lip-coverage-v1` so that
  older recordings can be distinguished from this rendering revision.

No new portrait or dental image was generated. Existing tooth extraction,
full-crown v3 source, and the previous lighting improvement are preserved.

## Verification

All 123 renderer tests pass. Embed and frontend production builds pass;
the existing large-bundle warning remains. Ten new tests cover unchanged unrounded openings, rigid coordinate
transforms, non-inverting closure at dental depth, authored pose
reconstruction, no target-pose lead, every pose-pair sweep and reversal,
actual integrated-state plumbing for both rendering paths, authored OO
coverage of both rows, and opaque draw calls with spatial clips.
The lighting regression test still verifies broad cavity shading precedes
the enamel and only narrow lip contact follows it.

Browser checks include EE, AA, OH, OO, F/V, TH and fully closed P/B/M. An
initial symmetric mask exposed the lower teeth through OO; the asymmetric
inner-lip correction was checked on both the reference and upload path.
The upload check uses the bundled fictional portrait sent only to the
disposable local server, not a customer's photo or an external AI service.
It remains a temporary candidate with the normal 24-hour retention policy.

Actual paired browser recordings use the 115-character English test script,
Kokoro Heart, native phoneme timing, and one shared audio track/cue timeline.
Evidence is in `output/reference-proof-lip-coverage/`: mouth and portrait
MP4s, a speech-frame contact sheet and a dense rounding-transition strip.
The left preview is the original engine, not SitePal. These are visual
regression checks, not an independent quality benchmark.

## Limitations

The inner-lip tunnel is a frontal 2D occlusion approximation, not anatomical
3D reconstruction. The existing photograph warp can still look stretched,
and the fitted-teeth fallback is visibly less realistic than a supplied
dental photograph. Passing these tests does not establish natural motion
across all portraits, profile settings, languages or viewing angles, nor a
9/10 score or superiority over SitePal.

## Rollback and deployment

Pre-deployment backup:
`/root/projects/liveface/backups/lip-coverage-20260907/frontend-before.tgz`.
Rollback image: `liveface-liveface-web:before-lip-coverage-20260907`.

Deployed 2026-09-07 via `personal_server`, rebuilding and restarting only
`liveface-web`. Live HTML serves `index-s7v8ANZA.js`. The running container's
bundle SHA-256 matches the local build:
`2812631ed50f6e489146d27bcb455b070183a71e6f03913d29d435d60caf491c`.
API health is OK and the read-only avatar count is unchanged, 17 → 17.
The API container was not restarted.

Both public recordings match the inspected local files:

- Mouth: `43a5e75ba222333f5a0a25414c26b235a7915d9b8e2cd1281ce54cafab8e8db0`.
- Portrait: `5d6e41b28e66a331cd8e912d8957767c54d8863865fd1b2afb4081e515f957b1`.

Exports are H.264/AAC, 1280×720 at 30 fps, approximately 7.8 seconds.
Local browser error log is empty. The production browser session required
sign-in, so authenticated visual checks were performed locally; production
verification used live assets, bundle equality and service health, not a
claimed authenticated live playback. No credentials were changed.

The existing dependency audit still reports eight findings (four high).
No dependency versions were changed in this patch.
