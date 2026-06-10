# Build prompt: "Liveface" — a production-grade talking-avatar SaaS

Build a full monorepo SaaS that turns a single uploaded photo into a real-time,
lip-syncing talking avatar that can be embedded on any website with one
`<script>` tag. It must run end-to-end with ZERO API keys (graceful fallbacks),
and scale up to real TTS providers, object storage, and Postgres when configured.

## 0. Monorepo layout
```
/backend    FastAPI (async SQLAlchemy 2.0, Alembic, Pydantic v2, pydantic-settings)
/frontend   Vite + React 18 + TypeScript dashboard (Tailwind, TanStack Query,
            react-hook-form + zod, react-i18next en/fr + RTL, dark mode)
/embed      Framework-agnostic embeddable widget + canvas engine (TS, no framework)
/infra      docker-compose (Postgres 16 + MinIO), bucket bootstrap
/Makefile   up/down/migrate/backend/frontend/embed/test (each cd's into a package)
```

## 1. Ports (non-default, to avoid collisions)
backend **7002**, dashboard **5174**, Postgres **7003**, MinIO S3 **7004**,
MinIO console **7005**. Vite proxies /api -> http://localhost:7002.

## 2. Hard requirement: boots with no configuration
- DB defaults to local SQLite (`sqlite+aiosqlite`). Postgres via DATABASE_URL.
- Storage: aioboto3 S3/R2 when R2_* set, else an HMAC-signed local-filesystem
  fallback that mirrors presigned PUT/GET (served by a /storage route). The
  selector keys on `storage_configured = all(R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET)`.
- TTS: a built-in always-on "offline" provider generates deterministic audio +
  viseme cues so preview/embed work with no keys. Real providers appear only
  when configured.
- Rig: when no MediaPipe model (RIG_MODEL_PATH unset), generate a valid synthetic
  478-point frontal mesh so the avatar flow still runs.

## 3. Milestones (implement in order; verify each)

### M0 Scaffold
App factory, CORS, request-id middleware, structured logging, consistent error
envelope `{detail, code}` with typed exceptions (Auth401/Forbidden403/NotFound404/
Conflict409/Validation422/RateLimit429). /health. Themed+translated landing/login shell.

### M1 Auth
User model + migration; bcrypt (passlib); JWT access (15m) + refresh (30d) via
python-jose. Endpoints: register, login (field `username_or_email`), refresh, me.
Frontend: auth store, typed fetch client with transparent one-shot refresh on 401,
protected routing, login/register pages.

### M2 Orgs / members / invitations
Organization, Membership (roles: owner/admin/member), Invitation models+migration.
Org-scoped endpoints enforce membership + role (derive org from the path/resource,
NEVER trust a client-supplied org_id). Token invitations: accept/revoke, last-owner
protection. Frontend: OrgSwitcher+create, responsive AppShell sidebar, MembersPage,
AcceptInvitePage.

### M3 Avatars + storage + rig
Avatar model (status: pending->processing->ready/failed) + migration. Storage
abstraction (presign_put/get, put_bytes/get_bytes/exists/delete). Presigned upload
flow: create -> client PUTs to presigned URL -> confirm /uploaded -> background rig
worker. Rig worker: MediaPipe FaceLandmarker (478 pts + 52 ARKit blendshapes) with
synthetic fallback -> scipy Delaunay triangulation -> 15 Oculus viseme maps +
256px thumbnail; store rig JSON + thumbnail in storage. Frontend: AvatarUploader
(with UPLOAD PROGRESS BAR via XHR), AvatarsPage (skeletons), AvatarDetailPage with
live status polling.

### M4 TTS + canvas preview
Provider abstraction normalized to 15 Oculus visemes. Providers: Azure (native
viseme events), ElevenLabs (char-alignment -> cues), Google (coarse), OpenAI
(audio only), + always-on offline. SpeechCache keyed on sha256(provider,voice,
locale,text). Endpoints /tts/providers|voices|synthesize. Canvas engine in /embed:
textured triangle-mesh warp (see 4), cue-driven lip-sync with amplitude fallback
(Web Audio analyser), blink/sway/breathing, mesh-debug overlay. Dashboard reuses
the engine in AvatarPreview + VoicePicker + speak panel.

