"""ShelfSense FastAPI application factory."""

import logging
import time
from collections.abc import Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .api.catalog import router as catalog_router
from .api.chat import router as chat_router
from .api.competitors import router as competitors_router
from .api.dashboard import router as dashboard_router
from .api.health import router as health_router
from .api.heatmap import router as heatmap_router
from .api.insights import router as insights_router
from .api.intelligence import router as intelligence_router
from .api.me import router as me_router
from .api.notifications import router as notifications_router
from .api.products import router as products_router
from .api.runs import router as runs_router
from .api.settings import router as settings_router
from .config import get_settings
from .db import dispose_db

logger = logging.getLogger("shelfsense")


def configure_logging() -> None:
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .services.scheduler import shutdown_scheduler, start_scheduler
    from .services.telegram import start_bot, stop_bot

    configure_logging()
    settings = get_settings()
    app.state.scheduler_running = False
    app.state.bot_running = False
    if settings.telegram_enabled:
        app.state.bot_running = await start_bot()
    else:
        logger.info("telegram disabled; bot not started")
    try:
        start_scheduler()
        app.state.scheduler_running = True
    except Exception:
        logger.exception("scheduler failed to start")
    try:
        yield
    finally:
        await stop_bot()
        shutdown_scheduler()
        await dispose_db()


ERROR_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    422: "unprocessable",
    429: "rate_limited",
    503: "service_unavailable",
}


def error_body(code: str, message: str, fields: list[dict] | None = None) -> dict:
    """The single error envelope every failing response uses."""
    error: dict = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    return {"error": error}


def validation_fields(errors: Sequence[Any]) -> list[dict[str, str]]:
    fields = []
    for item in errors:
        message = str(item.get("msg", "Invalid value"))
        # Custom validators raise ValueError; pydantic prefixes those messages.
        message = message.removeprefix("Value error, ")
        location = ".".join(str(part) for part in item.get("loc", ()))
        fields.append({"loc": location, "msg": message})
    return fields


def validation_response(errors: Sequence[Any]) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content=error_body(
            "validation_error", "Request validation failed", validation_fields(errors)
        ),
    )


class UnhandledErrorMiddleware:
    """Turn uncaught exceptions into the JSON error envelope.

    Installed inside CORSMiddleware so 500 responses still carry CORS headers;
    Starlette's own fallback handler sits outside every user middleware.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        response_started = False

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception:
            logger.exception(
                "request_id=%s unhandled error",
                scope.get("state", {}).get("request_id", "unknown"),
            )
            if response_started:
                raise
            response = JSONResponse(
                status_code=500,
                content=error_body("internal_error", "Unexpected server error"),
            )
            await response(scope, receive, send)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = ERROR_CODES.get(exc.status_code, f"http_{exc.status_code}")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed"
        fields = None
        # Endpoints may raise a structured detail: {"code", "message", "fields"?}.
        if isinstance(exc.detail, dict):
            code = str(exc.detail.get("code") or code)
            message = str(exc.detail.get("message") or message)
            fields = exc.detail.get("fields")
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(code, message, fields),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return validation_response(exc.errors())

    @app.exception_handler(ValidationError)
    async def model_validation_error(
        request: Request, exc: ValidationError
    ) -> JSONResponse:
        # A schema built inside a handler rejected its input: still the client's fault.
        return validation_response(exc.errors())

    @app.exception_handler(IntegrityError)
    async def integrity_error(request: Request, exc: IntegrityError) -> JSONResponse:
        logger.warning(
            "request_id=%s integrity error: %s",
            getattr(request.state, "request_id", "unknown"),
            exc.orig,
        )
        return JSONResponse(
            status_code=409,
            content=error_body(
                "conflict", "This change conflicts with data that already exists"
            ),
        )


# localhost, 127.0.0.1 and the RFC 1918 ranges (10/8, 172.16/12, 192.168/16), any port.
DEV_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost|127\.0\.0\.1"
    r"|10(\.\d{1,3}){3}"
    r"|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}"
    r"|192\.168(\.\d{1,3}){2}"
    r")(:\d+)?$"
)


def create_app() -> FastAPI:
    settings = get_settings()
    settings.validate_for_startup()
    app = FastAPI(title="ShelfSense API", version="0.1.0", lifespan=lifespan)
    # Last added runs first: request context -> CORS -> unhandled-error catch.
    app.add_middleware(UnhandledErrorMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        # Development: any port on localhost or a private LAN address, so a demo
        # opened from another device on the same network still connects.
        allow_origin_regex=(
            DEV_ORIGIN_REGEX if settings.app_env == "development" else None
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        logger.info(
            "request_id=%s method=%s path=%s status=%s ms=%s",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            round((time.perf_counter() - started) * 1000),
        )
        return response

    register_error_handlers(app)

    if not settings.is_production:
        # Production serves screenshots only through the owner-checked
        # `GET /api/check-results/{id}/screenshot` endpoint.
        media_dir = Path("media")
        media_dir.mkdir(parents=True, exist_ok=True)
        app.mount("/media", StaticFiles(directory=media_dir), name="media")
    app.include_router(health_router, prefix="/api")
    app.include_router(me_router, prefix="/api")
    app.include_router(dashboard_router, prefix="/api")
    app.include_router(catalog_router, prefix="/api")
    app.include_router(products_router, prefix="/api")
    app.include_router(runs_router, prefix="/api")
    app.include_router(competitors_router, prefix="/api")
    app.include_router(heatmap_router, prefix="/api")
    app.include_router(insights_router, prefix="/api")
    app.include_router(intelligence_router, prefix="/api")
    app.include_router(chat_router, prefix="/api")
    app.include_router(notifications_router, prefix="/api")
    app.include_router(settings_router, prefix="/api")
    return app


app = create_app()
