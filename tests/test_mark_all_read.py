"""Tests for marking an entire inbox as read."""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from lnemail.core.models import EmailAccount
from lnemail.core.timeutils import utcnow
from lnemail.services.email_service import EmailService


def test_email_service_marks_unseen_messages_in_one_store() -> None:
    service = EmailService.__new__(EmailService)
    mail = MagicMock()
    mail.search.return_value = ("OK", [b"2 5 9"])
    mail.store.return_value = ("OK", [])
    service._create_imap_connection = MagicMock(return_value=mail)

    success, count = service.mark_all_as_read("user@lnemail.net", "password")

    assert success is True
    assert count == 3
    mail.store.assert_called_once_with("2,5,9", "+FLAGS.SILENT", "\\Seen")


def test_mark_all_read_includes_current_expiry_warning(
    client: TestClient,
    db: Session,
    test_account: EmailAccount,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import lnemail.api.endpoints as endpoints

    test_account.expires_at = utcnow() + timedelta(days=30)
    db.add(test_account)
    db.commit()
    monkeypatch.setattr(
        endpoints.email_service, "mark_all_as_read", lambda *_: (True, 3)
    )

    response = client.post("/api/v1/emails/read-all", headers=auth_headers)

    assert response.status_code == 200, response.text
    assert response.json() == {"marked_read_count": 4}
    db.refresh(test_account)
    assert test_account.expiry_warning_read_for == test_account.expires_at


def test_opening_expiry_warning_persists_read_state(
    client: TestClient,
    db: Session,
    test_account: EmailAccount,
    auth_headers: dict[str, str],
) -> None:
    test_account.expires_at = utcnow() + timedelta(days=30)
    db.add(test_account)
    db.commit()
    warning_id = f"lnemail-expiry-warning-{int(test_account.expires_at.timestamp())}"

    response = client.get(f"/api/v1/emails/{warning_id}", headers=auth_headers)

    assert response.status_code == 200, response.text
    assert response.json()["read"] is True
    db.refresh(test_account)
    assert test_account.expiry_warning_read_for == test_account.expires_at
