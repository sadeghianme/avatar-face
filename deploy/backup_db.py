"""Consistent copy of the live SQLite database, taken by deploy.sh.

The API runs the database in WAL mode (app.db): a commit lands in
liveface.sqlite3-wal and reaches the main file only at a checkpoint, and the
API's pooled connections stay open for the life of the process, so that can
be a long time. Copying the main file alone therefore misses every commit
since the last checkpoint, silently; a backup that lacks the newest users,
avatars and publishes is found out only when it is restored. SQLite's online
backup API reads through the WAL and copies one consistent snapshot while the
API keeps writing.

Standard library only, and not part of the image: deploy.sh pipes it into the
container that is RUNNING, which is still the previous build.

    python backup_db.py /data/liveface.sqlite3 /data/liveface.sqlite3.bak-<stamp>
"""

from __future__ import annotations

import sqlite3
import sys
from contextlib import closing
from pathlib import Path


def backup(source: str, target: str) -> None:
    # sqlite3.connect creates a missing file, which would make a mistyped
    # path "succeed" with an empty backup.
    if not Path(source).is_file():
        raise SystemExit(f"no database at {source}")
    with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(target)) as dst:
        src.backup(dst)


if __name__ == "__main__":
    backup(sys.argv[1], sys.argv[2])
