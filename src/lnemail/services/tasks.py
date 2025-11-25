"""
Background tasks for LNemail services.
This module contains functions to be executed by the Redis Queue (RQ) worker,
handling asynchronous operations like payment verification and cleanup.
"""

from datetime import datetime, timedelta
from loguru import logger
from redis import Redis
from rq import Queue
from sqlmodel import Session, select, func

from ..config import settings
from ..core.models import (
    DeliveryStatus,
    EmailAccount,
    PaymentStatus,
    PendingOutgoingEmail,
    EmailSendStatistics,
)

from ..db import engine
from .email_service import EmailService
from .lnd_service import LNDService

# Set up Redis connection and RQ queue
redis_conn = Redis(host=settings.REDIS_HOST, port=settings.REDIS_PORT)
queue = Queue("lnemail", connection=redis_conn)

# Retry configuration
RETRY_DELAYS = [30, 60, 300, 900, 3600]  # 30s, 1m, 5m, 15m, 1h
ONGOING_RETRY_DELAY = 3600  # After initial retries, retry every hour indefinitely


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


def update_email_statistics(
    session: Session, status: PaymentStatus, price_sats: int
) -> None:
    """Update monthly email send statistics.

    Args:
        session: Database session
        status: Final status of the email (PAID or FAILED)
        price_sats: Price paid for the email
    """
    try:
        year_month = EmailSendStatistics.get_current_year_month()

        statement = select(EmailSendStatistics).where(
            EmailSendStatistics.year_month == year_month
        )
        stats = session.exec(statement).first()

        if not stats:
            stats = EmailSendStatistics(
                year_month=year_month,
                total_sent=0,
                total_failed=0,
                total_revenue_sats=0,
            )

        if status == PaymentStatus.PAID:
            stats.total_sent += 1
            stats.total_revenue_sats += price_sats
        elif status == PaymentStatus.FAILED:
            stats.total_failed += 1

        stats.updated_at = datetime.utcnow()
        session.add(stats)
        session.commit()

        logger.info(
            f"Updated email statistics for {year_month}: "
            f"sent={stats.total_sent}, failed={stats.total_failed}"
        )

    except Exception as e:
        logger.error(f"Error updating email statistics: {str(e)}")


def process_send_email_payment(payment_hash: str, is_retry: bool = False) -> None:
    """Process a paid invoice for an outgoing email and send the email.

    Args:
        payment_hash: The hash of the invoice for the outgoing email.
        is_retry: Whether this is a retry attempt
    """
    logger.info(
        f"Processing send email payment for hash: {payment_hash}"
        f"{' (retry)' if is_retry else ''}"
    )

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

            # Skip if already processed successfully
            if (
                pending_email.status == PaymentStatus.PAID
                and pending_email.delivery_status == DeliveryStatus.SENT
            ):
                logger.info(
                    f"Outgoing email already sent successfully for hash: {payment_hash}"
                )
                return

            # Check payment status
            paid = lnd_service.check_invoice(payment_hash)

            if not paid:
                # Invoice not paid yet
                if datetime.utcnow() > pending_email.expires_at:
                    pending_email.status = PaymentStatus.EXPIRED
                    session.add(pending_email)
                    session.commit()
                    logger.warning(
                        f"Outgoing email invoice expired for hash: {payment_hash}"
                    )
                else:
                    logger.info(
                        f"Outgoing email invoice not paid yet for hash: {payment_hash}"
                    )
                    # Re-queue to check again later
                    queue.enqueue_in(
                        timedelta(seconds=5),
                        process_send_email_payment,
                        payment_hash,
                        False,
                        job_timeout=600,
                    )
                return

            # Payment received, validate we have email content
            if not pending_email.recipient or not pending_email.body:
                logger.error(f"Email content missing for paid invoice: {payment_hash}")
                pending_email.status = (
                    PaymentStatus.PAID
                )  # Payment was received but we can't process
                pending_email.delivery_status = DeliveryStatus.FAILED
                pending_email.delivery_error = "Invalid email content"
                session.add(pending_email)
                session.commit()
                return

            # Get the sender's email account to retrieve password
            sender_statement = select(EmailAccount).where(
                EmailAccount.email_address == pending_email.sender_email
            )
            sender_account = session.exec(sender_statement).first()

            if not sender_account or not sender_account.email_password:
                logger.error(
                    f"Sender account not found or missing password: "
                    f"{pending_email.sender_email}"
                )
                pending_email.status = PaymentStatus.PAID  # Payment received
                pending_email.delivery_status = DeliveryStatus.FAILED
                pending_email.delivery_error = "Sender authentication failed"
                session.add(pending_email)
                session.commit()
                return

            # Mark as paid immediately since we confirmed payment
            pending_email.status = PaymentStatus.PAID

            # Send email using SMTP with authentication
            success, message = email_service.send_email_with_auth(
                sender=pending_email.sender_email,
                sender_password=sender_account.email_password,
                recipient=pending_email.recipient,
                subject=pending_email.subject or "",
                body=pending_email.body,
                in_reply_to=pending_email.in_reply_to,
                references=pending_email.references,
            )

            if success:
                pending_email.delivery_status = DeliveryStatus.SENT
                pending_email.delivery_error = None
                pending_email.sent_at = datetime.utcnow()

                # Update statistics
                update_email_statistics(
                    session, PaymentStatus.PAID, pending_email.price_sats
                )

                logger.info(
                    f"Email sent successfully from {pending_email.sender_email}"
                )
            else:
                # Email send failed, increment retry count
                pending_email.delivery_error = message
                # Keep status as PAID (payment successful), but delivery pending/failed
                # The delivery_status remains PENDING until we exhaust retries or succeed,
                # or we can explicitly set it if needed, but usually PENDING is fine for retries.
                # However, the task logic below continues to retry.

                pending_email.retry_count += 1
                pending_email.last_retry_at = datetime.utcnow()

                # Calculate retry delay
                if pending_email.retry_count <= len(RETRY_DELAYS):
                    # Use initial retry delays
                    retry_delay = RETRY_DELAYS[pending_email.retry_count - 1]
                else:
                    # After initial retries, continue with hourly retries indefinitely
                    retry_delay = ONGOING_RETRY_DELAY

                logger.warning(
                    f"Email send failed (attempt {pending_email.retry_count}), "
                    f"retrying in {retry_delay}s: {message}"
                )

                # Schedule retry
                queue.enqueue_in(
                    timedelta(seconds=retry_delay),
                    process_send_email_payment,
                    payment_hash,
                    True,  # is_retry
                    job_timeout=600,
                )

            session.add(pending_email)
            session.commit()

    except Exception as e:
        logger.error(f"Error in process_send_email_payment: {str(e)}")


