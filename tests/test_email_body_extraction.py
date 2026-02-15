"""Tests for email body extraction logic in EmailService.

Verifies that multipart emails correctly prefer text/html over text/plain,
while still handling plain-text-only and html-only messages correctly.
"""

import email
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, cast


def _extract_body(msg: email.message.Message) -> dict[str, Any]:
    """Extract body and content_type from an email.message.Message.

    This mirrors the extraction logic in EmailService.get_email_content()
    so we can unit-test it without an IMAP connection.
    """
    content_type = "text/plain"
    body = ""

    if msg.is_multipart():
        for part in msg.walk():
            part_content_type = part.get_content_type()
            if part_content_type in {"text/plain", "text/html"}:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                payload_bytes = cast(bytes, payload)
                charset = part.get_content_charset() or "utf-8"
                decoded = payload_bytes.decode(charset, errors="replace")
                if part_content_type == "text/html" or content_type != "text/html":
                    body = decoded
                    content_type = part_content_type
                if content_type == "text/html":
                    break
    else:
        payload = msg.get_payload(decode=True)
        if payload is not None:
            payload_bytes = cast(bytes, payload)
            charset = msg.get_content_charset() or "utf-8"
            body = payload_bytes.decode(charset, errors="replace")
            content_type = msg.get_content_type()

    return {"body": body, "content_type": content_type}


# -- Multipart emails (text/plain + text/html) ----------------------------


def test_multipart_alternative_prefers_html() -> None:
    """Standard multipart/alternative: plain first, then HTML. Should pick HTML."""
    msg = MIMEMultipart("alternative")
    msg.attach(MIMEText("Hello plain", "plain"))
    msg.attach(MIMEText("<p>Hello <b>HTML</b></p>", "html"))

    result = _extract_body(msg)
    assert result["content_type"] == "text/html"
    assert "<b>HTML</b>" in result["body"]


def test_multipart_alternative_html_first() -> None:
    """Unusual ordering: HTML before plain. Should still pick HTML."""
    msg = MIMEMultipart("alternative")
    msg.attach(MIMEText("<p>HTML first</p>", "html"))
    msg.attach(MIMEText("Plain second", "plain"))

    result = _extract_body(msg)
    assert result["content_type"] == "text/html"
    assert "HTML first" in result["body"]


def test_multipart_mixed_with_alternative() -> None:
    """multipart/mixed containing a multipart/alternative sub-part."""
    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText("Plain text body", "plain"))
    alt.attach(MIMEText("<div>Rich body</div>", "html"))

    msg = MIMEMultipart("mixed")
    msg.attach(alt)
    # Simulate a text attachment
    attachment = MIMEText("attachment content", "plain")
    attachment.add_header("Content-Disposition", "attachment", filename="note.txt")
    msg.attach(attachment)

    result = _extract_body(msg)
    assert result["content_type"] == "text/html"
    assert "Rich body" in result["body"]


# -- Single-part emails ----------------------------------------------------


def test_plain_text_only() -> None:
    """Single-part plain text email."""
    msg = MIMEText("Just plain text", "plain")

    result = _extract_body(msg)
    assert result["content_type"] == "text/plain"
    assert result["body"] == "Just plain text"


def test_html_only() -> None:
    """Single-part HTML email (no plain text alternative)."""
    msg = MIMEText("<h1>HTML Only</h1>", "html")

    result = _extract_body(msg)
    assert result["content_type"] == "text/html"
    assert "<h1>HTML Only</h1>" in result["body"]


# -- Multipart with only one text type ------------------------------------


def test_multipart_plain_only() -> None:
    """Multipart with only a text/plain part."""
    msg = MIMEMultipart("mixed")
    msg.attach(MIMEText("Only plain", "plain"))

    result = _extract_body(msg)
    assert result["content_type"] == "text/plain"
    assert result["body"] == "Only plain"


def test_multipart_html_only() -> None:
    """Multipart with only a text/html part."""
    msg = MIMEMultipart("mixed")
    msg.attach(MIMEText("<p>Only HTML</p>", "html"))

    result = _extract_body(msg)
    assert result["content_type"] == "text/html"
    assert "<p>Only HTML</p>" in result["body"]


# -- Edge cases ------------------------------------------------------------


def test_empty_body() -> None:
    """Email with no decodable body."""
    msg = MIMEMultipart("mixed")

    result = _extract_body(msg)
    assert result["content_type"] == "text/plain"
    assert result["body"] == ""


def test_charset_handling() -> None:
    """Email with non-UTF-8 charset."""
    msg = MIMEText("Umlaute: \xe4\xf6\xfc", "plain", "latin-1")

    result = _extract_body(msg)
    assert result["content_type"] == "text/plain"
    assert "Umlaute:" in result["body"]
