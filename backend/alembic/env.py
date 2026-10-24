"""Alembic environment: migrations run through the app's async drivers.

`DATABASE_URL` (via app settings) wins over `alembic.ini`, so asyncpg and
aiosqlite are used as-is; no sync driver needs to be installed.
"""

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context
from app.config import get_settings
from app.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def get_url() -> str:
    return get_settings().database_url


def configure(url_or_connection: str | Connection) -> None:
    is_url = isinstance(url_or_connection, str)
    url = url_or_connection if is_url else str(url_or_connection.engine.url)
    options = {
        "target_metadata": target_metadata,
        # SQLite cannot ALTER most constraints; batch mode rebuilds the table.
        "render_as_batch": url.startswith("sqlite"),
        "compare_type": True,
    }
    if is_url:
        context.configure(
            url=url,
            literal_binds=True,
            dialect_opts={"paramstyle": "named"},
            **options,
        )
    else:
        context.configure(connection=url_or_connection, **options)


def run_migrations_offline() -> None:
    configure(get_url())
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = get_url()
    connectable = async_engine_from_config(
        section, prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
