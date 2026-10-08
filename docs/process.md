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
   origin <topic>`, `gh pr create --fill`. CI runs all six jobs on the pull
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
3. Back up the live SQLite database with SQLite's online backup
   (`deploy/backup_db.py`, safe under WAL) to `/data/liveface.sqlite3.bak-<stamp>`
   and keep the newest 10 (`BACKUP_KEEP=<n>` to change).
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
older code now runs on the newer schema. If it cannot, restore the backup the
deploy took just before that release (its path is in that deploy's summary):

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

| Job | What it proves | Time |
|---|---|---|
| `backend` | ruff, pyright, pytest against the production pins and the checksummed MediaPipe models | ~12 min |
| `embed` | lint, type check (tests included), vitest with the pixel goldens, build | ~2 min |
| `frontend` | structure check, type check, production build | <1 min |
| `frontend-lint` | ESLint (UI kit and data-layer rules), Prettier, unit tests | <1 min |
| `deploy-script` | ShellCheck (pinned) on `deploy/*.sh`; every gate of `deploy.sh` | <1 min |
| `images` | both production images build (every model checksum, `nginx -t`), boot, report the commit, and all 20 pages load in headless Chrome with zero CSP violations | ~10 min |

The `images` job's browser sweep (`deploy/smoke/web-sweep.mjs`) seeds a user, a
photo avatar, a 3D avatar and a share link through the API, speaks on the share
page and runs the real widget in the Simulator for both avatars. To run it
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

## Branch protection

Not set yet; the owner runs this once (it needs admin rights on the
repository, which is why it is not automated):

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
| Python dev tools | `ruff`, `pyright` exact versions in `backend/pyproject.toml` | change the version; fix what the new one reports in the same pull request |
| npm packages | `embed/package-lock.json`, `frontend/package-lock.json` (`npm ci` everywhere) | in the package: `npm install <pkg>@<version>`, commit the lockfile |
| three.js | `embed/package.json` (the lockfile); its KTX2 transcoder is copied from the installed three into `embed/dist` by the build (`embed/scripts/build.mjs`) and served by the API beside `liveface-3d.js` | as any npm package: the transcoder moves with it |
| Models | URL and SHA-256 of every file in `backend/Dockerfile` | below |
| Base images | `FROM <tag>@sha256:<digest>` in both Dockerfiles | below; Dependabot proposes new digests monthly |
| GitHub Actions | major tags in `ci.yml` | Dependabot proposes them monthly |
| ShellCheck | image tag and digest in `ci.yml` | `docker buildx imagetools inspect koalaman/shellcheck:<tag>` |

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
pull request. The images use Node 22 (Node 20 is past its end of life); the
`embed` and `frontend` CI jobs still set Node 20 and should follow.

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

**Known gap: `script-src 'unsafe-inline'`.** The Simulator runs the customer's
page in an `<iframe srcdoc>` with inline scripts written per run, and a srcdoc
document inherits the dashboard's policy, so no hash or nonce can cover it. To
drop `'unsafe-inline'`: serve that page as its own document (for example
`/simulator-frame.html`, with its own policy from its own nginx location) and
pass it the snippet by `postMessage`; then allow the theme script in
`index.html` by its hash. The sweep shows exactly what a stricter policy blocks.
