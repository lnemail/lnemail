"""
Integration tests for the send-email-with-attachments flow.

Tests the full HTTP request path through the API endpoint using FastAPI's
TestClient, verifying request validation, database persistence, and
response format. External services (LND, Redis) are mocked.
"""

import base64
import json

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from lnemail.core.models import PendingOutgoingEmail
from lnemail.core.schemas import MAX_TOTAL_ATTACHMENT_SIZE_BYTES


SEND_URL = "/api/v1/email/send"


class TestSendEmailEndpointNoAttachments:
    """Baseline: sending without attachments still works."""

    def test_send_without_attachments(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        payload = {
            "recipient": "alice@example.com",
            "subject": "Hello",
            "body": "Test body",
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202
        data = resp.json()
        assert data["payment_hash"] == "fakehash_abc123"
        assert data["recipient"] == "alice@example.com"
        assert data["subject"] == "Hello"

    def test_send_requires_auth(self, client: TestClient) -> None:
        payload = {
            "recipient": "alice@example.com",
            "subject": "Hello",
            "body": "body",
        }
        resp = client.post(SEND_URL, json=payload)
        assert resp.status_code == 401


class TestSendEmailWithAttachments:
    """Test the full send flow including attachment handling."""

    def test_single_text_attachment(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        sample_attachment: dict[str, str],
    ) -> None:
        payload = {
            "recipient": "bob@example.com",
            "subject": "With attachment",
            "body": "See attached.",
            "attachments": [sample_attachment],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202
        data = resp.json()
        assert data["payment_hash"] == "fakehash_abc123"
        assert data["sender_email"] == "testuser@lnemail.net"

    def test_png_attachment(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        sample_png_attachment: dict[str, str],
    ) -> None:
        payload = {
            "recipient": "carol@example.com",
            "subject": "Image attached",
            "body": "Here is a PNG.",
            "attachments": [sample_png_attachment],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202

    def test_multiple_attachments(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        sample_attachment: dict[str, str],
        sample_png_attachment: dict[str, str],
    ) -> None:
        payload = {
            "recipient": "dave@example.com",
            "subject": "Multiple files",
            "body": "Two files attached.",
            "attachments": [sample_attachment, sample_png_attachment],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202

    def test_attachments_stored_in_db(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        db: Session,
        sample_attachment: dict[str, str],
    ) -> None:
        """Verify attachments are persisted as JSON in the database."""
        payload = {
            "recipient": "eve@example.com",
            "subject": "DB check",
            "body": "Check storage.",
            "attachments": [sample_attachment],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202

        stmt = select(PendingOutgoingEmail).where(
            PendingOutgoingEmail.payment_hash == "fakehash_abc123"
        )
        pending = db.exec(stmt).first()
        assert pending is not None
        assert pending.attachments_json is not None

        stored = json.loads(pending.attachments_json)
        assert len(stored) == 1
        assert stored[0]["filename"] == "test.txt"
        assert stored[0]["content_type"] == "text/plain"
        # Verify content roundtrips
        decoded = base64.b64decode(stored[0]["content"])
        assert decoded == b"Hello, this is a test file."

    def test_no_attachments_json_is_none(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        db: Session,
    ) -> None:
        """When no attachments are sent, attachments_json should be None."""
        payload = {
            "recipient": "frank@example.com",
            "subject": "No files",
            "body": "Plain email.",
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202

        stmt = select(PendingOutgoingEmail).where(
            PendingOutgoingEmail.payment_hash == "fakehash_abc123"
        )
        pending = db.exec(stmt).first()
        assert pending is not None
        assert pending.attachments_json is None


class TestAttachmentValidation:
    """Test server-side validation of attachment data."""

    def test_invalid_base64_rejected(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        payload = {
            "recipient": "x@example.com",
            "subject": "bad",
            "body": "bad",
            "attachments": [
                {
                    "filename": "bad.txt",
                    "content_type": "text/plain",
                    "content": "!!!not-valid-base64!!!",
                }
            ],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 400
        assert "Invalid base64" in resp.json()["detail"]

    def test_oversized_attachment_rejected(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        """An attachment exceeding 8 MB decoded size should be rejected."""
        # Create content just over the limit
        big_data = b"\x00" * (MAX_TOTAL_ATTACHMENT_SIZE_BYTES + 1)
        content = base64.b64encode(big_data).decode()
        payload = {
            "recipient": "x@example.com",
            "subject": "big",
            "body": "big",
            "attachments": [
                {
                    "filename": "huge.bin",
                    "content_type": "application/octet-stream",
                    "content": content,
                }
            ],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 400
        assert "exceeds" in resp.json()["detail"]

    def test_combined_size_over_limit_rejected(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        """Multiple attachments whose combined size exceeds limit are rejected."""
        half_plus = MAX_TOTAL_ATTACHMENT_SIZE_BYTES // 2 + 1024
        chunk = base64.b64encode(b"\x00" * half_plus).decode()
        payload = {
            "recipient": "x@example.com",
            "subject": "two big",
            "body": "two big",
            "attachments": [
                {
                    "filename": "a.bin",
                    "content_type": "application/octet-stream",
                    "content": chunk,
                },
                {
                    "filename": "b.bin",
                    "content_type": "application/octet-stream",
                    "content": chunk,
                },
            ],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 400
        assert "exceeds" in resp.json()["detail"]

    def test_exactly_at_limit_accepted(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        """Attachment exactly at the 8 MB limit should be accepted."""
        exact_data = b"\x00" * MAX_TOTAL_ATTACHMENT_SIZE_BYTES
        content = base64.b64encode(exact_data).decode()
        payload = {
            "recipient": "x@example.com",
            "subject": "exact",
            "body": "exact",
            "attachments": [
                {
                    "filename": "exact.bin",
                    "content_type": "application/octet-stream",
                    "content": content,
                }
            ],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202

    def test_missing_attachment_fields_rejected(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        """Attachments missing required fields should fail validation."""
        payload = {
            "recipient": "x@example.com",
            "subject": "bad",
            "body": "bad",
            "attachments": [{"filename": "only_name.txt"}],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 422  # Pydantic validation error

    def test_empty_attachments_list_accepted(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        """An explicit empty attachments list is fine."""
        payload = {
            "recipient": "x@example.com",
            "subject": "empty list",
            "body": "empty",
            "attachments": [],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202


class TestSendEmailResponseFormat:
    """Verify the response structure matches EmailSendInvoiceResponse."""

    def test_response_contains_all_fields(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        sample_attachment: dict[str, str],
    ) -> None:
        payload = {
            "recipient": "verify@example.com",
            "subject": "Format check",
            "body": "Check fields.",
            "attachments": [sample_attachment],
        }
        resp = client.post(SEND_URL, json=payload, headers=auth_headers)
        assert resp.status_code == 202
        data = resp.json()

        expected_keys = {
            "payment_request",
            "payment_hash",
            "price_sats",
            "sender_email",
            "recipient",
            "subject",
        }
        assert set(data.keys()) == expected_keys
        assert data["price_sats"] == 100
        assert data["payment_request"] == "lnbc1000n1fake_invoice_request"
        assert data["sender_email"] == "testuser@lnemail.net"
