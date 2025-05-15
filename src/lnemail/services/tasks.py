"""
Background tasks for LNemail services.

This module contains functions to be executed by the Redis Queue (RQ) worker,
handling asynchronous operations like payment verification and cleanup.
"""

from datetime import datetime, timedelta

from loguru import logger
from redis import Redis
from rq import Queue
from sqlmodel import Session, select

from ..config import settings
from ..core.models import EmailAccount, PaymentStatus
from ..db import engine
from .email_service import EmailService
from .lnd_service import LNDService

# Set up Redis connection and RQ queue
redis_conn = Redis(host=settings.REDIS_HOST, port=settings.REDIS_PORT)
queue = Queue("lnemail", connection=redis_conn)


def check_payment_status(payment_hash: str) -> None:
    """Check if a Lightning invoice has been paid and set up email if it has.

    Args:
        payment_hash: The hash of the invoice to check
    """
    logger.info(f"Checking payment status for hash: {payment_hash}")

    # Initialize services
    lnd_service = LNDService()
    email_service = EmailService()

    try:
        # Check if payment is received
        paid = lnd_service.check_invoice(payment_hash)

        if not paid:
            logger.info(f"Payment not received yet for hash: {payment_hash}")
            return

        # Payment received, update account
        with Session(engine) as session:
            statement = select(EmailAccount).where(
                EmailAccount.payment_hash == payment_hash
            )
            account = session.exec(statement).first()

            if not account:
                logger.error(f"Account not found for payment hash: {payment_hash}")
                return

            if account.payment_status == PaymentStatus.PAID:
                logger.info(f"Payment already processed for: {account.email_address}")
                return

            # Create the actual email account
            success, password = email_service.create_account(account.email_address)

            if success:
                # Store the password in the database
                account.email_password = password
                account.payment_status = PaymentStatus.PAID
                session.add(account)
                session.commit()
                logger.info(f"Email account activated: {account.email_address}")
            else:
                logger.error(f"Failed to create email account: {account.email_address}")

    except Exception as e:
        logger.error(f"Error in check_payment_status: {str(e)}")


def cleanup_expired_accounts() -> None:
    """Find and clean up expired accounts.

    This task finds accounts that have expired and marks them as expired,
    optionally cleaning up resources.
    """
    logger.info("Running expired accounts cleanup task")

    try:
        # Initialize email service
        email_service = EmailService()

        with Session(engine) as session:
            # Find expired accounts that are still marked as paid
            now = datetime.utcnow()
            statement = select(EmailAccount).where(
                (EmailAccount.expires_at < now)
                & (EmailAccount.payment_status == PaymentStatus.PAID)
            )

            expired_accounts = session.exec(statement).all()
            logger.info(f"Found {len(expired_accounts)} expired accounts")

            # Process each expired account
            for account in expired_accounts:
                logger.info(f"Processing expired account: {account.email_address}")

                # Update status to expired
                account.payment_status = PaymentStatus.EXPIRED
                session.add(account)

                # Delete the email account
                # Note: In a real system, you might want to implement a grace period
                # or notification system before deletion
                email_service.delete_account(account.email_address)

            session.commit()

    except Exception as e:
        logger.error(f"Error in cleanup_expired_accounts: {str(e)}")


def schedule_regular_tasks() -> None:
    """Schedule recurring tasks at appropriate intervals.

    This function should be called once at application startup to schedule
    regular maintenance tasks.
    """
    # Schedule cleanup task to run daily
    queue.enqueue_in(
        timedelta=timedelta(days=1),
        func=cleanup_expired_accounts,
        job_id="daily_cleanup",
        job_timeout=3600,  # 1 hour timeout
    )

    logger.info("Scheduled regular maintenance tasks")
