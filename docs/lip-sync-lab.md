# Lip-sync lab

Route: `/lip-sync-lab`. Organization membership is required.

This is a timing experiment, not a replacement for the existing avatar page,
Photoface HD, or embed widget. It reuses `AvatarEngine` and saved face assets.
The only change in the shared renderer is an optional `cueClock` callback;
without it, the existing clock and animation behavior remain the same.

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

## Model and runtime

The Docker build includes a separate timestamp-enabled Kokoro model by default
(~326 MB on disk), verified by SHA-256. It is loaded lazily by the lab only.
Budget roughly another 1 GB of resident memory per backend worker after use;
measure on the target host before broad rollout. Requests within one worker
are serialized. Existing Kokoro uses its original model and cache.

For constrained hosts, build with `--build-arg INCLUDE_LIPSYNC_MODEL=0`.
The lab remains usable as a clock-only comparison. No model is downloaded
at request time.

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

Native synthesis is lab-only, uncached, and uses the normal organization
usage check/accounting. It never writes native cues to the stable speech
cache. Browser and cloned voices are intentionally unavailable in this lab.

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
start/pause/buffering/resume/cancel/error behavior.

For visual acceptance, generate the test sentence, replay, pause/resume, and
change avatars while generating. Test a short paragraph in each supported
language and a long phrase approaching the 600-character lab limit. Check
P/B/M closures, F/V contact, OO rounding, silence, and final closure. Capture
audio and video together before drawing conclusions about synchronization.

Remaining work: aligned timing for Piper/Persian and cloned voices, calibrated
mouth geometry, browser/device audiovisual measurements, and a controlled
recorded comparison with SitePal. No claim of SitePal parity is made here.
