#!/usr/bin/env bash
#
# Deploy one commit of main to the server: the two images CI built and tested
# for exactly that commit, pulled from GitHub's registry. Nothing is built on
# the server.
#
#   deploy/deploy.sh                  deploy HEAD
#   deploy/deploy.sh --ref <commit>   deploy another commit of origin/main
#   deploy/deploy.sh --dry-run        every check, then print what would happen;
#                                     nothing is sent and the server is not contacted
#   deploy/deploy.sh --rollback       put back the release that was live before
#                                     the last deploy (docs/process.md, "Rollback")
#   deploy/deploy.sh --build          the fallback: send the commit's tree and build
#                                     both images on the server, as before images
#                                     were pulled (a commit CI pushed no images for)
#   deploy/deploy.sh --skip-ci-check  emergencies only: ship without a green CI run
#
# Before anything leaves this machine it refuses (exit code in brackets):
#   [3] a working tree with changes, other than uncommitted brand files under
#       frontend/public/brand/, which the owner keeps there on purpose and
#       which are never shipped (see "What ships" below);
#   [4] a commit that is not on origin/main (pushed, so CI has seen it);
#   [5] a commit with no successful `ci` run of its own: its run on main
#       still running, failed, cancelled, or never ran, and no successful
#       merge queue run of that commit either.
# Then on the server, before anything there changes:
#   [7] the server cannot pull from ghcr.io: the images are private and it
#       is not logged in, or its token cannot read them. What to run, once,
#       is printed;
#   [8] no image of this commit in the registry: CI pushes them only for a
#       commit on main or in the merge queue whose images job passed (and
#       only since pull mode). --build builds it on the server instead.
#
# What ships is the commit and nothing else. Pulled: the images CI built
# from it (ghcr.io/sadeghianme/liveface-{api,web}:<commit>), after they
# booted, served every page and ran the avatar wizard end to end; of the
# tree, only deploy/docker-compose.prod.yml goes to the server, out of
# `git archive <commit>`. With --build: `git archive <commit>`, the
# committed tree, never the working tree, so an uncommitted favicon or an
# untracked concepts/ folder cannot reach the server by accident. The commit
# is baked into both images (LIVEFACE_VERSION); after the restart this script
# reads it back from /api/health and /version.json, so "deployed" means the
# new containers are the ones answering, not merely that something is up.
#
# This exists because deploying by hand went wrong three separate ways in one
# session, each of them silent:
#
#   1. rsync to /opt/liveface, which is not where the containers run. The sync
#      "succeeded" and changed nothing.
#   2. `docker compose up` without -f, since the compose file is not named
#      docker-compose.yml. Fails with a message that sounds like the file is
#      missing entirely.
#   3. rsync --delete removed deploy/.env, which is gitignored and so looks
#      like a deleted file from the source side. The site stayed up on the old
#      containers, so nothing appeared wrong until the next build.
#
# Any of those leaves a deploy that reports success while serving stale code.
#
# Every remote command below is built from this script's own values, expanded
# here before ssh sends them; that is the intent, not an escaping slip.
# shellcheck disable=SC2029
set -euo pipefail

# Keepalives, because this script hung twice after a successful deploy: a
# build that pulls ~850MB of models can leave the connection silent for
# minutes, and without them ssh waits forever rather than noticing. The
# deploy had actually finished both times, which is the worst version of
# this failure -- it looks like a broken deploy and is not.
SSH_OPTS=(-o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o ConnectTimeout=20)
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }

