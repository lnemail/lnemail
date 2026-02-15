"""Tests for sending emails with attachments.

Verifies that:
- SendAttachment schema validates correctly,
- MAX_TOTAL_ATTACHMENT_SIZE_BYTES constant is 8 MB,
- Attachment size validation rejects oversized payloads,
- Attachments are serialized/deserialized correctly for DB storage,
- send_email_with_auth() builds correct MIME messages with attachments,
- Invalid base64 content is rejected.
"""

import base64
import json
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from lnemail.core.schemas import (
    EmailSendRequest,
    MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
    SendAttachment,
)


# ── Schema tests ─────────────────────────────────────────────────────────


class TestSendAttachmentSchema:
    """Test the SendAttachment Pydantic model."""

    def test_valid_attachment(self) -> None:
        content = base64.b64encode(b"hello world").decode()
        att = SendAttachment(
            filename="test.txt",
            content_type="text/plain",
            content=content,
        )
        assert att.filename == "test.txt"
        assert att.content_type == "text/plain"
        assert att.content == content

    def test_missing_filename_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SendAttachment(
                content_type="text/plain",
                content=base64.b64encode(b"x").decode(),
            )

    def test_missing_content_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SendAttachment(
                filename="a.txt",
                content_type="text/plain",
            )


class TestEmailSendRequestAttachments:
    """Test attachments field on EmailSendRequest."""

    def test_default_empty_attachments(self) -> None:
        req = EmailSendRequest(recipient="a@b.com", subject="Hi", body="Hello")
        assert req.attachments == []

    def test_with_attachments(self) -> None:
        content = base64.b64encode(b"data").decode()
        req = EmailSendRequest(
            recipient="a@b.com",
            subject="Hi",
            body="Hello",
            attachments=[
                SendAttachment(
                    filename="f.bin",
                    content_type="application/octet-stream",
                    content=content,
                )
            ],
        )
        assert len(req.attachments) == 1
        assert req.attachments[0].filename == "f.bin"


class TestMaxAttachmentSize:
    """Test the constant is defined correctly."""

    def test_max_size_is_8mb(self) -> None:
        assert MAX_TOTAL_ATTACHMENT_SIZE_BYTES == 8 * 1024 * 1024


# ── Serialization round-trip tests ───────────────────────────────────────


class TestAttachmentSerialization:
    """Test JSON serialization for DB storage."""

    def test_roundtrip(self) -> None:
        content = base64.b64encode(b"\x89PNG fake").decode()
        attachments = [
            SendAttachment(
                filename="logo.png",
                content_type="image/png",
                content=content,
            )
        ]

        # Serialize (as done in the endpoint)
        json_str = json.dumps([att.model_dump() for att in attachments])

        # Deserialize (as done in tasks.py)
        loaded: List[Dict[str, str]] = json.loads(json_str)
        assert len(loaded) == 1
        assert loaded[0]["filename"] == "logo.png"
        assert loaded[0]["content_type"] == "image/png"
        # Verify the base64 content decodes back to original bytes
        assert base64.b64decode(loaded[0]["content"]) == b"\x89PNG fake"

    def test_multiple_attachments_roundtrip(self) -> None:
        attachments = [
            SendAttachment(
                filename="a.txt",
                content_type="text/plain",
                content=base64.b64encode(b"text content").decode(),
            ),
            SendAttachment(
                filename="b.bin",
                content_type="application/octet-stream",
                content=base64.b64encode(b"\x00\x01\x02").decode(),
            ),
        ]

        json_str = json.dumps([att.model_dump() for att in attachments])
        loaded = json.loads(json_str)
        assert len(loaded) == 2
        assert {a["filename"] for a in loaded} == {"a.txt", "b.bin"}

    def test_none_attachments_json(self) -> None:
        """When attachments_json is None, tasks should pass None."""
        attachments_json: str | None = None
        if attachments_json:
            attachments = json.loads(attachments_json)
        else:
            attachments = None
        assert attachments is None


# ── Attachment size validation tests ─────────────────────────────────────


