"""
API endpoint handlers for LNemail.

This module contains the FastAPI route definitions and handlers
for all the LNemail API endpoints.
"""

import base64
import json
from datetime import datetime, timedelta
from email.utils import formatdate
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlmodel import Session, select, desc
from loguru import logger

from ..config import settings
from ..core.models import EmailAccount, PaymentStatus, PendingOutgoingEmail
from ..core.schemas import (
    AccountResponse,
    EmailContent,
    EmailDeleteRequest,
    EmailDeleteResponse,
    EmailHeader,
    EmailListResponse,
    EmailCreateRequest,
    EmailSendInvoiceResponse,
    EmailSendRequest,
    EmailSendStatusResponse,
    ErrorResponse,
    HealthResponse,
    InvoiceResponse,
    MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
    PaymentStatusResponse,
    RecentSendItem,
    RecentSendsResponse,
    RenewalInvoiceResponse,
    RenewalRequest,
    RenewalStatusResponse,
)
from ..db import get_db
from ..services.email_service import EmailService
from ..services.lnd_service import LNDService
from ..services.tasks import (
    check_payment_status,
    check_renewal_payment_status,
    process_send_email_payment,
    queue,
)

# Create routers
router = APIRouter()
health_router = APIRouter(tags=["health"])

# Setup simple Bearer token scheme for authentication
security = HTTPBearer(auto_error=False)

# Initialize services
lnd_service = LNDService()
email_service = EmailService()

# Virtual expiration warning email ID prefix.  The full ID includes the
# account's ``expires_at`` timestamp so it changes after a renewal,
# ensuring users see a fresh warning in their next renewal window.
_EXPIRY_WARNING_ID_PREFIX = "lnemail-expiry-warning"
_EXPIRY_WARNING_DAYS = 90


def _build_expiry_warning_header(account: EmailAccount) -> EmailHeader:
    """Build a synthetic EmailHeader for the expiration warning."""
    now = datetime.utcnow()
    days_left = max(0, (account.expires_at - now).days)
    return EmailHeader(
        id=f"{_EXPIRY_WARNING_ID_PREFIX}-{int(account.expires_at.timestamp())}",
        subject=f"Your LNemail account expires in {days_left} days",
        sender=f"LNemail <noreply@{settings.MAIL_DOMAIN}>",
        date=formatdate(localtime=False, usegmt=True),
        read=False,
    )


def _build_expiry_warning_content(account: EmailAccount) -> EmailContent:
    """Build a synthetic EmailContent for the expiration warning."""
    now = datetime.utcnow()
    days_left = max(0, (account.expires_at - now).days)
    body = (
        f"Hello,\n\n"
        f"Your LNemail account ({account.email_address}) will expire "
        f"in {days_left} days on "
        f"{account.expires_at.strftime('%Y-%m-%d')}.\n\n"
        f"To renew your account, click the Renew button in the header "
        f"or use the renewal banner at the top of your inbox.\n\n"
        f"You can renew for 1 or more years using a Lightning payment.\n\n"
        f"If your account expires, you have a 1-year grace period "
        f"during which you can still renew and your emails will be "
        f"preserved.\n\n"
        f"-- LNemail\n"
    )
    return EmailContent(
        id=f"{_EXPIRY_WARNING_ID_PREFIX}-{int(account.expires_at.timestamp())}",
        subject=f"Your LNemail account expires in {days_left} days",
        sender=f"LNemail <noreply@{settings.MAIL_DOMAIN}>",
        date=formatdate(localtime=False, usegmt=True),
        body=body,
        body_plain=body,
        body_html=None,
        content_type="text/plain",
        attachments=[],
        read=False,
        message_id=None,
        references=None,
    )


