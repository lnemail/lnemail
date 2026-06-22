"""Nostr Wallet Connect (NWC / NIP-47) payment backend.

Wraps a single NWC wallet connection using the official ``nostr-sdk``
(rust-nostr) ``Nwc`` client. The client API is async (Tokio-backed); the
rest of LNemail's payment code is synchronous (the RQ worker is sync and
the FastAPI endpoints call the payment service synchronously), so each
call is bridged with ``asyncio.run`` on a private event loop.

NWC wallets are third-party providers, so this backend is **untrusted**:
the dispatcher only ever hands it a generic memo, never an email
address, access token or recipient.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar

from loguru import logger

from .base import InvoiceResult, PaymentBackend

try:  # pragma: no cover - import guard exercised only when dep is missing
    from nostr_sdk import (
        LookupInvoiceRequest,
        MakeInvoiceRequest,
        NostrWalletConnectUri,
        Nwc,
        TransactionState,
    )

    _NOSTR_SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    _NOSTR_SDK_AVAILABLE = False


# NWC invoice expiry, kept in sync with the LND backend's 600s default so
# downstream polling budgets (see services.tasks) stay consistent.
NWC_INVOICE_EXPIRY = 600


_T = TypeVar("_T")


def _run(coro: Coroutine[Any, Any, _T]) -> _T:
    """Run an async coroutine to completion from any context.

    The NWC client (nostr-sdk) is async, but this backend is called from
    both synchronous code (the RQ worker) and asynchronous code (the
    FastAPI request handlers, which already run inside an event loop).
    ``asyncio.run`` cannot be used when a loop is already running, so we
    always execute the coroutine on a fresh event loop in a dedicated
    thread. This works uniformly from either context.
    """
    value: list[_T] = []
    error: list[BaseException] = []

    def _worker() -> None:
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            value.append(loop.run_until_complete(coro))
        except BaseException as exc:  # noqa: BLE001 - re-raised below
            error.append(exc)
        finally:
            loop.close()

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
    thread.join()

    if error:
        raise error[0]
    return value[0]


class NWCBackend(PaymentBackend):
    """A single NWC wallet connection used as an alternative provider."""

    trusted = False

    def __init__(self, connection_uri: str, *, name: str | None = None) -> None:
        if not _NOSTR_SDK_AVAILABLE:
            raise RuntimeError(
                "nostr-sdk is required for NWC payment providers; install it "
                "or unset the NWC_* settings."
            )
        self._uri_str = connection_uri
        # Derive a stable, non-secret name (the wallet's relay host) for logs.
        self.name = name or self._derive_name(connection_uri)
        # Parsing validates the URI up front and fails fast on bad config.
        self._uri = NostrWalletConnectUri.parse(connection_uri)

    @staticmethod
    def _derive_name(connection_uri: str) -> str:
        """Best-effort, secret-free identifier for logs."""
        try:
            uri = NostrWalletConnectUri.parse(connection_uri)
            relays = uri.relays()
            if relays:
                return f"nwc:{relays[0]}"
        except Exception:  # pragma: no cover - defensive only
            pass
        return "nwc"

    def _client(self) -> "Nwc":
        # A fresh client per call keeps each operation self-contained and
        # avoids sharing a relay connection across threads/loops.
        return Nwc(self._uri)

    def create_invoice(
        self, amount_sats: int, memo: str, exclude_provider: str | None = None
    ) -> InvoiceResult:
        async def _make() -> InvoiceResult:
            nwc = self._client()
            request = MakeInvoiceRequest(
                amount=amount_sats * 1000,  # NWC amounts are in millisats
                description=memo,
                description_hash=None,
                expiry=NWC_INVOICE_EXPIRY,
            )
            response = await nwc.make_invoice(request)
            payment_hash = response.payment_hash or ""
            return {
                "payment_hash": payment_hash,
                "payment_request": response.invoice,
                "provider": self.name,
            }

        result = _run(_make())
        logger.info(
            f"NWC invoice created via {self.name} "
            f"(amount={amount_sats} sats, hash={result['payment_hash'][:16]}...)"
        )
        return result

    def check_invoice(self, payment_hash: str) -> bool:
        async def _lookup() -> bool:
            nwc = self._client()
            request = LookupInvoiceRequest(payment_hash=payment_hash, invoice=None)
            response = await nwc.lookup_invoice(request)
            # Prefer the explicit state; fall back to settled_at for wallets
            # that omit state.
            if response.state is not None:
                return bool(response.state == TransactionState.SETTLED)
            return response.settled_at is not None

        try:
            return _run(_lookup())
        except Exception as exc:
            # Match LNDService.check_invoice: never raise on a lookup, just
            # report "not settled" so polling can retry / fall back.
            logger.warning(
                f"NWC lookup_invoice failed via {self.name} for "
                f"{payment_hash[:16]}...: {exc}"
            )
            return False
