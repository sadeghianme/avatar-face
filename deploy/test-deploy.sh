#!/usr/bin/env bash
#
# Tests for deploy.sh, run by CI (the deploy-script job) and by hand:
#   deploy/test-deploy.sh
#
# Hermetic: a scratch repository with its own bare "origin", and stubs on
# PATH. `gh` answers as `gh run list ... --jq` would, from $GH_RUNS (the push
# run on main) and $GH_QUEUE_RUNS (the merge queue's run). The gates run with
# --dry-run, which never contacts a server. A whole deploy runs against a
# pretend server: `ssh` runs the remote command right here, in a scratch
# directory, where `docker` and `curl` are stubs that record what they were
# asked and answer as the server and the site would.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/liveface-deploy-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

git_() { git -C "$WORK/repo" -c user.name=test -c user.email=test@example.com "$@"; }

git init -q --bare --initial-branch=main "$WORK/origin.git"
git init -q --initial-branch=main "$WORK/repo"
mkdir -p "$WORK/repo/deploy" "$WORK/repo/frontend/public/brand" "$WORK/repo/backend"
cp "$HERE/deploy.sh" "$WORK/repo/deploy/deploy.sh"
cp "$HERE/backup_db.py" "$WORK/repo/deploy/backup_db.py"
echo "name: liveface  # the compose file, as committed" >"$WORK/repo/deploy/docker-compose.prod.yml"
echo "committed icon" >"$WORK/repo/frontend/public/brand/favicon-64.png"
echo "print('api')" >"$WORK/repo/backend/main.py"
git_ add -A
git_ commit -q -m "first release"
git_ remote add origin "$WORK/origin.git"
git_ push -q origin main
FIRST="$(git_ rev-parse HEAD)"

mkdir "$WORK/bin"
# The gh stub records how it was asked, and answers with the
# "status|conclusion|url" line deploy.sh's --jq produces (empty = no runs).
cat >"$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case " $* " in
  *" --event merge_group "*) [ -n "${GH_QUEUE_RUNS:-}" ] && printf '%s\n' "$GH_QUEUE_RUNS" ;;
  *) [ -n "${GH_RUNS:-}" ] && printf '%s\n' "$GH_RUNS" ;;
esac
exit 0
STUB
# The server: ssh drops its options and the host, and runs the command here,
# as the remote shell would.
cat >"$WORK/bin/ssh" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
exec bash -c "$*"
STUB
# docker on the server. $DOCKER_PULL picks how pulls go: ok, denied (the
# registry refuses the login), missing (no such image).
cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1 ${2:-}" in
  "pull "*)
    ref="${*: -1}"
    case "${DOCKER_PULL:-ok}" in
      ok) echo "$ref" ;;
      denied) echo "Error response from daemon: error from registry: denied" >&2; exit 1 ;;
      missing) echo "Error response from daemon: failed to resolve reference \"$ref\": $ref: not found" >&2; exit 1 ;;
    esac
    ;;
  "exec -i") cat >/dev/null ;; # the backup script, on stdin
  "image inspect")
    case " $* " in *" --format "*) echo "the-previous-release" ;; esac
    ;;
  "image ls")
    # The registry tags the server has: an earlier release's, and this one's.
    case "${*: -3:1}" in *liveface-api) printf '%s\n' "0ld0ld" "$DEPLOYING" ;; esac
    ;;
  "image prune") echo "Total reclaimed space: 0B" ;;
esac
exit 0
STUB
# The site answers as the release being deployed.
cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *%{http_code}*) printf '%s\n' "${arg//%\{http_code\}/200}" | sed 's/\\n$//'; exit 0 ;;
  esac
done
printf '{"status":"ok","version":"%s"}\n' "$DEPLOYING"
STUB
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" GH_LOG="$WORK/gh.log" DOCKER_LOG="$WORK/docker.log"
export REMOTE=test-server REMOTE_DIR="$WORK/server" PUBLIC_URL=https://liveface.test
export DOCKER_CONFIG="$WORK/docker-config"
mkdir -p "$REMOTE_DIR/deploy" "$DOCKER_CONFIG"
echo "JWT_SECRET=server-only" >"$REMOTE_DIR/deploy/.env"
GREEN="completed|success|https://github.com/example/actions/runs/1"
QUEUE_GREEN="completed|success|https://github.com/example/actions/runs/9"

