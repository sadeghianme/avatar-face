# Liveface API image. Build context = repo root:
#   docker build -f backend/Dockerfile .
# Multi-stage: node builds the embed widget bundles; python runs the API.

FROM node:20-alpine AS embed-build
WORKDIR /build/embed
COPY embed/package.json embed/package-lock.json ./
RUN npm ci
COPY embed/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app/backend

# mediapipe needs OpenCV runtime libs. espeak-ng is used only for its
# grapheme-to-phoneme front end (`-q --ipa`), which is what lets lip-sync work
# in roughly a hundred languages instead of only English — a few MB for every
# language nobody has to hand-write a rule table for.
# libegl1/libgles2 are needed by mediapipe 1.x, which loads a C shared
# library at import of any task. Without them every detection raises inside
# landmarks_from_image, which catches and falls back to the synthetic mesh —
# so face detection does not fail loudly, it silently stops working and
# every upload gets "no face detected". Learned the hard way.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libegl1 libgles2 curl espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# Models first, before any source is copied: they depend on nothing in this
# repository, so a code change must not re-download ~700MB of them (it did,
# on every deploy, until the host's address was rate limited by GitHub and a
# deploy failed on a 503). Every download retries with a delay for the same
# reason.

# MediaPipe FaceLandmarker model for real photo rigging. Versioned URL and a
# checksum, not /latest/: every stored rig was measured by this exact model,
# and a silently replaced one would move the points of every re-detection.
RUN mkdir -p models \
 && curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task \
 && echo "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  models/face_landmarker.task" | sha256sum -c - \
 && curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/selfie_segmenter.tflite \
    https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite
ENV RIG_MODEL_PATH=/app/backend/models/face_landmarker.task
ENV SEGMENT_MODEL_PATH=/app/backend/models/selfie_segmenter.tflite

# Kokoro-82M local TTS (Apache-2.0): one consistent server voice with no key,
# no per-character bill, and no text leaving the instance. ~350MB, fetched at
# build time like the MediaPipe models above.
RUN curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/kokoro-v1.0.onnx     https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx  && curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/voices-v1.0.bin     https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
ENV KOKORO_MODEL_PATH=/app/backend/models/kokoro-v1.0.onnx
ENV KOKORO_VOICES_PATH=/app/backend/models/voices-v1.0.bin

# The timestamped Kokoro export. When present, the Kokoro provider speaks
# with it and times the mouth by the model's own phoneme spans
# (services.tts.kokoro); kokoro-v1.0.onnx above is then loaded only if it
# fails. Warmed at startup, ~1 GB resident. INCLUDE_LIPSYNC_MODEL=0 builds
# without it: speech falls back to kokoro-v1.0.onnx with cues fitted to the
# audio's length, and the lab labels its clock-only mode.
ARG INCLUDE_LIPSYNC_MODEL=1
RUN if [ "$INCLUDE_LIPSYNC_MODEL" = "1" ]; then \
      curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/kokoro-timed.onnx \
        https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/dd4401a9add81ac692d20e240d22ec9dda82cc29/onnx/model.onnx \
      && echo "651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054  models/kokoro-timed.onnx" | sha256sum -c -; \
    fi
ENV KOKORO_LIPSYNC_MODEL_PATH=/app/backend/models/kokoro-timed.onnx

# Piper voices (MIT) for the languages Kokoro does not speak — Persian first,
# then Arabic, Turkish, Russian, German, Dutch, Polish. ~63MB each; only the
# ones present on disk are advertised, so trimming this list is safe.
RUN mkdir -p models/piper \
 && for v in fa/fa_IR/amir/medium/fa_IR-amir-medium \
             fa/fa_IR/gyro/medium/fa_IR-gyro-medium \
             ar/ar_JO/kareem/medium/ar_JO-kareem-medium \
             tr/tr_TR/dfki/medium/tr_TR-dfki-medium \
             ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium \
             de/de_DE/thorsten/medium/de_DE-thorsten-medium \
             nl/nl_NL/mls/medium/nl_NL-mls-medium \
             pl/pl_PL/darkman/medium/pl_PL-darkman-medium ; do \
      name=$(basename $v) ; \
      curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/piper/$name.onnx \
        https://huggingface.co/rhasspy/piper-voices/resolve/main/$v.onnx \
   && curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/piper/$name.onnx.json \
        https://huggingface.co/rhasspy/piper-voices/resolve/main/$v.onnx.json ; \
    done
ENV PIPER_VOICES_DIR=/app/backend/models/piper

COPY backend/pyproject.toml backend/constraints.txt ./
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./
# One-off maintenance scripts, run with `python -m scripts.<name>`.
COPY backend/scripts ./scripts
# Pinned: this was unpinned, and a rebuild silently upgraded to a mediapipe
# major version with a different runtime dependency, breaking detection on a
# deploy that changed nothing in this repo. constraints.txt pins every other
# library to the versions running in production (see the README, "Pinned
# backend versions"); it restricts versions only, it adds no packages.
RUN pip install --no-cache-dir -c constraints.txt . "mediapipe==1.0.1"
# Widget bundles served at /liveface.js and /liveface-3d.js
COPY --from=embed-build /build/embed/dist /app/embed/dist


EXPOSE 7002
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7002"]
