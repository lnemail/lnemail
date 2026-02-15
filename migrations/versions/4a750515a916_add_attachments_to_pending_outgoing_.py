"""add attachments_json to pending_outgoing_emails

Revision ID: 4a750515a916
Revises: 6f4361c3b2e1
Create Date: 2026-02-15 18:30:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "4a750515a916"
down_revision = "6f4361c3b2e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pending_outgoing_emails",
        sa.Column("attachments_json", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pending_outgoing_emails", "attachments_json")
