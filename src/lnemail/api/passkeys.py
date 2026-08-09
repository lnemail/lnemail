"""WebAuthn passkey enrollment and access-token recovery endpoints."""

from __future__ import annotations

import base64
import json
import secrets
from datetime import timedelta
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, update
from sqlalchemy.engine import CursorResult
from sqlmodel import SQLModel, Session, col, select
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import (
    bytes_to_base64url,
    options_to_json_dict,
    parse_authentication_credential_json,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from ..config import settings
from ..core.models import EmailAccount, PasskeyCredential, WebAuthnChallenge
from ..core.schemas import (
    PasskeyAuthenticationRequest,
    PasskeyListResponse,
    PasskeyRegistrationRequest,
    PasskeyRegistrationResponse,
    PasskeyResponse,
    PasskeyTokenRecoveryResponse,
    WebAuthnOptionsResponse,
)
from ..core.timeutils import utcnow
from ..db import get_db
from .endpoints import get_current_account, validate_account_access

router = APIRouter(prefix="/passkeys", tags=["passkeys"])

_CHALLENGE_TTL = timedelta(minutes=5)
_REGISTRATION = "registration"
_AUTHENTICATION = "authentication"
_MAX_PENDING_AUTHENTICATION_CHALLENGES = 10_000


def _enum_value(value: Any) -> str | None:
    if value is None:
        return None
    return str(getattr(value, "value", value))


def _passkey_response(credential: PasskeyCredential) -> PasskeyResponse:
    return PasskeyResponse(
        id=bytes_to_base64url(credential.credential_id),
        name=credential.name,
        created_at=credential.created_at,
        last_used_at=credential.last_used_at,
    )


def _store_challenge(
    db: Session,
    challenge: bytes,
    ceremony_type: str,
    account_id: int | None = None,
) -> str:
    challenge_table = SQLModel.metadata.tables["webauthn_challenges"]
    db.execute(delete(challenge_table).where(challenge_table.c.expires_at <= utcnow()))
    if ceremony_type == _AUTHENTICATION:
        pending_count = db.execute(
            select(func.count())
            .select_from(challenge_table)
            .where(challenge_table.c.ceremony_type == _AUTHENTICATION)
        ).scalar_one()
        if pending_count >= _MAX_PENDING_AUTHENTICATION_CHALLENGES:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many passkey requests are pending",
            )
    ceremony_id = secrets.token_urlsafe(32)
    db.add(
        WebAuthnChallenge(
            id=ceremony_id,
            challenge=challenge,
            ceremony_type=ceremony_type,
            account_id=account_id,
            expires_at=utcnow() + _CHALLENGE_TTL,
        )
    )
    db.commit()
    return ceremony_id


def _consume_challenge(
    db: Session,
    ceremony_id: str,
    ceremony_type: str,
    account_id: int | None = None,
) -> bytes:
    challenge_table = SQLModel.metadata.tables["webauthn_challenges"]
    result = db.execute(
        delete(challenge_table)
        .where(
            challenge_table.c.id == ceremony_id,
            challenge_table.c.ceremony_type == ceremony_type,
            challenge_table.c.account_id == account_id,
            challenge_table.c.expires_at > utcnow(),
        )
        .returning(challenge_table.c.challenge)
    ).scalar_one_or_none()
    db.commit()
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Passkey request is invalid or expired",
        )
    return cast(bytes, result)


def _ensure_user_handle(db: Session, account: EmailAccount) -> bytes:
    """Initialize an account's user handle once, including under concurrency."""
    if account.id is None:
        raise HTTPException(status_code=500, detail="Account is not persisted")
    if account.passkey_user_handle is None:
        account_table = SQLModel.metadata.tables["email_accounts"]
        db.execute(
            update(account_table)
            .where(
                account_table.c.id == account.id,
                account_table.c.passkey_user_handle.is_(None),
            )
            .values(passkey_user_handle=secrets.token_bytes(32))
        )
        db.commit()
        db.refresh(account)
    if account.passkey_user_handle is None:
        raise HTTPException(
            status_code=500, detail="Passkey account initialization failed"
        )
    return account.passkey_user_handle


@router.get("", response_model=PasskeyListResponse)
async def list_passkeys(
    account: EmailAccount = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> PasskeyListResponse:
    credentials = db.exec(
        select(PasskeyCredential)
        .where(PasskeyCredential.account_id == account.id)
        .order_by(col(PasskeyCredential.created_at))
    ).all()
    return PasskeyListResponse(
        passkeys=[_passkey_response(credential) for credential in credentials]
    )


@router.post("/registration/options", response_model=WebAuthnOptionsResponse)
async def registration_options(
    account: EmailAccount = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> WebAuthnOptionsResponse:
    user_handle = _ensure_user_handle(db, account)

    credentials = db.exec(
        select(PasskeyCredential).where(PasskeyCredential.account_id == account.id)
    ).all()
    options = generate_registration_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        rp_name=settings.WEBAUTHN_RP_NAME,
        user_id=user_handle,
        user_name=account.email_address,
        user_display_name=account.email_address,
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=credential.credential_id)
            for credential in credentials
        ],
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
    )
    ceremony_id = _store_challenge(db, options.challenge, _REGISTRATION, account.id)
    return WebAuthnOptionsResponse(
        ceremony_id=ceremony_id,
        options=options_to_json_dict(options),
    )


