"""Tests for email body extraction and attachment extraction logic.

Verifies that:
- multipart emails extract both body_plain and body_html,
- backward-compatible body/content_type prefer HTML when available,
- attachments are extracted with correct encoding (text vs base64),
- inline body parts are not treated as attachments.
"""

import base64
import email
from email.mime.application import MIMEApplication
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, cast


def _extract_body(msg: email.message.Message) -> dict[str, Any]:
    """Extract body fields from an email.message.Message.

    This mirrors the extraction logic in EmailService.get_email_content()
    so we can unit-test it without an IMAP connection.  Returns the same
    dict shape: body, body_plain, body_html, content_type.
    """
    body_plain = ""
    body_html = ""

    if msg.is_multipart():
        for part in msg.walk():
            # Skip attachment parts (same logic as email_service.py)
            if part.get_content_disposition() in ("attachment", "inline"):
                if (
                    part.get_content_disposition() == "inline"
                    and part.get_content_type()
                    in (
                        "text/plain",
                        "text/html",
                    )
                ):
                    pass  # inline body parts are fine
                else:
                    continue

            part_content_type = part.get_content_type()
            if part_content_type in {"text/plain", "text/html"}:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                payload_bytes = cast(bytes, payload)
                charset = part.get_content_charset() or "utf-8"
                decoded = payload_bytes.decode(charset, errors="replace")

                if part_content_type == "text/plain" and not body_plain:
                    body_plain = decoded
                elif part_content_type == "text/html" and not body_html:
                    body_html = decoded

            if body_plain and body_html:
                break
    else:
        payload = msg.get_payload(decode=True)
        if payload is not None:
            payload_bytes = cast(bytes, payload)
            charset = msg.get_content_charset() or "utf-8"
            decoded = payload_bytes.decode(charset, errors="replace")
            if msg.get_content_type() == "text/html":
                body_html = decoded
            else:
                body_plain = decoded

    # Backward-compatible primary body (prefers HTML)
    if body_html:
        body = body_html
        content_type = "text/html"
    else:
        body = body_plain
        content_type = "text/plain"

    return {
        "body": body,
        "body_plain": body_plain or None,
        "body_html": body_html or None,
        "content_type": content_type,
    }


def _extract_attachments(msg: email.message.Message) -> list[dict[str, Any]]:
    """Extract attachments from an email.message.Message.

    Mirrors EmailService._extract_attachments() for unit testing.
    """
    attachments: list[dict[str, Any]] = []

    for part in msg.walk():
        disposition = part.get_content_disposition()
        if disposition not in ("attachment", "inline"):
            continue
        if disposition == "inline" and part.get_content_type() in (
            "text/plain",
            "text/html",
        ):
            continue

        filename = part.get_filename()
        if not filename:
            ext = part.get_content_type().split("/")[-1]
            filename = f"attachment.{ext}"

        content_type = part.get_content_type()
        payload = part.get_payload(decode=True)
        if payload is None:
            continue

        raw_bytes = cast(bytes, payload)
        size = len(raw_bytes)

        is_text = content_type.startswith("text/") or filename.lower().endswith(
            (".txt", ".asc", ".gpg", ".pgp", ".csv", ".json", ".xml", ".log")
        )

        if is_text:
            charset = part.get_content_charset() or "utf-8"
            try:
                content = raw_bytes.decode(charset, errors="replace")
            except (UnicodeDecodeError, LookupError):
                content = raw_bytes.decode("latin-1", errors="replace")
            encoding = "text"
        else:
            content = base64.b64encode(raw_bytes).decode("ascii")
            encoding = "base64"

        attachments.append(
            {
                "filename": filename,
                "content_type": content_type,
                "size": size,
                "content": content,
                "encoding": encoding,
            }
        )

    return attachments


# ── Dual-body extraction tests ───────────────────────────────────────────