REMOTE="${REMOTE:-personal_server}"
REMOTE_DIR="${REMOTE_DIR:-/root/projects/liveface}"
PUBLIC_URL="${PUBLIC_URL:-https://avatar.mehdisadeghian.com}"
# Database backups kept in /data (the newest N; older ones are deleted).
BACKUP_KEEP="${BACKUP_KEEP:-10}"
COMPOSE="docker-compose.prod.yml"
API_CONTAINER="liveface-liveface-api-1"
# What compose runs: the images it names after the project and the service.
# A deploy tags what it ships as :latest of these; :release and :previous
# are the last two releases a deploy verified.
API_IMAGE="liveface-liveface-api"
WEB_IMAGE="liveface-liveface-web"
# Where CI pushes the images it tested, tagged with the commit (private;
# ci.yml, the images job). The server pulls them with its own login.
REGISTRY="ghcr.io"
REGISTRY_USER="sadeghianme"
GHCR_API="$REGISTRY/$REGISTRY_USER/liveface-api"
GHCR_WEB="$REGISTRY/$REGISTRY_USER/liveface-web"
# The label both Dockerfiles set: what marks an image as this project's when
# the leftovers of earlier releases are pruned.
IMAGE_SOURCE="https://github.com/sadeghianme/avatar-face"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Uncommitted changes here are tolerated, and never shipped.
BRAND_DIR="frontend/public/brand/"

DRY_RUN=0
SKIP_CI=0
ROLLBACK=0
BUILD=0
REF="HEAD"

# The header above, up to "What ships".
usage() { awk 'NR > 2 && /^# What ships/ { exit } NR > 2 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-ci-check) SKIP_CI=1 ;;
    --rollback) ROLLBACK=1 ;;
    --build) BUILD=1 ;;
    --ref)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      REF="$2"
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

refuse() { # code message...
  local code="$1"
  shift
  echo "REFUSED: $*" >&2
  exit "$code"
}

need() {
  command -v "$1" >/dev/null 2>&1 || refuse 6 "'$1' is not installed; it is needed to $2."
}

# The "version" field of /api/health and of /version.json: the commit each
# image was built from (one-line JSON; no jq needed).
json_version() { sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }

# ---------------------------------------------------------------- rollback ---

if [ "$ROLLBACK" = 1 ]; then
  echo "==> rollback: $API_IMAGE:previous and $WEB_IMAGE:previous become :latest"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  dry run: would re-tag both :previous images as :latest on $REMOTE,"
    echo "  'docker compose -f $COMPOSE up -d --no-build' in $REMOTE_DIR/deploy,"
    echo "  then wait for $PUBLIC_URL/api/health to report the previous release."
    exit 0
  fi
  need ssh "reach the server"
  need curl "check the site's health"
  # The release being restored, from the label its image was built with
  # (empty for an image built before releases were labelled).
  PREVIOUS="$(ssh "$REMOTE" "docker image inspect $API_IMAGE:previous $WEB_IMAGE:previous >/dev/null \
    && docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' $API_IMAGE:previous")" \
    || refuse 1 "no :previous images on $REMOTE: nothing to roll back to."
  echo "  restoring release: ${PREVIOUS:-<unlabelled, built before releases were versioned>}"
  ssh "$REMOTE" "docker tag $API_IMAGE:previous $API_IMAGE:latest \
    && docker tag $WEB_IMAGE:previous $WEB_IMAGE:latest \
    && cd $REMOTE_DIR/deploy && docker compose -f $COMPOSE up -d --no-build"
  echo "==> waiting for the API"
  for attempt in $(seq 1 60); do
    body="$(curl -sf --max-time 10 "$PUBLIC_URL/api/health" || true)"
    version="$(printf '%s\n' "$body" | json_version)"
    # An unlabelled release predates the version field: answering is all it can say.
    if [ -n "$body" ] && { [ -z "$PREVIOUS" ] || [ "$version" = "$PREVIOUS" ]; }; then
      echo "  healthy after ${attempt} attempt(s), version ${version:-unreported}"
      break
    fi
    if [ "$attempt" -eq 60 ]; then
      echo "  the API did not report ${PREVIOUS:-a healthy release} within 5 minutes" >&2
      echo "    ssh $REMOTE 'docker ps --filter name=liveface'" >&2
      exit 1
    fi
    sleep 5
  done
  # The restored release is now the one a later rollback must not undo.
  ssh "$REMOTE" "docker tag $API_IMAGE:previous $API_IMAGE:release && docker tag $WEB_IMAGE:previous $WEB_IMAGE:release"
  echo "==> ROLLED BACK to ${PREVIOUS:-the previous images}"
  echo "  The database was not touched. If the release rolled back had run a migration,"
  echo "  this code now runs on the newer schema; restore the backup deploy.sh took"
  echo "  before that release if it cannot (ls /data/liveface.sqlite3.bak-* in the API container)."
  exit 0
