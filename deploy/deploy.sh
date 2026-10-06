#!/usr/bin/env bash
#
# Deploy one commit of main to the server: exactly the tree CI tested.
#
#   deploy/deploy.sh                  deploy HEAD
#   deploy/deploy.sh --ref <commit>   deploy another commit of origin/main
#   deploy/deploy.sh --dry-run        every check, then print what would ship;
#                                     nothing is sent and the server is not contacted
#   deploy/deploy.sh --rollback       put back the release that was live before
#                                     the last deploy (docs/process.md, "Rollback")
#   deploy/deploy.sh --skip-ci-check  emergencies only: ship without a green CI run
#
# Before anything leaves this machine it refuses (exit code in brackets):
#   [3] a working tree with changes, other than uncommitted brand files under
#       frontend/public/brand/, which the owner keeps there on purpose and
#       which are never shipped (see "What ships" below);
#   [4] a commit that is not on origin/main (pushed, so CI has seen it);
#   [5] a commit whose own `ci` run on main did not succeed (still running,
#       failed, cancelled, or never ran).
#
# What ships is `git archive <commit>`: the committed tree of that commit and
# nothing else. Never the working tree, so an uncommitted favicon or an
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
API_IMAGE="liveface-liveface-api"
WEB_IMAGE="liveface-liveface-web"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Uncommitted changes here are tolerated, and never shipped.
BRAND_DIR="frontend/public/brand/"

DRY_RUN=0
SKIP_CI=0
ROLLBACK=0
REF="HEAD"

# The header above, up to "What ships".
usage() { awk 'NR > 2 && /^# What ships/ { exit } NR > 2 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-ci-check) SKIP_CI=1 ;;
    --rollback) ROLLBACK=1 ;;
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
need tar "unpack the release"
[ "$SKIP_CI" = 1 ] || need gh "ask GitHub whether CI passed (or pass --skip-ci-check)"
if [ "$DRY_RUN" = 0 ]; then
  need rsync "send the release"
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
  # The newest `ci` run started by a push to main for this commit decides:
  # a pull request's run tests a merge commit, not this tree, and a re-run
  # replaces its run's result in place.
  latest="$(cd "$LOCAL_DIR" && gh run list --commit "$SHA" --workflow ci --branch main --event push \
    --limit 1 --json status,conclusion,url --jq '.[] | [.status, .conclusion, .url] | join("|")')" \
    || refuse 5 "could not ask GitHub for CI runs (gh auth status?). --skip-ci-check exists for emergencies."
  if [ -z "$latest" ]; then
    refuse 5 "no CI run on main for $SHA. CI runs for the newest commit of each push: deploy that one, or start a run (gh workflow run ci)."
  fi
  IFS='|' read -r ci_status ci_conclusion ci_url <<EOF
$latest
EOF
  if [ "$ci_status" != "completed" ]; then
    refuse 5 "CI is still running for $SHA ($ci_status): $ci_url -- wait for it (gh run watch)."
  fi
  if [ "$ci_conclusion" != "success" ]; then
    refuse 5 "CI concluded '$ci_conclusion' for $SHA: $ci_url"
  fi
  CI_RESULT="success $ci_url"
  echo "  $CI_RESULT"
fi

# ----------------------------------------------------------------- release ---

EXPORT="$(mktemp -d "${TMPDIR:-/tmp}/liveface-release.XXXXXX")"
trap 'rm -rf "$EXPORT"' EXIT
git -C "$LOCAL_DIR" archive --format=tar "$SHA" | tar -x -C "$EXPORT"
FILES="$(find "$EXPORT" -type f | wc -l | tr -d ' ')"
KB="$(du -sk "$EXPORT" | cut -f1)"
echo "==> release $SHA: $FILES files, $((KB / 1024)) MB (git archive of the commit)"

if [ "$DRY_RUN" = 1 ]; then
  for entry in "$EXPORT"/* "$EXPORT"/.[!.]*; do
    [ -e "$entry" ] || continue
    printf '  %8s KB  %s\n' "$(du -sk "$entry" | cut -f1)" "${entry#"$EXPORT"/}"
  done
  echo "==> dry run: nothing sent. A deploy would:"
  echo "  rsync this tree to $REMOTE:$REMOTE_DIR (--delete; deploy/.env and server data kept)"
  echo "  back up /data/liveface.sqlite3 (keeping the newest $BACKUP_KEEP backups)"
  echo "  keep the live release as :previous, build with LIVEFACE_VERSION=$SHA, restart"
  echo "  require $PUBLIC_URL/api/health and /version.json to report $SHA"
  exit 0
fi

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
ssh "$REMOTE" "test -s $REMOTE_DIR/deploy/.env" || {
  echo "ERROR: $REMOTE_DIR/deploy/.env is missing or empty." >&2
  echo "If the containers are still running, recover it before restarting them:" >&2
  echo "  docker inspect liveface-liveface-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \\" >&2
  echo "    | grep '^JWT_SECRET=' > $REMOTE_DIR/deploy/.env" >&2
  exit 1
}

# Not cp: the database is in WAL mode, so recent commits live in the -wal
# file beside it, and a copy of the main file alone silently lacks them.
# backup_db.py uses SQLite's online backup instead; see its docstring.
BACKUP="/data/liveface.sqlite3.bak-$(date +%Y%m%d-%H%M%S)"
echo "==> backing up the database to $BACKUP"
ssh "$REMOTE" "docker exec -i $API_CONTAINER python - /data/liveface.sqlite3 $BACKUP" \
  < "$LOCAL_DIR/deploy/backup_db.py"
# The stamp sorts by time, so the newest are last in name order.
ssh "$REMOTE" "docker exec $API_CONTAINER sh -c \
  'ls -1 /data/liveface.sqlite3.bak-* | sort -r | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -v --'" \
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

echo "==> building and restarting"
ssh "$REMOTE" "cd $REMOTE_DIR/deploy && LIVEFACE_VERSION=$SHA docker compose -f $COMPOSE up -d --build" || {
  echo "  build or restart failed. Compose replaces no container until every image builds," >&2
  echo "  so a failed BUILD leaves the old release serving. If containers were replaced:" >&2
  echo "    deploy/deploy.sh --rollback" >&2
  exit 1
}

# Wait for the API to answer before exec'ing into the container. Running
# `docker exec` against a container that is still restarting blocks with no
# output and no timeout -- which is what the hang looked like from here.
# Answering is not enough: it must be the release just built.
echo "==> waiting for the API to report $SHA"
for attempt in $(seq 1 60); do
  version="$(curl -sf --max-time 10 "$PUBLIC_URL/api/health" | json_version || true)"
  if [ "$version" = "$SHA" ]; then
    echo "  healthy after ${attempt} attempt(s)"
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "  the API did not report $SHA within 5 minutes (last answer: ${version:-none})" >&2
    echo "  The build may still have succeeded -- check:" >&2
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

echo "==> DEPLOY"
echo "  release   $SHA $SUBJECT"
echo "  CI        $CI_RESULT"
echo "  api, web  both report $SHA"
echo "  backup    $BACKUP"
echo "  rollback  deploy/deploy.sh --rollback (restores :previous; the database is left as is)"
echo "==> done. The widget is cached for 4h — hard-refresh embedding sites."
