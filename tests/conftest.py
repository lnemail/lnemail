"""
Shared test fixtures for integration tests.

Provides a FastAPI TestClient backed by an in-memory SQLite database,
with external services (LND, Redis Queue, scheduled tasks) mocked out.
"""

import base64
import sys
from collections.abc import Generator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from lnemail.core.models import EmailAccount, PaymentStatus
from lnemail.db import get_db


# ---------------------------------------------------------------------------
# Patch LNDService and EmailService constructors BEFORE importing the app
# module, because endpoints.py instantiates both at module level.
# ---------------------------------------------------------------------------
_mock_lnd_instance = MagicMock()
_mock_lnd_instance.create_invoice.return_value = {
    "payment_hash": "fakehash_abc123",
    "payment_request": "lnbc1000n1fake_invoice_request",
}

# Ensure that lnemail.api.endpoints hasn't been imported yet so we can
# control the module-level service construction.
_endpoints_already_loaded = "lnemail.api.endpoints" in sys.modules

if not _endpoints_already_loaded:
    # Patch before the module-level LNDService() and EmailService() calls
    _lnd_patch = patch(
        "lnemail.services.lnd_service.LNDService.__init__", lambda self: None
    )
    _email_patch = patch("os.makedirs")  # EmailService.__init__ calls makedirs
    _rq_patch = patch(
        "lnemail.services.tasks.redis_conn",
        MagicMock(),
    )
    _lnd_patch.start()
    _email_patch.start()
    _rq_patch.start()

    # Now import the app -- module-level code runs with mocked constructors
    from lnemail.main import app as _app  # noqa: E402

    _lnd_patch.stop()
    _email_patch.stop()
    _rq_patch.stop()

    # Replace the module-level service instances with our controlled mocks
    import lnemail.api.endpoints as _ep

    _ep.lnd_service = _mock_lnd_instance
else:
    from lnemail.main import app as _app


@pytest.fixture(name="engine")
def fixture_engine() -> Any:
    """Create an in-memory SQLite engine for testing.

    Uses StaticPool so that all Session() calls share the same underlying
    connection, which is required for in-memory SQLite databases.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


@pytest.fixture(name="db")
def fixture_db(engine: Any) -> Generator[Session, None, None]:
    """Provide a test database session."""
    with Session(engine) as session:
        yield session


@pytest.fixture(name="test_account")
def fixture_test_account(db: Session) -> EmailAccount:
    """Create and persist a paid test account."""
    account = EmailAccount(
        email_address="testuser@lnemail.net",
        access_token="test-token-12345",
        email_password="testpassword",
        payment_hash="testhash123",
        payment_status=PaymentStatus.PAID,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


@pytest.fixture(name="client")
def fixture_client(
    engine: Any,
    test_account: EmailAccount,
) -> Generator[TestClient, None, None]:
    """Create a TestClient with in-memory DB and mocked external services."""
    import lnemail.api.endpoints as ep

    def override_get_db() -> Generator[Session, None, None]:
        with Session(engine) as session:
            yield session

    _app.dependency_overrides[get_db] = override_get_db

    # Ensure the mock LND service is in place for each test
    ep.lnd_service = _mock_lnd_instance
    # Reset call counts between tests
    _mock_lnd_instance.reset_mock()
    _mock_lnd_instance.create_invoice.return_value = {
        "payment_hash": "fakehash_abc123",
        "payment_request": "lnbc1000n1fake_invoice_request",
    }

    mock_queue = MagicMock()

    with (
        patch.object(ep, "queue", mock_queue),
        patch("lnemail.services.tasks.schedule_regular_tasks"),
    ):
        yield TestClient(_app)

    _app.dependency_overrides.clear()


@pytest.fixture()
def auth_headers(test_account: EmailAccount) -> dict[str, str]:
    """Return Authorization headers for the test account."""
    return {"Authorization": f"Bearer {test_account.access_token}"}


@pytest.fixture()
def sample_attachment() -> dict[str, str]:
    """Return a sample small attachment dict for use in requests."""
    content = base64.b64encode(b"Hello, this is a test file.").decode()
    return {
        "filename": "test.txt",
        "content_type": "text/plain",
        "content": content,
    }


@pytest.fixture()
def sample_png_attachment() -> dict[str, str]:
    """Return a sample PNG-like attachment dict."""
    # Minimal PNG header bytes for a realistic test
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    content = base64.b64encode(png_bytes).decode()
    return {
        "filename": "image.png",
        "content_type": "image/png",
        "content": content,
    }