fi

# --------------------------------------------------------------- preflight ---

need git "read the commit to ship"
[ "$SKIP_CI" = 1 ] || need gh "ask GitHub whether CI passed (or pass --skip-ci-check)"
[ "$BUILD" = 0 ] || need tar "unpack the release"
if [ "$DRY_RUN" = 0 ]; then
  [ "$BUILD" = 0 ] || need rsync "send the release"
  need ssh "reach the server"
  need curl "check the site's health"
fi
git -C "$LOCAL_DIR" rev-parse --git-dir >/dev/null 2>&1 \
  || refuse 6 "$LOCAL_DIR is not a git checkout; releases are made from commits."

echo "==> checking the working tree"
blocking=""
brand=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  path="${line:3}"
  case "$path" in
    *" -> "*) blocking="$blocking  $line"$'\n' ;; # a rename: never tolerated
    "$BRAND_DIR"*) brand="$brand  $line"$'\n' ;;
    *) blocking="$blocking  $line"$'\n' ;;
  esac
done <<EOF
$(git -C "$LOCAL_DIR" status --porcelain=v1 --untracked-files=all)
EOF
if [ -n "$blocking" ]; then
  printf '%s' "$blocking" >&2
  refuse 3 "the working tree has changes. Commit and push them (then wait for CI), or stash them: the release is a commit, and these would not be in it."
fi
if [ -n "$brand" ]; then
  echo "  uncommitted brand files, tolerated and NOT shipped (the commit's own copies are):"
  printf '%s' "$brand"
fi

echo "==> checking the commit is on origin/main"
git -C "$LOCAL_DIR" fetch --quiet origin main \
  || refuse 4 "could not fetch origin/main to check the commit was pushed."
SHA="$(git -C "$LOCAL_DIR" rev-parse --verify --quiet "$REF^{commit}")" \
  || refuse 2 "'$REF' is not a commit."
SUBJECT="$(git -C "$LOCAL_DIR" log -1 --format=%s "$SHA")"
git -C "$LOCAL_DIR" merge-base --is-ancestor "$SHA" origin/main \
  || refuse 4 "$SHA is not on origin/main. Push it (git push origin main) and let CI run on it first."
echo "  $SHA $SUBJECT"

echo "==> checking CI passed for this exact commit"
CI_RESULT=""
if [ "$SKIP_CI" = 1 ]; then
  {
    echo "  ######################################################################"
    echo "  ##  --skip-ci-check: SHIPPING A COMMIT CI HAS NOT PASSED.           ##"
    echo "  ##  Emergencies only. Nothing has proven this commit's tests,       ##"
    echo "  ##  lint, type checks or image builds. Re-run CI on it, and roll    ##"
    echo "  ##  back (deploy.sh --rollback) if anything looks wrong.            ##"
    echo "  ######################################################################"
  } >&2
  CI_RESULT="SKIPPED (--skip-ci-check)"
else
  # Two kinds of run test exactly this commit: the push of it to main, and,
  # with the merge queue, the queue's run of the commit it then put on main
  # (the same commit, tested before it landed). A pull request's run tests
  # a merge commit, not this tree, and a re-run replaces its run's result in
  # place, so the newest run of each kind decides.
  #
  # The push run decides when it finished other than cancelled: a red main
  # is never shipped, even if the queue's run of it passed. When it is
  # missing, still running or cancelled (a newer push supersedes it), a
  # successful queue run is enough: that is what lets a deploy start as
  # soon as the queue merges.
  push_run="$(cd "$LOCAL_DIR" && gh run list --commit "$SHA" --workflow ci --branch main --event push \
    --limit 1 --json status,conclusion,url --jq '.[] | [.status, .conclusion, .url] | join("|")')" \
    || refuse 5 "could not ask GitHub for CI runs (gh auth status?). --skip-ci-check exists for emergencies."
  IFS='|' read -r push_status push_conclusion push_url <<EOF
