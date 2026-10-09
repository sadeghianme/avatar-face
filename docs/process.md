# Process: releasing, protecting main, moving pins

How a change reaches avatar.mehdisadeghian.com, how to undo it, and how the
pinned versions behind it are moved. The scripts are the source of truth:
`deploy/deploy.sh` (its header lists every option), `deploy/test-deploy.sh`
and `.github/workflows/ci.yml`.

## Release path

```
branch ──PR──▶ CI green ──merge──▶ CI green on main ──▶ deploy.sh <commit> ──▶ verified ──(if needed)──▶ deploy.sh --rollback
```

1. **Branch and pull request.** `git switch -c <topic>`, commit, `git push -u
   origin <topic>`, `gh pr create --fill`. CI runs every job on the pull
   request (table below).
2. **Merge when green.** Branch protection (below) refuses the merge until
   every job passes and the branch is up to date with main.
3. **CI on main.** The merge is a push to main, and CI runs again on that exact
   commit. `deploy.sh` accepts only a commit whose *own* push run on main
   succeeded: a pull request's run tested a merge commit, not this tree.
   `gh run watch` follows it.
4. **Deploy.** From a clean checkout of main at that commit:

   ```bash
   git switch main && git pull --ff-only
   deploy/deploy.sh --dry-run    # every check, then what would ship; contacts no server
   deploy/deploy.sh              # or: deploy/deploy.sh --ref <commit on origin/main>
   ```

5. **Verified by the script, not by eye.** The deploy ends only when
   `https://avatar.mehdisadeghian.com/api/health` and `/version.json` both report
   the commit it built, then prints the alembic revision, row counts and a
   summary. Embedding sites cache the widget for up to 4 hours: hard-refresh one
   to see a widget change.
