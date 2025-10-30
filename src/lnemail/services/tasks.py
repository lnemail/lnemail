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
from ..core.models import EmailAccount, PaymentStatus, PendingOutgoingEmail
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


def process_send_email_payment(payment_hash: str) -> None:
    """Process a paid invoice for an outgoing email and send the email.

    Args:
        payment_hash: The hash of the invoice for the outgoing email.
    """
    logger.info(f"Processing send email payment for hash: {payment_hash}")

    lnd_service = LNDService()
    email_service = EmailService()

    try:
        with Session(engine) as session:
            statement = select(PendingOutgoingEmail).where(
                PendingOutgoingEmail.payment_hash == payment_hash
            )
            pending_email = session.exec(statement).first()

            if not pending_email:
                logger.error(
                    f"Pending outgoing email not found for hash: {payment_hash}"
                )
                return

            if pending_email.status != PaymentStatus.PENDING:
                logger.info(
                    f"Outgoing email already processed or expired for hash: {payment_hash}"
                )
                return

            paid = lnd_service.check_invoice(payment_hash)
            if paid:
                # Get the sender's email account to retrieve password
                sender_statement = select(EmailAccount).where(
                    EmailAccount.email_address == pending_email.sender_email
                )
                sender_account = session.exec(sender_statement).first()

                if not sender_account or not sender_account.email_password:
                    logger.error(
                        f"Sender account not found or missing password: {pending_email.sender_email}"
                    )
                    pending_email.status = PaymentStatus.FAILED
                else:
                    # Send email using SMTP with authentication
                    success, message = email_service.send_email_with_auth(
                        sender=pending_email.sender_email,
                        sender_password=sender_account.email_password,
                        recipient=pending_email.recipient,
                        subject=pending_email.subject,
                        body=pending_email.body,
                        in_reply_to=pending_email.in_reply_to,
                        references=pending_email.references,
                    )

                    if success:
                        pending_email.status = PaymentStatus.PAID
                        logger.info(
                            f"Email sent successfully from {pending_email.sender_email} to {pending_email.recipient}"
                        )
                    else:
                        pending_email.status = PaymentStatus.FAILED
                        logger.error(
                            f"Failed to send email from {pending_email.sender_email} to {pending_email.recipient}: {message}"
                        )
            else:
                # Invoice not paid yet or expired, mark as failed if past expiry
                if datetime.utcnow() > pending_email.expires_at:
                    pending_email.status = PaymentStatus.EXPIRED
                    logger.warning(
                        f"Outgoing email invoice expired for hash: {payment_hash}"
                    )
                else:
                    logger.info(
                        f"Outgoing email invoice not paid yet for hash: {payment_hash}"
                    )
                    # Re-queue if not paid and not expired to check again later
                    queue.enqueue_in(
                        timedelta(seconds=5),  # Check again in 5 seconds
                        process_send_email_payment,
                        payment_hash,
                        job_timeout=600,
                    )
                    return  # Exit, as we re-queued

            session.add(pending_email)
            session.commit()

    except Exception as e:
        logger.error(f"Error in process_send_email_payment: {str(e)}")


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
                (
                    EmailAccount.expires_at < now + timedelta(days=365)
                )  # 1 year grace period
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
                email_service.delete_account(account.email_address)

            session.commit()

    except Exception as e:
        logger.error(f"Error in cleanup_expired_accounts: {str(e)}")


def cleanup_expired_pending_emails() -> None:
    """Find and clean up expired pending outgoing email records."""
    logger.info("Running expired pending emails cleanup task")

    try:
        with Session(engine) as session:
            now = datetime.utcnow()

            # Find pending emails whose invoices have expired
            statement = select(PendingOutgoingEmail).where(
                (PendingOutgoingEmail.expires_at < now)
                & (PendingOutgoingEmail.status == PaymentStatus.PENDING)
            )
            expired_pending_emails = session.exec(statement).all()

            logger.info(
                f"Found {len(expired_pending_emails)} expired pending outgoing emails"
            )

            for pending_email in expired_pending_emails:
                pending_email.status = PaymentStatus.EXPIRED
                session.add(pending_email)
                logger.info(
                    f"Marked pending outgoing email as expired: {pending_email.payment_hash}"
                )

            session.commit()

    except Exception as e:
        logger.error(f"Error in cleanup_expired_pending_emails: {str(e)}")


def schedule_regular_tasks() -> None:
    """Schedule recurring tasks at appropriate intervals.

    This function should be called once at application startup to schedule
    regular maintenance tasks.
    """
    # Schedule cleanup tasks
    queue.enqueue_in(
        timedelta=timedelta(days=1),
        func=cleanup_expired_accounts,
        job_id="daily_account_cleanup",
        job_timeout=3600,  # 1 hour timeout
        meta={"repeat": True},  # Ensure it re-schedules itself
    )

    queue.enqueue_in(
        timedelta=timedelta(hours=1),
        func=cleanup_expired_pending_emails,
        job_id="hourly_pending_email_cleanup",
        job_timeout=600,  # 10 minute timeout
        meta={"repeat": True},  # Ensure it re-schedules itself
    )

    logger.info("Scheduled regular maintenance tasks")