@router.post("/registration", response_model=PasskeyRegistrationResponse)
async def register_passkey(
    request_data: PasskeyRegistrationRequest,
    account: EmailAccount = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> PasskeyRegistrationResponse:
    if account.id is None or account.passkey_user_handle is None:
        raise HTTPException(
            status_code=400, detail="Passkey registration was not started"
        )

    expected_challenge = _consume_challenge(
        db, request_data.ceremony_id, _REGISTRATION, account.id
    )
    try:
        verification = verify_registration_response(
            credential=request_data.credential,
            expected_challenge=expected_challenge,
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            expected_origin=settings.WEBAUTHN_ORIGIN,
            require_user_verification=True,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Passkey registration could not be verified",
        ) from exc

    existing = db.exec(
        select(PasskeyCredential).where(
            PasskeyCredential.credential_id == verification.credential_id
        )
    ).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail="Passkey is already registered")

    transports = request_data.credential.get("response", {}).get("transports", [])
    credential = PasskeyCredential(
        account_id=account.id,
        credential_id=verification.credential_id,
        credential_public_key=verification.credential_public_key,
        sign_count=verification.sign_count,
        name=request_data.name.strip(),
        transports_json=json.dumps(transports),
        device_type=_enum_value(verification.credential_device_type),
        backed_up=verification.credential_backed_up,
    )
    db.add(credential)
    db.commit()
    db.refresh(credential)
    return PasskeyRegistrationResponse(passkey=_passkey_response(credential))


@router.post("/authentication/options", response_model=WebAuthnOptionsResponse)
async def authentication_options(
    db: Session = Depends(get_db),
) -> WebAuthnOptionsResponse:
    options = generate_authentication_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        allow_credentials=None,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    ceremony_id = _store_challenge(db, options.challenge, _AUTHENTICATION)
    return WebAuthnOptionsResponse(
        ceremony_id=ceremony_id,
        options=options_to_json_dict(options),
    )


@router.post(
    "/authentication",
    response_model=PasskeyTokenRecoveryResponse,
)
async def authenticate_passkey(
    request_data: PasskeyAuthenticationRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> PasskeyTokenRecoveryResponse:
    expected_challenge = _consume_challenge(
        db, request_data.ceremony_id, _AUTHENTICATION
    )
    try:
        parsed = parse_authentication_credential_json(request_data.credential)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid passkey response") from exc

    credential = db.exec(
        select(PasskeyCredential).where(
            PasskeyCredential.credential_id == parsed.raw_id
        )
    ).first()
    if credential is None:
        raise HTTPException(status_code=401, detail="Passkey is not registered")

    account = db.get(EmailAccount, credential.account_id)
    if account is None or account.passkey_user_handle is None:
        raise HTTPException(status_code=401, detail="Passkey account was not found")
    if parsed.response.user_handle != account.passkey_user_handle:
        raise HTTPException(status_code=401, detail="Passkey account does not match")

    try:
        verification = verify_authentication_response(
            credential=parsed,
            expected_challenge=expected_challenge,
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            expected_origin=settings.WEBAUTHN_ORIGIN,
            credential_public_key=credential.credential_public_key,
            credential_current_sign_count=credential.sign_count,
            require_user_verification=True,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Passkey authentication could not be verified",
        ) from exc

    validate_account_access(account)
    credential_table = SQLModel.metadata.tables["passkey_credentials"]
    update_result = cast(
        CursorResult[Any],
        db.execute(
            update(credential_table)
            .where(
                credential_table.c.id == credential.id,
                credential_table.c.sign_count == credential.sign_count,
            )
            .values(
                sign_count=verification.new_sign_count,
                device_type=_enum_value(verification.credential_device_type),
                backed_up=verification.credential_backed_up,
                last_used_at=utcnow(),
            )
        ),
    )
    if update_result.rowcount != 1:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Passkey was used concurrently; please try again",
        )
    db.commit()

    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return PasskeyTokenRecoveryResponse(
        email_address=account.email_address,
        access_token=account.access_token,
    )


@router.delete("/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_passkey(
    credential_id: str,
    account: EmailAccount = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> Response:
    credential = db.exec(
        select(PasskeyCredential).where(
            PasskeyCredential.account_id == account.id,
            PasskeyCredential.credential_id == _decode_credential_id(credential_id),
        )
    ).first()
    if credential is None:
        raise HTTPException(status_code=404, detail="Passkey was not found")
    db.delete(credential)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _decode_credential_id(value: str) -> bytes:
    try:
        padding = "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode(value + padding)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Passkey was not found") from exc
