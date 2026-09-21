# Low-delay speech and Reference Avatar photo testing

## Scope

The Reference Avatar and Lip-sync labs now use phrase-level streaming for
Kokoro when the timestamp-enabled model is installed. This is not token-by-token
LLM input or model-frame streaming. The browser sends the script once and starts
playing timed audio phrases before synthesis of the remaining script finishes.
Other providers retain complete-recording playback, explicitly labelled.

The original avatar editor, existing TTS endpoint, provider cache, published
widget behaviour, teeth materials and lip-coverage renderer are unchanged.
The frontend architecture guidance kept transport/parsing separate from page
composition and reused the authenticated request client and photo pipeline.

## Implementation

- Private `POST /orgs/{org_id}/lab/lip-sync/stream`, with existing membership,
  600-character validation and monthly usage checks. NDJSON frames carry a
  versioned start, ordered PCM chunks plus native/local cues, and a terminal
  completion or explicit failure. No automatic partial-stream retries.
- Mono 24 kHz PCM16 uses exact sample counts/offsets, avoiding cumulative
  rounding drift. UTF-8/JSON boundary splits, duplicate/missing/out-of-order
  chunks, inconsistent totals and oversized audio are rejected by the client.
- Short phrase units (72-character target) and adaptive look-ahead. Longer batches
  (up to 120 characters) are used only when their measured generation cost, plus
  25% safety margin and 400 ms headroom, fits the estimated buffered audio.
  Slower servers keep short packets. Punctuation and word boundaries are preferred;
  input characters are neither dropped nor duplicated. Unbroken words are not cut
  to satisfy these soft targets; the entire request remains bounded at 600 chars.
- One Web Audio output schedules both previews. The output-clock position is
  mapped to content time, excluding buffer gaps. Incoming cues extend the active
  track without restarting articulation. Pauses/stalls close the lips and freeze
  progress; resume uses the same clock. Stop, route/portrait changes and unmount
  abort the request and stop/disconnect scheduled sources.
- One active stream per workspace, at most four concurrent lab streams per API
  process. Native inference is serialized. Cancellation does not free its slot
  until the already-running ONNX worker actually finishes; no next phrase starts
  after disconnection. Each completed phrase is metered before delivery, once.
- Optional model warm-up runs outside the health/startup critical path. Per-native
  phrase timeout is 90 seconds; the browser request deadline is 180 seconds.
- Completed PCM/cue packets are assembled into one WAV for existing replay and
  comparison export, without another generation request. The page reports first
  audio delay and buffer pauses (>20 ms scheduled gaps), not an accuracy score.
- The upload card now shows the selected photo, explicit success, Change photo,
  Test this photo, and Use sample portrait. Test this photo opens the script
  section; it does not automatically spend speech usage. Upload has cancellation
  on unmount and a 90-second timeout. Invalid replacements do not replace the
  active avatar. Temporary photos still use private signed storage and the
  existing retention sweeper, without creating/publishing library avatars.

## Measurements and checks

An initial paired warm local API test (before the adaptive look-ahead refinement):
579 English characters, Kokoro Heart.

| Path | First audio available | All synthesis completed | Audio length |
| --- | ---: | ---: | ---: |
| Previous complete-recording endpoint | 11.715 s | 11.715 s | 39.726 s |
| Timed phrase stream | 1.229 s | 12.449 s | 39.702 s |

The stream's six packet arrivals were 1.229, 3.661, 6.350, 8.739, 11.179 and
12.449 seconds. This is a time-to-first-audio improvement, not a claim of faster
total synthesis. Phrase boundaries can slightly change prosody and duration.
These are single-run measurements, not a percentile benchmark or service SLA.

Local browser tests with the 115-character reference script reported first audio
at 1.45 seconds, with later warm tests at 1.34–1.36 seconds. A 231-character test
used a freshly uploaded bundled fictional portrait. Pause held exactly
0.2172900000715252 seconds across repeated observations while later packets
continued arriving. Stop-before-first-audio and switching portraits cleared the
previous playback without a stale response restarting it.

- Backend: 461 tests passed, 3 skipped (existing optional integration tests).
- Renderer/transport: 140 tests passed across 17 files.
- Embed and frontend production builds pass; structure check: 96 files, 2 locales.
- Existing dependency warnings remain: eight frontend audit findings (four high)
  and the large-bundle warning. No dependency versions were changed.

Photo upload and selected-photo speech were verified through the local browser
against a disposable database. The same backend upload endpoint is unchanged in
this release. Automated production upload selection was blocked by the Chrome
extension's file-URL permission, before any file was sent; this is not an app
upload failure. No personal customer photo was sent to another service.

## Deployment and rollback

Production is `https://avatar.mehdisadeghian.com/reference-avatar`, via
`personal_server`, root `/root/projects/liveface`.

Backup: `backups/speech-stream-20260907/code-before.tgz`.
Rollback images: `liveface-liveface-api:before-speech-stream-20260907` and
`liveface-liveface-web:before-speech-stream-20260907`.

The API code-only release uses `deploy/Dockerfile.speech-stream` on the pinned
existing runtime image `1bbc6ee9200c678bfe1aeceee032bc9241428bfb026a63b3a08837c1aacf822e`.
This preserves installed dependencies, model weights and published widget
bundles. The normal backend Dockerfile remains available for clean builds.
No secrets, database schema, storage volumes or proxy settings were changed.

Final API release image: `liveface-liveface-api:speech-stream-20260907-v2`
(`f19a61da75f693c96283d24077d59c23f2536d06872e1c20cb3acf2a0df8f2f4`).
Final frontend bundle: `index-CL7loIx9.js`, SHA-256
`11add97cb2f25e14856ce224437432f89a9ea3fbd17b2baacf148a4efb00d850`.
The running bundle matches the local production build.
Both services restarted successfully; health is OK and the read-only avatar
count remained 17 → 17. Authenticated production streaming worked in a separate
Chrome tab, without reloading the user's existing tab. Its first 347-character
test started audio in 3.31 seconds while only one of four phrases had arrived.
Adding buffer-gap diagnostics exposed one production underrun with fixed larger
follow-up chunks; this prompted the adaptive server batching in the final release.
The final adaptive test completed 347 characters / 23.3966 seconds of audio in five
packets, with first audio at 4.35 seconds and **zero scheduled buffering pauses**.
The production browser had no error logs or app alerts. The first packet still
arrives before the remaining speech is generated; total generation speed has not
been represented as the same metric as time to first audio.
The production comparison recorder successfully replayed/exported the assembled
WAV: the preview video and `liveface-comparison-lip-coverage-v1.webm` download
became available without a new synthesis request. Recording remains a comparison
of Liveface's two renderers, not a SitePal comparison.

Rollback the service images by tagging the saved images back to the compose
image names and recreating only `liveface-api` and `liveface-web` without a build.
Restore changed source files selectively from the code archive if needed;
do not overwrite later user edits or data volumes.

## Technical references

Playback scheduling follows the [Web Audio source scheduling contract](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start).
The visual clock uses the [audio output timestamp](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp)
where supported, with a latency-adjusted context-clock fallback. Actual start
delay depends on script, voice, CPU load, network, browser and audio device;
the measurements above do not establish lip-sync perceptual quality or SitePal
superiority.