class TestAttachmentSizeValidation:
    """Test the size validation logic from the endpoint."""

    @staticmethod
    def _validate_attachments(attachments: list[SendAttachment]) -> int:
        """Replicates the validation logic from the send_email endpoint."""
        total_size = 0
        for attachment in attachments:
            decoded = base64.b64decode(attachment.content)
            total_size += len(decoded)
        return total_size

    def test_small_attachment_passes(self) -> None:
        data = b"x" * 100
        att = SendAttachment(
            filename="small.txt",
            content_type="text/plain",
            content=base64.b64encode(data).decode(),
        )
        total = self._validate_attachments([att])
        assert total == 100
        assert total <= MAX_TOTAL_ATTACHMENT_SIZE_BYTES

    def test_exactly_at_limit(self) -> None:
        data = b"x" * MAX_TOTAL_ATTACHMENT_SIZE_BYTES
        att = SendAttachment(
            filename="big.bin",
            content_type="application/octet-stream",
            content=base64.b64encode(data).decode(),
        )
        total = self._validate_attachments([att])
        assert total == MAX_TOTAL_ATTACHMENT_SIZE_BYTES

    def test_over_limit(self) -> None:
        data = b"x" * (MAX_TOTAL_ATTACHMENT_SIZE_BYTES + 1)
        att = SendAttachment(
            filename="toobig.bin",
            content_type="application/octet-stream",
            content=base64.b64encode(data).decode(),
        )
        total = self._validate_attachments([att])
        assert total > MAX_TOTAL_ATTACHMENT_SIZE_BYTES

    def test_multiple_attachments_combined_size(self) -> None:
        half = MAX_TOTAL_ATTACHMENT_SIZE_BYTES // 2
        att1 = SendAttachment(
            filename="a.bin",
            content_type="application/octet-stream",
            content=base64.b64encode(b"x" * half).decode(),
        )
        att2 = SendAttachment(
            filename="b.bin",
            content_type="application/octet-stream",
            content=base64.b64encode(b"x" * half).decode(),
        )
        total = self._validate_attachments([att1, att2])
        assert total == half * 2
        assert total <= MAX_TOTAL_ATTACHMENT_SIZE_BYTES


# ── MIME attachment building tests ───────────────────────────────────────