async def get_current_account(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    db: Session = Depends(get_db),
) -> EmailAccount:
    """Validate the bearer token and return the corresponding account.

    Allows expired accounts within the 1-year grace period to authenticate
    so they can access the renewal flow. Fully expired accounts (past the
    grace period) are rejected.

    Args:
        credentials: Authorization credentials from the request
        db: Database session dependency

    Returns:
        EmailAccount: The authenticated account

    Raises:
        HTTPException: If token is invalid or account not found
    """
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials

    statement = select(EmailAccount).where(EmailAccount.access_token == token)
    account = db.exec(statement).first()

    if not account:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if account.payment_status == PaymentStatus.EXPIRED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account has been permanently expired",
        )

    if account.payment_status != PaymentStatus.PAID:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account payment required",
        )

    # Allow expired-but-within-grace-period accounts to authenticate
    # so they can renew. The grace period is 1 year after expiration.
    now = datetime.utcnow()
    if account.expires_at < now:
        grace_period_end = account.expires_at + timedelta(days=365)
        if now > grace_period_end:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account has expired beyond the renewal grace period",
            )

    return account


async def get_current_active_account(
    account: EmailAccount = Depends(get_current_account),
) -> EmailAccount:
    """Validate that the authenticated account is not expired.

    Wraps ``get_current_account`` with an additional check that the
    account's ``expires_at`` is in the future.  Expired accounts that are
    within the renewal grace period can still authenticate (via
    ``get_current_account``) but must not access email endpoints.

    Args:
        account: The account returned by ``get_current_account``.

    Returns:
        EmailAccount: The authenticated, non-expired account.

    Raises:
        HTTPException: 403 if the account has expired.
    """
    now = datetime.utcnow()
    if account.expires_at < now:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account has expired. Please renew your account to continue.",
        )
    return account


@router.post(
    "/email",
    response_model=InvoiceResponse,
    status_code=status.HTTP_201_CREATED,
    responses={500: {"model": ErrorResponse, "description": "Internal server error"}},
)
async def create_email_account(
    background_tasks: BackgroundTasks,
    request_data: EmailCreateRequest | None = None,
    db: Session = Depends(get_db),
) -> InvoiceResponse:
    """Create a new email account and generate Lightning invoice.

    Args:
        background_tasks: FastAPI background tasks
        db: Database session dependency

    Returns:
        Invoice details and payment instructions
    """
    try:
        # Generate random email and access token
        email_address = EmailAccount.generate_random_email(domain=settings.MAIL_DOMAIN)
        access_token = EmailAccount.generate_access_token()

        memo_parts = ["LNemail account"]
        if request_data and request_data.include_email:
            memo_parts.append(f"Email: {email_address}")
        if request_data and request_data.include_token:
            memo_parts.append(f"Token: {access_token}")
        memo_parts.append("(valid for 1 year)")
        memo = " ".join(memo_parts)

        invoice = lnd_service.create_invoice(settings.EMAIL_PRICE, memo)

        # Create account record in pending state
        account = EmailAccount(
            email_address=email_address,
            access_token=access_token,
            payment_hash=invoice["payment_hash"],
            payment_status=PaymentStatus.PENDING,
        )

        if settings.USE_LNPROXY and "original_payment_request" in invoice:
            # Store the original payment request for validation when using LNProxy
            account.original_payment_request = invoice["original_payment_request"]

        db.add(account)
        db.commit()
        db.refresh(account)

        # Schedule background task to check payment status
        queue.enqueue(
            check_payment_status,
            invoice["payment_hash"],
            job_timeout=600,  # 10 minute timeout
        )

        # Return invoice information to client
        return InvoiceResponse(
            email_address=email_address,
            access_token=access_token,
            payment_request=invoice["payment_request"],
            payment_hash=invoice["payment_hash"],
            expires_at=account.expires_at,
            price_sats=settings.EMAIL_PRICE,
        )

    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create email account",
        )


