"""The API's own logging survives the migrations it runs at startup."""

import json
import logging
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.ext.asyncio import create_async_engine

from app import main
from app.core.config import get_settings
from app.core.logging import JsonFormatter, configure_logging

ALEMBIC_INI = Path(main.__file__).resolve().parents[1] / "alembic.ini"


@pytest.fixture
def logging_state():
    """The process's logging set-up, put back after the test whatever it did."""
    root = logging.getLogger()
    level, handlers = root.level, root.handlers[:]
    loggers = logging.Logger.manager.loggerDict
    disabled = {
        name: logger.disabled
        for name, logger in loggers.items()
        if isinstance(logger, logging.Logger)
    }
    yield
    root.setLevel(level)
    root.handlers = handlers
    for name, logger in loggers.items():
        if isinstance(logger, logging.Logger):
            logger.disabled = disabled.get(name, False)


async def test_migrating_at_startup_keeps_the_applications_logging(
    tmp_path, monkeypatch, capsys, logging_state
):
    """alembic/env.py configured logging from alembic.ini in the API's own
    process: it replaced the JSON handler, raised the root level to WARN and
    disabled every logger already made, so production logged nothing after
    startup, not even the line per request."""
    database = tmp_path / "startup.sqlite3"
    # alembic/env.py migrates the settings' database, not the engine's.
    monkeypatch.setattr(get_settings(), "database_url", f"sqlite+aiosqlite:///{database}")
    configure_logging()
    root = logging.getLogger()
    (json_handler,) = root.handlers
    request_log = logging.getLogger("liveface.request")

    engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
    try:
        await main._ensure_schema(engine)  # a fresh database: created, then stamped
        await main._ensure_schema(engine)  # a managed one: upgraded
    finally:
        await engine.dispose()

    head = ScriptDirectory.from_config(Config(str(ALEMBIC_INI))).get_current_head()
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("select version_num from alembic_version").fetchone() == (head,)

    assert root.handlers == [json_handler]
    assert isinstance(json_handler.formatter, JsonFormatter)
    assert root.level == logging.INFO
    assert not request_log.disabled

    capsys.readouterr()
    request_log.info("GET /health -> 200")
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [(line["logger"], line["message"]) for line in lines] == [
        ("liveface.request", "GET /health -> 200")
    ]