$push_run
EOF
  if [ "$push_status" = completed ] && [ "$push_conclusion" = success ]; then
    CI_RESULT="success (push to main) $push_url"
  elif [ "$push_status" = completed ] && [ "$push_conclusion" != cancelled ]; then
    refuse 5 "CI concluded '$push_conclusion' for $SHA: $push_url"
  else
    # The queue's runs are on its own branches, gh-readonly-queue/main/<entry>.
    queue_run="$(cd "$LOCAL_DIR" && gh run list --commit "$SHA" --workflow ci --event merge_group \
      --limit 5 --json status,conclusion,url,headBranch \
      --jq '[.[] | select(.headBranch | startswith("gh-readonly-queue/main/"))] | .[:1][] | [.status, .conclusion, .url] | join("|")')" \
      || refuse 5 "could not ask GitHub for CI runs (gh auth status?). --skip-ci-check exists for emergencies."
    IFS='|' read -r queue_status queue_conclusion queue_url <<EOF
$queue_run
EOF
    if [ "$queue_status" = completed ] && [ "$queue_conclusion" = success ]; then
      CI_RESULT="success (merge queue) $queue_url"
    elif [ -n "$push_run" ] && [ "$push_status" != completed ]; then
      refuse 5 "CI is still running for $SHA ($push_status): $push_url -- wait for it (gh run watch)."
    elif [ -n "$push_run" ]; then
      refuse 5 "CI concluded '$push_conclusion' for $SHA: $push_url"
    elif [ -n "$queue_run" ] && [ "$queue_status" != completed ]; then
      refuse 5 "the merge queue's CI is still running for $SHA ($queue_status): $queue_url -- wait for it (gh run watch)."
    elif [ -n "$queue_run" ]; then
      refuse 5 "the merge queue's CI concluded '$queue_conclusion' for $SHA: $queue_url"
    else
      refuse 5 "no CI run on main for $SHA. CI runs once per push, on its newest commit: deploy that commit (or a later one)."
    fi
  fi
  echo "  $CI_RESULT"
fi

# ----------------------------------------------------------------- release ---

API_REF="$GHCR_API:$SHA"
WEB_REF="$GHCR_WEB:$SHA"

if [ "$BUILD" = 1 ]; then
  EXPORT="$(mktemp -d "${TMPDIR:-/tmp}/liveface-release.XXXXXX")"
  trap 'rm -rf "$EXPORT"' EXIT
  git -C "$LOCAL_DIR" archive --format=tar "$SHA" | tar -x -C "$EXPORT"
  FILES="$(find "$EXPORT" -type f | wc -l | tr -d ' ')"
  KB="$(du -sk "$EXPORT" | cut -f1)"
  echo "==> release $SHA: $FILES files, $((KB / 1024)) MB (git archive of the commit), built on the server (--build)"
else
  echo "==> release $SHA: the images CI tested"
  echo "  $API_REF"
  echo "  $WEB_REF"
fi

