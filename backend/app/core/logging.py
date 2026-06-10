"""Structured JSON logging and request-id middleware."""
from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if rid := request_id_var.get():
            payload["request_id"] = rid
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        if extra := getattr(record, "extra_fields", None):
            payload.update(extra)
        return json.dumps(payload, default=str)


def configure_logging(debug: bool = False) -> None:
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.handlers = [handler]
    logging.getLogger("uvicorn.access").disabled = True


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Assign a request id, echo it back, and log one line per request."""

    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        token = request_id_var.set(rid)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["x-request-id"] = rid
        elapsed_ms = (time.perf_counter() - started) * 1000
        logging.getLogger("liveface.request").info(
            "%s %s -> %s (%.1fms)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response
