"""Liveface application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from app.api import api_keys, auth, avatars, embed, integrations, orgs, stock, storage_routes, tts, usage
from app.core.config import get_settings
from app.core.credentials import credentials
from app.core.errors import install_error_handlers
from app.core.logging import RequestIdMiddleware, configure_logging
from app.db import get_engine, get_session_factory
from app.models import Base

# Paths that third-party pages call directly: CORS must reflect ANY origin
# (key-level allowed_domains does the actual gating).
PUBLIC_CORS_PREFIXES = ("/embed/", "/storage/", "/stock-avatars/")


class PublicCorsMiddleware(BaseHTTPMiddleware):
    """Path-scoped CORS for the public embed surface.

    Reflects the Origin header and answers preflight OPTIONS so the widget
    works from any host page; per-key domain checks happen at auth time.
    """

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith(PUBLIC_CORS_PREFIXES):
            return await call_next(request)
        origin = request.headers.get("origin", "*")
        cors_headers = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }
        if request.method == "OPTIONS":
            return PlainTextResponse("", status_code=204, headers=cors_headers)
        response = await call_next(request)
        for key, value in cors_headers.items():
            response.headers[key] = value
        return response


logger = logging.getLogger("liveface.startup")


async def _ensure_schema(engine) -> None:
    """Bring the database up to date before serving.

    `create_all` alone is not enough and this bit us: it creates MISSING
    TABLES but never adds a column to a table that already exists. So a
    migration that adds a column applied on fresh installs and silently did
    nothing on the deployed database, which then answered every avatar query
    with "no such column".

    Fresh database  -> create_all, then stamp head, so later migrations apply.
    Managed database -> upgrade head.
    Existing but unstamped -> refuse to guess. Stamping head would mark
    pending migrations as done and hide exactly the failure above; log it and
    let a human run `alembic stamp <rev>` once.
    """
    import asyncio

    from sqlalchemy import inspect

    async with engine.begin() as conn:
        tables = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))

    fresh = "users" not in tables
    stamped = "alembic_version" in tables

    if fresh:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    def run_alembic(action: str) -> None:
        from alembic import command
        from alembic.config import Config

        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        (command.stamp if action == "stamp" else command.upgrade)(cfg, "head")

    if fresh:
        await asyncio.to_thread(run_alembic, "stamp")
    elif stamped:
        await asyncio.to_thread(run_alembic, "upgrade")
    else:
        logger.error(
            "database has tables but no alembic_version; migrations are NOT being "
            "applied. Run `alembic stamp <current-revision>` once to adopt it."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = get_engine()
    await _ensure_schema(engine)
    # Load dashboard-managed provider credentials over env settings.
    async with get_session_factory()() as db:
        await credentials.load(db)
    yield
    await engine.dispose()


def _bundle_etag(path) -> str:
    """A content hash of the bundle, cached against (mtime, size).

    Content rather than mtime: a rebuild rewrites the file on every deploy
    even when the bundle is byte-identical, and hashing the mtime would throw
    away every visitor's cached copy for no reason.
    """
    import hashlib

    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _ETAG_CACHE.get(key)
    if cached is None:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:32]
        # Keyed by mtime and size, so a rebuild replaces rather than grows it.
        _ETAG_CACHE.clear()
        cached = _ETAG_CACHE[key] = f'"{digest}"'
    return cached


_ETAG_CACHE: dict[tuple, str] = {}


def _etag_matches(if_none_match: str | None, etag: str) -> bool:
    """RFC 9110 If-None-Match, tolerant of what proxies do to the tag.

    Caddy and Cloudflare append a suffix like `-gzip` when they re-encode the
    body, and may mark it weak. Comparing raw strings would therefore never
    match through the proxy, and every revalidation would return a full 200.
    """
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True

    def normalise(tag: str) -> str:
        tag = tag.strip()
        if tag.startswith(("W/", "w/")):
            tag = tag[2:]
        tag = tag.strip('"')
        for suffix in ("-gzip", "-br", "-zstd", "-df"):
            if tag.endswith(suffix):
                tag = tag[: -len(suffix)]
        return tag

    target = normalise(etag)
    return any(normalise(tag) == target for tag in if_none_match.split(","))


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.debug)

    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    install_error_handlers(app)

    # add_middleware() wraps outside-in: the LAST added runs FIRST. The
    # public-CORS middleware must run before the dashboard CORSMiddleware,
    # or embed preflights from third-party origins get rejected with 400.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(PublicCorsMiddleware)
    app.add_middleware(RequestIdMiddleware)

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "app": settings.app_name}

    def _serve_widget_bundle(filename: str, request: Request):
        """Serve an embed bundle that revalidates instead of expiring.

        The URL is baked into every customer's pasted snippet, so it can never
        carry a content hash the way a normal asset does — which leaves
        revalidation as the only way a deployed fix reaches visitors promptly.

        Two things make that work, and both are load-bearing:

        `private` keeps Cloudflare from rewriting the header. Its Browser
        Cache TTL is set to 4 hours and silently replaces `no-cache` with
        `max-age=14400` on anything it considers cacheable; marking the
        response private takes it out of that path.

        The conditional handling below is what makes `no-cache` cheap. A bare
        FileResponse ignores If-None-Match and answers 200 with the whole
        body every time, so without this, revalidation would mean
        re-downloading the bundle on every single page load.
        """
        from pathlib import Path

        from fastapi.responses import FileResponse, PlainTextResponse, Response

        bundle = Path(__file__).resolve().parents[2] / "embed" / "dist" / filename
        if not bundle.is_file():
            return PlainTextResponse(
                f"// {filename} not built — run `make embed`", status_code=404
            )

        etag = _bundle_etag(bundle)
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, no-cache, must-revalidate",
            "ETag": etag,
        }
        if _etag_matches(request.headers.get("if-none-match"), etag):
            return Response(status_code=304, headers=headers)
        return FileResponse(bundle, media_type="application/javascript", headers=headers)

    @app.get("/liveface.js", include_in_schema=False)
    async def widget_script(request: Request):
        """The embed widget (13KB; lazy-loads the 3D bundle when needed)."""
        return _serve_widget_bundle("liveface.js", request)

    @app.get("/liveface-3d.js", include_in_schema=False)
    async def widget_script_3d(request: Request):
        """Three.js + 3D engine, loaded only for kind=model3d avatars."""
        return _serve_widget_bundle("liveface-3d.js", request)

    app.include_router(auth.router)
    app.include_router(orgs.router)
    app.include_router(avatars.router)
    app.include_router(storage_routes.router)
    app.include_router(tts.router)
    app.include_router(api_keys.router)
    app.include_router(embed.router)
    app.include_router(integrations.router)
    app.include_router(usage.router)
    app.include_router(stock.router)

    return app


app = create_app()