@router.get(
    "/payment/{payment_hash}",
    response_model=PaymentStatusResponse,
    responses={
        404: {"model": ErrorResponse, "description": "Payment not found"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def check_payment(
    payment_hash: str, db: Session = Depends(get_db)
) -> PaymentStatusResponse:
    """Check payment status for a given payment hash.

    Args:
        payment_hash: The Lightning payment hash to check
        db: Database session dependency

    Returns:
        Payment status and account details if paid
    """
    try:
        # Check if we have this payment hash in our database
        statement = select(EmailAccount).where(
            EmailAccount.payment_hash == payment_hash
        )
        account = db.exec(statement).first()

        if not account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found"
            )

        # If still pending, check the current status with LND
        if account.payment_status == PaymentStatus.PENDING:
            paid = lnd_service.check_invoice(payment_hash)
            if paid and account.payment_status != PaymentStatus.PAID:
                # Payment just received, trigger the account setup
                queue.enqueue(check_payment_status, payment_hash, job_timeout=600)

        # Return appropriate response based on payment status
        response = PaymentStatusResponse(payment_status=account.payment_status)

        if account.payment_status == PaymentStatus.PAID:
            response.email_address = account.email_address
            response.access_token = account.access_token

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking payment status: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to check payment status",
        )


@router.post(
    "/email/send",
    response_model=EmailSendInvoiceResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {"model": ErrorResponse, "description": "Account not paid or expired"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def send_email(
    send_request: EmailSendRequest,
    account: EmailAccount = Depends(get_current_active_account),
    db: Session = Depends(get_db),
) -> EmailSendInvoiceResponse:
    """Initiate sending an email from the authenticated account.

    Generates a Lightning invoice that the user must pay to send the email.
    The email itself will be sent in a background task after the invoice is paid.

    Args:
        send_request: Details of the email to send (recipient, subject, body).
        account: Authenticated EmailAccount from token validation.
        db: Database session dependency.

    Returns:
        EmailSendInvoiceResponse: Details of the Lightning invoice to pay.
    """
    try:
        # Validate total attachment size
        if send_request.attachments:
            total_size = 0
            for attachment in send_request.attachments:
                try:
                    decoded = base64.b64decode(attachment.content)
                    total_size += len(decoded)
                except Exception:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Invalid base64 content for attachment: {attachment.filename}",
                    )
            if total_size > MAX_TOTAL_ATTACHMENT_SIZE_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Total attachment size ({total_size} bytes) exceeds "
                    f"the {MAX_TOTAL_ATTACHMENT_SIZE_BYTES // (1024 * 1024)} MB limit",
                )

        sender_email = account.email_address
        memo = f"Send email from {sender_email} to {send_request.recipient}"

        invoice = lnd_service.create_invoice(settings.EMAIL_SEND_PRICE, memo)

        # Serialize attachments to JSON for storage
        attachments_json: str | None = None
        if send_request.attachments:
            attachments_json = json.dumps(
                [att.model_dump() for att in send_request.attachments]
            )

        pending_email = PendingOutgoingEmail(
            sender_email=sender_email,
            recipient=send_request.recipient,
            subject=send_request.subject,
            body=send_request.body,
            payment_hash=invoice["payment_hash"],
            payment_request=invoice["payment_request"],
            price_sats=settings.EMAIL_SEND_PRICE,
            status=PaymentStatus.PENDING,
            in_reply_to=send_request.in_reply_to,
            references=send_request.references,
            attachments_json=attachments_json,
        )

        db.add(pending_email)
        db.commit()
        db.refresh(pending_email)

        # Schedule background task to process email send after payment
        queue.enqueue(
            process_send_email_payment,
            invoice["payment_hash"],
            job_timeout=600,  # 10 minute timeout for payment confirmation
        )

        return EmailSendInvoiceResponse(
            payment_request=invoice["payment_request"],
            payment_hash=invoice["payment_hash"],
            price_sats=settings.EMAIL_SEND_PRICE,
            sender_email=sender_email,
            recipient=send_request.recipient,
            subject=send_request.subject,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error initiating email send: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to initiate email send",
        )


@router.get(
    "/email/send/status/{payment_hash}",
    response_model=EmailSendStatusResponse,
    responses={
        404: {"model": ErrorResponse, "description": "Payment not found"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def check_send_email_payment_status(
    payment_hash: str, db: Session = Depends(get_db)
) -> EmailSendStatusResponse:
    """Check payment and delivery status for an outgoing email send."""
    try:
        statement = select(PendingOutgoingEmail).where(
            PendingOutgoingEmail.payment_hash == payment_hash
        )
        pending_email = db.exec(statement).first()

        if not pending_email:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Outgoing email payment not found",
            )

        if pending_email.status == PaymentStatus.PENDING:
            paid = lnd_service.check_invoice(payment_hash)
            if paid:
                queue.enqueue(process_send_email_payment, payment_hash, job_timeout=600)

        # Sanitize delivery error for security
        delivery_error = pending_email.delivery_error
        if delivery_error:
            # Return a generic error message to avoid leaking internal details
            delivery_error = (
                "Email delivery failed. The system will retry automatically."
            )

        return EmailSendStatusResponse(
            payment_status=pending_email.status,
            delivery_status=str(pending_email.delivery_status).lower(),
            delivery_error=delivery_error,
            sender_email=pending_email.sender_email,
            recipient=pending_email.recipient,
            subject=pending_email.subject,
            sent_at=pending_email.sent_at,
            retry_count=pending_email.retry_count,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking outgoing email payment status: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to check outgoing email payment status",
        )


@router.get(
    "/email/sends/recent",
    response_model=RecentSendsResponse,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {"model": ErrorResponse, "description": "Account not paid or expired"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def get_recent_sends(
    account: EmailAccount = Depends(get_current_active_account),
    db: Session = Depends(get_db),
) -> RecentSendsResponse:
    """Get recent email sends for the authenticated account."""
    try:
        statement = (
            select(PendingOutgoingEmail)
            .where(PendingOutgoingEmail.sender_email == account.email_address)
            .order_by(desc(PendingOutgoingEmail.created_at))
            .limit(10)
        )
        recent_sends = db.exec(statement).all()

        return RecentSendsResponse(
            sends=[
                RecentSendItem(
                    payment_hash=email.payment_hash,
                    recipient=email.recipient,
                    subject=email.subject,
                    payment_status=email.status,
                    delivery_status=str(email.delivery_status).lower(),
                    created_at=email.created_at,
                    sent_at=email.sent_at,
                )
                for email in recent_sends
            ]
        )
    except Exception as e:
        logger.error(f"Error getting recent sends: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get recent sends",
        )


@router.get(
    "/account",
    response_model=AccountResponse,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {"model": ErrorResponse, "description": "Account not paid or expired"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def get_account(
    account: EmailAccount = Depends(get_current_account),
) -> AccountResponse:
    """Get account details for the authenticated user."""
    now = datetime.utcnow()
    is_expired = account.expires_at < now
    days_until_expiry = max(0, (account.expires_at - now).days) if not is_expired else 0

    # Renewal eligible if account is expired but within 1-year grace period,
    # or if the account is still active
    grace_period_end = account.expires_at + timedelta(days=365)
    renewal_eligible = now < grace_period_end

    return AccountResponse(
        email_address=account.email_address,
        expires_at=account.expires_at,
        is_expired=is_expired,
        days_until_expiry=days_until_expiry,
        renewal_eligible=renewal_eligible,
    )


@router.get(
    "/emails",
    response_model=EmailListResponse,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {"model": ErrorResponse, "description": "Account not paid or expired"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def list_emails(
    account: EmailAccount = Depends(get_current_active_account),
) -> EmailListResponse:
    """List emails for the authenticated account.

    Args:
        account: Authenticated EmailAccount from token validation

    Returns:
        List of email headers
    """
    try:
        # Use the stored email password from the account
        if not account.email_password:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Email password not found for account",
            )

        emails = email_service.list_emails(
            account.email_address, account.email_password
        )

        # Convert the returned data to the correct type
        email_headers: list[EmailHeader] = [EmailHeader(**email) for email in emails]

        # Prepend a virtual expiration warning if account expires soon
        now = datetime.utcnow()
        days_left = (account.expires_at - now).days
        if 0 < days_left <= _EXPIRY_WARNING_DAYS:
            email_headers.insert(0, _build_expiry_warning_header(account))

        return EmailListResponse(emails=email_headers)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing emails: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list emails",
        )


@router.get(
    "/emails/{email_id}",
    response_model=EmailContent,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {"model": ErrorResponse, "description": "Account not paid or expired"},
        404: {"model": ErrorResponse, "description": "Email not found"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def get_email(
    email_id: str, account: EmailAccount = Depends(get_current_active_account)
) -> EmailContent:
    """Get detailed content of a specific email.

    Args:
        email_id: ID of the email to retrieve
        account: Authenticated EmailAccount from token validation

    Returns:
        Detailed email content
    """
    try:
        # Handle virtual expiration warning email
        if email_id.startswith(_EXPIRY_WARNING_ID_PREFIX):
            return _build_expiry_warning_content(account)

        # Use the stored email password from the account
        if not account.email_password:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Email password not found for account",
            )

        email: EmailContent = EmailContent.validate(
            email_service.get_email_content(
                account.email_address, account.email_password, email_id
            )
        )

        if not email:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Email not found"
            )

        return email

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting email content: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get email content",
        )


@router.delete(
    "/emails/{email_id}",
    response_model=EmailDeleteResponse,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {"model": ErrorResponse, "description": "Account not paid or expired"},
        404: {"model": ErrorResponse, "description": "Email not found"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def delete_email(
    email_id: str, account: EmailAccount = Depends(get_current_active_account)
) -> EmailDeleteResponse:
    """Delete a specific email.

    Args:
        email_id: ID of the email to delete
        account: Authenticated EmailAccount from token validation

    Returns:
        EmailDeleteResponse: Result of the deletion operation
    """
    try:
        # Virtual warning emails cannot be deleted — just acknowledge
        if email_id.startswith(_EXPIRY_WARNING_ID_PREFIX):
            return EmailDeleteResponse(
                success=True,
                deleted_count=1,
                failed_ids=[],
                message="Email dismissed",
            )

        if not account.email_password:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Email password not found for account",
            )

        success = email_service.delete_email(
            account.email_address, account.email_password, email_id
        )

        if success:
            return EmailDeleteResponse(
                success=True,
                deleted_count=1,
                failed_ids=[],
                message="Email deleted successfully",
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Email not found or could not be deleted",
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting email {email_id}: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete email",
        )


@router.delete(
    "/emails",
    response_model=EmailDeleteResponse,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {"model": ErrorResponse, "description": "Account not paid or expired"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def delete_emails_bulk(
    delete_request: EmailDeleteRequest,
    account: EmailAccount = Depends(get_current_active_account),
) -> EmailDeleteResponse:
    """Delete multiple emails in bulk.

    Args:
        delete_request: List of email IDs to delete
        account: Authenticated EmailAccount from token validation

    Returns:
        EmailDeleteResponse: Result of the bulk deletion operation
    """
    try:
        # Filter out virtual warning email IDs before passing to IMAP
        real_ids = [
            eid
            for eid in delete_request.email_ids
            if not eid.startswith(_EXPIRY_WARNING_ID_PREFIX)
        ]
        virtual_count = len(delete_request.email_ids) - len(real_ids)

        if not account.email_password:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Email password not found for account",
            )

        if real_ids:
            success, failed_ids = email_service.delete_emails_bulk(
                account.email_address, account.email_password, real_ids
            )
        else:
            success = True
            failed_ids = []

        deleted_count = len(real_ids) - len(failed_ids) + virtual_count

        if deleted_count == 0:
            message = "No emails were deleted"
        elif failed_ids:
            message = (
                f"Deleted {deleted_count} out of {len(delete_request.email_ids)} emails"
            )
        else:
            message = f"Successfully deleted {deleted_count} emails"

        return EmailDeleteResponse(
            success=success,
            deleted_count=deleted_count,
            failed_ids=failed_ids,
            message=message,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error during bulk email deletion: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete emails",
        )


@router.post(
    "/account/renew",
    response_model=RenewalInvoiceResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        401: {"model": ErrorResponse, "description": "Unauthorized"},
        403: {
            "model": ErrorResponse,
            "description": "Account not eligible for renewal",
        },
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def renew_account(
    renewal_request: RenewalRequest | None = None,
    account: EmailAccount = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> RenewalInvoiceResponse:
    """Initiate account renewal by creating a Lightning invoice.

    Generates a Lightning invoice for the renewal payment. The account
    expiration will be extended after payment is confirmed. If the account
    is currently expired (within the grace period), the new expiration is
    calculated from the old expiration date, not from today.

    Args:
        renewal_request: Optional request with number of years (default 1).
        account: Authenticated EmailAccount from token validation.
        db: Database session dependency.

    Returns:
        RenewalInvoiceResponse: Lightning invoice details for renewal payment.
    """
    try:
        years = 1
        if renewal_request:
            years = renewal_request.years

        now = datetime.utcnow()
        grace_period_end = account.expires_at + timedelta(days=365)
        if now > grace_period_end:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account is no longer eligible for renewal",
            )

        total_price = settings.RENEWAL_PRICE * years

        # Calculate new expiration: extend from current expiration (not from now)
        # This rewards users who renew early and preserves time for expired accounts
        base_date = max(account.expires_at, now)
        new_expires_at = base_date + timedelta(days=365 * years)

        memo_parts = [f"LNemail renewal ({years} year{'s' if years > 1 else ''})"]
        if years > 1:
            memo_parts.append("Only 1 year guaranteed; extra years are donations")
        memo = " - ".join(memo_parts)

        invoice = lnd_service.create_invoice(total_price, memo)

        # Store the renewal payment hash on the account
        account.renewal_payment_hash = invoice["payment_hash"]
        db.add(account)
        db.commit()

        # Enqueue background task to check renewal payment
        queue.enqueue(
            check_renewal_payment_status,
            invoice["payment_hash"],
            years,
            job_timeout=600,
        )

        return RenewalInvoiceResponse(
            payment_request=invoice["payment_request"],
            payment_hash=invoice["payment_hash"],
            price_sats=total_price,
            years=years,
            new_expires_at=new_expires_at,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error initiating account renewal: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to initiate account renewal",
        )


@router.get(
    "/account/renew/status/{payment_hash}",
    response_model=RenewalStatusResponse,
    responses={
        404: {"model": ErrorResponse, "description": "Payment not found"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def check_renewal_status(
    payment_hash: str, db: Session = Depends(get_db)
) -> RenewalStatusResponse:
    """Check payment status for a renewal invoice.

    Args:
        payment_hash: The Lightning payment hash to check.
        db: Database session dependency.

    Returns:
        RenewalStatusResponse: Current renewal payment status.
    """
    try:
        statement = select(EmailAccount).where(
            EmailAccount.renewal_payment_hash == payment_hash
        )
        account = db.exec(statement).first()

        if not account:
            # Account not found by renewal_payment_hash. This can happen when
            # the background task already processed the payment and cleared the
            # hash. Check with LND to distinguish from a truly invalid hash.
            paid = lnd_service.check_invoice(payment_hash)
            if paid:
                # Payment was settled and the hash was already cleared by the
                # background task — renewal was processed successfully.
                return RenewalStatusResponse(
                    payment_status="paid",
                    new_expires_at=None,
                )

            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Renewal payment not found",
            )

        # If still pending, check with LND
        paid = lnd_service.check_invoice(payment_hash)
        if paid and account.renewal_payment_hash == payment_hash:
            # Payment detected but not yet processed — re-enqueue the task
            # The task itself is idempotent and will handle the actual extension
            queue.enqueue(
                check_renewal_payment_status,
                payment_hash,
                1,  # Default to 1 year; the task reads actual years from context
                job_timeout=600,
            )

        # Determine status: if the renewal_payment_hash has been cleared,
        # the renewal was processed successfully
        if account.renewal_payment_hash != payment_hash:
            # Hash was cleared after successful processing
            return RenewalStatusResponse(
                payment_status="paid",
                new_expires_at=account.expires_at,
            )

        if paid:
            return RenewalStatusResponse(
                payment_status="processing",
            )

        return RenewalStatusResponse(
            payment_status="pending",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking renewal status: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to check renewal status",
        )


@health_router.get("/health", response_model=HealthResponse, tags=["health"])
async def health_check() -> HealthResponse:
    """Health check endpoint.

    Returns:
        Health status information
    """
    return HealthResponse(status="ok", version=settings.APP_VERSION)
