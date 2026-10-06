#!/usr/bin/env bash
#
# Tests for deploy.sh's gates, run by CI (the deploy-script job) and by hand:
#   deploy/test-deploy.sh
#
# Hermetic: a scratch repository with its own bare "origin", and a stub `gh`
# on PATH that answers as `gh run list ... --jq` would. Every case runs
# deploy.sh --dry-run, which never contacts a server, and checks its exit
# code and what it says.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/liveface-deploy-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

git_() { git -C "$WORK/repo" -c user.name=test -c user.email=test@example.com "$@"; }

git init -q --bare --initial-branch=main "$WORK/origin.git"
git init -q --initial-branch=main "$WORK/repo"
mkdir -p "$WORK/repo/deploy" "$WORK/repo/frontend/public/brand" "$WORK/repo/backend"
cp "$HERE/deploy.sh" "$WORK/repo/deploy/deploy.sh"
echo "committed icon" >"$WORK/repo/frontend/public/brand/favicon-64.png"
echo "print('api')" >"$WORK/repo/backend/main.py"
git_ add -A
git_ commit -q -m "first release"
git_ remote add origin "$WORK/origin.git"
git_ push -q origin main
FIRST="$(git_ rev-parse HEAD)"

# The stub records how it was asked, and answers from $GH_RUNS (the
# "status|conclusion|url" line deploy.sh's --jq produces; empty = no runs).
mkdir "$WORK/bin"
cat >"$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ -n "${GH_RUNS:-}" ] && printf '%s\n' "$GH_RUNS"
exit 0
STUB
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH" GH_LOG="$WORK/gh.log"
GREEN="completed|success|https://github.com/example/actions/runs/1"

failures=0
# case <name> <expected exit> <text the output must contain> -- <deploy.sh args...>
case_() {
  local name="$1" want="$2" text="$3"
  shift 4
  local got=0
  "$WORK/repo/deploy/deploy.sh" --dry-run "$@" >"$WORK/out" 2>&1 || got=$?
  if [ "$got" = "$want" ] && grep -qF -- "$text" "$WORK/out"; then
    echo "ok   $name"
  else
    echo "FAIL $name: exit $got (wanted $want), output:"
    sed 's/^/     | /' "$WORK/out"
    failures=$((failures + 1))
  fi
}

export GH_RUNS="$GREEN"
case_ "a clean, pushed commit with green CI ships" 0 "release $FIRST" --
if grep -q -- "--commit $FIRST --workflow ci --branch main --event push" "$GH_LOG"; then
  echo "ok   CI is asked about that exact commit, on main, by push"
else
  echo "FAIL gh was asked: $(cat "$GH_LOG")"
  failures=$((failures + 1))
fi

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

GH_RUNS="in_progress||https://github.com/example/actions/runs/2"
case_ "CI still running is refused" 5 "CI is still running" --
GH_RUNS="completed|failure|https://github.com/example/actions/runs/3"
case_ "red CI is refused" 5 "CI concluded 'failure'" --
GH_RUNS="completed|cancelled|https://github.com/example/actions/runs/4"
case_ "cancelled CI is refused" 5 "CI concluded 'cancelled'" --
GH_RUNS=""
case_ "no CI run at all is refused" 5 "no CI run on main" --
case_ "--skip-ci-check ships anyway, loudly" 0 "SHIPPING A COMMIT CI HAS NOT PASSED" -- --skip-ci-check

GH_RUNS="$GREEN"
case_ "--rollback --dry-run explains itself without contacting the server" 0 ":previous" -- --rollback
case_ "an unknown option is a usage error" 2 "unknown option" -- --deploy-everything

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all deploy.sh gates behave"