class TestDualBodyExtraction:
    """Test that both body_plain and body_html are captured."""

    def test_multipart_alternative_both_bodies(self) -> None:
        """multipart/alternative should capture both plain and HTML."""
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText("Hello plain", "plain"))
        msg.attach(MIMEText("<p>Hello <b>HTML</b></p>", "html"))

        result = _extract_body(msg)
        assert result["body_plain"] == "Hello plain"
        assert result["body_html"] is not None
        assert "<b>HTML</b>" in result["body_html"]

    def test_backward_compat_prefers_html(self) -> None:
        """Primary body/content_type should prefer HTML when both exist."""
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText("Hello plain", "plain"))
        msg.attach(MIMEText("<p>Hello HTML</p>", "html"))

        result = _extract_body(msg)
        assert result["content_type"] == "text/html"
        assert "Hello HTML" in result["body"]

    def test_html_first_order(self) -> None:
        """Unusual ordering: HTML before plain. Both still captured."""
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText("<p>HTML first</p>", "html"))
        msg.attach(MIMEText("Plain second", "plain"))

        result = _extract_body(msg)
        assert result["body_html"] is not None
        assert "HTML first" in result["body_html"]
        assert result["body_plain"] == "Plain second"
        assert result["content_type"] == "text/html"

    def test_multipart_mixed_with_alternative(self) -> None:
        """multipart/mixed containing multipart/alternative sub-part."""
        alt = MIMEMultipart("alternative")
        alt.attach(MIMEText("Plain text body", "plain"))
        alt.attach(MIMEText("<div>Rich body</div>", "html"))

        msg = MIMEMultipart("mixed")
        msg.attach(alt)
        attachment = MIMEText("attachment content", "plain")
        attachment.add_header("Content-Disposition", "attachment", filename="note.txt")
        msg.attach(attachment)

        result = _extract_body(msg)
        assert result["body_plain"] == "Plain text body"
        assert result["body_html"] is not None
        assert "Rich body" in result["body_html"]
        assert result["content_type"] == "text/html"


class TestSinglePartBody:
    """Test single-part email body extraction."""

    def test_plain_text_only(self) -> None:
        msg = MIMEText("Just plain text", "plain")
        result = _extract_body(msg)
        assert result["content_type"] == "text/plain"
        assert result["body"] == "Just plain text"
        assert result["body_plain"] == "Just plain text"
        assert result["body_html"] is None

    def test_html_only(self) -> None:
        msg = MIMEText("<h1>HTML Only</h1>", "html")
        result = _extract_body(msg)
        assert result["content_type"] == "text/html"
        assert "<h1>HTML Only</h1>" in result["body"]
        assert result["body_html"] is not None
        assert result["body_plain"] is None


class TestMultipartSingleType:
    """Test multipart with only one text type."""

    def test_multipart_plain_only(self) -> None:
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("Only plain", "plain"))
        result = _extract_body(msg)
        assert result["content_type"] == "text/plain"
        assert result["body_plain"] == "Only plain"
        assert result["body_html"] is None

    def test_multipart_html_only(self) -> None:
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("<p>Only HTML</p>", "html"))
        result = _extract_body(msg)
        assert result["content_type"] == "text/html"
        assert result["body_html"] is not None
        assert "<p>Only HTML</p>" in result["body_html"]
        assert result["body_plain"] is None


class TestBodyEdgeCases:
    """Edge cases for body extraction."""

    def test_empty_body(self) -> None:
        msg = MIMEMultipart("mixed")
        result = _extract_body(msg)
        assert result["content_type"] == "text/plain"
        assert result["body"] == ""
        assert result["body_plain"] is None
        assert result["body_html"] is None

    def test_charset_handling(self) -> None:
        msg = MIMEText("Umlaute: \xe4\xf6\xfc", "plain", "latin-1")
        result = _extract_body(msg)
        assert result["content_type"] == "text/plain"
        assert "Umlaute:" in result["body"]


# ── Attachment extraction tests ──────────────────────────────────────────


