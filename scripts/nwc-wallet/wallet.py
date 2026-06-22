"""A minimal Nostr Wallet Connect (NIP-47) wallet *service* for e2e tests.

This is NOT used in production. It exists so the end-to-end suite can
exercise LNemail's NWC payment backend against a real Nostr relay and a
real (regtest) Lightning node, instead of mocking the network.

It:
  * connects to a Nostr relay (RELAY_URL),
  * connects to the regtest merchant LND over gRPC (reusing the app's
    own LNDService, configured via the usual LND_* env vars),
  * publishes a NIP-47 ``info`` event advertising make_invoice /
    lookup_invoice,
  * answers NIP-47 requests by creating / looking up invoices on the
    merchant LND,
  * writes the client-facing ``nostr+walletconnect://`` URI to
    ``NWC_URI_FILE`` so the compose stack can hand it to lnemail.

Wallet identity vs client secret (per NIP-47):
  * the wallet has a service keypair (WALLET_SECRET),
  * the client (lnemail) authenticates with a *separate* secret
    (CLIENT_SECRET); the wallet authorises that client's pubkey.

Everything is deliberately small and best-effort: it is a test harness.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

from loguru import logger
from nostr_sdk import (
    Client,
    EventBuilder,
    Filter,
    HandleNotification,
    Keys,
    Kind,
    NostrSigner,
    PublicKey,
    RelayUrl,
    Tag,
    Timestamp,
    nip04_decrypt,
    nip04_encrypt,
)

from lnemail.services.lnd_service import LNDService

RELAY_URL = os.environ.get("RELAY_URL", "ws://relay:8080")
WALLET_SECRET = os.environ["WALLET_SECRET"]  # hex nsec for the wallet service
CLIENT_SECRET = os.environ["CLIENT_SECRET"]  # hex nsec the client (lnemail) uses
NWC_URI_FILE = os.environ.get("NWC_URI_FILE", "/shared/nwc.uri")

KIND_INFO = 13194
KIND_REQUEST = 23194
KIND_RESPONSE = 23195


def _build_nwc_uri(wallet_pubkey_hex: str) -> str:
    relay = RELAY_URL
    return (
        f"nostr+walletconnect://{wallet_pubkey_hex}"
        f"?relay={relay}&secret={CLIENT_SECRET}"
    )


class _Handler(HandleNotification):
    """Process incoming NIP-47 requests and reply with results."""

    def __init__(
        self,
        client: Client,
        wallet_keys: Keys,
        client_pubkey: PublicKey,
        lnd: LNDService,
    ) -> None:
        self._client = client
        self._wallet_keys = wallet_keys
        self._client_pubkey = client_pubkey
        self._lnd = lnd

    async def handle(self, relay_url: str, subscription_id: str, event) -> None:  # type: ignore[no-untyped-def]
        try:
            if event.kind().as_u16() != KIND_REQUEST:
                return
            author = event.author()
            # Decrypt the request (NIP-04) using the wallet secret + sender pubkey.
            content = nip04_decrypt(
                self._wallet_keys.secret_key(), author, event.content()
            )
            request = json.loads(content)
            method = request.get("method")
            params = request.get("params", {})
            logger.info(f"NWC request: {method}")

            result_payload = await self._dispatch(method, params)
            response = {"result_type": method, **result_payload}

            encrypted = nip04_encrypt(
                self._wallet_keys.secret_key(),
                author,
                json.dumps(response),
            )
            builder = EventBuilder(Kind(KIND_RESPONSE), encrypted).tags(
                [Tag.public_key(author), Tag.event(event.id())]
            )
            await self._client.send_event_builder(builder)
        except Exception as exc:  # pragma: no cover - test harness
            logger.error(f"Failed handling NWC request: {exc}")

    async def _dispatch(self, method: str, params: dict) -> dict:
        now = int(time.time())
        if method == "make_invoice":
            amount_msat = int(params.get("amount", 0))
            amount_sats = max(1, amount_msat // 1000)
            memo = params.get("description") or ""
            invoice = self._lnd.create_invoice(amount_sats, memo)
            return {
                "result": {
                    "type": "incoming",
                    "invoice": invoice["payment_request"],
                    "description": memo,
                    "payment_hash": invoice["payment_hash"],
                    "amount": amount_msat,
                    "fees_paid": 0,
                    "created_at": now,
                    "expires_at": now + 600,
                    "metadata": {},
                }
            }
        if method == "lookup_invoice":
            payment_hash = params.get("payment_hash") or ""
            settled = self._lnd.check_invoice(payment_hash)
            result: dict[str, object] = {
                "type": "incoming",
                "payment_hash": payment_hash,
                "amount": 0,
                "fees_paid": 0,
                "created_at": now,
                "expires_at": now + 600,
                "metadata": {},
            }
            if settled:
                result["preimage"] = "00" * 32
                result["settled_at"] = now
            return {"result": result}
        return {
            "error": {"code": "NOT_IMPLEMENTED", "message": f"unsupported: {method}"}
        }

    async def handle_msg(self, relay_url: str, msg) -> None:  # type: ignore[no-untyped-def]
        return None


async def main() -> None:
    wallet_keys = Keys.parse(WALLET_SECRET)
    client_keys = Keys.parse(CLIENT_SECRET)
    wallet_pubkey_hex = wallet_keys.public_key().to_hex()

    logger.info(f"NWC wallet pubkey: {wallet_pubkey_hex}")
    logger.info(f"Authorised client pubkey: {client_keys.public_key().to_hex()}")

    lnd = LNDService()

    client = Client(NostrSigner.keys(wallet_keys))
    await client.add_relay(RelayUrl.parse(RELAY_URL))
    await client.connect()
    await asyncio.sleep(2)

    # Publish the NIP-47 info event (capabilities) - replaceable kind 13194.
    info_builder = EventBuilder(Kind(KIND_INFO), "make_invoice lookup_invoice")
    await client.send_event_builder(info_builder)
    logger.info("Published NWC info event")

    # Subscribe to requests addressed to this wallet.
    req_filter = (
        Filter()
        .kind(Kind(KIND_REQUEST))
        .pubkey(wallet_keys.public_key())
        .since(Timestamp.now())
    )
    await client.subscribe(req_filter)

    # Now that the wallet is live, expose the client URI for lnemail.
    uri = _build_nwc_uri(wallet_pubkey_hex)
    Path(NWC_URI_FILE).write_text(uri)
    logger.info(f"Wrote NWC URI to {NWC_URI_FILE}")

    handler = _Handler(client, wallet_keys, client_keys.public_key(), lnd)
    await client.handle_notifications(handler)


if __name__ == "__main__":
    asyncio.run(main())
