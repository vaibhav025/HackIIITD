"""Initial ShelfSense schema.

Explicit DDL generated from the models (autogenerate against an empty
database, then reviewed). Only generic SQLAlchemy types are used so the
same revision runs on SQLite and Postgres.

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-18
"""

import sqlalchemy as sa

from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pincodes",
        sa.Column("code", sa.String(length=12), nullable=False),
        sa.Column("area_name", sa.String(length=200), nullable=False),
        sa.Column("city", sa.String(length=100), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lng", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("code"),
    )
    op.create_table(
        "telegram_link_attempts",
        sa.Column("chat_id", sa.String(length=64), nullable=False),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_telegram_link_attempts_attempted_at"),
        "telegram_link_attempts",
        ["attempted_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_telegram_link_attempts_chat_id"),
        "telegram_link_attempts",
        ["chat_id"],
        unique=False,
    )

    op.create_table(
        "users",
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("business_name", sa.String(length=200), nullable=True),
        sa.Column("business_type", sa.String(length=32), nullable=False),
        sa.Column("language", sa.String(length=8), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("default_city", sa.String(length=100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)

    op.create_table(
        "products",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("brand", sa.String(length=200), nullable=True),
        sa.Column("search_query", sa.String(length=500), nullable=False),
        sa.Column("image_url", sa.String(length=1000), nullable=True),
        sa.Column("cost_price", sa.Float(), nullable=True),
        sa.Column("min_margin_pct", sa.Float(), nullable=False),
        sa.Column("max_change_pct", sa.Float(), nullable=False),
        sa.Column("floor_price", sa.Float(), nullable=True),
        sa.Column("check_frequency", sa.String(length=16), nullable=False),
        sa.Column("volatile_boost", sa.Boolean(), nullable=False),
        sa.Column("approval_required", sa.Boolean(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_products_user_id"), "products", ["user_id"], unique=False)

    op.create_table(
        "subscriptions",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("plan", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("renews_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_subscriptions_user_id"), "subscriptions", ["user_id"], unique=True
    )

    op.create_table(
        "user_settings",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("briefing_time", sa.String(length=5), nullable=False),
        sa.Column("quiet_hours_start", sa.String(length=5), nullable=True),
        sa.Column("quiet_hours_end", sa.String(length=5), nullable=True),
        sa.Column("default_thresholds", sa.JSON(), nullable=False),
        sa.Column("channels", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_table(
        "alert_rules",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("threshold", sa.Float(), nullable=True),
        sa.Column("rule_text", sa.String(length=2000), nullable=True),
        sa.Column("rule_json", sa.JSON(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_alert_rules_product_id"), "alert_rules", ["product_id"], unique=False
    )

    op.create_table(
        "alerts",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("message", sa.String(length=2000), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("dedupe_key", sa.String(length=500), nullable=False),
        sa.Column("sent_telegram", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read", sa.Boolean(), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("dedupe_key"),
    )
    op.create_index(
        op.f("ix_alerts_product_id"), "alerts", ["product_id"], unique=False
    )
    op.create_index(op.f("ix_alerts_user_id"), "alerts", ["user_id"], unique=False)

    op.create_table(
        "chat_conversations",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("product_id", sa.String(length=36), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_chat_conversations_user_id"),
        "chat_conversations",
        ["user_id"],
        unique=False,
    )

    op.create_table(
        "check_runs",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("trigger", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("total_jobs", sa.Integer(), nullable=False),
        sa.Column("done_jobs", sa.Integer(), nullable=False),
        sa.Column("failed_jobs", sa.Integer(), nullable=False),
        sa.Column("credits_used", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_check_runs_product_id"), "check_runs", ["product_id"], unique=False
    )
    op.create_index(
        "uq_check_runs_one_active_per_product",
        "check_runs",
        ["product_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('queued', 'running')"),
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )

    op.create_table(
        "competitors",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("platform", sa.String(length=32), nullable=False),
        sa.Column("url", sa.String(length=1000), nullable=True),
        sa.Column("search_query", sa.String(length=500), nullable=True),
        sa.Column("confirmed", sa.Boolean(), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_competitors_product_id"), "competitors", ["product_id"], unique=False
    )

    op.create_table(
        "product_listings",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("platform", sa.String(length=32), nullable=False),
        sa.Column("url", sa.String(length=1000), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_product_listings_product_id"),
        "product_listings",
        ["product_id"],
        unique=False,
    )

    op.create_table(
        "product_pincodes",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("pincode", sa.String(length=12), nullable=False),
        sa.Column("platform", sa.String(length=32), nullable=False),
        sa.ForeignKeyConstraint(
            ["pincode"],
            ["pincodes.code"],
        ),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("product_id", "pincode", "platform"),
    )
    op.create_table(
        "recommendations",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("priority", sa.String(length=16), nullable=False),
        sa.Column("action_text", sa.String(length=2000), nullable=False),
        sa.Column("impact_text", sa.String(length=2000), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("decided_via", sa.String(length=16), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_recommendations_product_id"),
        "recommendations",
        ["product_id"],
        unique=False,
    )

    op.create_table(
        "telegram_link_codes",
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("chat_type", sa.String(length=16), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("code"),
    )
    op.create_index(
        op.f("ix_telegram_link_codes_product_id"),
        "telegram_link_codes",
        ["product_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_telegram_link_codes_user_id"),
        "telegram_link_codes",
        ["user_id"],
        unique=False,
    )

    op.create_table(
        "telegram_links",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("chat_id", sa.String(length=100), nullable=False),
        sa.Column("chat_title", sa.String(length=300), nullable=True),
        sa.Column("linked_by_telegram_user_id", sa.String(length=64), nullable=True),
        sa.Column("alert_types", sa.JSON(), nullable=False),
        sa.Column("briefing_time", sa.String(length=5), nullable=True),
        sa.Column("last_briefing_date", sa.String(length=10), nullable=True),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "product_id", "chat_id", name="uq_telegram_links_product_chat"
        ),
    )
    op.create_index(
        op.f("ix_telegram_links_chat_id"), "telegram_links", ["chat_id"], unique=False
    )
    op.create_index(
        op.f("ix_telegram_links_product_id"),
        "telegram_links",
        ["product_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_telegram_links_user_id"), "telegram_links", ["user_id"], unique=False
    )

    op.create_table(
        "ai_summaries",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=True),
        sa.Column("summary_text", sa.String(length=4000), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["check_runs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_ai_summaries_product_id"), "ai_summaries", ["product_id"], unique=False
    )

    op.create_table(
        "change_events",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("competitor_id", sa.String(length=36), nullable=True),
        sa.Column("platform", sa.String(length=32), nullable=False),
        sa.Column("pincode", sa.String(length=12), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("old_value", sa.Float(), nullable=True),
        sa.Column("new_value", sa.Float(), nullable=True),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["competitor_id"], ["competitors.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_change_events_product_id"),
        "change_events",
        ["product_id"],
        unique=False,
    )

    op.create_table(
        "chat_messages",
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("content", sa.String(length=8000), nullable=False),
        sa.Column("actions", sa.JSON(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["chat_conversations.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_chat_messages_conversation_id"),
        "chat_messages",
        ["conversation_id"],
        unique=False,
    )

    op.create_table(
        "check_results",
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("competitor_id", sa.String(length=36), nullable=True),
        sa.Column("platform", sa.String(length=32), nullable=False),
        sa.Column("pincode", sa.String(length=12), nullable=False),
        sa.Column("in_stock", sa.Boolean(), nullable=True),
        sa.Column("price", sa.Float(), nullable=True),
        sa.Column("mrp", sa.Float(), nullable=True),
        sa.Column("eta_minutes", sa.Integer(), nullable=True),
        sa.Column("rating", sa.Float(), nullable=True),
        sa.Column("screenshot_url", sa.String(length=1000), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error", sa.String(length=1000), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["competitor_id"], ["competitors.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["check_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_check_results_checked_at"),
        "check_results",
        ["checked_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_check_results_competitor_id"),
        "check_results",
        ["competitor_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_check_results_pincode"), "check_results", ["pincode"], unique=False
    )
    op.create_index(
        op.f("ix_check_results_platform"), "check_results", ["platform"], unique=False
    )
    op.create_index(
        op.f("ix_check_results_product_id"),
        "check_results",
        ["product_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_check_results_run_id"), "check_results", ["run_id"], unique=False
    )

    op.create_table(
        "credit_ledger",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=True),
        sa.Column("credits", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["check_runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_credit_ledger_run_id"), "credit_ledger", ["run_id"], unique=False
    )
    op.create_index(
        op.f("ix_credit_ledger_user_id"), "credit_ledger", ["user_id"], unique=False
    )

    op.create_table(
        "review_insights",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("competitor_id", sa.String(length=36), nullable=True),
        sa.Column("loves", sa.JSON(), nullable=False),
        sa.Column("complaints", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["competitor_id"], ["competitors.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_review_insights_product_id"),
        "review_insights",
        ["product_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_review_insights_product_id"), table_name="review_insights")

    op.drop_table("review_insights")
    op.drop_index(op.f("ix_credit_ledger_user_id"), table_name="credit_ledger")
    op.drop_index(op.f("ix_credit_ledger_run_id"), table_name="credit_ledger")

    op.drop_table("credit_ledger")
    op.drop_index(op.f("ix_check_results_run_id"), table_name="check_results")
    op.drop_index(op.f("ix_check_results_product_id"), table_name="check_results")
    op.drop_index(op.f("ix_check_results_platform"), table_name="check_results")
    op.drop_index(op.f("ix_check_results_pincode"), table_name="check_results")
    op.drop_index(op.f("ix_check_results_competitor_id"), table_name="check_results")
    op.drop_index(op.f("ix_check_results_checked_at"), table_name="check_results")

    op.drop_table("check_results")
    op.drop_index(op.f("ix_chat_messages_conversation_id"), table_name="chat_messages")

    op.drop_table("chat_messages")
    op.drop_index(op.f("ix_change_events_product_id"), table_name="change_events")

    op.drop_table("change_events")
    op.drop_index(op.f("ix_ai_summaries_product_id"), table_name="ai_summaries")

    op.drop_table("ai_summaries")
    op.drop_index(op.f("ix_telegram_links_user_id"), table_name="telegram_links")
    op.drop_index(op.f("ix_telegram_links_product_id"), table_name="telegram_links")
    op.drop_index(op.f("ix_telegram_links_chat_id"), table_name="telegram_links")

    op.drop_table("telegram_links")
    op.drop_index(
        op.f("ix_telegram_link_codes_user_id"), table_name="telegram_link_codes"
    )
    op.drop_index(
        op.f("ix_telegram_link_codes_product_id"), table_name="telegram_link_codes"
    )

    op.drop_table("telegram_link_codes")
    op.drop_index(op.f("ix_recommendations_product_id"), table_name="recommendations")

    op.drop_table("recommendations")
    op.drop_table("product_pincodes")
    op.drop_index(op.f("ix_product_listings_product_id"), table_name="product_listings")

    op.drop_table("product_listings")
    op.drop_index(op.f("ix_competitors_product_id"), table_name="competitors")

    op.drop_table("competitors")
    op.drop_index(
        "uq_check_runs_one_active_per_product",
        table_name="check_runs",
        sqlite_where=sa.text("status IN ('queued', 'running')"),
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.drop_index(op.f("ix_check_runs_product_id"), table_name="check_runs")

    op.drop_table("check_runs")
    op.drop_index(
        op.f("ix_chat_conversations_user_id"), table_name="chat_conversations"
    )

    op.drop_table("chat_conversations")
    op.drop_index(op.f("ix_alerts_user_id"), table_name="alerts")
    op.drop_index(op.f("ix_alerts_product_id"), table_name="alerts")

    op.drop_table("alerts")
    op.drop_index(op.f("ix_alert_rules_product_id"), table_name="alert_rules")

    op.drop_table("alert_rules")
    op.drop_table("user_settings")
    op.drop_index(op.f("ix_subscriptions_user_id"), table_name="subscriptions")

    op.drop_table("subscriptions")
    op.drop_index(op.f("ix_products_user_id"), table_name="products")

    op.drop_table("products")
    op.drop_index(op.f("ix_users_email"), table_name="users")

    op.drop_table("users")
    op.drop_index(
        op.f("ix_telegram_link_attempts_chat_id"), table_name="telegram_link_attempts"
    )
    op.drop_index(
        op.f("ix_telegram_link_attempts_attempted_at"),
        table_name="telegram_link_attempts",
    )

    op.drop_table("telegram_link_attempts")
    op.drop_table("pincodes")