def retry_failed_emails() -> None:
    """Retry sending failed emails.

    This should be called on worker startup to resume failed email sends.
    Now retries indefinitely with hourly intervals after initial attempts.
    """
    logger.info("Checking for failed emails to retry")

    try:
        with Session(engine) as session:
            # Find failed emails that have content (no max retry limit)
            statement = select(PendingOutgoingEmail).where(
                (PendingOutgoingEmail.status == PaymentStatus.FAILED)
                & (PendingOutgoingEmail.recipient != None)  # noqa: E711
                & (PendingOutgoingEmail.body != None)  # noqa: E711
                & (
                    PendingOutgoingEmail.created_at
                    > datetime.utcnow() - timedelta(days=7)  # Keep trying for 7 days
                )
            )
            failed_emails = session.exec(statement).all()

            logger.info(f"Found {len(failed_emails)} failed emails to retry")

            for pending_email in failed_emails:
                logger.info(
                    f"Retrying failed email: {pending_email.payment_hash} "
                    f"(attempt {pending_email.retry_count + 1})"
                )

                # Calculate retry delay based on current retry count
                if pending_email.retry_count < len(RETRY_DELAYS):
                    retry_delay = RETRY_DELAYS[pending_email.retry_count]
                else:
                    retry_delay = ONGOING_RETRY_DELAY

                # Queue the retry
                queue.enqueue_in(
                    timedelta(seconds=retry_delay),
                    process_send_email_payment,
                    pending_email.payment_hash,
                    True,  # is_retry
                    job_timeout=600,
                )

    except Exception as e:
        logger.error(f"Error in retry_failed_emails: {str(e)}")


