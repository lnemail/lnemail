"""
Unit tests for the renewal payment background task.

Focus: the bounded polling behavior that prevents an unpaid renewal
invoice from spawning a self-requeueing job that polls LND forever
(regression test for the infinite re-enqueue bug).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from lnemail.core.models import EmailAccount, PaymentStatus
from lnemail.core.timeutils import utcnow
import lnemail.services.tasks as tasks


def _make_engine() -> Any:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_account(engine: Any, *, renewal_hash: str, expires_at: datetime) -> str:
    with Session(engine) as session:
        account = EmailAccount(
            email_address="renew@lnemail.net",
            access_token="renew-token",
            email_password="pw",
            payment_hash="acct_hash",
            payment_status=PaymentStatus.PAID,
            renewal_payment_hash=renewal_hash,
            expires_at=expires_at,
        )
        session.add(account)
        session.commit()
        session.refresh(account)
        return str(account.email_address)


class TestRenewalPollBounding:
    """The task must stop re-queuing once the invoice can no longer be paid."""

    def test_unpaid_reenqueues_with_incremented_attempt(self) -> None:
        engine = _make_engine()
        mock_queue = MagicMock()
        mock_backend = MagicMock()
        mock_backend.check_invoice.return_value = False

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
        ):
            tasks.check_renewal_payment_status("hash_unpaid", years=1, attempt=0)

        # Should have re-queued exactly once, carrying attempt+1.
        mock_queue.enqueue_in.assert_called_once()
        args = mock_queue.enqueue_in.call_args.args
        # (delay, func, payment_hash, years, attempt)
        assert args[1] is tasks.check_renewal_payment_status
        assert args[2] == "hash_unpaid"
        assert args[3] == 1
        assert args[4] == 1

    def test_unpaid_at_last_attempt_stops_requeueing(self) -> None:
        engine = _make_engine()
        mock_queue = MagicMock()
        mock_backend = MagicMock()
        mock_backend.check_invoice.return_value = False

        last_attempt = tasks.MAX_RENEWAL_POLL_ATTEMPTS - 1

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
        ):
            tasks.check_renewal_payment_status(
                "hash_expired", years=1, attempt=last_attempt
            )

        # No re-queue: the invoice has effectively expired.
        mock_queue.enqueue_in.assert_not_called()

    def test_expired_invoice_does_not_falsely_mark_paid(self) -> None:
        """Giving up on an unpaid invoice must NOT clear renewal_payment_hash,
        otherwise the status endpoint would report it as paid."""
        engine = _make_engine()
        email = _seed_account(
            engine,
            renewal_hash="hash_expired",
            expires_at=utcnow() + timedelta(days=10),
        )
        mock_queue = MagicMock()
        mock_backend = MagicMock()
        mock_backend.check_invoice.return_value = False

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
        ):
            tasks.check_renewal_payment_status(
                "hash_expired", years=1, attempt=tasks.MAX_RENEWAL_POLL_ATTEMPTS - 1
            )

        with Session(engine) as session:
            account = session.exec(
                select(EmailAccount).where(EmailAccount.email_address == email)
            ).first()
            assert account is not None
            # Hash is intentionally left intact for an abandoned invoice.
            assert account.renewal_payment_hash == "hash_expired"

    def test_paid_extends_account_and_clears_hash_without_requeue(self) -> None:
        engine = _make_engine()
        original_expiry = utcnow() + timedelta(days=30)
        email = _seed_account(
            engine, renewal_hash="hash_paid", expires_at=original_expiry
        )
        mock_queue = MagicMock()
        mock_backend = MagicMock()
        mock_backend.check_invoice.return_value = True

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
        ):
            tasks.check_renewal_payment_status("hash_paid", years=1, attempt=0)

        mock_queue.enqueue_in.assert_not_called()
        with Session(engine) as session:
            account = session.exec(
                select(EmailAccount).where(EmailAccount.email_address == email)
            ).first()
            assert account is not None
            assert account.renewal_payment_hash is None
            # Extended ~1 year from the original expiry.
            assert account.expires_at > original_expiry + timedelta(days=364)

    def test_max_attempts_covers_invoice_lifetime(self) -> None:
        """The poll budget should at least span the invoice's expiry window."""
        budget_seconds = tasks.MAX_RENEWAL_POLL_ATTEMPTS * tasks.RENEWAL_POLL_INTERVAL
        assert budget_seconds >= tasks.RENEWAL_INVOICE_EXPIRY


