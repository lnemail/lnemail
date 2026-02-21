"""
API request and response schema models.
These Pydantic models define the structure of data accepted and returned by the API,
providing validation, serialization, and documentation.
"""

from datetime import datetime, timezone
from typing import List, Optional
from pydantic import BaseModel, Field


class InvoiceResponse(BaseModel):
    """Response schema for newly created Lightning invoice."""

    email_address: str
    access_token: str
    payment_request: str
    payment_hash: str
    expires_at: datetime
    price_sats: int


class PaymentStatusResponse(BaseModel):
    """Response schema for payment status check."""

    payment_status: str
    email_address: str | None = None
    access_token: str | None = None


class EmailCreateRequest(BaseModel):
    include_email: bool = False
    include_token: bool = False


class EmailHeader(BaseModel):
    """Schema for email list items with metadata only."""

    id: str
    subject: str
    sender: str
    date: str
    read: bool


class EmailListResponse(BaseModel):
    """Response schema for email listing endpoint."""

    emails: List[EmailHeader]


class EmailAttachment(BaseModel):
    """Schema for an email attachment."""

    filename: str
    content_type: str
    size: int
    content: str
    encoding: str  # "text" or "base64"


class EmailContent(BaseModel):
    """Response schema for detailed email content."""

    id: str
    subject: str
    sender: str
    date: str
    body: str
    body_plain: str | None = None
    body_html: str | None = None
    content_type: str
    attachments: list[EmailAttachment]
    read: bool
    message_id: str | None = None
    references: str | None = None


class SendAttachment(BaseModel):
    """Schema for an attachment to be sent with an outgoing email."""

    filename: str
    content_type: str
    content: str  # base64-encoded file content


# 8 MB total attachment size limit (leaves room for base64 overhead + headers
# within the 10 MB SMTP server limit)
MAX_TOTAL_ATTACHMENT_SIZE_BYTES: int = 8 * 1024 * 1024


class EmailSendRequest(BaseModel):
    """Request schema for sending an email."""

    recipient: str
    subject: str
    body: str
    in_reply_to: str | None = None
    references: str | None = None
    attachments: list[SendAttachment] = Field(default_factory=list)


class EmailSendInvoiceResponse(BaseModel):
    """Response schema for initiating an email send, returning an invoice."""

    payment_request: str
    payment_hash: str
    price_sats: int
    sender_email: str
    recipient: str
    subject: str


class EmailSendStatusResponse(BaseModel):
    """Response schema for checking payment and delivery status."""

    payment_status: str
    delivery_status: str
    delivery_error: Optional[str] = None
    sender_email: Optional[str] = None
    recipient: Optional[str] = None
    subject: Optional[str] = None
    sent_at: Optional[datetime] = None
    retry_count: int = 0


class RecentSendItem(BaseModel):
    """Schema for recent send history items."""

    payment_hash: str
    recipient: str
    subject: str
    payment_status: str
    delivery_status: str
    created_at: datetime
    sent_at: Optional[datetime] = None


class RecentSendsResponse(BaseModel):
    """Response schema for recent send history."""

    sends: List[RecentSendItem]


class ErrorResponse(BaseModel):
    """Standard error response schema."""

    detail: str


class HealthResponse(BaseModel):
    """Health check response schema."""

    status: str
    version: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AccountResponse(BaseModel):
    email_address: str
    expires_at: datetime
    is_expired: bool = False
    days_until_expiry: int = 0
    renewal_eligible: bool = False


class RenewalRequest(BaseModel):
    """Request schema for account renewal."""

    years: int = Field(default=1, ge=1, le=10)


class RenewalInvoiceResponse(BaseModel):
    """Response schema for a renewal Lightning invoice."""

    payment_request: str
    payment_hash: str
    price_sats: int
    years: int
    new_expires_at: datetime


class RenewalStatusResponse(BaseModel):
    """Response schema for checking renewal payment status."""

    payment_status: str
    new_expires_at: Optional[datetime] = None


class EmailDeleteRequest(BaseModel):
    """Request schema for deleting emails."""

    email_ids: List[str]


class EmailDeleteResponse(BaseModel):
    """Response schema for email deletion operations."""

    success: bool
    deleted_count: int
    failed_ids: List[str] = Field(default_factory=list)
    message: str
