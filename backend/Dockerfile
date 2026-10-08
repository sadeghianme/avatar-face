# Liveface API image. Build context = repo root:
#   docker build -f backend/Dockerfile .
# Multi-stage: node builds the embed widget bundles; python runs the API.
#
# Base images are pinned by digest (the tag says what it is, the digest makes
# a rebuild get the same bytes); docs/process.md says how to move them.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS embed-build
WORKDIR /build/embed
COPY embed/package.json embed/package-lock.json ./
RUN npm ci
COPY embed/ ./
RUN npm run build

FROM python:3.12-slim-trixie@sha256:ddb0207ae1f0356c2b724d740769b0c5f5f51cc54a0525178f721825f78fe74c
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
# repository, so a code change must not re-download ~850MB of them (it did,
# on every deploy, until the host's address was rate limited by GitHub and a
# deploy failed on a 503). Every download retries with a delay for the same
# reason.
#
# Every file is checked against a SHA-256 taken when it was pinned: a model
# replaced upstream fails the build instead of quietly changing what every
# avatar is measured or voiced with. Moving a pin: docs/process.md.

# MediaPipe FaceLandmarker (3.6MB) and the selfie segmenter (244KB).
# Versioned URLs, not /latest/: every stored rig was measured by this exact
# model, and a silently replaced one would move the points of every
# re-detection.
RUN mkdir -p models \
 && curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task \
 && curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/selfie_segmenter.tflite \
    https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite \
 && printf '%s\n' \
    "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  models/face_landmarker.task" \
    "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b  models/selfie_segmenter.tflite" \
    | sha256sum -c -
ENV RIG_MODEL_PATH=/app/backend/models/face_landmarker.task
ENV SEGMENT_MODEL_PATH=/app/backend/models/selfie_segmenter.tflite

# Kokoro-82M local TTS (Apache-2.0): one consistent server voice with no key,
# no per-character bill, and no text leaving the instance. The model is
# 310MB and the voices 27MB, from the model-files-v1.0 release.
RUN curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/kokoro-v1.0.onnx \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx \
 && curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/voices-v1.0.bin \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin \
 && printf '%s\n' \
    "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5  models/kokoro-v1.0.onnx" \
    "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d  models/voices-v1.0.bin" \
    | sha256sum -c -
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
# then Arabic, Turkish, Russian, German, Dutch, Polish. ~63MB each (Dutch
# 77MB); only the ones present on disk are advertised, so trimming this list
# is safe (drop its two checksum lines with it). Read from one revision of the
# rhasspy/piper-voices repository, not `main`: the same files `main` serves
# (none of these changed since 2024), but a revision cannot move.
RUN set -e; rev=c10ece1aade47bb51c153c893d14e5bf8e5b7117; mkdir -p models/piper; \
    for v in fa/fa_IR/amir/medium/fa_IR-amir-medium \
             fa/fa_IR/gyro/medium/fa_IR-gyro-medium \
             ar/ar_JO/kareem/medium/ar_JO-kareem-medium \
             tr/tr_TR/dfki/medium/tr_TR-dfki-medium \
             ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium \
             de/de_DE/thorsten/medium/de_DE-thorsten-medium \
             nl/nl_NL/mls/medium/nl_NL-mls-medium \
             pl/pl_PL/darkman/medium/pl_PL-darkman-medium ; do \
      name=$(basename $v) ; \
      curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/piper/$name.onnx \
        https://huggingface.co/rhasspy/piper-voices/resolve/$rev/$v.onnx ; \
      curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o models/piper/$name.onnx.json \
        https://huggingface.co/rhasspy/piper-voices/resolve/$rev/$v.onnx.json ; \
    done; \
    printf '%s\n' \
    "fb815380d969ea372b0b21b0de14421f58fe481047e153e69685d079b6e1a9d1  models/piper/fa_IR-amir-medium.onnx" \
    "75f918a3bf0f57a9179abe725af529f2a5c79d6c899e2a84aec76c685d5dfb9a  models/piper/fa_IR-amir-medium.onnx.json" \
    "37dfae43c82ee38ca9e6aac4ffef76a74d6b282ccbc397b27761f35d355c99ba  models/piper/fa_IR-gyro-medium.onnx" \
    "4cd0ca01824b460f490224e284f9b68ecf07f91f3c654ba3bce59d4eb7646082  models/piper/fa_IR-gyro-medium.onnx.json" \
    "9e95cab07b679da603bba17c4dec7ab3111320571964ee95c0379603c086491e  models/piper/ar_JO-kareem-medium.onnx" \
    "ea6d9b9d9076dbdb6bf5c98c6a141ef154959d2359709b37855727964e7d6c4d  models/piper/ar_JO-kareem-medium.onnx.json" \
    "2844717f524ab965d3fe86e60562cbb601d3e456836efcc2196cc3a14112a8fb  models/piper/tr_TR-dfki-medium.onnx" \
    "13ebd7810f1b61b5027583cf3131a0a233b6ea81c38f2200ebc4ff41c3cca039  models/piper/tr_TR-dfki-medium.onnx.json" \
    "f073356ebc4bd0f80c5af58df2953a5988bd5bdab1eb38635ce960b071fbefcb  models/piper/ru_RU-dmitri-medium.onnx" \
    "667ef3117bc642c2892dff7690d8bdc8ca4228aeaa783b2dc1416df632855e0d  models/piper/ru_RU-dmitri-medium.onnx.json" \
    "7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819  models/piper/de_DE-thorsten-medium.onnx" \
    "974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85  models/piper/de_DE-thorsten-medium.onnx.json" \
    "88312e0fbf505b87caf2373d94c1384892e86b1bf2ee482cf65dc8ba179cc7d3  models/piper/nl_NL-mls-medium.onnx" \
    "6ddb215d38f1392ab935ad45441b82ada1eeae0452a2d6849ed71ea4f2e0aa63  models/piper/nl_NL-mls-medium.onnx.json" \
    "db505438a5364e8e2e0242c4324130a873ed660dfbe8d9689cef428ffb1b645f  models/piper/pl_PL-darkman-medium.onnx" \
    "70f999f11fa8ad13d3ef779041ee93c9f38be5abdbacdfad42449712fe91c81b  models/piper/pl_PL-darkman-medium.onnx.json" \
    | sha256sum -c -
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
# library to the versions running in production (see docs/process.md,
# "Dependency pins"); it restricts versions only, it adds no packages.
RUN pip install --no-cache-dir -c constraints.txt . "mediapipe==1.0.1"
# Widget bundles served at /liveface.js and /liveface-3d.js
COPY --from=embed-build /build/embed/dist /app/embed/dist

# The commit this image was built from (deploy/deploy.sh passes it). Last,
# so a new commit rebuilds only these metadata layers: /health reports it,
# the label lets `docker inspect` and a rollback say which release an image is.
ARG LIVEFACE_VERSION=dev
ENV LIVEFACE_VERSION=$LIVEFACE_VERSION
LABEL org.opencontainers.image.revision=$LIVEFACE_VERSION \
      org.opencontainers.image.source=https://github.com/sadeghianme/avatar-face

EXPOSE 7002
# --no-proxy-headers: uvicorn must not rewrite the peer from X-Forwarded-For.
# The application works out the client's address itself, from the peer
# outward through the proxies it is told to trust (app/core/client_ip.py,
# TRUSTED_PROXIES and TRUST_CLOUDFLARE in deploy/docker-compose.prod.yml),
# and needs the real peer to start from.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7002", "--no-proxy-headers"]
