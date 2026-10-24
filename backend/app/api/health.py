from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..db import get_session
from ..schemas.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(
    request: Request,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> HealthResponse:
    await session.execute(text("SELECT 1"))
    return HealthResponse(
        status="ok",
        database="ok",
        mock_mode=settings.effective_mock_mode,
        integrations={
            "tinyfish": settings.tinyfish_enabled,
            "gemini": settings.gemini_enabled,
            "telegram": settings.telegram_enabled,
            "storage": settings.storage_enabled,
        },
        auth_mode=settings.auth_mode,
        tinyfish_mode=settings.tinyfish_mode,
        billing_mode="live" if settings.is_production else "test",
        bot_running=bool(getattr(request.app.state, "bot_running", False)),
        scheduler_running=bool(getattr(request.app.state, "scheduler_running", False)),
    )
