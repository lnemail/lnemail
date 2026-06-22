# NWC payment-backend e2e

This directory lets the end-to-end suite run against the **Nostr Wallet
Connect (NIP-47)** payment backend instead of talking to LND directly.

It adds two throwaway services to the regtest stack:

- **`relay`** - an ephemeral [`nostr-rs-relay`](https://github.com/scsibug/nostr-rs-relay)
  that shuttles NIP-47 messages.
- **`nwc-wallet`** - a tiny NIP-47 *wallet service* (`wallet.py`) backed by
  the regtest **merchant LND**. It answers `make_invoice` / `lookup_invoice`
  by creating and checking real invoices on that node, and writes the
  client-facing `nostr+walletconnect://` URI to `/shared/nwc.uri`.

`lnemail-api` / `lnemail-worker` are then reconfigured with
`PAYMENT_BACKEND=nwc` and `NWC_ONLY=true`, reading `NWC_CONNECTIONS` from
that URI. The *same* Playwright tests (signup, send/read/reply, renewal)
run unchanged - every invoice is now created and settled over NWC.

## Run it

```bash
./tests/e2e/nwc_wallet/run-nwc.sh
```

The script boots the base stack, waits for the LND<->router channel,
builds + starts the relay and wallet, switches lnemail to NWC, and runs
`pytest tests/e2e`.

## How payment flows

1. lnemail asks its NWC wallet (over the relay) to `make_invoice`.
2. The wallet creates a real BOLT11 invoice on the **merchant LND**.
3. The test pays it from the **router LND** (the existing `pay_invoice`).
4. lnemail polls `lookup_invoice` over NWC; the wallet reports the
   merchant LND invoice as settled, and the flow completes.

## Notes / caveats

- The keys in `docker-compose.e2e-nwc.yaml` are throwaway regtest keys,
  not secrets.
- `wallet.py` is a **test harness**: it implements just enough of NIP-47
  (`make_invoice`, `lookup_invoice`) to exercise lnemail. It is not a
  production wallet.
- Privacy is enforced on the lnemail side: NWC providers are "untrusted"
  and only ever receive a generic invoice memo (see
  `src/lnemail/services/payments/base.py`).