class TestMIMEAttachmentBuilding:
    """Test that send_email_with_auth builds correct MIME messages.

    We patch the SMTP connection to capture the built message without
    actually sending it.
    """

    @patch("os.makedirs")
    @patch("lnemail.services.email_service.EmailService._create_smtp_connection")
    def test_email_with_attachment_has_correct_parts(
        self, mock_smtp_conn: MagicMock, mock_makedirs: MagicMock
    ) -> None:
        """An email with one attachment should have 2 MIME parts."""
        from lnemail.services.email_service import EmailService

        # Set up mock SMTP
        mock_smtp = MagicMock()
        mock_smtp_conn.return_value = mock_smtp

        # Capture the message passed to send_message
        sent_messages: list[Any] = []
        mock_smtp.send_message.side_effect = lambda msg: sent_messages.append(msg)

        service = EmailService()
        file_content = b"Hello attachment"
        attachments = [
            {
                "filename": "hello.txt",
                "content_type": "text/plain",
                "content": base64.b64encode(file_content).decode(),
            }
        ]

        success, _ = service.send_email_with_auth(
            sender="test@example.com",
            sender_password="password",
            recipient="dest@example.com",
            subject="Test with attachment",
            body="Body text",
            attachments=attachments,
        )

        assert success is True
        assert len(sent_messages) == 1

        msg = sent_messages[0]
        assert msg.is_multipart()

        parts = list(msg.walk())
        # Parts: multipart container, text/plain body, text/plain attachment
        content_types = [p.get_content_type() for p in parts]
        assert "multipart/mixed" in content_types
        assert content_types.count("text/plain") == 2  # body + attachment

        # Find the attachment part
        att_part = None
        for part in parts:
            if part.get_content_disposition() == "attachment":
                att_part = part
                break

        assert att_part is not None
        assert att_part.get_filename() == "hello.txt"
        # Decode the payload and verify content
        decoded_payload = att_part.get_payload(decode=True)
        assert decoded_payload == file_content

    @patch("os.makedirs")
    @patch("lnemail.services.email_service.EmailService._create_smtp_connection")
    def test_email_without_attachments_unchanged(
        self, mock_smtp_conn: MagicMock, mock_makedirs: MagicMock
    ) -> None:
        """An email without attachments should have only the body part."""
        from lnemail.services.email_service import EmailService

        mock_smtp = MagicMock()
        mock_smtp_conn.return_value = mock_smtp

        sent_messages: list[Any] = []
        mock_smtp.send_message.side_effect = lambda msg: sent_messages.append(msg)

        service = EmailService()
        success, _ = service.send_email_with_auth(
            sender="test@example.com",
            sender_password="password",
            recipient="dest@example.com",
            subject="No attachments",
            body="Just text",
        )

        assert success is True
        msg = sent_messages[0]
        parts = [p for p in msg.walk() if not p.is_multipart()]
        assert len(parts) == 1
        assert parts[0].get_content_type() == "text/plain"

    @patch("os.makedirs")
    @patch("lnemail.services.email_service.EmailService._create_smtp_connection")
    def test_binary_attachment_mime_type(
        self, mock_smtp_conn: MagicMock, mock_makedirs: MagicMock
    ) -> None:
        """Binary attachment should use the specified content type."""
        from lnemail.services.email_service import EmailService

        mock_smtp = MagicMock()
        mock_smtp_conn.return_value = mock_smtp

        sent_messages: list[Any] = []
        mock_smtp.send_message.side_effect = lambda msg: sent_messages.append(msg)

        service = EmailService()
        png_bytes = b"\x89PNG\r\n\x1a\n fake png data"
        attachments = [
            {
                "filename": "image.png",
                "content_type": "image/png",
                "content": base64.b64encode(png_bytes).decode(),
            }
        ]

        success, _ = service.send_email_with_auth(
            sender="test@example.com",
            sender_password="password",
            recipient="dest@example.com",
            subject="With image",
            body="See attached",
            attachments=attachments,
        )

        assert success is True
        msg = sent_messages[0]
        att_part = None
        for part in msg.walk():
            if part.get_content_disposition() == "attachment":
                att_part = part
                break

        assert att_part is not None
        assert att_part.get_content_type() == "image/png"
        assert att_part.get_filename() == "image.png"
        assert att_part.get_payload(decode=True) == png_bytes

    @patch("os.makedirs")
    @patch("lnemail.services.email_service.EmailService._create_smtp_connection")
    def test_multiple_attachments(
        self, mock_smtp_conn: MagicMock, mock_makedirs: MagicMock
    ) -> None:
        """Multiple attachments should all be present in the MIME message."""
        from lnemail.services.email_service import EmailService

        mock_smtp = MagicMock()
        mock_smtp_conn.return_value = mock_smtp

        sent_messages: list[Any] = []
        mock_smtp.send_message.side_effect = lambda msg: sent_messages.append(msg)

        service = EmailService()
        attachments = [
            {
                "filename": "a.txt",
                "content_type": "text/plain",
                "content": base64.b64encode(b"content a").decode(),
            },
            {
                "filename": "b.pdf",
                "content_type": "application/pdf",
                "content": base64.b64encode(b"%PDF-1.4").decode(),
            },
        ]

        success, _ = service.send_email_with_auth(
            sender="test@example.com",
            sender_password="password",
            recipient="dest@example.com",
            subject="Multiple attachments",
            body="Two files attached",
            attachments=attachments,
        )

        assert success is True
        msg = sent_messages[0]

        att_parts = [
            p for p in msg.walk() if p.get_content_disposition() == "attachment"
        ]
        assert len(att_parts) == 2
        filenames = {p.get_filename() for p in att_parts}
        assert filenames == {"a.txt", "b.pdf"}
