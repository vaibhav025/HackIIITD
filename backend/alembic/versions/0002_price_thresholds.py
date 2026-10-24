"""Smart price-recommendation threshold columns on products.

Adds the platform commission, MRP ceiling, price sensitivity and the
price-point rounding toggle. All columns are nullable so existing rows keep
working (NULL sensitivity means "regular"). Batch mode keeps SQLite happy;
on Postgres it is a plain ALTER TABLE ... ADD COLUMN.

Revision ID: 0002_price_thresholds
Revises: 0001_initial
Create Date: 2026-10-22
"""

import sqlalchemy as sa

from alembic import op

revision = "0002_price_thresholds"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("products") as batch:
        batch.add_column(sa.Column("commission_pct", sa.Float(), nullable=True))
        batch.add_column(sa.Column("mrp", sa.Float(), nullable=True))
        batch.add_column(
            sa.Column("price_sensitivity", sa.String(length=16), nullable=True)
        )
        batch.add_column(
            sa.Column(
                "round_to_price_point",
                sa.Boolean(),
                nullable=True,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("products") as batch:
        batch.drop_column("round_to_price_point")
        batch.drop_column("price_sensitivity")
        batch.drop_column("mrp")
        batch.drop_column("commission_pct")
