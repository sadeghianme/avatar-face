"""Typed application exceptions and the consistent error envelope.

Every error response has the shape {"detail": str, "code": str} so clients
(dashboard, widget, third-party integrators) can branch on `code` without
parsing prose.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    status_code = 500
    code = "internal_error"

    def __init__(
        self,
        detail: str | None = None,
        code: str | None = None,
        extra: dict | None = None,
        headers: dict[str, str] | None = None,
    ):
        self.detail = detail or self.__class__.__name__
        if code is not None:
            self.code = code
        # Machine-readable context beside the envelope (e.g. the reasons a
        # fit was refused), for clients that can do better than show prose.
        self.extra = extra or {}
        # Response headers the status needs to be actionable: Retry-After on
        # a 429 or 503 tells a client when to come back instead of hammering.
        self.headers = headers or {}
        super().__init__(self.detail)


class Auth401(AppError):
    status_code = 401
    code = "unauthorized"


class Forbidden403(AppError):
    status_code = 403
    code = "forbidden"


class NotFound404(AppError):
    status_code = 404
    code = "not_found"


class Conflict409(AppError):
    status_code = 409
    code = "conflict"


class PayloadTooLarge413(AppError):
    status_code = 413
    code = "payload_too_large"


class Validation422(AppError):
    status_code = 422
    code = "validation_error"


class RateLimit429(AppError):
    status_code = 429
    code = "rate_limited"


class ServiceUnavailable503(AppError):
    status_code = 503
    code = "service_unavailable"


def error_body(exc: AppError) -> dict:
    """The envelope of `exc`: {"detail", "code"} and its extra context.

    What the handler below answers, and what a stream whose headers are
    already sent says in its own error frame (services.tts.stream), so a
    client reads one shape wherever the refusal comes from.
    """
    return {**exc.extra, "detail": exc.detail, "code": exc.code}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        headers = dict(exc.headers)
        if exc.status_code == 401:
            headers["WWW-Authenticate"] = "Bearer"
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(exc),
            headers=headers or None,
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": str(exc.detail), "code": f"http_{exc.status_code}"},
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "detail": "Request validation failed",
                "code": "validation_error",
                "errors": exc.errors(),
            },
        )