### M5 Embed
ApiKey model+migration: sha256-hashed, prefix-indexed, plaintext shown ONCE.
Org-scoped key mgmt (owner/admin). Public key-auth endpoints /embed/v1/avatars/{id}
and /embed/v1/synthesize with Origin/Referer checks vs allowed_domains + per-key
in-memory rate limiting. Auto-bootstrapping `liveface.js`: reads data-avatar/
data-key/data-api attrs, renders canvas, exposes window.Liveface. EmbedSnippet
generator + ApiKeysPage with reveal-once. Sample host page in /embed/example.
IMPORTANT: /embed/* must work cross-origin — path-scoped CORS middleware that
reflects Origin and answers OPTIONS; presigned/local-storage URLs must be ABSOLUTE
(built from PUBLIC_BASE_URL) so a third-party page can load texture/audio.

### M6 Polish
UsageEvent model+migration; meter every synthesis; per-org monthly char limit
(429 usage_limit_reached); /orgs/{id}/usage summary. SettingsPage (org rename,
usage, theme/lang). RTL pass (logical CSS properties, dir at layout root by locale).

## 4. Canvas engine specifics (these were hard-won — implement exactly)
- Warp each mesh triangle by solving the source->dest affine with CRAMER'S RULE
  (the naive derivation is degenerate and draws nothing). Guard |det|<1e-6.
- Texture coords map to the TEXTURE's own naturalWidth/naturalHeight (the
  thumbnail may be scaled), not image_size.
- Frame the face from face_box (expand for forehead/hair+chin, fit in true aspect,
  center). StrictMode-safe: a `destroyed` flag guards mount->unmount->mount.
- Blendshape-driven visemes (rig v3): per-viseme ARKit weights (jawOpen, mouthClose,
  mouthPucker, mouthFunnel, mouthStretch, mouthSmile). 2D deformation basis applied
  to mouth landmarks; derive weights from v1/v2 open/width/round when absent.
- Mouth interior v2: smooth quadratic lip path; ANGLE-SORT the inner-lip ring
  around its centroid (raw index order self-intersects and the clip leaks across
  the face); anatomically fixed-size teeth that hang from the lips (dark gap grows
  with jawOpen, NOT teeth size); gum line; tongue with center groove on open;
  inner-lip contact shadow. Guard: if ring spread is implausible vs mouth box,
  rebuild from mouth_indices. The SYNTHETIC rig must place INNER_LIP_RING on the
  mouth (else the cavity paints across the face).
- Head pose layer (2.5D, no GPU): yaw/pitch via radial-parallax dome
  (depth = 1 - (dx^2+dy^2); nose moves most, rim least); roll about a neck pivot
  below the chin; amplitudes scale with smoothed speech "energy"; gentle nods on a
  loose cadence while speaking. Brow layer: lift canonical MediaPipe brow rows
  inner->outer on eased sin pulses (idle micro-expressions + emphasis while speaking)
  + rest browInnerUp. Eased (sin-curve) blinks.

## 5. Streaming speech + multilingual (enhancements)
- /embed/src/speech.ts: multilingual sentence splitter (Latin . ! ? ; … plus CJK
  。！？ Arabic ؟ Devanagari ।, newlines; hard-wrap >220 chars; merge tiny frags)
  and a prefetching speech queue: synth(chunk N+1) runs WHILE chunk N plays, so
  long text starts in first-sentence latency. Cancellable (generation counter).
  engine.playAudio gains an onEnd callback; abort during stop() must NOT surface as
  an error.
- Widget: Liveface.speak (chunked), Liveface.stop(), Liveface.isSpeaking(),
  Liveface.listen({lang}), Liveface.sttSupported(). Dashboard speak panel: Stop
  button + mic dictation button.
- char_to_viseme must animate non-Latin text: strip diacritics (é/ü/ñ), map
  Cyrillic + Arabic to phonetic viseme classes, deterministic CJK/Devanagari
  rotation. Never freeze at "sil" for real letters; punctuation stays "sil".
- STT = browser Web Speech API (free, ~60 langs, partial transcripts). Graceful
  unsupported path (Firefox). Optional Whisper provider behind the same interface
  for privacy/Firefox/server-side.

## 6. Dashboard-managed provider keys (enhancement)
provider_credentials table (global, encrypted at rest with Fernet; master key from
CREDENTIAL_ENCRYPTION_KEY, else derived from JWT_SECRET). In-memory overlay layered
over env settings (DB wins); loaded at startup, reloaded on write — so keys take
effect with no restart. Providers read credentials.get("...") not settings.X.
Endpoints GET/PUT /integrations + POST /integrations/{provider}/test, gated to
org owners; secrets WRITE-ONLY (return masked "••••1234" + source db|env|unset).
Google accepts pasted service-account JSON OR a file path. Frontend: Settings ->
"Voice providers" card with per-provider fields + Test button.

## 7. Stock avatar gallery (enhancement)
6+ bundled stylized portraits drawn to the synthetic rig's exact facial
proportions (a generator script). GET /stock-avatars (+ public image route),
POST /orgs/{id}/avatars/from-stock copies the image into storage and enqueues the
normal rig worker. Frontend gallery on the New Avatar page; one-click create.

## 8. Avatar-prep UX (enhancement)
Step indicator (detect -> mesh+visemes -> preview) + elapsed seconds + stall
detection at 60s with a Retry button that re-enqueues the rig job.

## 9. Config pitfalls to encode as requirements
- pydantic-settings JSON-decodes list fields from .env BEFORE validators; annotate
  CSV list fields (cors_origins, allowed_image_types) with `Annotated[list[str],
  NoDecode]` so `CORS_ORIGINS=a,b` parses (otherwise settings construction crashes).
- Tests must be deterministic regardless of a developer .env: in conftest, force
  the local-storage fallback (null R2_*, clear get_storage cache).
- 204 routes: no `-> None` return annotation (FastAPI assertion).
- Provide .env.example documenting every knob.

## 10. Quality bar / acceptance
- Full backend pytest suite green (~60+ tests): auth, orgs/roles, avatars, rig
  pipeline, TTS+cache, embed (key auth, origin checks, rate limit), usage limits,
  integrations (encrypted-at-rest assertion), stock flow, multilingual viseme,
  config CSV parsing.
- `tsc -b` clean for frontend and embed.
- Verified in a real browser: avatar renders non-blank; speaking animates mouth
  with teeth/tongue contained within lips; idle head drifts; chunked long text
  chains seamlessly; Stop works; cross-origin embed loads on a separate-origin page.

## 11. Production-hardening backlog (state, don't skip silently)
1. Move in-memory state (credential overlay, rate limiter, speech cache) to Redis
   — required before running >1 worker.
2. Replace BackgroundTasks rig jobs with a real queue (RQ/Celery) + a stuck-job
   sweeper (avatars must not hang in "processing" after a restart).
3. Revocable refresh tokens (server-side session table).
4. CI (GitHub Actions running the test suite on push).
5. Rate-limit auth endpoints (login/register), not just the embed API.
6. Set RIG_MODEL_PATH in any real deployment (synthetic rig looks wrong on photos).

## 12. Next quality tier (optional, leapfrogs SitePal)
Neural render path as another provider: SadTalker/Wav2Lip-class photo animation via
a serverless GPU (Replicate, ~$0.02/clip) for CACHEABLE phrases (render once ->
store MP4 -> serve forever), keeping the real-time canvas engine for live speech.
No GPU owned; app still runs GPU-free when the provider is unconfigured.