class TestAttachmentExtraction:
    """Test _extract_attachments logic."""

    def test_text_attachment_encoding(self) -> None:
        """Text attachments should use encoding='text'."""
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("body", "plain"))
        att = MIMEText("file content", "plain")
        att.add_header("Content-Disposition", "attachment", filename="note.txt")
        msg.attach(att)

        attachments = _extract_attachments(msg)
        assert len(attachments) == 1
        assert attachments[0]["filename"] == "note.txt"
        assert attachments[0]["encoding"] == "text"
        assert attachments[0]["content"] == "file content"
        assert attachments[0]["content_type"] == "text/plain"
        assert attachments[0]["size"] == len(b"file content")

    def test_binary_attachment_base64(self) -> None:
        """Binary attachments should use encoding='base64'."""
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("body", "plain"))

        pdf_bytes = b"%PDF-1.4 fake pdf content"
        att = MIMEApplication(pdf_bytes, _subtype="pdf")
        att.add_header("Content-Disposition", "attachment", filename="doc.pdf")
        msg.attach(att)

        attachments = _extract_attachments(msg)
        assert len(attachments) == 1
        assert attachments[0]["filename"] == "doc.pdf"
        assert attachments[0]["encoding"] == "base64"
        assert attachments[0]["content_type"] == "application/pdf"
        assert attachments[0]["size"] == len(pdf_bytes)
        # Verify content roundtrips correctly
        decoded = base64.b64decode(attachments[0]["content"])
        assert decoded == pdf_bytes

    def test_inline_body_parts_skipped(self) -> None:
        """Inline text/plain and text/html parts should not appear as attachments."""
        msg = MIMEMultipart("mixed")
        plain = MIMEText("inline body", "plain")
        plain.add_header("Content-Disposition", "inline")
        msg.attach(plain)

        html = MIMEText("<p>inline html</p>", "html")
        html.add_header("Content-Disposition", "inline")
        msg.attach(html)

        attachments = _extract_attachments(msg)
        assert len(attachments) == 0

    def test_inline_image_kept(self) -> None:
        """Inline images should be captured as attachments."""
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("body", "plain"))

        img_bytes = b"\x89PNG\r\n\x1a\n fake image"
        img = MIMEBase("image", "png")
        img.set_payload(img_bytes)
        img.add_header("Content-Disposition", "inline", filename="logo.png")
        msg.attach(img)

        attachments = _extract_attachments(msg)
        assert len(attachments) == 1
        assert attachments[0]["filename"] == "logo.png"
        assert attachments[0]["encoding"] == "base64"

    def test_multiple_attachments(self) -> None:
        """Multiple attachments of different types."""
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("body", "plain"))

        # Text attachment
        txt = MIMEText("log data", "plain")
        txt.add_header("Content-Disposition", "attachment", filename="app.log")
        msg.attach(txt)

        # Binary attachment
        data = b"\x00\x01\x02\x03"
        bin_att = MIMEApplication(data, _subtype="octet-stream")
        bin_att.add_header("Content-Disposition", "attachment", filename="data.bin")
        msg.attach(bin_att)

        attachments = _extract_attachments(msg)
        assert len(attachments) == 2
        filenames = {a["filename"] for a in attachments}
        assert filenames == {"app.log", "data.bin"}

        log_att = next(a for a in attachments if a["filename"] == "app.log")
        assert log_att["encoding"] == "text"

        bin_result = next(a for a in attachments if a["filename"] == "data.bin")
        assert bin_result["encoding"] == "base64"

    def test_fallback_filename(self) -> None:
        """Attachment without a filename gets a generated one."""
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("body", "plain"))

        att = MIMEBase("application", "zip")
        att.set_payload(b"PK\x03\x04 fake zip")
        att.add_header("Content-Disposition", "attachment")
        msg.attach(att)

        attachments = _extract_attachments(msg)
        assert len(attachments) == 1
        assert attachments[0]["filename"] == "attachment.zip"

    def test_no_attachments(self) -> None:
        """Plain message with no attachments returns empty list."""
        msg = MIMEText("simple body", "plain")
        attachments = _extract_attachments(msg)
        assert len(attachments) == 0

    def test_asc_extension_treated_as_text(self) -> None:
        """Files with .asc extension should be treated as text."""
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("body", "plain"))

        # .asc file with generic octet-stream content type
        att = MIMEBase("application", "octet-stream")
        att.set_payload(
            b"-----BEGIN PGP SIGNATURE-----\ndata\n-----END PGP SIGNATURE-----"
        )
        att.add_header("Content-Disposition", "attachment", filename="signature.asc")
        msg.attach(att)

        attachments = _extract_attachments(msg)
        assert len(attachments) == 1
        assert attachments[0]["encoding"] == "text"
        assert "BEGIN PGP SIGNATURE" in attachments[0]["content"]
