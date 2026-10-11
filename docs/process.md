# Process: releasing, protecting main, moving pins

How a change reaches avatar.mehdisadeghian.com, how to undo it, and how the
pinned versions behind it are moved. The scripts are the source of truth:
`deploy/deploy.sh` (its header lists every option), `deploy/test-deploy.sh`
and `.github/workflows/ci.yml`.

## Release path

```
branch ──PR──▶ CI green ──merge──▶ CI green on main ──▶ deploy.sh ──▶ verified ──(if needed)──▶ deploy.sh --rollback
                                    (images pushed)      (pulls them)
```

1. **Branch and pull request.** `git switch -c <topic>`, commit, `git push -u
   origin <topic>`, `gh pr create --fill`. CI runs every job on the pull
   request (table below).
2. **Merge when green.** Branch protection (below) refuses the merge until
   every job passes and the branch is up to date with main. With the
   [merge queue](#merge-queue), **Merge when ready** queues the pull request
   instead, and the queue tests and merges it.
3. **CI on main.** The merge is a push to main, and CI runs again on that exact
   commit. When every test has passed, its `images` job pushes the two images
   it tested to GitHub's registry, tagged with the commit ([Images](#images)).
   `deploy.sh` accepts only a commit whose *own* push run on main succeeded:
   a pull request's run tested a merge commit, not this tree. In the merge
   queue, the queue's run of the commit counts too: it is the same commit,
   tested (and its images pushed) before it reached main. `gh run watch`
   follows a run.
4. **Deploy.** From a clean checkout of main at that commit:

   ```bash
   git switch main && git pull --ff-only
   deploy/deploy.sh --dry-run    # every check, then what would happen; contacts no server
   deploy/deploy.sh              # or: deploy/deploy.sh --ref <commit on origin/main>
   ```

   The server pulls the images and restarts on them. It builds nothing.
5. **Verified by the script, not by eye.** The deploy ends only when
   `https://avatar.mehdisadeghian.com/api/health` and `/version.json` both report
   the commit it shipped. It then prints the alembic revision, row counts and a
   summary. Embedding sites cache the widget for up to 4 hours: hard-refresh one
   to see a widget change.
6. **Roll back** if anything looks wrong: `deploy/deploy.sh --rollback`
   ([Rollback](#rollback)).

**How long it takes.** Measured on 2026-10-09. CI takes about 5 minutes with a
warm layer cache. The `images` job is the longest, and its browser sweep and
wizard take 3 of those minutes. The first run on a branch, and the first on
main, takes about 10, because it fills the cache. Pushing the images adds 5 to
20 seconds. A pulled deploy should take about a minute (estimated from its
parts before the first one ran: one ssh connection, a pull of a few MB, the
backup, the restart and the health check; the first pulled deploy downloads
everything once and prunes the old images, a minute or two more). So from
merge to live should be about 6 to 7 minutes of machine time. Before pull mode, CI took 4.6 to 6.9
minutes, and the server built for about a minute when its layer cache held
everything below the source. When the cache missed, the build fetched ~850 MB
of models and reinstalled the libraries. What remains between "ready" and
"merged" is mostly `strict`: a pull request that is behind main must be
updated and tested again first. That wait is what the
[merge queue](#merge-queue) removes.

### What deploy.sh refuses

Before anything leaves the machine:

| Exit | Refused because | What to do |
|---|---|---|
| 2 | unknown option, or `--ref` is not a commit | `deploy/deploy.sh --help` |
| 3 | the working tree has changes | commit and push them (and wait for CI), or stash them |
| 4 | the commit is not on `origin/main` | push it; CI must run on it first |
| 5 | no successful `ci` run of this commit: its push run on main is still running, failed, was cancelled, or never ran, and no merge queue run of it succeeded (a *failed* main run is refused even then) | wait (`gh run watch`), fix, or deploy the newest pushed commit |
| 6 | a tool is missing (`git`, `gh`, `ssh`, `curl`; with `--build`, `rsync` and `tar`) | install it; `gh auth status` must be logged in |

Then on the server, before anything there changes:

| Exit | Refused because | What to do |
|---|---|---|
| 7 | the server cannot pull from `ghcr.io`: the images are private and docker there has no login, or the registry refused its login (a token without `read:packages`, or an expired one). The pull is tried first, so public images need no login | [the one-time login](#one-time-the-servers-registry-login); the script prints the steps and says which case it is |
| 8 | the registry has no image of this commit: CI pushes them only for a commit on main or in the merge queue whose `images` job passed, and only since images are pulled | deploy a newer commit, or build this one on the server: `deploy/deploy.sh --build --ref <commit>` |

Uncommitted files under `frontend/public/brand/` are the one exception to exit
3: the owner keeps brand experiments there. They are listed as *not shipped*
and never are: what ships is the commit (its images, or with `--build` its
`git archive`), never the working tree. Every gate is tested in CI by
`deploy/test-deploy.sh`: a scratch repository with a stub `gh`, and a whole
pulled deploy against a pretend server (stub `ssh`, `docker` and `curl`) that
checks the order of the server's steps, that nothing is built, and that
refusals 7 and 8 come before any change.

### What a deploy does on the server

All of it runs over one ssh connection, multiplexed. A new connection to the
server takes 3.5 s and a deploy runs about a dozen commands; over the first
connection each takes 0.6 s.

1. Refuse to continue if `deploy/.env` is missing or empty.
2. Pull `ghcr.io/sadeghianme/liveface-api:<commit>` and
   `ghcr.io/sadeghianme/liveface-web:<commit>`. Refusals 7 and 8 come from
   this step, with the old release serving and nothing changed. After the
   first pull the server has every layer below the application's source
   (system libraries, models, Python libraries, nginx), so a code change
   downloads only the layers above it. Measured on the first push: the API
   image is 1,530 MB compressed in 20 layers, and its layers above the
   libraries are about 3 MB (the source 0.4, the installed project 1.7, the
   widget bundles 0.8). The dashboard image is 35 MB, 9.7 of it the build. A
   code change pulls 3 to 13 MB, under a second at the 170 to 290 MB/s the
   server measured from `ghcr.io`. The first pull, about 1.6 GB, is about 10
   seconds of download, plus the unpacking (estimated at under a minute).
3. Write `deploy/docker-compose.prod.yml` from `git archive <commit>`, the only
   file of the tree the server needs. `deploy/.env` is in no commit, so this
   cannot touch it.
4. Back up the live SQLite database with `VACUUM INTO` (`deploy/backup_db.py`:
   one consistent snapshot through the WAL, compacted, so free pages are not
   copied) to `/data/liveface.sqlite3.bak-<stamp>` and keep the newest 10
   (`BACKUP_KEEP=<n>` to change). The backups hold the database only: the
   files in storage (pictures, rigs, the speech cache) are not in them.
5. Tag the last verified release (`:release`) as `:previous`, for `--rollback`.
6. Tag the pulled images as the ones compose runs,
   `liveface-liveface-api:latest` and `liveface-liveface-web:latest`, and
   `docker compose -f docker-compose.prod.yml up -d --no-build`. The commit is
   baked into both images: `ENV LIVEFACE_VERSION` and the
   `org.opencontainers.image.revision` label in the API, `/version.json` and
   the label in the dashboard.
7. Wait up to 5 minutes for `/api/health` to report the commit, then check
   `/version.json`; only then tag the new images `:release`.
8. Prune what earlier releases left: the registry tags of other commits
   (`:release` and `:previous` still name what a rollback needs), then this
   project's images that no tag names any more (`docker image prune
   --filter label=org.opencontainers.image.source=https://github.com/sadeghianme/avatar-face`,
   untagged images only). Each release before `:previous` used to stay on the
   disk, about a GB apiece. Best effort: a failure is reported and changes
   nothing else.

Migrations run when the API container starts (`app/main.py`, `ensure_schema`).
A migration that fails crash-loops the new container: roll back.

### The fallback: `--build`

`deploy/deploy.sh --build` deploys the way every release was made before
images were pulled. It runs the same gates, then `rsync --delete` of the
commit's `git archive` to `/root/projects/liveface` (the excludes, `.env`,
databases, `backend/local_storage`, …, only protect server-side files from
`--delete`), the backup and `:previous` as above, and
`LIVEFACE_VERSION=<commit> docker compose -f docker-compose.prod.yml up -d --build`.
Compose replaces no container until both images build, so a failed build
leaves the old release serving. It takes as long as it always did: about a
minute on the last deploys before pull mode, when the server's layer cache
held everything below the source, and longer when it did not and the build
fetched the models (~850 MB) and the libraries again.

Use it for a commit the registry has no images of (exit 8): one from before
images were pulled, or one shipped with `--skip-ci-check` before its `images`
job pushed. Use it also while the server cannot reach the registry.

### One-time: the server's registry login

The images are private, so docker on the server needs a login to `ghcr.io`
before the first pulled deploy. Until then `deploy.sh` stops with exit 7 and
prints these steps. The owner does this once; `deploy.sh` never asks for,
reads or passes on the token.

0. Make both packages private, if they are not yet (GitHub created them
   public, [Images](#images)): on
   <https://github.com/users/sadeghianme/packages/container/liveface-api/settings>
   and <https://github.com/users/sadeghianme/packages/container/liveface-web/settings>,
   **Danger Zone**, **Change visibility**, **Private**. Until this is done,
   every push to main publishes both images for anyone to pull.
1. Create a personal access token (classic) with the `read:packages` scope
   and nothing else:
   <https://github.com/settings/tokens/new?scopes=read:packages&description=liveface-server-pull>.
   GitHub's registry accepts no fine-grained token. Read-only is enough: CI
   pushes with its own `GITHUB_TOKEN`.
2. Give it to docker on the server on stdin, so it is in no shell history:

   ```bash
   ssh personal_server
   docker login ghcr.io -u sadeghianme --password-stdin
   # paste the token, press Enter, then Ctrl-D: "Login Succeeded"
   ```

Docker keeps it in `/root/.docker/config.json`, base64-encoded rather than
encrypted (docker says so): a token that can only read these packages is what
it should be. A token with an expiry date stops deploys at exit 7 the day it
expires: create a new one and log in again. To revoke it, delete it on
GitHub's token page; `docker logout ghcr.io` on the server forgets it there.

### Images

CI's `images` job builds both images with BuildKit and GitHub's Actions
cache (`type=gha`, a scope per image): a layer whose inputs did not change is
restored instead of rebuilt and keeps its digest, so the registry and the
server already have it. On a push to main and in the merge queue, after
every test passed, it pushes them as `ghcr.io/sadeghianme/liveface-api:<commit>`
and `ghcr.io/sadeghianme/liveface-web:<commit>`, with `GITHUB_TOKEN` and
`packages: write` on that job alone (never on a pull request, whose token is
read-only when it comes from a fork). It then reads each back from the
registry and fails unless its layers, environment, command and labels are
the tested image's, and lists every layer with its compressed size (what a
pull downloads).

- **Layer order is what makes a pull small.** In `backend/Dockerfile`
  everything that does not depend on the source comes first: system
  libraries, the models (checksummed), then the Python libraries, installed
  from the dependency list alone (a small stage extracts it from
  `pyproject.toml`, so a dev-tool pin there does not invalidate it) and
  `constraints.txt`. The source and the project itself (`pip install
  --no-deps .`) come after. The job checks the image's `pip freeze` equals
  `constraints.txt`. Keep new layers in that order: a file copied above the
  libraries makes every commit reinstall them.
- **Private, once the owner makes them so.** GitHub creates a package that a
  workflow publishes with the visibility of the workflow's repository, so
  both came out *public*, like the repository. The owner makes each private
  once ([step 0 of the login](#one-time-the-servers-registry-login)); it stays
  so for every later push. The job's last step warns, on every push, while one is public
  (an anonymous reader gets a token for it), with the link to the setting.
  Public images would need no login on the server, but anyone could pull
  them, the third-party models and voices inside included.
- Container storage and transfer on `ghcr.io` are free at present (GitHub's
  billing docs). Old versions are not deleted automatically. To delete
  some, use the package's settings page, or
  `gh api --method DELETE /user/packages/container/liveface-api/versions/<id>`
  with a token that has `delete:packages`.
- **What it costs**, measured on this change's
  runs. With an empty cache, the API image took 271 s: 62 s of build, 72 s
  exporting it to docker for the tests, and 134 s filling the Actions cache,
  which happens once per branch. The dashboard took 68 s. Pushing every layer of
  both to an empty registry took 13 s and 5 s, and the read-back 4 s. With the
  cache warm, the API image takes 81 s and the dashboard 9 s (the plain
  `docker build` this replaced took 76 s and 28 s). The cache shares GitHub's
  10 GB per repository with the virtualenv, npm and browser caches, and the
  least recently used entry is evicted first. The two images take about 1.9 GB
  per branch that built them.

### Merge queue

**Not available to this repository today.** GitHub offers merge queues only
in repositories owned by an organization (any public one, or private ones on
GitHub Enterprise Cloud). `sadeghianme/avatar-face` belongs to a personal
account, so the rule is not offered to it (GitHub's docs; not tried here,
since settings are the owner's). Everything else is ready: the workflow
runs every job on `merge_group` and reports the same six checks, the
`images` job pushes the queue's commit, and `deploy.sh` accepts the queue's
run.

To use it, transfer the repository to an organization (a free one is enough
for a public repository). The registry namespace follows the owner, so in
the same change, rename `ghcr.io/sadeghianme/…` to the organization's in
`ci.yml` (`API_IMAGE`, `WEB_IMAGE`, the warning's settings link),
`deploy/deploy.sh` (`IMAGE_OWNER`, `IMAGE_SOURCE`) and the
`org.opencontainers.image.source` label of both Dockerfiles, and make the
organization's new packages private as above. The server's login can stay
the owner's own (`-u sadeghianme`): a classic token reads the packages of
the organizations its account can read. Then add the rule (repository
admin):

```bash
gh api --method POST repos/<owner>/avatar-face/rulesets \
  -H "Accept: application/vnd.github+json" --input - <<'EOF'
{
  "name": "main: merge queue",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "rules": [
    {
      "type": "merge_queue",
      "parameters": {
        "merge_method": "MERGE",
        "max_entries_to_build": 2,
        "min_entries_to_merge": 1,
        "max_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 0,
        "grouping_strategy": "ALLGREEN",
        "check_response_timeout_minutes": 60
      }
    }
  ]
}
EOF
```

- **Merge method `MERGE`**: merge commits, as the history uses them.
- **Build concurrency 2** (`max_entries_to_build`): a second queued pull
  request is tested on top of the first while the first runs, and a third
  waits. Each CI run is about ten jobs, and the account's runners are shared
  by every run.
- **One pull request per merge** (`min_entries_to_merge`,
  `max_entries_to_merge` 1, no wait): every commit on main is one queue
  entry, so each has its own tested images.
- **`ALLGREEN`**: only pull requests whose own checks passed are merged.
  60 minutes for the checks to report (the `images` job's timeout is 40).
- **The required checks stay the same six** (`backend`, `embed`, `frontend`,
  `frontend-lint`, `deploy-script`, `images`), in the branch protection rule
  below. The queue requires them of its own run.
- **Turn `strict` off** in that rule. The queue tests every pull request
  merged onto the newest main, which is what `strict` was for, and keeping
  it would make authors update their branches for nothing:
  `gh api --method PATCH repos/<owner>/avatar-face/branches/main/protection/required_status_checks -F strict=false`.

Check it: `gh api repos/<owner>/avatar-face/rules/branches/main`. With the
queue, the push run on main still runs, and `deploy.sh` can start as soon as
the queue merges: the queue's run already passed and pushed the images.

### Emergencies: `--skip-ci-check`

Ships a pushed commit without a green CI run, behind a banner, and records
"SKIPPED" in the summary. Everything else still applies: a clean tree, a commit
on `origin/main`, the version check after the restart. CI pushes the images
only after its `images` job passed, so a commit whose run has not got that
far has none: add `--build` (`deploy/deploy.sh --skip-ci-check --build`).
Afterwards, watch that commit's own run finish (`gh run watch`) or re-run it
if it failed for a reason outside the code (`gh run rerun <id>`), and roll
back if it stays red.

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
`deploy/deploy.sh --ref <commit>`, which pulls its images from the registry
(a commit from before images were pulled has none: add `--build`).

The database is not touched. If the release being undone ran a migration, the
older code now runs on the newer schema, which migrations are written to allow
(028 keeps the old speech table for this). A release from backend round 3 on
starts on a database a newer release migrated: it logs that it does not know
the revision and serves (`app/main.py`, `ensure_schema`). A release before it
runs `alembic upgrade` at startup and stops on the unknown revision, so stamp
the database back to that release's last migration first, while the newer
release is still running. Rolling back over 028 to the release before it:

```bash
ssh personal_server "docker exec -w /app/backend -e PYTHONPATH=/app/backend \
  liveface-liveface-api-1 alembic stamp 027_scene"
deploy/deploy.sh --rollback
```

The next deploy runs 028 again (it is written to be re-run). Rolling back over
029 (dashboard sessions) is the same with `alembic stamp 028_speech_clips`:
everyone signs in again, on the old release and once more when 029 is
deployed again, because a re-run deletes the sessions from before rather than
trust them ([Sessions](#sessions)). If the older code
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

`.github/workflows/ci.yml` runs on every push to main, every pull request and
every [merge queue](#merge-queue) entry (`merge_group`). A newer push to the
same branch or pull request cancels the run it supersedes. The workflow's
token is read-only (`contents: read`); only the `images` job may write
packages, to push the images it tested ([Images](#images)).

**The API contract.** `frontend/src/lib/api-schema.json` is the OpenAPI
document, and `backend/scripts/export_openapi.py` its only generator
(`python -m scripts.export_openapi` from `backend/`, or `npm run api:schema`).
The dashboard generates `src/lib/api-types.ts` from it (`npm run gen:api`), the
widget `embed/src/api-types.ts` (`npm run gen:api` in `embed/`). A change to
the API is therefore three files in one pull request: export, then generate
in both packages; CI fails on any of them left behind.

**Private names stay in their module.** No other module, package `__init__`
or test imports, reads, patches or re-exports a backend module's
underscore name; what the modules of a package share is public in the module
that owns it, and a test drives a public function or patches a public seam
(`backend/tests/test_private_names.py`, in the suite, beside the layering
checks of `test_layering.py`).

**The backend is four jobs** (six with the shards), and `backend` stands for them:

- `backend-checks`: everything but the tests. That is `ruff check`, `ruff format
  --check`, `pyright`, the OpenAPI document, and the migrations against the
  models. The migration check builds an empty SQLite with `alembic upgrade
  head` and runs `alembic check`, which compares tables, columns, types,
  nullability, indexes and foreign keys. It then takes the newest migration
  down and up again and checks once more. Production migrates when the API
  starts, but the tests build their schema from the models, so this step is
  the only one that catches a model change committed without its migration.
- `backend-tests (1)`, `(2)` and `(3)`: the suite in three shards. Each test
  belongs to exactly one shard (`LIVEFACE_TEST_SHARD=<k>/<n>`, a CRC of its
  id; `tests/conftest.py`), and each shard runs on every core of its runner
  (`pytest -n auto`). Every pytest-xdist worker has its own database and
  storage, so a test must write only under `tmp_path`. Each shard runs with
  coverage and uploads its data file. Three, not two: the halves took 4 to
  5.5 minutes and were the longest jobs of the run.
- `backend-coverage`: after the three shards, combines their coverage data
  and holds it to the floor ([Coverage](#coverage)).
- `backend`: the required check. It needs `backend-checks`, every shard and
  `backend-coverage`, and fails unless all succeeded. It runs `if:
  always()`, because a required check that is skipped counts as passed.

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
| `backend-tests` (×3) | pytest with coverage, a third of the suite each, on every core, against the production pins, espeak-ng and the checksummed MediaPipe models | 2.7–4.1 min (pytest 133–206 s per shard) |
| `backend-coverage` | the three shards' coverage combined, at or above the floor; the HTML and LCOV report uploaded | ~20 s |
| `backend` | every backend job above passed (the required check) | seconds |
| `embed` | lint, type check (tests included), the widget's generated API types match the committed document, vitest with the pixel goldens and coverage at or above its floors, build, the browser tests (Chromium; the speech timing test also in Firefox and WebKit, with the backend's speech encoder and a null sound sink: about a minute and a half of it) | ~4 min |
| `frontend` | type check, the unit tests (node --test) and the rendering tests (Vitest), each with coverage at or above its floors, structure check, production build | ~1 min |
| `frontend-lint` | ESLint (UI kit and data-layer rules), Prettier, the dashboard's generated API types match the committed document | <1 min |
| `deploy-script` | ShellCheck (pinned) on `deploy/*.sh`; every gate of `deploy.sh` | <1 min |
| `images` | both production images build (every model checksum, `nginx -t`; BuildKit with the Actions layer cache), the API's `pip freeze` is `constraints.txt`, both boot, report the commit, and all 23 page visits load in headless Chrome with zero CSP violations (the Simulator injection replayed among them, and the session checked for tokens a script could read); then the wizard end to end, from a new account to a published, spoken, shared and deleted avatar. On main and in the merge queue it then pushes both images and checks the pushed ones are the tested ones ([Images](#images)) | ~5 min with a warm layer cache, the sweep and the wizard 3 of them; ~10 on a branch's first run, filling the cache; the push 5–20 s |

The `images` job's browser sweep (`deploy/smoke/web-sweep.mjs`) seeds a user, a
photo avatar, a 3D avatar and a share link through the API, speaks on the share
page, runs the real widget in the Simulator for both avatars and speaks there,
and replays the Simulator injection (N1) as a link and as a paste. It signs in
from the page, as the login form does, and checks that a reload keeps the
session with no token in `document.cookie` or storage. To run it
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

### The wizard, end to end

After the sweep, the same job makes an avatar the way an owner does
(`deploy/smoke/wizard-e2e.mjs`), on the path a server without AI keys offers:

1. A new account through the register form, landing on the empty dashboard.
   The test never injects a token: it signs in only through the form, so
   it does not depend on how the dashboard keeps its session.
2. **New avatar**, then step 1 **Human**; step 2 **Upload a photo**
   (`deploy/smoke/fixtures/portrait.jpg`, a fictional generated face, 640
   px), **Realistic**, the AI box left unticked, the statement about the
   face ticked, **Create my avatar**.
3. Step 3 prepares the photo itself (MediaPipe's cut-out and face, in the
   API image): "No AI was used", and the picture loads.
4. Step 4 shows the points found. The test checks that the eyes, mouth and
   head points sit in a face's order on the picture, plays the talking
   preview's sample (its stream must answer, not the browser's fallback
   voice), then presses **Publish**.
5. On the avatar's page the stage draws a picture (screenshot pixels, not
   one flat colour). A typed line is spoken in the image's Kokoro voice:
   **Speak** stays busy until the player has played the stream out, at
   least about as long as the audio the stream carried. Kokoro is always in
   the image, so there is no browser-voice fallback to test here.
6. The public link is turned on and `/s/<token>` is opened in a separate,
   signed-out browser context. Its avatar draws, and **Play** is busy for at
   least the length of the recording the server sent.
7. The avatar is deleted with the inline confirmation. The dashboard is
   empty again, its page says it is not found, and its link is gone.

The test fails on any console error, uncaught page error or
Content-Security-Policy violation, in any page or frame, and on any 5xx. The
only exception is the deleted avatar's own 404s in the last step, which that
step asks for on purpose. Every wait is on something the page shows (a
heading, a role, a text, an attribute), each with a bound; the server's jobs
are waited out as the page polls them, and nothing sleeps.

It is driven by Playwright (`playwright-core`, pinned in
`deploy/smoke/package-lock.json` to the version the widget's browser tests
use) on the Chrome the runner already has, which the sweep uses too. Raw CDP
was enough for the sweep's page visits. A flow with a file picker, role and
text waits, and a second signed-out context needed Playwright's locators,
`filechooser` and `newContext`, which a CDP harness would have to rebuild.

To run it locally, start the stack as above, then:

```bash
npm ci --prefix deploy/smoke
node deploy/smoke/wizard-e2e.mjs http://127.0.0.1:7090   # CHROME=<path> picks the browser
```

In CI it takes about 50 seconds, after a 2-second `npm ci`. On a busy laptop
it can take a few minutes, and every wait's bound allows for that. It prints
each step with its time, and where its files are:
`$WIZARD_E2E_ARTIFACTS`, or a new temp directory. That directory has a
screenshot after every step, `console.log`, `network.json` and
`steps.json`. On a failure it also has a screenshot of every open page and a
Playwright trace per browser context (`npx playwright-core show-trace
trace-owner.zip`). In CI the directory is uploaded as the `wizard-e2e`
artifact when the job fails, with the API container's whole log beside it.

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

- **backend**: lines and branches of `app/` (branch coverage on), the three
  shards of `backend-tests` combined; the floor is on coverage.py's
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

In CI, each shard of `backend-tests` writes its data file
(`COVERAGE_FILE=.coverage.shard<k>`) and uploads it; `backend-coverage`
downloads the three, runs `coverage combine`, and `coverage report` holds the
total to `fail_under`. `backend` needs `backend-coverage`, so the required
check fails with it. `embed` and `frontend` run the coverage scripts in
place of the plain ones. Every report (HTML and LCOV) is uploaded as an
artifact, kept 7 days: `backend-coverage`, `embed-coverage`,
`frontend-coverage` on the run's page (`gh run download <run> -n
embed-coverage`).

What it costs, measured when coverage was added (the suite then ran in two
halves; three shards since, [CI](#ci)): pytest under coverage takes
about 4.3 minutes per half instead of 3 (most runs; the runners vary by a
minute either way), `backend-coverage` 17 seconds after them, so a whole
run takes about 5.5 minutes instead of 4. Vitest takes 10 seconds longer in
`embed` and 5 in `frontend`; node --test, a fraction of a second.

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
  what main becomes. With the [merge queue](#merge-queue) it goes off: the
  queue tests every pull request on the newest main itself. The six checks
  stay, and the queue requires them of its own run (`merge_group`).
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
| Python libraries | `backend/constraints.txt` (the production `pip freeze`), used by the Dockerfile and CI, which holds the image's `pip freeze` to it; `mediapipe==1.0.1` in `backend/Dockerfile` | below |
| Python dev tools | `ruff`, `pyright`, `pytest-cov`, `coverage` exact versions in `backend/pyproject.toml` | change the version; fix what the new one reports in the same pull request (for the coverage tools: measure again, [Coverage](#coverage)) |
| Coverage for Vitest | `@vitest/coverage-v8` exact in both `package.json`s, always the installed `vitest`'s version | with every move of `vitest`, in the same pull request: `npm install -D --save-exact @vitest/coverage-v8@<vitest's version>`; measure again ([Coverage](#coverage)) |
| npm packages | `embed/package-lock.json`, `frontend/package-lock.json`, `deploy/smoke/package-lock.json` (`npm ci` everywhere) | in the package: `npm install <pkg>@<version>`, commit the lockfile |
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
  50 kbit/s for 24 kHz speech; `speech_codec.py`). libsndfile writes the
  LAME header that names the encoder's delay and padding, and the
  browsers honour it (measured, below), so the MP3 plays on the WAV's own
  samples and the cues stay on time; a line libsndfile would not decode in
  full is kept as WAV. The dashboard's phrase stream gets PCM back
  (`pcm=True`).
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

**Timing in browsers (2026-10-09).** An MP3 starts late by its encoder's
delay (576 + 529 samples, 46 ms at 24 kHz) unless the decoder honours the
LAME header; that was checked only with libsndfile until review 3 (R1).
`embed/browser-tests/speech-timing.test.ts` encodes a click track with the
production encoder (`backend/scripts/encode_speech.py`, which runs
`speech_codec.py` alone), plays it as the widget plays speech, and finds
each mark again. CI runs it in Chromium, Firefox and WebKit on every
change (the embed job, with PulseAudio's null sink as the runner's sound
card). Measured (ms; "through the element": the engine's clock when the
mark reached the audio graph, MP3 minus WAV, medians over the marks):

| Browser | decodeAudioData, MP3 mark minus source | Through the element, MP3 minus WAV |
|---|---|---|
| Chromium 153, macOS | 0.0 at all 6 marks | −0.2 to +0.2 |
| Chromium 153, Linux (CI) | 0.0 | +0.1 to +3.8 |
| Firefox 155, macOS | 0.0 | −1.3 to +1.9 |
| Firefox 155, Linux (CI) | 0.0 | −2.0 to +0.7 |
| WebKit 26.6, macOS | 0.0 | −3.4 to +0.8 |
| WebKit 26.6, Linux (CI) | 0.0 | not measurable: GStreamer's element source holds about a second of audio, so the route is no ruler |

So the format stays MP3, and nothing about stored lines changed: no cache
version, no migration, every clip in production stays valid. (The same
test found the clock running ahead at the start of a line, fixed in
`embed/src/engine/media-clock.ts`; docs/avatar-lines.md, "Speech clock in
real browsers".) Not measured: real Safari and iOS (Safari's WebDriver
needs `safaridriver --enable`, an administrator's step), older Firefox ESR
releases, Chrome on Android.

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
   dashboard's `localStorage`, its cookies (the session's refresh cookie is
   httpOnly besides) or
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
paste, and fails if it runs. No session token is in reach of a script any
more ([Sessions](#sessions)).

## Sessions

Signing in to the dashboard opens a session the server can end
(`backend/app/services/sessions.py`, table `refresh_tokens`, migration 029).

| | What and where | Lifetime |
|---|---|---|
| Access token | a JWT (HS256, key derived from `JWT_SECRET` for this use alone) naming the user and the session (`sid`); kept in the dashboard's memory only (`frontend/src/lib/api.ts`), sent as `Authorization: Bearer` | 15 minutes (`ACCESS_TOKEN_MINUTES`) |
| Refresh token | 256 random bits in the `lf_refresh` cookie: `HttpOnly`, `SameSite=Strict`, `Path=/api/auth` (`SESSION_COOKIE_PATH`), `Secure` whenever `APP_BASE_URL` is https (`SESSION_COOKIE_SECURE` overrides). The database keeps its SHA-256, never the token | 30 days from its last use (`REFRESH_TOKEN_DAYS`) |
| `lf_session=1` | a cookie the dashboard can read, `Path=/`, with nothing secret in it: whether there is a session to restore on load, so a visitor who never signed in (the landing page, a share page) makes no request | as the refresh cookie |

- **Rotation.** Every refresh (`POST /api/auth/refresh`, on each page load
  and when an access token is refused) exchanges the refresh token for the
  next one of its session. A spent token presented again is a copy in
  someone else's hands: the whole session is revoked
  (`refresh_token_reused`), the copy and the owner's current token with it.
  Within `REFRESH_REUSE_GRACE_SECONDS` (10) of the exchange it is the same
  browser asking again (an answer lost to a reload or a dropped connection,
  two tabs at once): it gets the same next token again, which is derived
  from the one it replaces with a server key, so it is never stored either.
  The dashboard also holds a Web Lock around its refresh, so its tabs take
  turns, and a 401 refreshes once however many requests were refused.
- **Ending one.** `POST /api/auth/logout` (this session, by its cookie or its
  bearer token), `POST /api/auth/logout-all` (every session of the account,
  this one included: Settings, "Log out everywhere"; bearer only), and a
  password reset (every session, in the same commit as the new hash; the
  browser that reset it gets a new one). Signing in again ends the session
  the browser held before (its cookie comes along). An access token dies with its
  session at once: every authenticated request checks the session in the
  query that loads the user. The sweeper deletes tokens past their expiry.
  Removing a member from an organization ends no session: what a session
  proves is the account, and every request checks the organization's
  membership itself.
- **Cross-site requests.** The cookie authenticates only
  `/api/auth/refresh` and `/api/auth/logout`. Those, and the routes that
  set it (`login`, `reset-password`, against login CSRF), refuse a request
  whose `Sec-Fetch-Site` is not `same-origin`, or, from an older browser
  without it, whose `Origin` is not the dashboard's (`CORS_ORIGINS`,
  `APP_BASE_URL`): 403 `cross_site_request`. `SameSite=Strict` keeps the
  browser from sending the cookie from another site at all; the header check
  also covers a sibling subdomain, which counts as the same site. Everything
  else is authorized by the bearer header, which no browser attaches on its
  own.
- **Local development.** Vite on `http://localhost:5174` proxies `/api` to
  the API, so the cookie's path is the same as in production, and with the
  default `APP_BASE_URL` (http) the cookies are not marked Secure: a browser
  would refuse a Secure cookie over plain http, from a phone on the LAN too.
- **Passwords** are bcrypt through the `bcrypt` package (cost 12, `$2b$`);
  the hashes passlib wrote verify unchanged (`tests/test_security.py` holds
  real ones).

**Deploying the release that brings this signs everyone out once.** The
stateless refresh tokens issued before have no row and the old access tokens
carry no session, so both are refused; nothing in them is worth keeping
alive, since they are exactly the credentials that could not be revoked. A
dashboard tab left open across the deploy still runs the old bundle: its
requests fail with 401 from its next refresh on, until a reload loads the new
bundle and its login page. The old `liveface.tokens` entry is deleted from
`localStorage` on the first load of the new one. Rolling back over 029: [Rollback](#rollback).
