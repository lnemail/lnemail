"""add renewal fields to email_accounts

Revision ID: a1b2c3d4e5f6
Revises: 4a750515a916
Create Date: 2026-02-21 12:00:00.000000

"""

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision = "a1b2c3d4e5f6"
down_revision = "4a750515a916"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "email_accounts",
        sa.Column(
            "renewal_payment_hash",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=True,
        ),
    )
    op.create_index(
        op.f("ix_email_accounts_renewal_payment_hash"),
        "email_accounts",
        ["renewal_payment_hash"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_email_accounts_renewal_payment_hash"),
        table_name="email_accounts",
    )
    op.drop_column("email_accounts", "renewal_payment_hash")
