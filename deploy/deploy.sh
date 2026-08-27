#!/usr/bin/env bash
#
# Sync this working tree to the server and rebuild.
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
set -euo pipefail

# Keepalives, because this script hung twice after a successful deploy: a
# build that pulls ~850MB of models can leave the connection silent for
# minutes, and without them ssh waits forever rather than noticing. The
# deploy had actually finished both times, which is the worst version of
# this failure -- it looks like a broken deploy and is not.
SSH_OPTS="-o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o ConnectTimeout=20"
ssh() { command ssh $SSH_OPTS "$@"; }

REMOTE="${REMOTE:-personal_server}"
REMOTE_DIR="${REMOTE_DIR:-/root/projects/liveface}"
COMPOSE="docker-compose.prod.yml"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> syncing $LOCAL_DIR -> $REMOTE:$REMOTE_DIR"
# .env is deliberately excluded, NOT merely ignored: it exists only on the
# server, so --delete would otherwise remove the one copy of the secret.
rsync -az --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '*.sqlite3' \
  "$LOCAL_DIR/" "$REMOTE:$REMOTE_DIR/"

echo "==> checking the server can still build"
ssh "$REMOTE" "test -s $REMOTE_DIR/deploy/.env" || {
  echo "ERROR: $REMOTE_DIR/deploy/.env is missing or empty." >&2
  echo "If the containers are still running, recover it before restarting them:" >&2
  echo "  docker inspect liveface-liveface-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \\" >&2
  echo "    | grep '^JWT_SECRET=' > $REMOTE_DIR/deploy/.env" >&2
  exit 1
}

echo "==> backing up the database"
ssh "$REMOTE" "docker exec liveface-liveface-api-1 sh -c \
  'cp /data/liveface.sqlite3 /data/liveface.sqlite3.bak-\$(date +%Y%m%d-%H%M%S)'"

echo "==> building and restarting"
ssh "$REMOTE" "cd $REMOTE_DIR/deploy && docker compose -f $COMPOSE up -d --build"

# Wait for the API to answer before exec'ing into the container. Running
# `docker exec` against a container that is still restarting blocks with no
# output and no timeout -- which is what the hang looked like from here.
echo "==> waiting for the API"
for attempt in $(seq 1 60); do
  if curl -sf --max-time 10 -o /dev/null https://avatar.mehdisadeghian.com/api/health; then
    echo "  healthy after ${attempt} attempt(s)"
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "  API did not become healthy within 5 minutes" >&2
    echo "  The build may still have succeeded -- check:" >&2
    echo "    ssh $REMOTE 'docker ps --filter name=liveface'" >&2
    exit 1
  fi
  sleep 5
done

echo "==> verifying"
ssh "$REMOTE" "docker exec liveface-liveface-api-1 python -c \"
import sqlite3
c = sqlite3.connect('/data/liveface.sqlite3')
print('  alembic:', list(c.execute('select * from alembic_version'))[0][0])
for t in ('users','organizations','avatars','api_keys'):
    print('  %-14s %d' % (t, list(c.execute('select count(*) from '+t))[0][0]))
\""
curl -sf --max-time 20 -o /dev/null -w '  app %{http_code}\n' https://avatar.mehdisadeghian.com/
curl -sf --max-time 20 -o /dev/null -w '  api %{http_code}\n' https://avatar.mehdisadeghian.com/api/health
echo "==> done. The widget is cached for 4h — hard-refresh embedding sites."
