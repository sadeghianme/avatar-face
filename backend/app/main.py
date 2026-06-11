"""Liveface application factory."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Dev convenience: create tables on boot (Alembic owns real migrations).
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # Load dashboard-managed provider credentials over env settings.
    async with get_session_factory()() as db:
        await credentials.load(db)
    yield
    await engine.dispose()


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

    def _serve_widget_bundle(filename: str):
        from pathlib import Path

        from fastapi.responses import FileResponse, PlainTextResponse

        bundle = Path(__file__).resolve().parents[2] / "embed" / "dist" / filename
        if not bundle.is_file():
            return PlainTextResponse(
                f"// {filename} not built — run `make embed`", status_code=404
            )
        return FileResponse(
            bundle,
            media_type="application/javascript",
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300"},
        )

    @app.get("/liveface.js", include_in_schema=False)
    async def widget_script():
        """The embed widget (13KB; lazy-loads the 3D bundle when needed)."""
        return _serve_widget_bundle("liveface.js")

    @app.get("/liveface-3d.js", include_in_schema=False)
    async def widget_script_3d():
        """Three.js + 3D engine, loaded only for kind=model3d avatars."""
        return _serve_widget_bundle("liveface-3d.js")

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
