# Liveface

Turn a single uploaded photo into a real-time, lip-syncing talking avatar that
embeds on any website with one `<script>` tag.

```
/backend    FastAPI · async SQLAlchemy 2.0 · Alembic · Pydantic v2
/frontend   Vite · React 18 · TypeScript · Tailwind · TanStack Query · i18n (en/fr + RTL)
/embed      Framework-agnostic widget + canvas engine (TS, zero deps)
/infra      docker-compose: Postgres 16 + MinIO (both optional)
```

## Quickstart (zero configuration)

No API keys, no Docker, no .env needed — SQLite, local-file storage, and the
built-in offline TTS provider cover everything out of the box.

```bash
# Backend (Python 3.12 via uv)
cd backend
uv venv --python 3.12 .venv && uv pip install -p .venv/bin/python -e '.[dev]'
cd .. && make backend          # http://localhost:7002

# Frontend (new terminal)
cd frontend && npm install
cd .. && make frontend         # http://localhost:5174

# Embed widget bundle (served by the backend at /liveface.js)
cd embed && npm install && cd .. && make embed
```

Then: register → an org is created for you → **New avatar** → upload a photo,
pick a stock avatar, or import a **3D model** (.glb with ARKit blendshapes or
viseme morphs — e.g. an Avaturn export) → it rigs in seconds → open it and
press **Speak**. 3D avatars render with Three.js (sculpted visemes, real head
bones, eyelid blinks); the widget lazy-loads the 3D bundle only when needed.

## Embedding on any site

Create an API key (API keys page), then:

```html
<script
  src="https://your-api.example.com/liveface.js"
  data-avatar="AVATAR_ID"
  data-key="lf_..."
  data-api="https://your-api.example.com"
></script>
<script>
  Liveface.speak("Hello! Long text streams sentence by sentence.");
  // Liveface.stop(), Liveface.isSpeaking(), Liveface.listen({lang}), Liveface.sttSupported()
</script>
```

A sample third-party host page lives at `embed/example/index.html`
(serve it from any other origin to exercise the cross-origin path).

## Scaling up (all optional)

| Concern   | Default            | Configured                                          |
|-----------|--------------------|-----------------------------------------------------|
| Database  | SQLite             | `DATABASE_URL=postgresql+asyncpg://…` (`make up` for local Postgres on :7003) |
| Storage   | Local files + HMAC-signed URLs | `R2_*` env vars (R2/S3/MinIO on :7004)  |
| TTS       | Offline provider   | Azure / ElevenLabs / Google / OpenAI — keys via env or Settings → Voice providers (encrypted at rest, hot-reloaded) |
| Face rig  | Synthetic 478-pt mesh | `RIG_MODEL_PATH` → MediaPipe FaceLandmarker (478 pts + 52 blendshapes) |

Every knob is documented in [backend/.env.example](backend/.env.example).
Ports: API **7002**, dashboard **5174**, Postgres **7003**, MinIO **7004**/**7005**.

## Development

```bash
make test        # backend pytest suite (102 tests)
make typecheck   # tsc -b for frontend + embed
make migrate     # alembic upgrade head (per-milestone migrations)
```

## Production-hardening backlog (known, deliberate)

1. Move in-memory state (credential overlay, embed rate limiter) to Redis —
   required before running more than one worker.
2. Replace `BackgroundTasks` rig jobs with a real queue (RQ/Celery) + a
   stuck-job sweeper so avatars can't hang in `processing` after a restart.
3. Revocable refresh tokens (server-side session table).
4. CI running the test suite on push.
5. Rate-limit auth endpoints (login/register), not just the embed API.
6. Set `RIG_MODEL_PATH` in any real deployment — the synthetic rig looks
   wrong on real photos.

## Next quality tier

A neural render provider (SadTalker/Wav2Lip-class via a serverless GPU,
~$0.02/clip) for cacheable phrases — render once, store the MP4, serve
forever — while the canvas engine keeps handling live speech for free.
