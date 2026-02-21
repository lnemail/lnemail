"""
Tests for the renewal payment status endpoint.

Covers the check_renewal_status endpoint (GET /account/renew/status/{payment_hash}),
focusing on the race condition where the background task clears the
renewal_payment_hash before the frontend's next status poll.
"""

from datetime import datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session

from lnemail.core.models import EmailAccount


class TestRenewalStatusPending:
    """Tests for pending (unpaid) renewal status checks."""

    def test_returns_pending_when_unpaid(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
        auth_headers: dict[str, str],
    ) -> None:
        """Status is 'pending' when the invoice exists but is not yet paid."""
        test_account.renewal_payment_hash = "renewal_hash_pending"
        db.add(test_account)
        db.commit()

        import lnemail.api.endpoints as ep

        ep.lnd_service.check_invoice.return_value = False

        response = client.get("/api/v1/account/renew/status/renewal_hash_pending")

        assert response.status_code == 200
        data: dict[str, Any] = response.json()
        assert data["payment_status"] == "pending"
        assert data["new_expires_at"] is None

    def test_returns_404_for_unknown_hash(self, client: TestClient) -> None:
        """Status check for a completely unknown hash returns 404."""
        import lnemail.api.endpoints as ep

        ep.lnd_service.check_invoice.return_value = False

        response = client.get("/api/v1/account/renew/status/nonexistent_hash")

        assert response.status_code == 404


class TestRenewalStatusProcessing:
    """Tests for the processing state (paid but not yet extended)."""

    def test_returns_processing_when_paid_but_not_yet_cleared(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
    ) -> None:
        """Status is 'processing' when LND confirms payment but hash is not cleared."""
        test_account.renewal_payment_hash = "renewal_hash_processing"
        db.add(test_account)
        db.commit()

        import lnemail.api.endpoints as ep

        ep.lnd_service.check_invoice.return_value = True

        response = client.get("/api/v1/account/renew/status/renewal_hash_processing")

        assert response.status_code == 200
        data: dict[str, Any] = response.json()
        assert data["payment_status"] == "processing"


class TestRenewalStatusPaidHashCleared:
    """Tests for the race condition where renewal_payment_hash is cleared
    by the background task before the frontend polls again."""

    def test_returns_paid_when_hash_cleared_and_lnd_confirms(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
    ) -> None:
        """When the background task already cleared the hash, the endpoint
        should check LND and return 'paid' instead of 404."""
        # Simulate the state AFTER the background task has processed the payment:
        # renewal_payment_hash is None (cleared), expires_at extended.
        test_account.renewal_payment_hash = None
        test_account.expires_at = datetime.utcnow() + timedelta(days=730)
        db.add(test_account)
        db.commit()

        import lnemail.api.endpoints as ep

        # LND confirms the invoice was paid
        ep.lnd_service.check_invoice.return_value = True

        response = client.get("/api/v1/account/renew/status/some_paid_hash")

        assert response.status_code == 200
        data: dict[str, Any] = response.json()
        assert data["payment_status"] == "paid"

    def test_returns_404_when_hash_cleared_and_lnd_denies(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
    ) -> None:
        """When the hash is not found AND LND says it was never paid,
        return 404 (genuinely invalid hash)."""
        test_account.renewal_payment_hash = None
        db.add(test_account)
        db.commit()

        import lnemail.api.endpoints as ep

        ep.lnd_service.check_invoice.return_value = False

        response = client.get("/api/v1/account/renew/status/totally_bogus_hash")

        assert response.status_code == 404


class TestRenewalStatusPaidHashOnAccount:
    """Tests for the path where the account still has the hash but it
    has been changed (edge case)."""

    def test_returns_paid_when_hash_changed_on_account(
        self,
        client: TestClient,
        db: Session,
        test_account: EmailAccount,
    ) -> None:
        """If the account's renewal_payment_hash differs from the queried hash
        (e.g. a new renewal was started), and LND confirms the old hash was
        paid, the endpoint should return 'paid' for the old hash."""
        # Account has a new renewal_payment_hash for a different renewal
        test_account.renewal_payment_hash = "new_renewal_hash"
        db.add(test_account)
        db.commit()

        import lnemail.api.endpoints as ep

        # LND confirms the old hash was paid
        ep.lnd_service.check_invoice.return_value = True

        # Query for the old hash -- no account has this hash anymore
        response = client.get("/api/v1/account/renew/status/old_renewal_hash")

        assert response.status_code == 200
        data: dict[str, Any] = response.json()
        assert data["payment_status"] == "paid"
