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

    def __init__(self, detail: str | None = None, code: str | None = None):
        self.detail = detail or self.__class__.__name__
        if code is not None:
            self.code = code
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


class Validation422(AppError):
    status_code = 422
    code = "validation_error"


class RateLimit429(AppError):
    status_code = 429
    code = "rate_limited"


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else None
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.code},
            headers=headers,
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
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