def _seed_pending_signup(
    engine: Any, *, payment_hash: str, created_at: datetime
) -> str:
    """Insert a PENDING signup account with a given invoice age."""
    with Session(engine) as session:
        account = EmailAccount(
            email_address=f"{payment_hash}@lnemail.net",
            access_token=f"tok-{payment_hash}",
            payment_hash=payment_hash,
            payment_status=PaymentStatus.PENDING,
            created_at=created_at,
        )
        session.add(account)
        session.commit()
        session.refresh(account)
        return str(account.email_address)


class TestSignupPaymentPoller:
    """The batched poller sweeps all in-window pending signups in one job,
    reusing one backend connection, and always keeps its single chain alive."""

    def test_always_reenqueues_itself_with_fixed_job_id(self) -> None:
        engine = _make_engine()
        mock_queue = MagicMock()

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend") as get_backend,
        ):
            tasks.poll_signup_payments()

        # No pending accounts -> no backend connection is opened at all.
        get_backend.assert_not_called()
        # The single poller chain is rescheduled with the fixed id.
        mock_queue.enqueue_in.assert_called_once()
        kwargs = mock_queue.enqueue_in.call_args.kwargs
        args = mock_queue.enqueue_in.call_args.args
        assert args[1] is tasks.poll_signup_payments
        assert kwargs["job_id"] == tasks.SIGNUP_POLLER_JOB_ID

    def test_paid_in_window_invoice_is_activated(self) -> None:
        engine = _make_engine()
        email = _seed_pending_signup(
            engine, payment_hash="paid_hash", created_at=utcnow()
        )
        mock_queue = MagicMock()
        mock_backend = MagicMock()
        mock_backend.check_invoice.return_value = True
        mock_email = MagicMock()
        mock_email.create_account.return_value = (True, "mailbox-pw")

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
            patch.object(tasks, "EmailService", return_value=mock_email),
        ):
            tasks.poll_signup_payments()

        mock_backend.check_invoice.assert_called_once_with("paid_hash")
        mock_email.create_account.assert_called_once()
        with Session(engine) as session:
            account = session.exec(
                select(EmailAccount).where(EmailAccount.email_address == email)
            ).first()
            assert account is not None
            assert account.payment_status == PaymentStatus.PAID

    def test_unpaid_in_window_invoice_stays_pending(self) -> None:
        engine = _make_engine()
        email = _seed_pending_signup(
            engine, payment_hash="unpaid_hash", created_at=utcnow()
        )
        mock_queue = MagicMock()
        mock_backend = MagicMock()
        mock_backend.check_invoice.return_value = False

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
            patch.object(tasks, "EmailService", return_value=MagicMock()),
        ):
            tasks.poll_signup_payments()

        mock_backend.check_invoice.assert_called_once_with("unpaid_hash")
        with Session(engine) as session:
            account = session.exec(
                select(EmailAccount).where(EmailAccount.email_address == email)
            ).first()
            assert account is not None
            assert account.payment_status == PaymentStatus.PENDING

    def test_expired_window_invoice_is_skipped(self) -> None:
        """An invoice older than its validity window is not checked anymore."""
        engine = _make_engine()
        stale = utcnow() - timedelta(seconds=tasks.SIGNUP_INVOICE_WINDOW + 60)
        _seed_pending_signup(engine, payment_hash="stale_hash", created_at=stale)
        mock_queue = MagicMock()
        mock_backend = MagicMock()

        with (
            patch.object(tasks, "engine", engine),
            patch.object(tasks, "queue", mock_queue),
            patch.object(tasks, "get_payment_backend", return_value=mock_backend),
            patch.object(tasks, "EmailService", return_value=MagicMock()),
        ):
            tasks.poll_signup_payments()

        # Out of window: never checked (and no backend connection opened).
        mock_backend.check_invoice.assert_not_called()

    def test_window_covers_invoice_lifetime(self) -> None:
        assert tasks.SIGNUP_INVOICE_WINDOW >= tasks.RENEWAL_INVOICE_EXPIRY
