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

# mediapipe needs OpenCV runtime libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./
RUN pip install --no-cache-dir . mediapipe
# Widget bundles served at /liveface.js and /liveface-3d.js
COPY --from=embed-build /build/embed/dist /app/embed/dist

# MediaPipe FaceLandmarker model for real photo rigging.
RUN mkdir -p models && curl -fsSL -o models/face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
ENV RIG_MODEL_PATH=/app/backend/models/face_landmarker.task

EXPOSE 7002
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7002"]
