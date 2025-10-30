"""add_reply_fields_to_pending_outgoing_emails

Revision ID: c1274d3c1064
Revises: 1a4bb4606f11
Create Date: 2025-10-30 19:46:35.280957

"""

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision = "c1274d3c1064"
down_revision = "1a4bb4606f11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pending_outgoing_emails",
        sa.Column("in_reply_to", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )
    op.add_column(
        "pending_outgoing_emails",
        sa.Column("references", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pending_outgoing_emails", "references")
    op.drop_column("pending_outgoing_emails", "in_reply_to")
