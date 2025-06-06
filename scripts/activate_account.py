#!/usr/bin/env python3
"""
Manual script to activate a paid email account.
This script manually triggers the account activation process for a specific payment hash.

Example:

```shell
python activate_account.py --email someuser@lnemail.net
```
"""

import sys
import os
from loguru import logger

# Add the src directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from lnemail.db import engine
from lnemail.core.models import EmailAccount, PaymentStatus
from lnemail.services.email_service import EmailService
from lnemail.services.lnd_service import LNDService
from sqlmodel import Session, select


def activate_account_by_payment_hash(payment_hash: str) -> bool:
    """
    Manually activate an email account by payment hash.

    Args:
        payment_hash: The payment hash to activate

    Returns:
        True if successful, False otherwise
    """
    logger.info(f"Starting manual activation for payment hash: {payment_hash}")

    # Initialize services
    lnd_service = LNDService()
    email_service = EmailService()

    try:
        with Session(engine) as session:
            # Find the account by payment hash
            statement = select(EmailAccount).where(
                EmailAccount.payment_hash == payment_hash
            )
            account = session.exec(statement).first()

            if not account:
                logger.error(f"Account not found for payment hash: {payment_hash}")
                return False

            logger.info(f"Found account: {account.email_address}")
            logger.info(f"Current status: {account.payment_status}")

            if account.payment_status == PaymentStatus.PAID:
                logger.info("Account is already marked as paid")
                return True

            # Check if payment is actually received
            try:
                paid = lnd_service.check_invoice(payment_hash)
                logger.info(f"LND payment status: {paid}")
            except Exception as e:
                logger.warning(f"Could not check LND payment status: {e}")
                logger.info("Proceeding with manual activation anyway...")
                paid = True  # Assume paid since you mentioned it worked

            if not paid:
                logger.error("Payment not confirmed by LND")
                return False

            # Create the actual email account
            logger.info("Creating email account...")
            success, password = email_service.create_account(account.email_address)

            if success:
                # Store the password in the database
                account.email_password = password
                account.payment_status = PaymentStatus.PAID

                session.add(account)
                session.commit()

                logger.info("✅ Email account activated successfully!")
                logger.info(f"Email: {account.email_address}")
                logger.info(f"Password: {password}")
                logger.info(f"Status: {account.payment_status}")

                return True
            else:
                logger.error(f"Failed to create email account: {account.email_address}")
                return False

    except Exception as e:
        logger.error(f"Error in manual activation: {str(e)}")
        return False


def activate_account_by_email(email_address: str) -> bool:
    """
    Manually activate an email account by email address.

    Args:
        email_address: The email address to activate

    Returns:
        True if successful, False otherwise
    """
    logger.info(f"Starting manual activation for email: {email_address}")

    # Initialize services
    email_service = EmailService()

    try:
        with Session(engine) as session:
            # Find the account by email address
            statement = select(EmailAccount).where(
                EmailAccount.email_address == email_address
            )
            account = session.exec(statement).first()

            if not account:
                logger.error(f"Account not found for email: {email_address}")
                return False

            logger.info(f"Found account with payment hash: {account.payment_hash}")
            logger.info(f"Current status: {account.payment_status}")

            if account.payment_status == PaymentStatus.PAID:
                logger.info("Account is already marked as paid")
                if account.email_password:
                    logger.info(f"Email password: {account.email_password}")
                return True

            # Create the actual email account
            logger.info("Creating email account...")
            success, password = email_service.create_account(account.email_address)

            if success:
                # Store the password in the database
                account.email_password = password
                account.payment_status = PaymentStatus.PAID

                session.add(account)
                session.commit()

                logger.info("✅ Email account activated successfully!")
                logger.info(f"Email: {account.email_address}")
                logger.info(f"Password: {password}")
                logger.info(f"Status: {account.payment_status}")

                return True
            else:
                logger.error(f"Failed to create email account: {account.email_address}")
                return False

    except Exception as e:
        logger.error(f"Error in manual activation: {str(e)}")
        return False


def main() -> None:
    """Main function to handle command line arguments."""
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python activate_account.py <payment_hash>")
        print("  python activate_account.py --email <email_address>")
        print("\nExamples:")
        print("  python activate_account.py 0000000000000000000...")
        print("  python activate_account.py --email someuser@lnemail.net")
        sys.exit(1)

    if sys.argv[1] == "--email" and len(sys.argv) >= 3:
        email_address = sys.argv[2]
        success = activate_account_by_email(email_address)
    else:
        payment_hash = sys.argv[1]
        success = activate_account_by_payment_hash(payment_hash)

    if success:
        logger.info("✅ Account activation completed successfully!")
        sys.exit(0)
    else:
        logger.error("❌ Account activation failed!")
        sys.exit(1)


if __name__ == "__main__":
    main()
