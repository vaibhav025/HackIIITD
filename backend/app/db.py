"""Async SQLAlchemy setup used by API dependencies and scripts."""

from collections.abc import AsyncGenerator

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .config import get_settings


def enable_sqlite_foreign_keys(engine: Engine) -> None:
    """SQLite ignores FOREIGN KEY clauses unless each connection opts in.

    Enforcing them locally means a delete that would break referential integrity
    on Postgres fails in development and tests too, and `ON DELETE` rules apply.
    """
    if engine.dialect.name != "sqlite":
        return

    @event.listens_for(engine, "connect")
    def _set_pragma(dbapi_connection, _record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def engine_options(url: str) -> dict:
    """Connection options for hosted Postgres (Supabase) vs local SQLite."""
    if url.startswith("sqlite"):
        return {}
    options: dict = {"pool_pre_ping": True, "pool_recycle": 1800}
    # Supabase's transaction pooler (port 6543) cannot keep prepared statements.
    if ":6543/" in url:
        options["connect_args"] = {"statement_cache_size": 0, "prepared_statement_cache_size": 0}
    return options


settings = get_settings()
engine = create_async_engine(
    settings.database_url, future=True, **engine_options(settings.database_url)
)
enable_sqlite_foreign_keys(engine.sync_engine)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


async def dispose_db() -> None:
    await engine.dispose()