if [ "$DRY_RUN" = 1 ]; then
  if [ "$BUILD" = 1 ]; then
    for entry in "$EXPORT"/* "$EXPORT"/.[!.]*; do
      [ -e "$entry" ] || continue
      printf '  %8s KB  %s\n' "$(du -sk "$entry" | cut -f1)" "${entry#"$EXPORT"/}"
    done
    echo "==> dry run: nothing sent. A deploy with --build would:"
    echo "  rsync this tree to $REMOTE:$REMOTE_DIR (--delete; deploy/.env and server data kept)"
    echo "  back up /data/liveface.sqlite3 (keeping the newest $BACKUP_KEEP backups)"
    echo "  keep the live release as :previous, build with LIVEFACE_VERSION=$SHA, restart"
  else
    echo "==> dry run: nothing sent, the server not contacted. A deploy would, on $REMOTE:"
    echo "  pull both images (the server must be logged in to $REGISTRY, once: docs/process.md)"
    echo "  update $REMOTE_DIR/deploy/$COMPOSE from the commit (deploy/.env untouched)"
    echo "  back up /data/liveface.sqlite3 (keeping the newest $BACKUP_KEEP backups)"
    echo "  keep the live release as :previous, tag the pulled images :latest and restart"
    echo "  them, building nothing"
  fi
  echo "  require $PUBLIC_URL/api/health and /version.json to report $SHA"
  exit 0
fi

check_env() {
  ssh "$REMOTE" "test -s $REMOTE_DIR/deploy/.env" || {
    echo "ERROR: $REMOTE_DIR/deploy/.env is missing or empty." >&2
    echo "If the containers are still running, recover it before restarting them:" >&2
    echo "  docker inspect liveface-liveface-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \\" >&2
    echo "    | grep '^JWT_SECRET=' > $REMOTE_DIR/deploy/.env" >&2
    exit 1
  }
}

if [ "$BUILD" = 1 ]; then
  echo "==> syncing the release -> $REMOTE:$REMOTE_DIR"
  # The source is the clean export, so these excludes no longer filter what is
  # sent; they protect what lives only on the server from --delete:
  # .env above all, deliberately excluded and NOT merely ignored, because it
  # exists only on the server and --delete would otherwise remove the one copy
  # of the secret. Local databases and the image store are the server's data.
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
    --exclude '.git' \
    --exclude '.claude' \
    --exclude '.env' \
    --exclude 'node_modules' \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '*.sqlite3' \
    --exclude '*.sqlite3-wal' \
    --exclude '*.sqlite3-shm' \
    --exclude 'backend/local_storage' \
    "$EXPORT/" "$REMOTE:$REMOTE_DIR/"

  echo "==> checking the server can still build"
  check_env
else
  echo "==> checking the server's deploy/.env"
  check_env

  # Pulled before anything on the server changes: a server that cannot read
  # the registry, or a commit with no images, stops here with the old
  # release serving and the database untouched. A pull of a code change is
  # a few MB: every layer below the source (system libraries, models,
  # Python libraries) is already there.
  echo "==> pulling the images"
  pull_status=0
  ssh "$REMOTE" bash -s -- "$REGISTRY" "$API_REF" "$WEB_REF" <<'REMOTE_SCRIPT' || pull_status=$?
set -uo pipefail
registry="$1"
shift
for ref in "$@"; do
  started=$(date +%s)
  if out="$(docker pull --quiet "$ref" 2>&1)"; then
    echo "  $ref ($(($(date +%s) - started))s)"
    continue
  fi
  printf '%s\n' "$out" | sed 's/^/  docker: /' >&2
  case "$out" in
    *"manifest unknown"* | *"not found"*) exit 8 ;;
  esac
  # Refused (a private image answers "denied" to a reader it does not
  # know). Whether docker has a login for the registry at all says which
  # fix applies: the key alone is read, never the credential beside it.
  if grep -qs "\"$registry\"" "${DOCKER_CONFIG:-$HOME/.docker}/config.json"; then
    echo "  docker here has a login for $registry, and the registry refused it" >&2
  else
    echo "  docker here has no login for $registry" >&2
  fi
  exit 7
done
REMOTE_SCRIPT
  case "$pull_status" in
    0) ;;
    7)
      {
        echo "REFUSED: $REMOTE cannot pull from $REGISTRY (above: what docker said)."
        echo "  The images are private, so docker on the server needs a login to $REGISTRY,"
        echo "  made once, by the owner. This script never asks for or handles the token."
        echo "  A login it has but the registry refuses is a token without read:packages,"
        echo "  or an expired one: make a new one and log in again, the same way."
        echo "  1. Create a personal access token (classic) with the read:packages scope"
        echo "     alone (GitHub's registry accepts no fine-grained token):"
        echo "       https://github.com/settings/tokens/new?scopes=read:packages&description=liveface-server-pull"
        echo "  2. On the server, give it to docker on stdin, so it is in no shell history:"
        echo "       ssh $REMOTE"
        echo "       docker login $REGISTRY -u $REGISTRY_USER --password-stdin"
        echo "     then paste the token, press Enter and Ctrl-D; it answers 'Login Succeeded'."
        echo "  3. Run this deploy again. A token that expires stops deploys here again."
        echo "  Meanwhile, deploy/deploy.sh --build builds the images on the server instead."
      } >&2
      exit 7
      ;;
    8)
      refuse 8 "no image of $SHA in $REGISTRY. CI pushes both images only for a commit on main
  or in the merge queue whose images job passed (see its run), and only since images were
  pulled; an older commit was never pushed. Deploy a newer commit, or build this one on the
  server with: deploy/deploy.sh --build --ref $SHA"
      ;;
    *)
      echo "ERROR: pulling the images failed (ssh exit $pull_status); nothing on the server changed." >&2
      exit 1
      ;;
  esac

  echo "==> updating deploy/$COMPOSE on the server"
  # That file alone, from the commit (git archive), over the server's copy.
  # deploy/.env is not in any commit, so this cannot touch it.
  git -C "$LOCAL_DIR" archive --format=tar "$SHA" "deploy/$COMPOSE" \
    | ssh "$REMOTE" "mkdir -p $REMOTE_DIR && tar -x -C $REMOTE_DIR"
fi

# Not cp: the database is in WAL mode, so recent commits live in the -wal
# file beside it, and a copy of the main file alone silently lacks them.
# backup_db.py takes a consistent, compacted copy instead (VACUUM INTO);
# see its docstring.
BACKUP="/data/liveface.sqlite3.bak-$(date +%Y%m%d-%H%M%S)"
echo "==> backing up the database to $BACKUP"
ssh "$REMOTE" "docker exec -i $API_CONTAINER python - /data/liveface.sqlite3 $BACKUP" \
  < "$LOCAL_DIR/deploy/backup_db.py"
# The stamp sorts by time, so the newest are last in name order. Only the
# backups this script makes (bak-YYYYMMDD-HHMMSS) are pruned: a backup made
# by hand before a migration (e.g. bak-premigrate-<stamp>) is kept until
# someone deletes it on purpose.
ssh "$REMOTE" "docker exec $API_CONTAINER sh -c \
  'ls -1 /data/liveface.sqlite3.bak-[0-9]* | sort -r | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -v --'" \
  | sed 's/^/  pruned: /'

# What is live now becomes :previous, the target of --rollback. That is the
# last release this script verified (:release) when there is one -- not
# whatever happens to be running, which after a failed deploy is the
# release that failed.
echo "==> keeping the live release for --rollback"
ssh "$REMOTE" bash -s -- "$API_IMAGE" "$WEB_IMAGE" <<'REMOTE_SCRIPT'
set -euo pipefail
for image in "$1" "$2"; do
  if docker image inspect "$image:release" >/dev/null 2>&1; then
    docker tag "$image:release" "$image:previous"
  # The first deploy made by this script: what runs is the only release
  # there is. Compose names the container after the image, plus "-1".
  elif running="$(docker inspect --format '{{.Image}}' "${image}-1" 2>/dev/null)"; then
    docker tag "$running" "$image:previous"
  fi
done
echo "  previous: $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1:previous" 2>/dev/null || echo none)"
REMOTE_SCRIPT

if [ "$BUILD" = 1 ]; then
  echo "==> building and restarting"
  ssh "$REMOTE" "cd $REMOTE_DIR/deploy && LIVEFACE_VERSION=$SHA docker compose -f $COMPOSE up -d --build" || {
    echo "  build or restart failed. Compose replaces no container until every image builds," >&2
    echo "  so a failed BUILD leaves the old release serving. If containers were replaced:" >&2
    echo "    deploy/deploy.sh --rollback" >&2
    exit 1
  }
else
  # The pulled images become what compose runs (:latest of its own names),
  # so --rollback, :release and :previous work as they always have, and
  # compose builds nothing.
  echo "==> restarting on the pulled images"
  ssh "$REMOTE" "docker tag $API_REF $API_IMAGE:latest && docker tag $WEB_REF $WEB_IMAGE:latest \
    && cd $REMOTE_DIR/deploy && docker compose -f $COMPOSE up -d --no-build" || {
    echo "  restart failed. If containers were replaced: deploy/deploy.sh --rollback" >&2
    exit 1
  }
fi

# Wait for the API to answer before exec'ing into the container. Running
# `docker exec` against a container that is still restarting blocks with no
# output and no timeout -- which is what the hang looked like from here.
# Answering is not enough: it must be the release just shipped.
echo "==> waiting for the API to report $SHA"
for attempt in $(seq 1 60); do
  version="$(curl -sf --max-time 10 "$PUBLIC_URL/api/health" | json_version || true)"
  if [ "$version" = "$SHA" ]; then
    echo "  healthy after ${attempt} attempt(s)"
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "  the API did not report $SHA within 5 minutes (last answer: ${version:-none})" >&2
    echo "  The restart may still have succeeded -- check:" >&2
    echo "    ssh $REMOTE 'docker ps --filter name=liveface'" >&2
    echo "  and put the previous release back with: deploy/deploy.sh --rollback" >&2
    exit 1
  fi
  sleep 5
done
# The query string keeps Cloudflare from answering with a cached copy.
web_version="$(curl -sf --max-time 20 "$PUBLIC_URL/version.json?release=$SHA" | json_version || true)"
if [ "$web_version" != "$SHA" ]; then
  echo "  the dashboard reports '${web_version:-nothing}', not $SHA" >&2
  echo "  put the previous release back with: deploy/deploy.sh --rollback" >&2
  exit 1
fi

# Verified: this is now the release a later deploy keeps as :previous.
ssh "$REMOTE" "docker tag $API_IMAGE:latest $API_IMAGE:release && docker tag $WEB_IMAGE:latest $WEB_IMAGE:release"

echo "==> verifying"
ssh "$REMOTE" "docker exec $API_CONTAINER python -c \"
import sqlite3
c = sqlite3.connect('/data/liveface.sqlite3')
print('  alembic:', list(c.execute('select * from alembic_version'))[0][0])
for t in ('users','organizations','avatars','api_keys'):
    print('  %-14s %d' % (t, list(c.execute('select count(*) from '+t))[0][0]))
\""
curl -sf --max-time 20 -o /dev/null -w '  app %{http_code}\n' "$PUBLIC_URL/"
curl -sf --max-time 20 -o /dev/null -w '  api %{http_code}\n' "$PUBLIC_URL/api/health"

# Leftovers, best effort (a failure here is reported, never fatal: the
# release is verified). The registry tags of earlier releases: :release and
# :previous keep what a rollback needs. Then this project's images that no
# tag names any more -- the releases before :previous, which every deploy
# leaves behind and which filled the disk by a GB each. Only images with
# this project's source label, and only untagged ones.
echo "==> pruning earlier releases' images"
ssh "$REMOTE" bash -s -- "$SHA" "$IMAGE_SOURCE" "$GHCR_API" "$GHCR_WEB" <<'REMOTE_SCRIPT' \
  || echo "  pruning failed; nothing depends on it (docker image ls on the server)" >&2
set -uo pipefail
keep="$1"
source="$2"
shift 2
for repo in "$@"; do
  for tag in $(docker image ls "$repo" --format '{{.Tag}}'); do
    if [ "$tag" != "$keep" ]; then
      docker image rm "$repo:$tag" >/dev/null && echo "  untagged $repo:$tag"
    fi
  done
done
docker image prune --force --filter "label=org.opencontainers.image.source=$source" | sed -n 's/^Total/  total/p'
REMOTE_SCRIPT

echo "==> DEPLOY"
echo "  release   $SHA $SUBJECT"
echo "  CI        $CI_RESULT"
if [ "$BUILD" = 1 ]; then
  echo "  images    built on the server (--build)"
else
  echo "  images    pulled: $API_REF, $WEB_REF"
fi
echo "  api, web  both report $SHA"
echo "  backup    $BACKUP"
echo "  rollback  deploy/deploy.sh --rollback (restores :previous; the database is left as is)"
echo "==> done. The widget is cached for 4h — hard-refresh embedding sites."
