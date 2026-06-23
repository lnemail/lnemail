"""Nostr Wallet Connect (NWC / NIP-47) payment backend.

This talks NIP-47 to a wallet over a Nostr relay *directly* (building and
parsing the request/response events ourselves) instead of using
``nostr-sdk``'s typed ``Nwc`` client. The typed client deserializes
``lookup_invoice`` responses strictly and requires fields that real
wallets omit (e.g. coinos does not send ``amount``), which made settled
invoices undetectable. Parsing the JSON ourselves tolerates those
quirks; we only need ``invoice``/``payment_hash`` from ``make_invoice``
and the settled flag from ``lookup_invoice``.

NWC wallets are third-party providers, so this backend is **untrusted**:
the dispatcher only ever hands it a generic memo, never an email
address, access token or recipient.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar

from loguru import logger

from .base import InvoiceResult, PaymentBackend

try:  # pragma: no cover - import guard exercised only when dep is missing
    from nostr_sdk import (
        Client,
        EventBuilder,
        Filter,
        HandleNotification,
        Keys,
        Kind,
        NostrSigner,
        NostrWalletConnectUri,
        Tag,
        Timestamp,
        nip04_decrypt,
        nip04_encrypt,
    )

    _NOSTR_SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    _NOSTR_SDK_AVAILABLE = False


# NWC invoice expiry, kept in sync with the LND backend's 600s default so
# downstream polling budgets (see services.tasks) stay consistent.
NWC_INVOICE_EXPIRY = 600

# NIP-47 event kinds.
_KIND_REQUEST = 23194
_KIND_RESPONSE = 23195

# How long to wait for a wallet's response before giving up (per call).
_RESPONSE_TIMEOUT_S = 12
# How long to let relays connect before sending.
_CONNECT_GRACE_S = 1.5


_T = TypeVar("_T")


def _run(coro: Coroutine[Any, Any, _T]) -> _T:
    """Run an async coroutine to completion from any context.

    The Nostr client is async, but this backend is called from both
    synchronous code (the RQ worker) and asynchronous code (the FastAPI
    request handlers, which already run inside an event loop).
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


class NWCError(RuntimeError):
    """A NIP-47 request failed (transport, timeout, or wallet error)."""


if _NOSTR_SDK_AVAILABLE:

    class _ResponseHandler(HandleNotification):
        """Capture the NIP-47 response event content for one request.

        The per-call subscription is filtered to ``kind:23195`` events from
        the wallet addressed to us, so the first match is our response. When
        the request id is known we additionally require the response's
        ``#e`` tag to reference it.
        """

        def __init__(self, future: "asyncio.Future[str]") -> None:
            self._future = future
            self.request_id: str | None = None

        async def handle(
            self, relay_url: Any, subscription_id: str, event: Any
        ) -> None:
            if self._future.done():
                return
            try:
                if event.kind().as_u16() != _KIND_RESPONSE:
                    return
                if self.request_id is not None:
                    referenced = {e.to_hex() for e in event.tags().event_ids()}
                    if self.request_id not in referenced:
                        return
                self._future.set_result(event.content())
            except Exception:  # pragma: no cover - defensive
                pass

        async def handle_msg(self, relay_url: Any, msg: Any) -> None:
            return None


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
        # Parsing validates the URI up front and fails fast on bad config.
        self._uri = NostrWalletConnectUri.parse(connection_uri)
        self._wallet_pubkey = self._uri.public_key()
        self._client_keys = Keys(self._uri.secret())
        self._relays = self._uri.relays()
        # Derive a stable, non-secret name (the wallet's relay host) for logs.
        self.name = name or self._derive_name()

    def _derive_name(self) -> str:
        """Best-effort, secret-free identifier for logs."""
        try:
            if self._relays:
                return f"nwc:{self._relays[0]}"
        except Exception:  # pragma: no cover - defensive only
            pass
        return "nwc"

    async def _nip47_call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Send a NIP-47 request and return the wallet's raw JSON response.

        Builds the encrypted ``kind:23194`` request, waits for the matching
        ``kind:23195`` response (correlated by the request event id), and
        decrypts + JSON-parses it ourselves so wallet-specific field quirks
        do not break us.

        We subscribe and start handling notifications *before* sending so a
        response that arrives immediately is not missed (a one-shot relay
        query can race the reply).
        """
        client = Client(NostrSigner.keys(self._client_keys))
        loop = asyncio.get_event_loop()
        result_future: asyncio.Future[str] = loop.create_future()
        notif_task: asyncio.Task[None] | None = None
        try:
            for relay in self._relays:
                await client.add_relay(relay)
            await client.connect()
            await asyncio.sleep(_CONNECT_GRACE_S)

            # Subscribe for responses from the wallet addressed to us before
            # sending, so an immediate reply can't be missed.
            response_filter = (
                Filter()
                .kind(Kind(_KIND_RESPONSE))
                .author(self._wallet_pubkey)
                .pubkey(self._client_keys.public_key())
                .since(Timestamp.now())
            )
            await client.subscribe(response_filter)

            handler = _ResponseHandler(result_future)
            notif_task = asyncio.create_task(client.handle_notifications(handler))

            payload = json.dumps({"method": method, "params": params})
            content = nip04_encrypt(
                self._client_keys.secret_key(), self._wallet_pubkey, payload
            )
            builder = EventBuilder(Kind(_KIND_REQUEST), content).tags(
                [Tag.public_key(self._wallet_pubkey)]
            )
            sent = await client.send_event_builder(builder)
            handler.request_id = sent.id.to_hex()

            try:
                raw = await asyncio.wait_for(result_future, timeout=_RESPONSE_TIMEOUT_S)
            except asyncio.TimeoutError:
                raise NWCError("no response from wallet (timeout)")

            decrypted = nip04_decrypt(
                self._client_keys.secret_key(), self._wallet_pubkey, raw
            )
            data: dict[str, Any] = json.loads(decrypted)
            if data.get("error"):
                err = data["error"]
                raise NWCError(f"{err.get('code', 'ERROR')}: {err.get('message', '')}")
            return data
        finally:
            if notif_task is not None:
                notif_task.cancel()
            try:
                await client.shutdown()
            except Exception:  # pragma: no cover - best-effort cleanup
                pass

    def create_invoice(
        self, amount_sats: int, memo: str, exclude_provider: str | None = None
    ) -> InvoiceResult:
        async def _make() -> InvoiceResult:
            data = await self._nip47_call(
                "make_invoice",
                {
                    "amount": amount_sats * 1000,  # NWC amounts are millisats
                    "description": memo,
                    "expiry": NWC_INVOICE_EXPIRY,
                },
            )
            result = data.get("result") or {}
            invoice = result.get("invoice")
            payment_hash = result.get("payment_hash") or ""
            if not invoice:
                raise NWCError("make_invoice response missing 'invoice'")
            return {
                "payment_hash": payment_hash,
                "payment_request": invoice,
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
            data = await self._nip47_call(
                "lookup_invoice", {"payment_hash": payment_hash}
            )
            result = data.get("result") or {}
            # Tolerant settled detection: prefer settled_at, then a settled
            # state/status string. We never depend on fields wallets may omit
            # (e.g. coinos omits 'amount').
            if result.get("settled_at"):
                return True
            state = str(result.get("state") or result.get("status") or "").lower()
            return state == "settled"

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