6. **Roll back** if anything looks wrong: `deploy/deploy.sh --rollback`
   ([Rollback](#rollback)).

### What deploy.sh refuses

Before anything leaves the machine:

| Exit | Refused because | What to do |
|---|---|---|
| 2 | unknown option, or `--ref` is not a commit | `deploy/deploy.sh --help` |
| 3 | the working tree has changes | commit and push them (and wait for CI), or stash them |
| 4 | the commit is not on `origin/main` | push it; CI must run on it first |
| 5 | the commit's own `ci` run on main is still running, failed, was cancelled, or never ran | wait (`gh run watch`), fix, or deploy the newest pushed commit |
| 6 | a tool is missing (`git`, `gh`, `rsync`, `ssh`, `curl`, `tar`) | install it; `gh auth status` must be logged in |

Uncommitted files under `frontend/public/brand/` are the one exception to exit
3: the owner keeps brand experiments there. They are listed as *not shipped*
and never are, because what ships is `git archive <commit>`, not the working
tree. Every gate is tested in CI by `deploy/test-deploy.sh` (a scratch
repository with a stub `gh`).

### What a deploy does on the server

1. `rsync --delete` the exported commit to `/root/projects/liveface`. The
   excludes (`.env`, databases, `backend/local_storage`, …) only protect
   server-side files from `--delete`; `deploy/.env` exists only there.
2. Refuse to continue if `deploy/.env` is missing or empty.
3. Back up the live SQLite database with `VACUUM INTO` (`deploy/backup_db.py`:
   one consistent snapshot through the WAL, compacted, so free pages are not
   copied) to `/data/liveface.sqlite3.bak-<stamp>` and keep the newest 10
   (`BACKUP_KEEP=<n>` to change). The backups hold the database only: the
   files in storage (pictures, rigs, the speech cache) are not in them.
4. Tag the last verified release (`:release`) as `:previous`, for `--rollback`.
5. `LIVEFACE_VERSION=<commit> docker compose -f docker-compose.prod.yml up -d --build`.
   The commit is baked into both images: `ENV LIVEFACE_VERSION` and the
   `org.opencontainers.image.revision` label in the API, `/version.json` and
   the label in the dashboard. Compose replaces no container until both images
   build, so a failed build leaves the old release serving.
6. Wait up to 5 minutes for `/api/health` to report the commit, then check
   `/version.json`; only then tag the new images `:release`.

Migrations run when the API container starts (`app/main.py`, `_ensure_schema`).
A migration that fails crash-loops the new container: roll back.

### Emergencies: `--skip-ci-check`

Ships a pushed commit without a green CI run, behind a banner, and records
"SKIPPED" in the summary. Everything else still applies: a clean tree, a commit
on `origin/main`, the version check after the restart. Afterwards, watch that
commit's own run finish (`gh run watch`) or re-run it if it failed for a
reason outside the code (`gh run rerun <id>`), and roll back if it stays red.

## Rollback

```bash
deploy/deploy.sh --rollback --dry-run   # what it would do
deploy/deploy.sh --rollback
```

Re-tags `:previous` as `:latest` for both images, restarts them without
building, and waits until `/api/health` reports the previous release's commit
(read from its image label). `:previous` is always the last release a deploy
*verified*, so a deploy that failed its checks never becomes the target. One
step back only: for anything older, deploy that commit again with
`deploy/deploy.sh --ref <commit>` (it rebuilds; the model layers are cached).

The database is not touched. If the release being undone ran a migration, the
older code now runs on the newer schema, which migrations are written to allow
(028 keeps the old speech table for this). A release from backend round 3 on
starts on a database a newer release migrated: it logs that it does not know
the revision and serves (`app/main.py`, `_ensure_schema`). A release before it
runs `alembic upgrade` at startup and stops on the unknown revision, so stamp
the database back to that release's last migration first, while the newer
release is still running. Rolling back over 028 to the release before it:

```bash
ssh personal_server "docker exec -w /app/backend -e PYTHONPATH=/app/backend \
  liveface-liveface-api-1 alembic stamp 027_scene"
deploy/deploy.sh --rollback
```

The next deploy runs 028 again (it is written to be re-run). If the older code
cannot run on the newer schema at all, restore the backup the deploy took
just before that release (its path is in that deploy's summary):

```bash
ssh personal_server
docker volume ls | grep liveface_data            # liveface_liveface_data
docker stop liveface-liveface-api-1
docker run --rm -v liveface_liveface_data:/data alpine sh -c '
  cp /data/liveface.sqlite3 /data/liveface.sqlite3.before-restore &&
  cp /data/liveface.sqlite3.bak-<stamp> /data/liveface.sqlite3 &&
  rm -f /data/liveface.sqlite3-wal /data/liveface.sqlite3-shm'
docker start liveface-liveface-api-1
```

The `-wal` and `-shm` files must go with the old database: left beside the
restored file, SQLite would replay the newer log onto it.

## CI

`.github/workflows/ci.yml` runs on every push to main and every pull request. A
newer push to the same branch or pull request cancels the run it supersedes.

**The API contract.** `frontend/src/lib/api-schema.json` is the OpenAPI
document, and `backend/scripts/export_openapi.py` its only generator
(`python -m scripts.export_openapi` from `backend/`, or `npm run api:schema`).
The dashboard generates `src/lib/api-types.ts` from it (`npm run gen:api`), the
widget `embed/src/api-types.ts` (`npm run gen:api` in `embed/`). A change to
the API is therefore three files in one pull request: export, then generate
in both packages; CI fails on any of them left behind.

**The backend is four jobs**, and `backend` stands for them:

- `backend-checks`: everything but the tests. That is `ruff check`, `ruff format
  --check`, `pyright`, the OpenAPI document, and the migrations against the
  models. The migration check builds an empty SQLite with `alembic upgrade
  head` and runs `alembic check`, which compares tables, columns, types,
  nullability, indexes and foreign keys. It then takes the newest migration
  down and up again and checks once more. Production migrates when the API
  starts, but the tests build their schema from the models, so this step is
  the only one that catches a model change committed without its migration.
- `backend-tests (1)` and `(2)`: the suite in two halves. Each test belongs to
  exactly one half (`LIVEFACE_TEST_SHARD=<k>/<n>`, a CRC of its id;
  `tests/conftest.py`), and each half runs on every core of its runner
  (`pytest -n auto`). Every pytest-xdist worker has its own database and
  storage, so a test must write only under `tmp_path`. Each half runs with
  coverage and uploads its data file.
- `backend-coverage`: after both halves, combines their coverage data and
  holds it to the floor ([Coverage](#coverage)).
- `backend`: the required check. It needs the other four and fails unless
  all four succeeded. It runs `if: always()`, because a required check that
  is skipped counts as passed.

The virtualenv is cached, keyed on the Python version, `constraints.txt` and
`pyproject.toml`. The MediaPipe models are cached, keyed on their checksums,
and checked with `sha256sum` whether they were fetched or restored. No test
loads them yet. The one that would rebuild the reference manifest from the
masters with MediaPipe (`test_performance_kit.py`) runs only when
`LIVEFACE_FACE_MODEL` names a `face_landmarker.task`. It compares bytes with
the committed manifest, and the manifest rebuilt on CI's Linux runner does not
match.

The same checks from `backend/`, before pushing:

```bash
ruff check . && ruff format --check .    # `ruff format .` fixes the second
pyright
rm -f /tmp/m.sqlite3 && DATABASE_URL=sqlite+aiosqlite:////tmp/m.sqlite3 \
  sh -c 'alembic upgrade head && alembic check && alembic downgrade -1 && alembic upgrade head'
python -m pytest tests -q -n auto        # or `make test` from the root
python -m pytest tests -q -n auto --cov --cov-report=term   # with the floor: `make coverage`
```

Formatting is `ruff format` (`[tool.ruff.format]` in `backend/pyproject.toml`).
It is Black's style at line length 100, with double quotes, and a trailing
comma keeps one item per line. Hand-laid data tables stay between `# fmt: off`
and `# fmt: on`. The commit that formatted the backend is in
`.git-blame-ignore-revs`; locally, `git config blame.ignoreRevsFile
.git-blame-ignore-revs`. The dashboard and the widget use Prettier
(`npm run format:check`).

| Job | What it proves | Time |
|---|---|---|
| `backend-checks` | ruff (lint and format), pyright, the OpenAPI document exported again and identical to the committed one, the migrations against the models and the newest one down and up | ~1 min |
| `backend-tests` (×2) | pytest with coverage, half of the suite each, on every core, against the production pins, espeak-ng and the checksummed MediaPipe models | 3–5 min |
| `backend-coverage` | the two halves' coverage combined, at or above the floor; the HTML and LCOV report uploaded | ~20 s |
| `backend` | every backend job above passed (the required check) | seconds |
| `embed` | lint, type check (tests included), the widget's generated API types match the committed document, vitest with the pixel goldens and coverage at or above its floors, build, the browser tests | ~2.5 min |
| `frontend` | type check, the unit tests (node --test) and the rendering tests (Vitest), each with coverage at or above its floors, structure check, production build | ~1 min |
| `frontend-lint` | ESLint (UI kit and data-layer rules), Prettier, the dashboard's generated API types match the committed document | <1 min |
| `deploy-script` | ShellCheck (pinned) on `deploy/*.sh`; every gate of `deploy.sh` | <1 min |
| `images` | both production images build (every model checksum, `nginx -t`), boot, report the commit, and all 22 page visits load in headless Chrome with zero CSP violations (the Simulator injection replayed among them) | ~4 min |

The `images` job's browser sweep (`deploy/smoke/web-sweep.mjs`) seeds a user, a
photo avatar, a 3D avatar and a share link through the API, speaks on the share
page, runs the real widget in the Simulator for both avatars and speaks there,
and replays the Simulator injection (N1) as a link and as a paste. To run it
against images built locally:

```bash
docker build -f backend/Dockerfile --build-arg LIVEFACE_VERSION=local -t liveface-api:local .
docker build -f frontend/Dockerfile --build-arg LIVEFACE_VERSION=local -t liveface-web:local .
docker run -d --name lf-api -p 127.0.0.1:7092:7002 --tmpfs /data \
  -e JWT_SECRET=local-only -e PUBLIC_BASE_URL=http://127.0.0.1:7090/api \
  -e APP_BASE_URL=http://127.0.0.1:7090 -e CORS_ORIGINS=http://127.0.0.1:7090 \
  -e DATABASE_URL=sqlite+aiosqlite:////data/liveface.sqlite3 -e LOCAL_STORAGE_DIR=/data/storage \
  liveface-api:local
docker run -d --name lf-web -p 127.0.0.1:7091:80 liveface-web:local
node deploy/smoke/proxy.mjs 7090 http://127.0.0.1:7091 http://127.0.0.1:7092 &
node deploy/smoke/web-sweep.mjs http://127.0.0.1:7090      # Node 22+, Chrome installed
```

Use `127.0.0.1`, not `localhost`: the dashboard points snippets at
`localhost:7002` whenever its origin says localhost (the Vite dev setup).

## Coverage

Every test suite runs with coverage in CI, and a change that takes a suite
below its floor fails the package's required check. A floor is the value CI
measured, minus 1 to 2 points: enough margin for a run that takes another
path through a timing-dependent branch, small enough to catch a change that
lands code without tests. It is a ratchet: raised when coverage rises, never
lowered to make a change pass.

Measured in CI on 2026-10-09 (percent, measured → floor):

| Suite | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| backend, pytest (`app/`) | 93.68 | 84.30 | n/a | n/a |
| embed, vitest | 90.11 → **89** | 89.93 → **88** | 87.92 → **86** | 90.11 → **89** |
| frontend, node --test | 93.38 → **92** | 94.72 → **93** | 89.74 → **88** | n/a |
| frontend, Vitest (`test:ui`) | 65.22 → **64** | 78.27 → **77** | 70.39 → **69** | 65.22 → **64** |

The backend has one floor, on its total (lines and branches counted
together): 92.00 → **91**.

What each number counts:

- **backend**: lines and branches of `app/` (branch coverage on), the two
  halves of `backend-tests` combined; the floor is on coverage.py's
  "TOTAL". Measured with
  `concurrency = greenlet, thread`: SQLAlchemy's async layer runs the sync
  core in greenlets, and per-thread tracing misses those lines
  (`services/orgs.py` measured 48% instead of 83% on the same tests).
- **embed**: every `src/**/*.ts` file, loaded by a test or not, but the
  tests, their fixtures, the generated `api-types.ts` and the 3D head's
  harness page. V8 counts statements and lines alike. The browser tests
  (`npm run test:browser`) are not measured.
- **frontend, node --test**: the `src/` files the unit tests load (Node
  reports only those), but the tests and their fixtures. Node has no
  statement count.
- **frontend, Vitest**: every `src/**/*.{ts,tsx}` file, rendered by a test
  or not, but the tests, `src/test/`, the fixtures, the generated
  `api-types.ts`, the translation tables (`i18n/locales/`) and `main.tsx`.
  The logic that node --test covers counts here too, as code no rendering
  test reached, so this number is lower by construction: compare it with
  itself, not with the other.

Where the floors live:

| Suite | Floors in | Run it (from the package) | Report |
|---|---|---|---|
| backend | `fail_under` in `backend/.coveragerc` | `python -m pytest tests -q -n auto --cov --cov-report=term --cov-report=html` (`make coverage` from the root) | `htmlcov/index.html` |
| embed | `coverage.thresholds` in `embed/vitest.config.ts` | `npm run test:coverage` | `coverage/index.html` |
| frontend, node --test | `--test-coverage-lines/branches/functions` in the `test:coverage` script of `frontend/package.json` | `npm run test:coverage` (Node 22 or newer) | `coverage/node/lcov.info` |
| frontend, Vitest | `coverage.thresholds` in `frontend/vitest.config.ts` | `npm run test:ui:coverage` | `coverage/ui/index.html` |

Locally, `pytest --cov` over part of the backend suite falls below the floor
by design: add `--cov-fail-under=0`. Numbers on a laptop can differ from CI's
by a few tenths (another Node, another platform, timing); CI's are the ones
of record.

In CI, each half of `backend-tests` writes its data file
(`COVERAGE_FILE=.coverage.half<k>`) and uploads it; `backend-coverage`
downloads both, runs `coverage combine`, and `coverage report` holds the
total to `fail_under`. `backend` needs `backend-coverage`, so the required
check fails with it. `embed` and `frontend` run the coverage scripts in
place of the plain ones. Every report (HTML and LCOV) is uploaded as an
artifact, kept 7 days: `backend-coverage`, `embed-coverage`,
`frontend-coverage` on the run's page (`gh run download <run> -n
embed-coverage`).

**Raising a floor.** When a change raises a number by a point or more, raise
its floor in the same pull request: read the measured value in the job's log
on that pull request (the backend's in `backend-coverage`, "Coverage floor";
the others in the coverage summary of their test step), and set the floor
to it minus 1, rounded down to a whole number. Then update the measured
values beside the floor and in the table above.
To find what to test next, open the HTML report, or look at the files the
report lists as missing lines.

**When a floor fails.** Add the tests the change is missing. If the code
cannot run under the suite at all (a developer tool, a generated file),
exclude it in the coverage settings with a comment saying why, in a pull
request of its own. Moving coverage.py, pytest-cov or `@vitest/coverage-v8`
can change how lines and branches are counted: measure again on that pull
request and move the floors with it, in either direction, saying so in the
description.

## Branch protection

Set on main: the six checks below are required, `strict` and
`enforce_admins` are on, force pushes and deletions are refused. It was set
once by the owner with this call (it needs admin rights on the repository,
which is why it is not automated); run it again to restore the rule:

```bash
gh api --method PUT repos/sadeghianme/avatar-face/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      {"context": "backend", "app_id": 15368},
      {"context": "embed", "app_id": 15368},
      {"context": "frontend", "app_id": 15368},
      {"context": "frontend-lint", "app_id": 15368},
      {"context": "deploy-script", "app_id": 15368},
      {"context": "images", "app_id": 15368}
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

- `checks` are the job ids in `ci.yml`; `app_id` 15368 is GitHub Actions, so
  only a workflow run can satisfy them. Renaming a job means updating this rule.
- `backend-checks` and `backend-tests` are not in the rule, and do not need to
  be: `backend` fails unless all of them succeeded ([CI](#ci)).
- `strict`: a pull request must be up to date with main, so what CI tested is
  what main becomes.
- `enforce_admins`: the owner is held to it too. With it, a direct `git push`
  to main is refused: changes arrive through pull requests. To lift it for an
  emergency: `gh api --method DELETE repos/sadeghianme/avatar-face/branches/main/protection/enforce_admins`
  (and `--method POST` on the same path to restore it).
- No review is required: there is one maintainer. Merge commits stay allowed
  (`required_linear_history: false`), as the history uses them.

Check it: `gh api repos/sadeghianme/avatar-face/branches/main/protection --jq '.required_status_checks.checks[].context'`.

## Dependency pins

Everything that reaches production is pinned, so a rebuild cannot change
behaviour on its own. Moving a pin is a normal change: branch, pull request,
green CI (the `images` job rebuilds both images from scratch), merge, deploy.

| What | Pinned in | How to move it |
|---|---|---|
| Python libraries | `backend/constraints.txt` (the production `pip freeze`), used by the Dockerfile and CI; `mediapipe==1.0.1` in `backend/Dockerfile` | below |
| Python dev tools | `ruff`, `pyright`, `pytest-cov`, `coverage` exact versions in `backend/pyproject.toml` | change the version; fix what the new one reports in the same pull request (for the coverage tools: measure again, [Coverage](#coverage)) |
| Coverage for Vitest | `@vitest/coverage-v8` exact in both `package.json`s, always the installed `vitest`'s version | with every move of `vitest`, in the same pull request: `npm install -D --save-exact @vitest/coverage-v8@<vitest's version>`; measure again ([Coverage](#coverage)) |
| npm packages | `embed/package-lock.json`, `frontend/package-lock.json` (`npm ci` everywhere) | in the package: `npm install <pkg>@<version>`, commit the lockfile |
| three.js | `embed/package.json` (the lockfile); its KTX2 transcoder is copied from the installed three into `embed/dist` by the build (`embed/scripts/build.mjs`) and served by the API beside `liveface-3d.js` | as any npm package: the transcoder moves with it |
| Models | URL and SHA-256 of every file in `backend/Dockerfile` | below |
| Base images | `FROM <tag>@sha256:<digest>` in both Dockerfiles | below; Dependabot proposes new digests monthly |
| GitHub Actions | major tags in `ci.yml` | Dependabot proposes them monthly |
| ShellCheck | image tag and digest in `ci.yml` | `docker buildx imagetools inspect koalaman/shellcheck:<tag>` |
| Cloudflare's edge ranges | `backend/app/core/cloudflare_ranges.py` (generated) | `python -m scripts.refresh_cloudflare_ranges` from `backend/` (`--check` only compares); see [Client addresses](#client-addresses) |

**Python libraries.** Change the pin in `backend/constraints.txt` (and the range
in `pyproject.toml` if it forbids it), run the backend tests locally
(`pip install -c constraints.txt -e ".[rig,dev]"`, `pytest`), and go through the
release path; test a real photo-to-avatar flow on the deployed site. Then
regenerate the file from the container that runs it, so it is again the exact
production set:

```bash
ssh personal_server "docker exec liveface-liveface-api-1 pip freeze" \
  | grep -v '^liveface-backend' > backend/constraints.txt
```

**Models.** Never point at a moving name (`latest/`, `resolve/main`). To pin a
new file or revision: download it once, take its hash, and put both in the
Dockerfile's `sha256sum -c` list:

```bash
curl -fL -o model.onnx "https://huggingface.co/<repo>/resolve/<commit>/<path>"
shasum -a 256 model.onnx
```

For Hugging Face, the `.onnx` hash equals the file's LFS object id
(`https://huggingface.co/api/models/<repo>/tree/<commit>/<dir>?expand=true`),
a second source to check it against. Piper voices are read from one revision
(`rev=` in the Dockerfile); moving it means re-checking all sixteen hashes.
Dropping a voice means dropping its two hash lines too. A changed model can
change every avatar's measurements or voice: test a real avatar before
deploying.

**Base images.** Resolve the tag's current digest and replace it:

```bash
docker buildx imagetools inspect python:3.12-slim-trixie | grep Digest
docker buildx imagetools inspect node:22-alpine | grep Digest
docker buildx imagetools inspect nginx:1.30-alpine | grep Digest
```

A new line (Node 24, Python 3.13, nginx 1.32) is a deliberate upgrade: change
the tag, and the matching `node-version` / `python-version` in `ci.yml`, in one
pull request. The images and every CI job use Node 22 (Node 20 is past its
end of life).

## Client addresses

Every per-client rate limit (sign-in, sign-up, password reset, `/embed/v1/cues`,
share pages) and the consent record's keyed address hash use one function,
`backend/app/core/client_ip.py`. Nothing else reads `request.client` or a
forwarding header.

Production is Cloudflare, then Caddy on the `web_proxy` docker network, then
the API. The function starts at the TCP peer, which nobody can forge, and
walks outward only through hops it trusts:

1. From a peer in `TRUSTED_PROXIES` (the docker ranges: Caddy), the rightmost
   `X-Forwarded-For` entry is believed, at most `TRUSTED_PROXY_HOPS` (1)
   entries in all. Entries a client wrote further left are never read.
2. From an address in Cloudflare's published ranges (`TRUST_CLOUDFLARE`),
   `CF-Connecting-IP` is the client.
3. The first address that is neither is the client.

So a visitor through Cloudflare is keyed on their own address, not on the
edge that thousands share, and a client that reaches Caddy without Cloudflare
is keyed on its own address whatever headers it sends. Uvicorn runs with
`--no-proxy-headers` (`backend/Dockerfile`) so that the peer reaches the
application unchanged. With none of the three settings (development, tests),
the client is the peer.

Cloudflare's ranges are pinned in the repository, never fetched at startup.
They change rarely and Cloudflare announces it: refresh them then, and with the
monthly dependency review (`--check` exits 1 when the pinned list is stale).
A stale list fails safe: a visitor behind a new edge is keyed on that edge
until the refresh, as every visitor was before.

## Database size and the speech cache

Every line a widget, a share page or the dashboard speaks is cached, so it is
synthesised once. Until migration 028 the recording was a WAV blob in the
main SQLite file, never evicted, and copied into all ten deploy backups.
Now (`backend/app/services/tts/speech_cache.py`):

- The recording is a file in storage under `speech/`, as MP3 (VBR, about
  50 kbit/s for 24 kHz speech). libsndfile writes the LAME header, so
  Chromium, Safari's CoreAudio and libsndfile decode it to exactly the WAV's
  samples and the cues stay on time; a line that would not is kept as WAV.
  The dashboard's phrase stream gets PCM back (`pcm=True`).
- `speech_clips` holds one small row per line: key, cues, duration, file,
  size, the organization whose request made it, last use (recorded at most
  hourly).
- The sweeper (hourly, and at startup) evicts lines unused for
  `SPEECH_CACHE_MAX_IDLE_DAYS` (90), then the least recently used past an
  organization's `SPEECH_CACHE_ORG_MAX_BYTES` (256 MiB), then past
  `SPEECH_CACHE_MAX_BYTES` (2 GiB) in all, each down to 90% of its cap. A
  cloned voice's lines are pinned: never evicted, not counted. Between
  sweeps the cache can run over by an hour of speech, which the monthly
  character allowance bounds.
- Migration 028 empties the old `speech_cache` table, keeping a cloned
  voice's lines (copied inline into `speech_clips`, moved to storage at
  startup). The empty table stays so that a rollback over 028 works (with
  the stamp described under [Rollback](#rollback)): the older release reads
  and writes it, every line is a miss once, and cloned voices are
  unavailable until the next deploy carries them back.

**The file.** SQLite does not give freed pages back to the disk: after 028
the live file keeps its size, and its free pages are reused by new rows, so
it stops growing rather than shrinking. The backups shrink at once:
`deploy/backup_db.py` copies with `VACUUM INTO`, which writes only live
pages (the online backup API it replaces copied the free ones too). To give
the space back to the disk, compact the live file once, with the API
stopped for a few seconds (`VACUUM` needs the database to itself):

```bash
ssh personal_server
docker stop liveface-liveface-api-1
docker run --rm -v liveface_liveface_data:/data liveface-liveface-api \
  python -c "import sqlite3; db = sqlite3.connect('/data/liveface.sqlite3'); db.execute('VACUUM'); db.close()"
docker start liveface-liveface-api-1
```

Measured on a scratch database built by the migrations and filled with
synthetic rows (25 organizations, 200 avatars, 2,000 usage events, 1,540
cached lines cut from real speech, 40 of them a cloned voice's): before 028
the file and each backup were 473.6 MB, 466 MB of it WAV. After 028 and the
startup drain the live file kept 485.7 MB (484 MB of it free pages) and a
backup was 1.2 MB, with the cloned lines in storage as 1.7 MB of MP3. Filling
the cache again with 1,500 lines put 64.7 MB of MP3 in storage (6.9 times
less than their 445 MB of WAV, 13 ms a line including the encoding), reused
5.7 MB of the free pages for their rows, and left a 6.9 MB backup.

## Security headers

The dashboard's nginx (`frontend/nginx.conf`, with the headers in
`frontend/nginx-security-headers.conf`) sends on every response:

| Header | Value and reason |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`; each exception is commented in the file and needed by a page (the sweep was run against a stricter policy to confirm it). `frame-ancestors 'none'`, except the share page |
| `X-Frame-Options` | `DENY`, except the share page |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin`: reset, invite and share links carry tokens |
| `Permissions-Policy` | microphone and camera for this site and Avaturn's editor; geolocation, payment, USB, motion sensors off |
| `Strict-Transport-Security` | one year. TLS ends at Cloudflare and Caddy, but neither sends it; drop it here if they start to |

The share page (`/s/<token>`) is the one page other sites may frame. The widget
is not served by nginx: it is `/api/liveface.js` on customers' pages, under
their own policy. The API's responses (`/api/*`) carry no CSP of their own.

**No inline script, anywhere.** `script-src` is `'self'` (and
`'wasm-unsafe-eval'` for the 3D decoders) on every page: no `'unsafe-inline'`,
so no inline script, event-handler attribute or `javascript:` URL runs. The
theme script that runs before first paint is a file (`frontend/public/theme.js`).

**The Simulator runs untrusted input, in three layers.** Its "customer page"
runs whatever snippet was pasted, or the one a `/simulator?avatar=…` link
prefills, and anyone can send such a link (the review's N1 was a one-click
session theft through it). So:

1. **Values stay values** (`features/simulator/snippet.ts`). A link prefills
   only an avatar id (32 hex digits); anything else and every other parameter
   is ignored. A pasted avatar that is not an id, or a src or API base that is
   not an http(s) URL, cannot be run. Every value is HTML-escaped into the
   page (`buildDocument`), and that page has no inline script: it is the
   harness `frontend/public/simulator-frame.js`, then the widget's tag.
2. **The frame has its own origin.** It is `sandbox="allow-scripts"` with no
   `allow-same-origin`, so its origin is opaque. A script in it cannot read the
   dashboard's `localStorage` (where the session's tokens are), its cookies or
   its DOM, and the dashboard cannot reach in either. Frame and page talk only
   by `postMessage`. The frame posts to the dashboard's origin, never `"*"`, and
   acts only on its parent's messages. The page takes log lines only from that
   frame's window. The widget works there as on a customer's site: the embed
   API's CORS answers any origin, `null` included, and `allow="autoplay"`
   lends the frame the page's permission to play the voice. Its requests say
   `Origin: null`, which the API accepts from a Simulator token (the default
   mode) and refuses for a key locked to domains (`origin_not_allowed`), so
   "Use my own key" works here only with a key that has no domain list.
3. **The policy refuses inline script.** A srcdoc document inherits the
   dashboard's CSP, so even a value that escaped layer 1 could not run as an
   inline script there.

The `images` job's sweep replays the N1 proof of concept, as a link and as a
paste, and fails if it runs. The session's tokens are still in
`localStorage` (`docs/frontend-ui.md`, "Security notes"); moving them to
httpOnly cookies is a separate change.
