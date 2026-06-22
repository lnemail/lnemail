"""Tests for the 'get a new invoice from a different provider' endpoints.

Covers POST /email/{hash}/new-invoice, /email/send/{hash}/new-invoice and
/account/renew/{hash}/new-invoice: they re-issue an invoice for a pending
payment, replacing its payment_hash, and pass exclude_provider through to
the payment backend.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from lnemail.core.models import EmailAccount, PaymentStatus, PendingOutgoingEmail
from lnemail.core.timeutils import utcnow


def _set_new_invoice(client_mock: Any, payment_hash: str, provider: str) -> None:
    client_mock.create_invoice.return_value = {
        "payment_hash": payment_hash,
        "payment_request": f"lnbc_new_{payment_hash}",
        "provider": provider,
    }


class TestNewAccountInvoice:
    def test_reissues_signup_invoice_from_other_provider(
        self, client: TestClient, db: Session, test_account: EmailAccount
    ) -> None:
        import lnemail.api.endpoints as ep

        # Make the test account pending so it is re-issuable.
        test_account.payment_status = PaymentStatus.PENDING
        test_account.payment_hash = "old_signup_hash"
        db.add(test_account)
        db.commit()

        _set_new_invoice(ep.payment_backend, "new_signup_hash", "nwc")

        resp = client.post(
            "/api/v1/email/old_signup_hash/new-invoice",
            json={"exclude_provider": "lnd"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["payment_hash"] == "new_signup_hash"
        assert data["provider"] == "nwc"

        # The backend was asked to avoid the excluded provider.
        _, kwargs = ep.payment_backend.create_invoice.call_args
        assert kwargs.get("exclude_provider") == "lnd"

        # The account now points at the new hash.
        with Session(db.get_bind()) as s:
            acct = s.exec(
                select(EmailAccount).where(
                    EmailAccount.email_address == test_account.email_address
                )
            ).first()
            assert acct is not None
            assert acct.payment_hash == "new_signup_hash"

    def test_404_for_unknown_hash(self, client: TestClient) -> None:
        resp = client.post("/api/v1/email/does_not_exist/new-invoice", json={})
        assert resp.status_code == 404

    def test_409_when_already_paid(
        self, client: TestClient, db: Session, test_account: EmailAccount
    ) -> None:
        test_account.payment_status = PaymentStatus.PAID
        test_account.payment_hash = "paid_hash"
        db.add(test_account)
        db.commit()
        resp = client.post("/api/v1/email/paid_hash/new-invoice", json={})
        assert resp.status_code == 409


class TestNewSendInvoice:
    def _seed_pending_send(
        self, db: Session, account: EmailAccount, payment_hash: str
    ) -> None:
        pending = PendingOutgoingEmail(
            sender_email=account.email_address,
            recipient="dest@example.com",
            subject="Hi",
            body="body",
            payment_hash=payment_hash,
            payment_request="lnbc_old",
            price_sats=100,
            status=PaymentStatus.PENDING,
        )
        db.add(pending)
        db.commit()

    def test_reissues_send_invoice(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
        auth_headers: dict[str, str],
    ) -> None:
        import lnemail.api.endpoints as ep

        self._seed_pending_send(db, test_account, "old_send_hash")
        _set_new_invoice(ep.payment_backend, "new_send_hash", "lnd")

        resp = client.post(
            "/api/v1/email/send/old_send_hash/new-invoice",
            json={"exclude_provider": "nwc"},
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["payment_hash"] == "new_send_hash"
        assert data["provider"] == "lnd"
        _, kwargs = ep.payment_backend.create_invoice.call_args
        assert kwargs.get("exclude_provider") == "nwc"

    def test_requires_auth(self, client: TestClient) -> None:
        resp = client.post("/api/v1/email/send/whatever/new-invoice", json={})
        assert resp.status_code == 401

    def test_404_for_other_users_send(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
        auth_headers: dict[str, str],
    ) -> None:
        other = PendingOutgoingEmail(
            sender_email="someone-else@lnemail.net",
            recipient="dest@example.com",
            subject="Hi",
            body="body",
            payment_hash="foreign_hash",
            payment_request="lnbc_old",
            price_sats=100,
            status=PaymentStatus.PENDING,
        )
        db.add(other)
        db.commit()
        resp = client.post(
            "/api/v1/email/send/foreign_hash/new-invoice",
            json={},
            headers=auth_headers,
        )
        assert resp.status_code == 404


class TestNewRenewalInvoice:
    def test_reissues_renewal_invoice(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
        auth_headers: dict[str, str],
    ) -> None:
        import lnemail.api.endpoints as ep

        test_account.renewal_payment_hash = "old_renewal_hash"
        test_account.expires_at = utcnow() + timedelta(days=5)
        db.add(test_account)
        db.commit()

        _set_new_invoice(ep.payment_backend, "new_renewal_hash", "nwc")

        resp = client.post(
            "/api/v1/account/renew/old_renewal_hash/new-invoice",
            json={"exclude_provider": "lnd", "years": 2},
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["payment_hash"] == "new_renewal_hash"
        assert data["provider"] == "nwc"
        assert data["years"] == 2
        _, kwargs = ep.payment_backend.create_invoice.call_args
        assert kwargs.get("exclude_provider") == "lnd"

    def test_404_for_unknown_renewal_hash(
        self,
        client: TestClient,
        test_account: EmailAccount,
        auth_headers: dict[str, str],
    ) -> None:
        resp = client.post(
            "/api/v1/account/renew/nope/new-invoice", json={}, headers=auth_headers
        )
        assert resp.status_code == 404
