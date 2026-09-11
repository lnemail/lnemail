"""add free_send_used_at to email_accounts

Revision ID: b7c2d9e4f1a3
Revises: 9d8e7f6a5b4c
Create Date: 2026-09-11 00:00:00.000000

Existing accounts are left NULL on purpose: every account, including
those created before this release, gets one free outgoing email.
"""

from alembic import op
import sqlalchemy as sa


revision = "b7c2d9e4f1a3"
down_revision = "9d8e7f6a5b4c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "email_accounts",
        sa.Column("free_send_used_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("email_accounts", "free_send_used_at")
