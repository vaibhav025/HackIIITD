"""Test isolation: every pytest session gets its own throwaway, freshly seeded SQLite database.

The environment is set before any ``app`` module is imported, because ``app.db`` builds its
engine from settings at import time.
"""

import asyncio
import os
import tempfile
from pathlib import Path

_TEST_DIR = Path(tempfile.mkdtemp(prefix="shelfsense-tests-"))
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(_TEST_DIR / 'test.db').as_posix()}"
os.environ["APP_ENV"] = "development"
os.environ["MOCK_MODE"] = "true"
for _key in (
    "TINYFISH_API_KEY",
    "GEMINI_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "TINYFISH_PROFILE_BLINKIT",
    "TINYFISH_PROFILE_ZEPTO",
    "TINYFISH_PROFILE_INSTAMART",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_JWT_SECRET",
):
    os.environ[_key] = ""

from app.config import get_settings

get_settings.cache_clear()


async def _prepare_database() -> None:
    from app.db import engine
    from app.models import Base
    from scripts.seed import seed

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    await seed(demo_data=True)
    # Pooled aiosqlite connections are bound to this temporary event loop; drop them.
    await engine.dispose()


asyncio.run(_prepare_database())
