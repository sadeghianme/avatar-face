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

echo "==> verifying"
ssh "$REMOTE" "docker exec liveface-liveface-api-1 python -c \"
import sqlite3
c = sqlite3.connect('/data/liveface.sqlite3')
print('  alembic:', list(c.execute('select * from alembic_version'))[0][0])
for t in ('users','organizations','avatars','api_keys'):
    print('  %-14s %d' % (t, list(c.execute('select count(*) from '+t))[0][0]))
\""
curl -sf -o /dev/null -w '  app %{http_code}\n' https://avatar.mehdisadeghian.com/
curl -sf -o /dev/null -w '  api %{http_code}\n' https://avatar.mehdisadeghian.com/api/health
echo "==> done. The widget is cached for 4h — hard-refresh embedding sites."
