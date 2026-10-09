# Liveface

Turn a single uploaded photo into a real-time, lip-syncing talking avatar that
embeds on any website with one `<script>` tag. Live at
[avatar.mehdisadeghian.com](https://avatar.mehdisadeghian.com).

## Layout

```
backend/    API: FastAPI · async SQLAlchemy 2 · Alembic · Pydantic v2 (Python 3.12)
            MediaPipe face landmarks, Kokoro and Piper speech, espeak-ng phonemes
frontend/   Dashboard: Vite · React 18 · TypeScript · Tailwind · TanStack Query ·
            react-router · i18next (en/fr, right-to-left ready); served by nginx
embed/      The widget (/liveface.js) and its engines: Canvas 2D / WebGL photo
            warp, three.js for 3D models. The dashboard imports it from source
deploy/     deploy.sh (release, rollback), the production compose file,
            the database backup, smoke tests of the built images (smoke/)
infra/      docker compose for optional local Postgres 16 + MinIO
docs/       process (release, rollback, CI, pins, security headers),
            frontend-ui (the UI kit and lint rules), engine and lab write-ups
.github/    CI (workflows/ci.yml), Dependabot
```

`system-design.md` is the architecture overview (diagram:
`docs/system-design.svg`); `LIVEFACE_BUILD_PROMPT.md` is the original build
brief, kept for history.

## Run it locally

No API keys, no Docker and no `.env` are needed: SQLite, local-file storage
and the built-in offline speech provider cover everything. Python 3.12 (via
[uv](https://docs.astral.sh/uv/)) and Node 22 or newer.

```bash
# API on http://localhost:7002
cd backend
uv venv --python 3.12 .venv
uv pip install -p .venv/bin/python -c constraints.txt -e '.[rig,dev]'
cd .. && make backend

# Dashboard on http://localhost:5174 (proxies /api to :7002)
npm ci --prefix embed && npm ci --prefix frontend
make frontend

# The widget bundle the API serves at /liveface.js
make embed
```

Then register (an organization is created for you), **New avatar**, upload a
photo or import a 3D model (`.glb` with ARKit blendshapes or viseme morphs),
open it and press **Speak**.

Optional, for production behaviour locally: `brew install espeak-ng` (phonemes
for non-English lip-sync), and model files pointed to by `RIG_MODEL_PATH`,
`KOKORO_MODEL_PATH`, `PIPER_VOICES_DIR` (the URLs are in `backend/Dockerfile`;
without a face model the rig falls back to a synthetic mesh). Every setting is
in [backend/.env.example](backend/.env.example).

Ports: API **7002**, dashboard **5174**, Postgres **7003**, MinIO
**7004**/**7005** (`make up`).

## Tests and checks

What CI runs, per package (`.github/workflows/ci.yml`):

| Package | Commands (from the package directory) |
|---|---|
| backend | `ruff check .` · `ruff format --check .` (`ruff format .` fixes it) · `pyright` · the OpenAPI document re-exported and compared (`python -m scripts.export_openapi`) · migrations against the models (`alembic upgrade head` then `alembic check`, on an empty SQLite) · `python -m pytest tests -q -n auto --cov` (or `make test` without coverage, `make coverage` with it, from the root) |
| embed | `npm run lint` · `npm run format:check` · `npm run typecheck` (sources and tests) · `npm run check:api` (generated API types) · `npm run test:coverage` (vitest, pixel goldens included, with coverage; `npm test` without) · `npm run build` · `npm run test:browser` (Chromium) |
| frontend | `npm run check` (feature boundaries, en/fr parity) · `npm run lint` · `npm run format:check` · `npm run typecheck` (app and tests) · `npm run check:api` (generated API types) · `npm run test:coverage` (`node --test` with coverage, Node 22+; `npm test` without) · `npm run test:ui:coverage` (rendering tests with coverage; `npm run test:ui` without) · `npm run build` (type check + bundle) |
| deploy | `deploy/test-deploy.sh` (every gate of `deploy.sh`) · ShellCheck on `deploy/*.sh` |
| images | both Dockerfiles build, boot and pass `deploy/smoke/web-sweep.mjs`: every page in headless Chrome, zero CSP violations ([docs/process.md](docs/process.md#ci)) |

CI runs on every push to main and every pull request; a newer push cancels the
run it supersedes. The backend runs as three parallel jobs: its checks, and
its tests in two halves; a fourth combines the halves' coverage. The required
`backend` check passes only when all four do ([docs/process.md](docs/process.md#ci)).

### Coverage

Every suite is measured, and CI fails a change that takes one below its
floor: the value CI measured minus 1 to 2 points. Measured on 2026-10-09:
the backend 92.0% (lines and branches together; floor 91), the widget 90.1%
of lines (floor 89), the dashboard's unit tests 93.4% of the lines they load
(floor 92) and its rendering tests 65.2% of the whole app (floor 64), with
floors on branches and functions too. The floors are in
`backend/.coveragerc`, `embed/vitest.config.ts`, `frontend/vitest.config.ts`
and the `test:coverage` script of `frontend/package.json`. When a change
raises a number, raise its floor in the same pull request (measured value
minus 1, rounded down); never lower one to make a change pass. The HTML and
LCOV reports are artifacts of every CI run, kept 7 days. Details:
[docs/process.md](docs/process.md#coverage).

## Embedding on any site

Create an API key (API keys page), then:

```html
<script
  src="https://avatar.mehdisadeghian.com/api/liveface.js"
  data-avatar="AVATAR_ID"
  data-key="lf_..."
  data-api="https://avatar.mehdisadeghian.com/api"
></script>
<script>
  Liveface.speak("Hello! Long text streams sentence by sentence.");
  // Liveface.stop(), Liveface.isSpeaking(), Liveface.listen({lang}), Liveface.sttSupported()
</script>
```

`window.Liveface` appears once the widget is up (or has failed, when its calls
answer quietly). With several widgets on one page, `Liveface.speak()` and the
rest act on the **first widget to come up**, and each widget has its own handle
with the same calls: `Liveface.get("AVATAR_ID")` (or its canvas, or its script
tag), `Liveface.all()`, or `event.detail` of its `liveface:ready` event, which
fires on its canvas (bubbling) and on its script tag:

```html
<script id="guide" src="…/liveface.js" data-avatar="GUIDE_ID" data-key="lf_…"></script>
<script>
  document.getElementById("guide").addEventListener("liveface:ready", (e) => e.detail.speak("Hi!"));
</script>
```

The dashboard's **Simulator** runs a pasted snippet in a clean frame. A sample
third-party page is `embed/example/index.html` (serve it from another origin to
exercise the cross-origin path). An avatar's share link (`/s/<token>`) is a
public page that may be framed by any site.

## Deploy and roll back

```bash
deploy/deploy.sh --dry-run    # every check, then what would ship
deploy/deploy.sh              # ship HEAD: clean tree, pushed to origin/main, CI green on it
deploy/deploy.sh --rollback   # put back the release that was live before
```

A deploy ships `git archive` of one commit, never the working tree, bakes the
commit into both images, backs up the database first, and finishes only when
`/api/health` and `/version.json` report that commit. The whole release path,
branch protection, rollback with a database restore, and how every pin is
moved: [docs/process.md](docs/process.md).

## Scaling up (all optional)

| Concern | Default | Configured |
|---|---|---|
| Database | SQLite | `DATABASE_URL=postgresql+asyncpg://…` (`make up` for local Postgres on :7003) |
| Storage | Local files + HMAC-signed URLs | `R2_*` env vars (R2/S3/MinIO on :7004) |
| Speech | Offline provider; Kokoro and Piper when their models are present | Azure / ElevenLabs / Google / OpenAI: keys via env or Settings → Voice providers (encrypted at rest, hot-reloaded) |
| Face rig | Synthetic 478-point mesh | `RIG_MODEL_PATH` → MediaPipe FaceLandmarker (478 points + 52 blendshapes) |

## Known limits (deliberate, for now)

1. In-memory state (credential overlay, rate limiters, job runner): one API
   process only. More workers need Redis and a real queue.
2. Refresh tokens cannot be revoked yet (no server-side session table).
3. Rate limits are kept per process (item 1), keyed on the visitor's own
   address behind Cloudflare ([docs/process.md](docs/process.md#client-addresses)):
   everyone behind one carrier-grade NAT shares a bucket.
4. The session's tokens are in `localStorage`, not httpOnly cookies. The CSP
   allows no inline script, and the Simulator runs snippets in a frame of its
   own origin ([docs/process.md](docs/process.md#security-headers)).
