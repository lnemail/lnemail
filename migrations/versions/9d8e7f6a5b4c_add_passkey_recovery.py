"""add passkey recovery

Revision ID: 9d8e7f6a5b4c
Revises: a1b2c3d4e5f6
Create Date: 2026-08-09 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "9d8e7f6a5b4c"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "email_accounts",
        sa.Column("passkey_user_handle", sa.LargeBinary(), nullable=True),
    )
    op.add_column(
        "email_accounts",
        sa.Column("expiry_warning_read_for", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_email_accounts_passkey_user_handle",
        "email_accounts",
        ["passkey_user_handle"],
        unique=True,
    )
    op.create_table(
        "passkey_credentials",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("credential_id", sa.LargeBinary(), nullable=False),
        sa.Column("credential_public_key", sa.LargeBinary(), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("transports_json", sa.Text(), nullable=False),
        sa.Column("device_type", sa.String(), nullable=True),
        sa.Column("backed_up", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["account_id"], ["email_accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_passkey_credentials_account_id"),
        "passkey_credentials",
        ["account_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_passkey_credentials_credential_id"),
        "passkey_credentials",
        ["credential_id"],
        unique=True,
    )
    op.create_table(
        "webauthn_challenges",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("challenge", sa.LargeBinary(), nullable=False),
        sa.Column("ceremony_type", sa.String(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["email_accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_webauthn_challenges_account_id"),
        "webauthn_challenges",
        ["account_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_webauthn_challenges_ceremony_type"),
        "webauthn_challenges",
        ["ceremony_type"],
        unique=False,
    )
    op.create_index(
        op.f("ix_webauthn_challenges_expires_at"),
        "webauthn_challenges",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_webauthn_challenges_expires_at"),
        table_name="webauthn_challenges",
    )
    op.drop_index(
        op.f("ix_webauthn_challenges_ceremony_type"),
        table_name="webauthn_challenges",
    )
    op.drop_index(
        op.f("ix_webauthn_challenges_account_id"),
        table_name="webauthn_challenges",
    )
    op.drop_table("webauthn_challenges")
    op.drop_index(
        op.f("ix_passkey_credentials_credential_id"),
        table_name="passkey_credentials",
    )
    op.drop_index(
        op.f("ix_passkey_credentials_account_id"),
        table_name="passkey_credentials",
    )
    op.drop_table("passkey_credentials")
    op.drop_index("ix_email_accounts_passkey_user_handle", table_name="email_accounts")
    op.drop_column("email_accounts", "expiry_warning_read_for")
    op.drop_column("email_accounts", "passkey_user_handle")
