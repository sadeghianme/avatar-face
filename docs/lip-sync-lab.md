# Lip-sync lab

Route: `/lip-sync-lab`. Organization membership is required.

This is a timing experiment, not a replacement for the existing avatar page,
Photoface HD, or embed widget. It reuses `AvatarEngine` and saved face assets.
The shared renderer takes an optional `cueClock` callback. Without one,
`playAudio` (the share page, the widget) now times cues by the audio
element's position too (`embed/src/media-clock.ts`, since 2026-09-26),
which is what this lab showed to matter. The 3D engine (`Avatar3DEngine`)
plays speech by the same clock: held until the audio reports `playing`,
re-synced on `seeked`, and with the mouth closed while paused. Until the
voice has started, the silence the photo engine reads at time 0 is not a
pause in the speech: no catch-breath, blink or glance away before the
first word, however long a phone takes to start the audio.

## What the comparison means

- Both previews share one recording, voice, image, and rig. Head motion is
  disabled for the comparison. There is never a second audio player.
- With native Kokoro timing, the left side uses the existing duration model
  fitted to that recording. The right uses phoneme spans returned with the
  generated waveform and follows the media playback position every frame.
- For other supported server providers, or when the lab model is absent,
  both sides get the existing provider cues. The UI explicitly labels this
  clock-only mode. It is **not** forced alignment or improved phoneme timing.
- Playback starts the mouths on the audio `playing` event. Pause/buffering
  closes the mouths; resume repositions both cue tracks. Stop, errors,
  changing avatars, and leaving the page release the player. Late responses
  from a stopped request are discarded, although synthesis already running
  on the server may finish and count toward usage.
- Replay reuses the last generated recording without another API call.
  Editing the script or voice does not alter that recording.
- Visual lead starts at zero. It is a manual playback adjustment, not a
  measured accuracy claim. Mouth interpolation/smoothing still introduces
  articulation dynamics; native timestamps alone do not prove perceptual parity.
  Since 2026-10-06 the engine itself reads the cue track 50 ms ahead of
  the clock it is given (`ARTICULATION_LEAD_MS`, the articulation's measured
  delay: the lip gap's peaks then sit within 9 ms of the blend's by
  cross-correlation); the lab's visual lead is on top of that, on both
  sides alike.

## Model and runtime

The Docker build includes a separate timestamp-enabled Kokoro model by default
(~326 MB on disk), verified by SHA-256, and production states it explicitly
(`deploy/docker-compose.prod.yml`, `INCLUDE_LIPSYNC_MODEL: "1"`). It is
warmed at startup. Requests within one worker are serialized.

Since 2026-09-26 the product speaks through it too (services.tts.kokoro):
when it is installed, the Kokoro provider makes every recording with this
model, streamed phrases included, and serves the model's own phoneme spans
as cues (`native_cues`). Unusable spans keep the audio and fall back to
the stretched cues; a model that fails falls back to kokoro-v1.0.onnx,
which is then loaded (and that recording is not cached). Speech cache rows
made this way are keyed with `native-1` (`cache_version`), so no recording
cached with stretched cues is served as a native one. `KOKORO_NATIVE_TIMING=false`
switches it off.

Memory: a normal server now holds ONE Kokoro session (the timed model,
roughly 1 GB resident; measure on the target host), where it used to hold
two once both had been used. kokoro-v1.0.onnx stays in the image as the
fallback. Whether it can leave the image depends on whether the two exports
make the same speech: `scripts/compare_kokoro_models.py` measures it on a
machine with both models (it was not run when this changed: the models were
not on the development machine, and nothing was downloaded to check). By
construction the served audio differs in one known way: kokoro-onnx tops up
the pause after every comma and full stop only for a model that reports
timings, so the timed model's clause pauses are longer.

For constrained hosts, build with `--build-arg INCLUDE_LIPSYNC_MODEL=0`.
Speech then uses kokoro-v1.0.onnx with stretched cues, and the lab remains
usable as a clock-only comparison. No model is downloaded at request time.

Local configuration:

```text
KOKORO_LIPSYNC_MODEL_PATH=/absolute/path/to/kokoro-timed.onnx
KOKORO_VOICES_PATH=/absolute/path/to/voices-v1.0.bin
```

The model is [ONNX Community's timestamped Kokoro export](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/tree/dd4401a9add81ac692d20e240d22ec9dda82cc29/onnx), Apache-2.0.
The pinned `kokoro-onnx==0.6.1` runtime exposes `create_timed`. The adapter
accepts the model's plural `durations` output only after checking output order.
Stress/length tokens are attached to their phonemes instead of becoming fake
silences. Invalid or unmapped timing returns an explicit error, not a silent
fallback labeled as native.

The lab's own native synthesis (with its stretched baseline beside it) is
uncached and uses the normal organization usage check/accounting. Browser
and cloned voices are intentionally unavailable in this lab.

## Verification

```sh
npm test --prefix embed
npm run build --prefix embed
npm run build --prefix frontend
cd backend
.venv/bin/python -m pytest tests/test_lab_timing.py -q
RUN_LIPSYNC_MODEL_TESTS=1 .venv/bin/python -m pytest tests/test_lab_model.py -q
```

The model tests require the configuration above and perform actual synthesis
for US English, UK English, and French. Normal tests never download weights.
Unit tests cover timing preservation, affricates, stress/length modifiers,
invalid metadata, membership checks, explicit failure/fallback, and playback
start/pause/buffering/resume/cancel/error behavior. The product engines'
clock is pinned with a fake audio element whose `playing` arrives late
(`embed/src/__tests__/media-clock.test.ts` for the photo engine, including
the pause behaviour, and `engine3d-clock.test.ts` for the 3D engine).

For visual acceptance, generate the test sentence, replay, pause/resume, and
change avatars while generating. Test a short paragraph in each supported
language and a long phrase approaching the 600-character lab limit. Check
P/B/M closures, F/V contact, OO rounding, silence, and final closure. Capture
audio and video together before drawing conclusions about synchronization.

Remaining work: aligned timing for Piper/Persian and cloned voices, calibrated
mouth geometry, browser/device audiovisual measurements, and a controlled
recorded comparison with SitePal. No claim of SitePal parity is made here.
