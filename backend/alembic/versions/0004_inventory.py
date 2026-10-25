"""Seller inventory: warehouses, stock per product and warehouse, stock events.

Only generic SQLAlchemy types are used so the same revision runs on SQLite
and Postgres. On Postgres (Supabase) row level security is switched on for
the new tables, exactly like 0003_enable_rls does for the existing ones: the
backend connects as the table owner, so RLS with no policies only closes the
Supabase Data API to these tables.

Revision ID: 0004_inventory
Revises: 0003_enable_rls
Create Date: 2026-10-25
"""

import sqlalchemy as sa

from alembic import op

revision = "0004_inventory"
down_revision = "0003_enable_rls"
branch_labels = None
depends_on = None

NEW_TABLES = ("warehouses", "inventory_items", "inventory_events")


def _set_rls(enable: bool) -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    action = "ENABLE" if enable else "DISABLE"
    for table in NEW_TABLES:
        op.execute(f"ALTER TABLE public.{table} {action} ROW LEVEL SECURITY")


def upgrade() -> None:
    op.create_table(
        "warehouses",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("platform", sa.String(length=16), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("city", sa.String(length=100), nullable=False),
        sa.Column("pincode", sa.String(length=12), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_warehouses_user_name"),
    )
    op.create_index(
        op.f("ix_warehouses_user_id"), "warehouses", ["user_id"], unique=False
    )

    op.create_table(
        "inventory_items",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("warehouse_id", sa.String(length=36), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("low_stock_threshold", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.CheckConstraint("quantity >= 0", name="ck_inventory_items_quantity_nonneg"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["warehouse_id"], ["warehouses.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "product_id", "warehouse_id", name="uq_inventory_items_product_warehouse"
        ),
    )
    op.create_index(
        op.f("ix_inventory_items_product_id"),
        "inventory_items",
        ["product_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_inventory_items_warehouse_id"),
        "inventory_items",
        ["warehouse_id"],
        unique=False,
    )

    op.create_table(
        "inventory_events",
        sa.Column("item_id", sa.String(length=36), nullable=False),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("quantity_after", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["item_id"], ["inventory_items.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_inventory_events_item_id"),
        "inventory_events",
        ["item_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_inventory_events_created_at"),
        "inventory_events",
        ["created_at"],
        unique=False,
    )
    _set_rls(True)


def downgrade() -> None:
    op.drop_index(op.f("ix_inventory_events_created_at"), table_name="inventory_events")
    op.drop_index(op.f("ix_inventory_events_item_id"), table_name="inventory_events")
    op.drop_table("inventory_events")
    op.drop_index(op.f("ix_inventory_items_warehouse_id"), table_name="inventory_items")
    op.drop_index(op.f("ix_inventory_items_product_id"), table_name="inventory_items")
    op.drop_table("inventory_items")
    op.drop_index(op.f("ix_warehouses_user_id"), table_name="warehouses")
    op.drop_table("warehouses")
