#!/usr/bin/env python3
"""
Manually create and activate a new email account with a given name.

The account is inserted into the database as already paid, with a random
internal email password, access token, and a synthetic payment hash.
It also triggers the mail-agent to provision the account on the mailserver.

Examples:

    # Create with default 10-year validity
    python scripts/create_account.py alice

    # Explicit local-part and domain
    python scripts/create_account.py alice@lnemail.net

    # Custom validity in days
    python scripts/create_account.py alice --days 365

    # Custom validity in years
    python scripts/create_account.py alice --years 5
"""

import argparse
import secrets
import sys
import os
from datetime import datetime, timedelta

from loguru import logger

# Add the src directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from lnemail.config import settings
from lnemail.core.models import EmailAccount, PaymentStatus
from lnemail.db import engine
from lnemail.services.email_service import EmailService
from sqlmodel import Session, select

DEFAULT_YEARS = 10


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Manually create a paid email account.",
    )
    parser.add_argument(
        "address",
        help=(
            "Email local-part (e.g. 'alice') or full address "
            "(e.g. 'alice@lnemail.net'). If only the local-part is given, "
            f"the domain defaults to {settings.MAIL_DOMAIN}."
        ),
    )
    validity = parser.add_mutually_exclusive_group()
    validity.add_argument(
        "--days",
        type=int,
        default=None,
        help="Account validity in days (default: 10 years).",
    )
    validity.add_argument(
        "--years",
        type=int,
        default=None,
        help="Account validity in years (default: 10).",
    )
    return parser.parse_args()


def resolve_email(raw: str) -> str:
    """Normalise the user-supplied address to a full email."""
    if "@" in raw:
        return raw.lower()
    return f"{raw.lower()}@{settings.MAIL_DOMAIN}"


def compute_expiry(days: int | None, years: int | None) -> datetime:
    if days is not None:
        return datetime.utcnow() + timedelta(days=days)
    y = years if years is not None else DEFAULT_YEARS
    return datetime.utcnow() + timedelta(days=365 * y)


def create_account(
    email_address: str,
    expires_at: datetime,
) -> bool:
    """Insert the account into the DB and provision it on the mailserver.

    Returns:
        True on success, False otherwise.
    """
    email_service = EmailService()

    with Session(engine) as session:
        # Guard against duplicates
        existing = session.exec(
            select(EmailAccount).where(EmailAccount.email_address == email_address)
        ).first()
        if existing is not None:
            logger.error(f"Account already exists: {email_address}")
            if existing.payment_status == PaymentStatus.PAID:
                logger.info("Account is already paid and active.")
            else:
                logger.info(
                    f"Account exists with status={existing.payment_status}. "
                    "Use activate_account.py to activate it."
                )
            return False

        # Generate credentials
        access_token = EmailAccount.generate_access_token()
        # Synthetic payment hash -- will never collide with real LND hashes
        payment_hash = f"manual_{secrets.token_hex(32)}"

        account = EmailAccount(
            email_address=email_address,
            access_token=access_token,
            payment_hash=payment_hash,
            payment_status=PaymentStatus.PENDING,
            expires_at=expires_at,
        )
        session.add(account)
        session.commit()
        session.refresh(account)

        logger.info(f"Inserted DB record for {email_address}")

        # Provision on the mailserver via mail-agent
        success, password = email_service.create_account(email_address)
        if not success:
            logger.error(
                "Mail-agent failed to create the account on the mailserver. "
                "The DB record has been created but the mailserver account "
                "was not provisioned. You may need to retry or create it "
                "manually via: docker exec mailserver setup email add ..."
            )
            return False

        # Mark as paid and store the internal password
        account.email_password = password
        account.payment_status = PaymentStatus.PAID
        session.add(account)
        session.commit()

        logger.info("Account created and activated successfully.")
        logger.info(f"  Email:        {email_address}")
        logger.info(f"  Access token: {access_token}")
        logger.info(f"  Expires at:   {expires_at.isoformat()}")
        return True


def main() -> None:
    args = parse_args()
    email_address = resolve_email(args.address)
    expires_at = compute_expiry(args.days, args.years)

    logger.info(f"Creating account: {email_address}")
    logger.info(f"Validity until:   {expires_at.isoformat()}")

    success = create_account(email_address, expires_at)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