failures=0
fail() {
  echo "FAIL $*"
  failures=$((failures + 1))
}
# case_ <name> <expected exit> <text the output must contain> -- <deploy.sh args...>
# runs deploy.sh --dry-run; live_ (same arguments) runs a whole deploy.
run_() {
  local name="$1" want="$2" text="$3"
  shift 4
  local got=0
  : >"$DOCKER_LOG"
  "$WORK/repo/deploy/deploy.sh" "$@" >"$WORK/out" 2>&1 </dev/null || got=$?
  if [ "$got" = "$want" ] && grep -qF -- "$text" "$WORK/out"; then
    echo "ok   $name"
  else
    fail "$name: exit $got (wanted $want), output:"
    sed 's/^/     | /' "$WORK/out"
  fi
}
case_() { run_ "$1" "$2" "$3" "$4" --dry-run "${@:5}"; }
live_() { run_ "$@"; }

export GH_RUNS="$GREEN" GH_QUEUE_RUNS=""
case_ "a clean, pushed commit with green CI ships" 0 "release $FIRST" --
if grep -q -- "--commit $FIRST --workflow ci --branch main --event push" "$GH_LOG"; then
  echo "ok   CI is asked about that exact commit, on main, by push"
else
  fail "gh was asked: $(cat "$GH_LOG")"
fi
case_ "by default the images CI pushed for the commit are pulled" 0 "ghcr.io/sadeghianme/liveface-api:$FIRST" --
case_ "--build sends the tree and builds on the server instead" 0 "build with LIVEFACE_VERSION=$FIRST" -- --build

echo "edited" >>"$WORK/repo/backend/main.py"
case_ "a modified tracked file is refused" 3 "the working tree has changes" --
git_ checkout -q -- backend/main.py

echo "stray" >"$WORK/repo/backend/notes.txt"
case_ "an untracked file is refused" 3 "?? backend/notes.txt" --
rm "$WORK/repo/backend/notes.txt"

echo "redrawn icon" >"$WORK/repo/frontend/public/brand/favicon-64.png"
mkdir -p "$WORK/repo/frontend/public/brand/concepts"
echo "idea" >"$WORK/repo/frontend/public/brand/concepts/a.png"
case_ "uncommitted brand files are tolerated and reported as not shipped" 0 "NOT shipped" --
git_ checkout -q -- frontend/public/brand/favicon-64.png
rm -r "$WORK/repo/frontend/public/brand/concepts"

echo "print('next')" >"$WORK/repo/backend/main.py"
git_ commit -q -am "not pushed yet"
case_ "a commit not on origin/main is refused" 4 "is not on origin/main" --
case_ "an earlier pushed commit can be named with --ref" 0 "release $FIRST" -- --ref "$FIRST"
git_ push -q origin main
SECOND="$(git_ rev-parse HEAD)"

GH_RUNS="in_progress||https://github.com/example/actions/runs/2"
case_ "CI still running is refused" 5 "CI is still running" --
GH_RUNS="completed|failure|https://github.com/example/actions/runs/3"
case_ "red CI is refused" 5 "CI concluded 'failure'" --
GH_RUNS="completed|cancelled|https://github.com/example/actions/runs/4"
case_ "cancelled CI is refused" 5 "CI concluded 'cancelled'" --
GH_RUNS=""
case_ "no CI run at all is refused" 5 "no CI run on main" --
case_ "--skip-ci-check ships anyway, loudly" 0 "SHIPPING A COMMIT CI HAS NOT PASSED" -- --skip-ci-check

# The merge queue: its run tested this very commit before it reached main.
: >"$GH_LOG"
GH_RUNS="" GH_QUEUE_RUNS="$QUEUE_GREEN"
case_ "a green merge queue run ships, before main's own run" 0 "success (merge queue)" --
if grep -q -- "--commit $SECOND --workflow ci --event merge_group" "$GH_LOG"; then
  echo "ok   the merge queue is asked about that exact commit"
else
  fail "gh was asked: $(cat "$GH_LOG")"
