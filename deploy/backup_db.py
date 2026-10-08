"""Consistent, compact copy of the live SQLite database, taken by deploy.sh.

The API runs the database in WAL mode (app.db): a commit lands in
liveface.sqlite3-wal and reaches the main file only at a checkpoint, and the
API's pooled connections stay open for the life of the process, so that can
be a long time. Copying the main file alone therefore misses every commit
since the last checkpoint, silently; a backup that lacks the newest users,
avatars and publishes is found out only when it is restored.

`VACUUM INTO` reads one consistent snapshot through the WAL while the API
keeps writing (it is a read transaction, which WAL never makes a writer wait
for), and writes it out compacted. SQLite's online backup API, used before,
copied the file page for page, free pages included: after migration 028
moved the speech cache out of the database, every backup would still have
carried the space the audio had held. (The live file keeps those pages and
reuses them for new rows; docs/process.md, "Database size", says how to
compact it.)

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
    # VACUUM INTO refuses a target that is not empty; say why first.
    if Path(target).exists():
        raise SystemExit(f"{target} already exists")
    with closing(sqlite3.connect(source)) as src:
        src.execute("VACUUM INTO ?", (target,))


if __name__ == "__main__":
    backup(sys.argv[1], sys.argv[2])