def cleanup_expired_accounts() -> None:
    """Find and clean up expired accounts.

    This task finds accounts that have expired AND passed the 1-year grace period,
    then marks them as expired and cleans up resources.

    Timeline:
    - Account created: 2025-05-16
    - Account expires: 2026-05-16 (1 year validity)
    - Grace period ends: 2027-05-16 (1 year after expiration)
    - This task runs: Should only mark as EXPIRED after 2027-05-16
    """
    logger.info("Running expired accounts cleanup task")

    try:
        email_service = EmailService()

        with Session(engine) as session:
            now = datetime.utcnow()

            # Find accounts that expired more than 1 year ago
            # Grace period: Allow 1 year AFTER expiration for renewal
            grace_period_cutoff = now - timedelta(days=365)

            statement = select(EmailAccount).where(
                (EmailAccount.expires_at < grace_period_cutoff)
                & (EmailAccount.payment_status == PaymentStatus.PAID)
            )
            expired_accounts = session.exec(statement).all()

            logger.info(
                f"Found {len(expired_accounts)} accounts past grace period "
                f"(expired before {grace_period_cutoff.isoformat()})"
            )

            for account in expired_accounts:
                logger.info(
                    f"Processing account past grace period: {account.email_address} "
                    f"(expired: {account.expires_at.isoformat()})"
                )

                # Update status to expired
                account.payment_status = PaymentStatus.EXPIRED
                session.add(account)

                # Delete the email account
                email_service.delete_account(account.email_address)

            session.commit()

    except Exception as e:
        logger.error(f"Error in cleanup_expired_accounts: {str(e)}")


def cleanup_old_pending_accounts() -> None:
    """Clean up old pending account creation attempts that were never paid."""
    logger.info("Running old pending accounts cleanup task")

    try:
        with Session(engine) as session:
            cutoff_date = datetime.utcnow() - timedelta(days=1)

            # Find old pending accounts
            statement = select(EmailAccount).where(
                (EmailAccount.created_at < cutoff_date)
                & (EmailAccount.payment_status == PaymentStatus.PENDING)
            )
            old_pending_accounts = session.exec(statement).all()

            logger.info(
                f"Found {len(old_pending_accounts)} old pending accounts to clean up"
            )

            for account in old_pending_accounts:
                account.payment_status = PaymentStatus.EXPIRED
                session.add(account)
                logger.debug(
                    f"Marked old pending account as expired: {account.email_address}"
                )

            session.commit()

    except Exception as e:
        logger.error(f"Error in cleanup_old_pending_accounts: {str(e)}")


def cleanup_expired_pending_emails() -> None:
    """Clean up expired pending outgoing email records."""
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
                logger.debug(
                    f"Marked pending outgoing email as expired: "
                    f"{pending_email.payment_hash}"
                )

            session.commit()

    except Exception as e:
        logger.error(f"Error in cleanup_expired_pending_emails: {str(e)}")


def cleanup_old_outgoing_emails() -> None:
    """Clean up old outgoing email records (>30 days) regardless of status."""
    logger.info("Running old outgoing emails cleanup task")

    try:
        with Session(engine) as session:
            cutoff_date = datetime.utcnow() - timedelta(days=30)

            # Count records before deletion
            count_statement = (
                select(func.count())
                .select_from(PendingOutgoingEmail)
                .where(PendingOutgoingEmail.created_at < cutoff_date)
            )
            count = session.exec(count_statement).one()

            # Delete old records
            statement = select(PendingOutgoingEmail).where(
                PendingOutgoingEmail.created_at < cutoff_date
            )
            old_emails = session.exec(statement).all()

            for email in old_emails:
                session.delete(email)

            session.commit()

            logger.info(f"Deleted {count} old outgoing email records (>30 days)")

    except Exception as e:
        logger.error(f"Error in cleanup_old_outgoing_emails: {str(e)}")


def schedule_regular_tasks() -> None:
    """Schedule recurring tasks at appropriate intervals.

    This function should be called once at application startup to schedule
    regular maintenance tasks.
    """
    # Schedule cleanup tasks
    queue.enqueue_in(
        timedelta(days=1),
        cleanup_expired_accounts,
        job_id="daily_account_cleanup",
        job_timeout=3600,  # 1 hour timeout
    )

    queue.enqueue_in(
        timedelta(hours=1),
        cleanup_expired_pending_emails,
        job_id="hourly_pending_email_cleanup",
        job_timeout=600,  # 10 minute timeout
    )

    queue.enqueue_in(
        timedelta(days=1),
        cleanup_old_pending_accounts,
        job_id="daily_old_pending_accounts_cleanup",
        job_timeout=600,  # 10 minute timeout
    )

    queue.enqueue_in(
        timedelta(days=1),
        cleanup_old_outgoing_emails,
        job_id="daily_old_outgoing_emails_cleanup",
        job_timeout=3600,  # 1 hour timeout
    )

    # Retry failed emails on startup
    queue.enqueue(
        retry_failed_emails,
        job_id="startup_retry_failed_emails",
        job_timeout=600,
    )

    logger.info("Scheduled regular maintenance tasks and startup retry job")
