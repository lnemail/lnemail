"""send emails

Revision ID: 1a4bb4606f11
Revises: 0297c48ec3e6
Create Date: 2025-06-01 16:57:00.425863

"""

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision = "1a4bb4606f11"
down_revision = "0297c48ec3e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "pending_outgoing_emails",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("sender_email", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("recipient", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("subject", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("body", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("payment_hash", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column(
            "payment_request", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column("price_sats", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("PENDING", "PAID", "EXPIRED", "FAILED", name="paymentstatus"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_pending_outgoing_emails_payment_hash"),
        "pending_outgoing_emails",
        ["payment_hash"],
        unique=True,
    )
    op.create_index(
        op.f("ix_pending_outgoing_emails_sender_email"),
        "pending_outgoing_emails",
        ["sender_email"],
        unique=False,
    )
    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(
        op.f("ix_pending_outgoing_emails_sender_email"),
        table_name="pending_outgoing_emails",
    )
    op.drop_index(
        op.f("ix_pending_outgoing_emails_payment_hash"),
        table_name="pending_outgoing_emails",
    )
    op.drop_table("pending_outgoing_emails")
    # ### end Alembic commands ###
