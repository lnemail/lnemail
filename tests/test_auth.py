"""Tests covering bearer token authentication and normalization."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session

from lnemail.core.models import EmailAccount, PaymentStatus
from lnemail.core.tokens import generate_access_token


def _new_paid_account(db: Session, token: str) -> EmailAccount:
    account = EmailAccount(
        email_address=f"auth-{token[-6:]}@lnemail.net",
        access_token=token,
        email_password="pw",
        payment_hash=f"hash-{token[-6:]}",
        payment_status=PaymentStatus.PAID,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


class TestBearerAuth:
    def test_legacy_token_authenticates(self, client: TestClient) -> None:
        # The default ``test_account`` fixture uses a legacy-style opaque
        # token; it must continue to work.
        response = client.get(
            "/api/v1/account",
            headers={"Authorization": "Bearer test-token-12345"},
        )
        assert response.status_code == 200, response.text

    def test_new_format_token_authenticates(
        self, client: TestClient, db: Session
    ) -> None:
        token = generate_access_token()
        _new_paid_account(db, token)
        response = client.get(
            "/api/v1/account",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200, response.text

    def test_new_format_token_normalized_lowercase(
        self, client: TestClient, db: Session
    ) -> None:
        token = generate_access_token()
        _new_paid_account(db, token)
        response = client.get(
            "/api/v1/account",
            headers={"Authorization": f"Bearer {token.lower()}"},
        )
        assert response.status_code == 200, response.text

    def test_new_format_token_normalized_no_dashes(
        self, client: TestClient, db: Session
    ) -> None:
        token = generate_access_token()
        _new_paid_account(db, token)
        no_dashes = token.replace("-", "")
        response = client.get(
            "/api/v1/account",
            headers={"Authorization": f"Bearer {no_dashes}"},
        )
        assert response.status_code == 200, response.text

    def test_invalid_token_rejected(self, client: TestClient) -> None:
        response = client.get(
            "/api/v1/account",
            headers={"Authorization": "Bearer lne_AAAAA-BBBBB-CCCCC-DDDDD-EEEEE"},
        )
        assert response.status_code == 401
