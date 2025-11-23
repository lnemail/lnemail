"""privacy friendly send email stats

Revision ID: 4490abacfc6f
Revises: c1274d3c1064
Create Date: 2025-11-23 10:31:27.394209

"""

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision = "4490abacfc6f"
down_revision = "c1274d3c1064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create table only if it doesn't exist
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    if "email_send_statistics" not in inspector.get_table_names():
        op.create_table(
            "email_send_statistics",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("year_month", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
            sa.Column("total_sent", sa.Integer(), nullable=False),
            sa.Column("total_failed", sa.Integer(), nullable=False),
            sa.Column("total_revenue_sats", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_email_send_statistics_year_month"),
            "email_send_statistics",
            ["year_month"],
            unique=True,
        )

    # Check and add columns if they don't exist
    existing_columns = [
        col["name"] for col in inspector.get_columns("pending_outgoing_emails")
    ]

    # Add retry_count as nullable first, then update existing rows
    if "retry_count" not in existing_columns:
        op.add_column(
            "pending_outgoing_emails",
            sa.Column("retry_count", sa.Integer(), nullable=True),
        )
        # Update existing rows to have default value of 0
        op.execute(
            "UPDATE pending_outgoing_emails SET retry_count = 0 WHERE retry_count IS NULL"
        )
        # Now alter to NOT NULL (SQLite limitation workaround)
        with op.batch_alter_table("pending_outgoing_emails") as batch_op:
            batch_op.alter_column("retry_count", nullable=False, server_default="0")

    if "last_retry_at" not in existing_columns:
        op.add_column(
            "pending_outgoing_emails",
            sa.Column("last_retry_at", sa.DateTime(), nullable=True),
        )

    if "sent_at" not in existing_columns:
        op.add_column(
            "pending_outgoing_emails",
            sa.Column("sent_at", sa.DateTime(), nullable=True),
        )

    # Create indexes if they don't exist
    existing_indexes = [
        idx["name"] for idx in inspector.get_indexes("pending_outgoing_emails")
    ]

    if "ix_pending_outgoing_emails_created_at" not in existing_indexes:
        op.create_index(
            op.f("ix_pending_outgoing_emails_created_at"),
            "pending_outgoing_emails",
            ["created_at"],
            unique=False,
        )

    if "ix_pending_outgoing_emails_status" not in existing_indexes:
        op.create_index(
            op.f("ix_pending_outgoing_emails_status"),
            "pending_outgoing_emails",
            ["status"],
            unique=False,
        )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_pending_outgoing_emails_status"), table_name="pending_outgoing_emails"
    )
    op.drop_index(
        op.f("ix_pending_outgoing_emails_created_at"),
        table_name="pending_outgoing_emails",
    )
    op.drop_column("pending_outgoing_emails", "sent_at")
    op.drop_column("pending_outgoing_emails", "last_retry_at")
    op.drop_column("pending_outgoing_emails", "retry_count")
    op.drop_index(
        op.f("ix_email_send_statistics_year_month"), table_name="email_send_statistics"
    )
    op.drop_table("email_send_statistics")
