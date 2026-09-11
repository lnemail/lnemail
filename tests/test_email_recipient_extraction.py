"""Tests for identifying the address that received an inbound message."""

from email.message import Message

from lnemail.services.email_service import EmailService


def _service() -> EmailService:
    return EmailService.__new__(EmailService)


def test_delivered_to_takes_precedence_over_visible_to() -> None:
    message = Message()
    message["Delivered-To"] = "account+support@lnemail.net"
    message["To"] = "public-list@example.com"

    assert _service()._extract_recipient(message) == "account+support@lnemail.net"


def test_topmost_delivered_to_is_used() -> None:
    message = Message()
    message["Delivered-To"] = "final@lnemail.net"
    message["Delivered-To"] = "upstream@example.com"

    assert _service()._extract_recipient(message) == "final@lnemail.net"


def test_original_recipient_headers_are_ordered_fallbacks() -> None:
    message = Message()
    message["X-Original-To"] = "account+x-original@lnemail.net"
    message["Envelope-To"] = "account+envelope@lnemail.net"
    message["To"] = "visible@example.com"

    assert _service()._extract_recipient(message) == "account+x-original@lnemail.net"


def test_multiple_to_headers_are_retained_when_delivery_headers_are_missing() -> None:
    message = Message()
    message["To"] = "first@example.com"
    message["To"] = "second@example.com"

    assert (
        _service()._extract_recipient(message)
        == "first@example.com, second@example.com"
    )


def test_encoded_to_header_is_decoded() -> None:
    message = Message()
    message["To"] = "=?utf-8?q?Support_Team?= <support@example.com>"

    assert (
        _service()._extract_recipient(message) == "Support Team <support@example.com>"
    )


def test_missing_recipient_headers_returns_none() -> None:
    assert _service()._extract_recipient(Message()) is None
