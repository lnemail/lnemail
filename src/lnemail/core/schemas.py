"""
API request and response schema models.
These Pydantic models define the structure of data accepted and returned by the API,
providing validation, serialization, and documentation.
"""

from datetime import datetime
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


class EmailContent(BaseModel):
    """Response schema for detailed email content."""

    id: str
    subject: str
    sender: str
    date: str
    body: str
    content_type: str
    attachments: list[dict[str, str]]
    read: bool


class EmailSendRequest(BaseModel):
    """Request schema for sending an email."""

    recipient: str
    subject: str
    body: str


class EmailSendInvoiceResponse(BaseModel):
    """Response schema for initiating an email send, returning an invoice."""

    payment_request: str
    payment_hash: str
    price_sats: int
    sender_email: str
    recipient: str
    subject: str


class EmailSendStatusResponse(BaseModel):
    """Response schema for checking the status of an email send payment."""

    payment_status: str
    sender_email: Optional[str] = None
    recipient: Optional[str] = None
    subject: Optional[str] = None


class ErrorResponse(BaseModel):
    """Standard error response schema."""

    detail: str


class HealthResponse(BaseModel):
    """Health check response schema."""

    status: str
    version: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class AccountResponse(BaseModel):
    email_address: str
    expires_at: datetime


class EmailDeleteRequest(BaseModel):
    """Request schema for deleting emails."""

    email_ids: List[str]


class EmailDeleteResponse(BaseModel):
    """Response schema for email deletion operations."""

    success: bool
    deleted_count: int
    failed_ids: List[str] = Field(default_factory=list)
    message: str
