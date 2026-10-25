"""Enable row level security on every public table (Postgres / Supabase only).

Supabase exposes the ``public`` schema through its Data API, where the
browser's anon / publishable key can read and write any table that has RLS
off. ShelfSense never uses that API: the backend connects as the table owner,
which bypasses RLS. Turning RLS on with no policies therefore closes the Data
API to these tables without changing anything for the app. SQLite has no RLS,
so this is a no-op there.

Revision ID: 0003_enable_rls
Revises: 0002_price_thresholds
Create Date: 2026-10-25
"""

from alembic import op

revision = "0003_enable_rls"
down_revision = "0002_price_thresholds"
branch_labels = None
depends_on = None


def _set_rls(enable: bool) -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    action = "ENABLE" if enable else "DISABLE"
    op.execute(
        f"""
        DO $$
        DECLARE t record;
        BEGIN
          FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
            EXECUTE format('ALTER TABLE public.%I {action} ROW LEVEL SECURITY', t.tablename);
          END LOOP;
        END $$;
        """
    )


def upgrade() -> None:
    _set_rls(True)


def downgrade() -> None:
    _set_rls(False)
