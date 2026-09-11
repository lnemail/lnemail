"""
Tests for the free first outgoing email.

Every account can send its first email without paying. The API returns a
zero-price response without an invoice, the pending record is created as
PAID so the worker delivers it right away, and every later send goes
through the regular invoice path.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

import lnemail.api.endpoints as ep
import lnemail.services.tasks as tasks
from lnemail.core.models import (
    DeliveryStatus,
    EmailAccount,
    PaymentStatus,
    PendingOutgoingEmail,
)
from lnemail.core.timeutils import utcnow


SEND_URL = "/api/v1/email/send"
PAYLOAD = {"recipient": "alice@example.com", "subject": "Hi", "body": "First one"}


@pytest.fixture()
def fresh_account(db: Session, test_account: EmailAccount) -> EmailAccount:
    """Reset the shared account so its free send is still available."""
    test_account.free_send_used_at = None
    db.add(test_account)
    db.commit()
    db.refresh(test_account)
    return test_account


def _pending_by_hash(db: Session, payment_hash: str) -> PendingOutgoingEmail:
    pending = db.exec(
        select(PendingOutgoingEmail).where(
            PendingOutgoingEmail.payment_hash == payment_hash
        )
    ).first()
    assert pending is not None
    return pending


class TestFreeSendEndpoint:
    def test_account_reports_free_send_availability(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        fresh_account: EmailAccount,
    ) -> None:
        resp = client.get("/api/v1/account", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["free_send_available"] is True

    def test_first_send_is_free_and_queued_as_paid(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        fresh_account: EmailAccount,
        db: Session,
    ) -> None:
        resp = client.post(SEND_URL, json=PAYLOAD, headers=auth_headers)
        assert resp.status_code == 202
        data = resp.json()
        assert data["price_sats"] == 0
        assert data["payment_request"] is None
        assert data["payment_hash"].startswith("free_")
        assert data["recipient"] == "alice@example.com"
        ep.payment_backend.create_invoice.assert_not_called()

        pending = _pending_by_hash(db, data["payment_hash"])
        assert pending.status == PaymentStatus.PAID
        assert pending.price_sats == 0
        assert pending.body == "First one"

        # The worker is scheduled with the synthetic hash.
        enqueue_args = ep.queue.enqueue.call_args.args
        assert enqueue_args[0] is tasks.process_send_email_payment
        assert enqueue_args[1] == data["payment_hash"]

        db.refresh(fresh_account)
        assert fresh_account.free_send_used_at is not None

        account_resp = client.get("/api/v1/account", headers=auth_headers)
        assert account_resp.json()["free_send_available"] is False

    def test_second_send_requires_invoice(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        fresh_account: EmailAccount,
    ) -> None:
        first = client.post(SEND_URL, json=PAYLOAD, headers=auth_headers)
        assert first.json()["price_sats"] == 0

        second = client.post(SEND_URL, json=PAYLOAD, headers=auth_headers)
        assert second.status_code == 202
        data = second.json()
        assert data["price_sats"] > 0
        assert data["payment_hash"] == "fakehash_abc123"
        assert data["payment_request"] == "lnbc1000n1fake_invoice_request"
        ep.payment_backend.create_invoice.assert_called_once()

    def test_used_free_send_goes_straight_to_invoice(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
    ) -> None:
        """The default fixture account already consumed its free send."""
        resp = client.post(SEND_URL, json=PAYLOAD, headers=auth_headers)
        assert resp.json()["price_sats"] > 0
        ep.payment_backend.create_invoice.assert_called_once()

    def test_free_send_cannot_be_reissued(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        fresh_account: EmailAccount,
    ) -> None:
        payment_hash = client.post(SEND_URL, json=PAYLOAD, headers=auth_headers).json()[
            "payment_hash"
        ]
        resp = client.post(
            f"{SEND_URL}/{payment_hash}/new-invoice", json={}, headers=auth_headers
        )
        assert resp.status_code == 409

    def test_free_send_status_is_pollable(
        self,
        client: TestClient,
        auth_headers: dict[str, str],
        fresh_account: EmailAccount,
    ) -> None:
        payment_hash = client.post(SEND_URL, json=PAYLOAD, headers=auth_headers).json()[
            "payment_hash"
        ]
        resp = client.get(f"{SEND_URL}/status/{payment_hash}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["payment_status"] == "paid"
        assert data["delivery_status"] == "pending"

    def test_claim_is_atomic(self, db: Session, fresh_account: EmailAccount) -> None:
        """Only one of two claims on the same account can succeed."""
        assert ep._claim_free_send(db, fresh_account) is True
        db.commit()
        # Simulate a second request that loaded the account before the claim.
        stale = EmailAccount.model_validate(fresh_account)
        stale.id = fresh_account.id
        stale.free_send_used_at = None
        assert ep._claim_free_send(db, stale) is False


def _make_engine() -> Any:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


class TestFreeSendWorker:
    def test_paid_record_is_delivered_without_invoice_lookup(self) -> None:
        engine = _make_engine()
        with Session(engine) as session:
            session.add(
                EmailAccount(
                    email_address="free@lnemail.net",
                    access_token="free-token",
                    email_password="pw",
                    payment_hash="acct_hash",
                    payment_status=PaymentStatus.PAID,
                    free_send_used_at=utcnow(),
                )
            )
            session.add(
                PendingOutgoingEmail(
                    sender_email="free@lnemail.net",
                    recipient="bob@example.com",
                    subject="Free",
                    body="Hello",
                    payment_hash="free_abc",
                    payment_request="",
                    price_sats=0,
                    status=PaymentStatus.PAID,
                )
            )
            session.commit()

        mock_backend = MagicMock()
        mock_email = MagicMock()
        mock_email.send_email_with_auth.return_value = (True, "ok")

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", MagicMock()),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
            patch.object(tasks, "EmailService", return_value=mock_email),
        ):
            tasks.process_send_email_payment("free_abc")

        mock_backend.check_invoice.assert_not_called()
        mock_email.send_email_with_auth.assert_called_once()
        assert mock_email.send_email_with_auth.call_args.kwargs["body"] == "Hello"

        with Session(engine) as session:
            pending = _pending_by_hash(session, "free_abc")
            assert pending.delivery_status == DeliveryStatus.SENT
            assert pending.sent_at is not None
