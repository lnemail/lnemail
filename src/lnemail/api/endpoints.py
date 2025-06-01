"""
API endpoint handlers for LNemail.

This module contains the FastAPI route definitions and handlers
for all the LNemail API endpoints.
"""

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlmodel import Session, select
from loguru import logger

from ..config import settings
from ..core.models import EmailAccount, PaymentStatus, PendingOutgoingEmail
from ..core.schemas import (
    AccountResponse,
    EmailContent,
    EmailHeader,
    EmailListResponse,
    EmailCreateRequest,
    EmailSendInvoiceResponse,
    EmailSendRequest,
    EmailSendStatusResponse,
    ErrorResponse,
    HealthResponse,
    InvoiceResponse,
    PaymentStatusResponse,
)
from ..db import get_db
from ..services.email_service import EmailService
from ..services.lnd_service import LNDService
from ..services.tasks import check_payment_status, process_send_email_payment, queue

# Create routers
router = APIRouter()
health_router = APIRouter(tags=["health"])

# Setup simple Bearer token scheme for authentication
security = HTTPBearer(auto_error=False)

# Initialize services
lnd_service = LNDService()
email_service = EmailService()


async def get_current_account(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    db: Session = Depends(get_db),
) -> EmailAccount:
    """Validate the bearer token and return the corresponding account.

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

    if account.payment_status != PaymentStatus.PAID:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account payment required or expired",
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
    account: EmailAccount = Depends(get_current_account),
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
        sender_email = account.email_address
        memo = f"Send email from {sender_email} to {send_request.recipient}"

        invoice = lnd_service.create_invoice(settings.EMAIL_SEND_PRICE, memo)

        pending_email = PendingOutgoingEmail(
            sender_email=sender_email,
            recipient=send_request.recipient,
            subject=send_request.subject,
            body=send_request.body,
            payment_hash=invoice["payment_hash"],
            payment_request=invoice["payment_request"],
            price_sats=settings.EMAIL_SEND_PRICE,
            status=PaymentStatus.PENDING,
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
    """Check payment status for an outgoing email send.

    Args:
        payment_hash: The Lightning payment hash for the email send.
        db: Database session dependency.

    Returns:
        EmailSendStatusResponse: The status of the payment for the outgoing email.
    """
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

        # If still pending, check with LND
        if pending_email.status == PaymentStatus.PENDING:
            paid = lnd_service.check_invoice(payment_hash)
            if paid:
                # Payment just received, trigger the email sending process
                # This will be picked up by the RQ worker
                queue.enqueue(process_send_email_payment, payment_hash, job_timeout=600)

        return EmailSendStatusResponse(
            payment_status=pending_email.status,
            sender_email=pending_email.sender_email,
            recipient=pending_email.recipient,
            subject=pending_email.subject,
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
    return AccountResponse(
        email_address=account.email_address,
        expires_at=account.expires_at,
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
    account: EmailAccount = Depends(get_current_account),
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
    email_id: str, account: EmailAccount = Depends(get_current_account)
) -> EmailContent:
    """Get detailed content of a specific email.

    Args:
        email_id: ID of the email to retrieve
        account: Authenticated EmailAccount from token validation

    Returns:
        Detailed email content
    """
    try:
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


@health_router.get("/health", response_model=HealthResponse, tags=["health"])
async def health_check() -> HealthResponse:
    """Health check endpoint.

    Returns:
        Health status information
    """
    return HealthResponse(status="ok", version=settings.APP_VERSION)
