"""add delivery status tracking to pending outgoing emails

Revision ID: 6f4361c3b2e1
Revises: 4490abacfc6f
Create Date: 2025-11-23 12:00:00.000000

"""

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision = "6f4361c3b2e1"
down_revision = "4490abacfc6f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add delivery_status column with proper type and server default
    op.add_column(
        "pending_outgoing_emails",
        sa.Column(
            "delivery_status",
            sa.VARCHAR(),  # Match SQLModel's AutoString
            nullable=False,
            server_default="pending",
        ),
    )
    # Add delivery_error column with AutoString type
    op.add_column(
        "pending_outgoing_emails",
        sa.Column("delivery_error", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )

    # Create index on delivery_status
    op.create_index(
        op.f("ix_pending_outgoing_emails_delivery_status"),
        "pending_outgoing_emails",
        ["delivery_status"],
        unique=False,
    )

    # Migrate existing data
    op.execute(
        """
        UPDATE pending_outgoing_emails
        SET delivery_status = CASE
            WHEN status = 'paid' AND sent_at IS NOT NULL THEN 'sent'
            WHEN status = 'failed' THEN 'failed'
            WHEN status = 'expired' THEN 'expired'
            ELSE 'pending'
        END
        """
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_pending_outgoing_emails_delivery_status"),
        table_name="pending_outgoing_emails",
    )
    op.drop_column("pending_outgoing_emails", "delivery_error")
    op.drop_column("pending_outgoing_emails", "delivery_status")