fi
GH_RUNS="in_progress||https://github.com/example/actions/runs/5"
case_ "a green merge queue run ships while main's run is still going" 0 "success (merge queue)" --
GH_RUNS="completed|cancelled|https://github.com/example/actions/runs/6"
case_ "a green merge queue run ships when main's run was superseded" 0 "success (merge queue)" --
GH_RUNS="completed|failure|https://github.com/example/actions/runs/7"
case_ "main's red run is refused even after a green merge queue run" 5 "CI concluded 'failure'" --
GH_RUNS="" GH_QUEUE_RUNS="in_progress||https://github.com/example/actions/runs/8"
case_ "a merge queue run still going is refused" 5 "the merge queue's CI is still running" --
GH_QUEUE_RUNS="completed|failure|https://github.com/example/actions/runs/8"
case_ "a red merge queue run is refused" 5 "the merge queue's CI concluded 'failure'" --
GH_RUNS="$GREEN" GH_QUEUE_RUNS=""

case_ "--rollback --dry-run explains itself without contacting the server" 0 ":previous" -- --rollback
case_ "an unknown option is a usage error" 2 "unknown option" -- --deploy-everything

# --------------------------------------------------- a whole deploy, pulled ---

export DEPLOYING="$SECOND"
api="ghcr.io/sadeghianme/liveface-api"
web="ghcr.io/sadeghianme/liveface-web"

rm -f "$DOCKER_CONFIG/config.json"
live_ "a server with no login to ghcr.io is refused, with what to run" 7 \
  "docker login ghcr.io -u sadeghianme --password-stdin" --
if grep -qvE '^(pull|image inspect)' "$DOCKER_LOG"; then
  fail "the server was changed before the login was checked: $(cat "$DOCKER_LOG")"
fi

echo '{"auths": {"ghcr.io": {}}}' >"$DOCKER_CONFIG/config.json"
export DOCKER_PULL=denied
live_ "a login the registry refuses is refused the same way" 7 "read:packages" --
export DOCKER_PULL=missing
live_ "a commit CI pushed no images for is refused, pointing at --build" 8 \
  "deploy/deploy.sh --build --ref $SECOND" --
if grep -qvE '^pull ' "$DOCKER_LOG"; then
  fail "the server was changed before the images were found: $(cat "$DOCKER_LOG")"
fi

export DOCKER_PULL=ok
echo "name: an older compose file" >"$REMOTE_DIR/deploy/docker-compose.prod.yml"
live_ "a deploy pulls both images, restarts on them, verifies and prunes" 0 "images    pulled" --
# The server's side, in order: pull, back up, keep :previous, run the pulled
# images, mark them :release once verified, then prune.
expected="pull --quiet $api:$SECOND
pull --quiet $web:$SECOND
exec -i liveface-liveface-api-1 python - /data/liveface.sqlite3
tag liveface-liveface-api:release liveface-liveface-api:previous
tag liveface-liveface-web:release liveface-liveface-web:previous
tag $api:$SECOND liveface-liveface-api:latest
tag $web:$SECOND liveface-liveface-web:latest
compose -f docker-compose.prod.yml up -d --no-build
tag liveface-liveface-api:latest liveface-liveface-api:release
tag liveface-liveface-web:latest liveface-liveface-web:release
image rm $api:0ld0ld
image prune --force --filter label=org.opencontainers.image.source=https://github.com/sadeghianme/avatar-face"
actual="$(grep -E '^(pull|exec -i|tag|compose|image rm|image prune)' "$DOCKER_LOG" | sed 's/ \/data\/liveface.sqlite3.bak-.*//')"
if [ "$actual" = "$expected" ]; then
  echo "ok   the server pulls, backs up, keeps :previous, restarts on the pulled images, then prunes"
else
  fail "the server was asked, in order:"
  printf '%s\n' "$actual" | sed 's/^/     | /'
  echo "     wanted:"
  printf '%s\n' "$expected" | sed 's/^/     | /'
fi
if grep -qE -- '--build|^build|buildx' "$DOCKER_LOG"; then
  fail "a pulled deploy built something: $(grep -E -- '--build|^build|buildx' "$DOCKER_LOG")"
else
  echo "ok   nothing is built on the server"
fi
if git_ show "$SECOND:deploy/docker-compose.prod.yml" | cmp -s - "$REMOTE_DIR/deploy/docker-compose.prod.yml" \
  && [ "$(cat "$REMOTE_DIR/deploy/.env")" = "JWT_SECRET=server-only" ]; then
  echo "ok   the commit's compose file is on the server, and deploy/.env is untouched"
else
  fail "the server's deploy/: $(ls -la "$REMOTE_DIR/deploy")"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all deploy.sh gates behave"
