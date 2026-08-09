"""Passkey enrollment and access-token recovery tests."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from lnemail.core.models import EmailAccount, PasskeyCredential, WebAuthnChallenge


def test_passkey_enrollment_recovery_and_revocation(
    client: TestClient,
    db: Session,
    test_account: EmailAccount,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import lnemail.api.passkeys as passkeys

    options_response = client.post(
        "/api/v1/passkeys/registration/options", headers=auth_headers
    )
    assert options_response.status_code == 200, options_response.text
    options_body = options_response.json()
    assert options_body["options"]["rp"]["id"] == "lnemail.net"
    assert (
        options_body["options"]["authenticatorSelection"]["residentKey"] == "required"
    )

    db.refresh(test_account)
    assert test_account.passkey_user_handle is not None

    credential_id = b"credential-id"
    monkeypatch.setattr(
        passkeys,
        "verify_registration_response",
        lambda **_: SimpleNamespace(
            credential_id=credential_id,
            credential_public_key=b"public-key",
            sign_count=3,
            credential_device_type="multi_device",
            credential_backed_up=True,
        ),
    )
    registration_response = client.post(
        "/api/v1/passkeys/registration",
        headers=auth_headers,
        json={
            "ceremony_id": options_body["ceremony_id"],
            "name": "Laptop",
            "credential": {"response": {"transports": ["internal"]}},
        },
    )
    assert registration_response.status_code == 200, registration_response.text
    registered = registration_response.json()["passkey"]
    assert registered["name"] == "Laptop"

    stored = db.exec(
        select(PasskeyCredential).where(
            PasskeyCredential.credential_id == credential_id
        )
    ).one()
    assert stored.transports_json == '["internal"]'

    auth_options_response = client.post("/api/v1/passkeys/authentication/options")
    assert auth_options_response.status_code == 200, auth_options_response.text
    auth_options = auth_options_response.json()
    assert auth_options["options"]["userVerification"] == "required"
    assert auth_options["options"]["allowCredentials"] == []

    monkeypatch.setattr(
        passkeys,
        "parse_authentication_credential_json",
        lambda _: SimpleNamespace(
            raw_id=credential_id,
            response=SimpleNamespace(user_handle=test_account.passkey_user_handle),
        ),
    )
    monkeypatch.setattr(
        passkeys,
        "verify_authentication_response",
        lambda **_: SimpleNamespace(
            new_sign_count=4,
            credential_device_type="multi_device",
            credential_backed_up=True,
        ),
    )
    recovery_response = client.post(
        "/api/v1/passkeys/authentication",
        json={
            "ceremony_id": auth_options["ceremony_id"],
            "credential": {"id": "ignored-by-mock"},
        },
    )
    assert recovery_response.status_code == 200, recovery_response.text
    assert recovery_response.json() == {
        "email_address": test_account.email_address,
        "access_token": test_account.access_token,
    }
    assert recovery_response.headers["cache-control"] == "no-store"
    assert recovery_response.headers["pragma"] == "no-cache"
    db.refresh(stored)
    assert stored.sign_count == 4

    replay_response = client.post(
        "/api/v1/passkeys/authentication",
        json={
            "ceremony_id": auth_options["ceremony_id"],
            "credential": {"id": "ignored-by-mock"},
        },
    )
    assert replay_response.status_code == 400

    list_response = client.get("/api/v1/passkeys", headers=auth_headers)
    assert list_response.status_code == 200
    assert list_response.json()["passkeys"][0]["name"] == "Laptop"

    delete_response = client.delete(
        f"/api/v1/passkeys/{registered['id']}", headers=auth_headers
    )
    assert delete_response.status_code == 204
    assert db.exec(select(PasskeyCredential)).all() == []


def test_registration_challenge_is_bound_to_account(
    client: TestClient,
    db: Session,
    test_account: EmailAccount,
    auth_headers: dict[str, str],
) -> None:
    response = client.post(
        "/api/v1/passkeys/registration/options", headers=auth_headers
    )
    ceremony_id = response.json()["ceremony_id"]
    challenge = db.get(WebAuthnChallenge, ceremony_id)

    assert challenge is not None
    assert challenge.account_id == test_account.id
    assert challenge.ceremony_type == "registration"


def test_passkey_endpoints_require_bearer_token_for_management(
    client: TestClient,
) -> None:
    assert client.get("/api/v1/passkeys").status_code == 401
    assert client.post("/api/v1/passkeys/registration/options").status_code == 401
