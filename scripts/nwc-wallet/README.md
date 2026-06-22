# NWC payment provider (dev stack)

The dev stack runs lnemail with **two** Lightning payment providers: the
self-hosted LND node and a Nostr Wallet Connect (NIP-47) wallet, with LND
as the fallback (`PAYMENT_BACKEND=multi`). This exercises the
multi-provider path out of the box.

This directory holds the local NWC side of that setup:

- **`wallet.py`** - a small NIP-47 *wallet service* backed by the regtest
  merchant LND. It answers `make_invoice` / `lookup_invoice` by creating
  and checking real invoices on that node, and writes the client-facing
  `nostr+walletconnect://` URI to `/shared/nwc.uri` for lnemail to read.
- **`relay-config.toml`** - config for the ephemeral `nostr-rs-relay`
  that shuttles the NIP-47 messages.

Both run as the `relay` and `nwc-wallet` services in
`docker-compose.yaml`. The keys in the compose file are throwaway regtest
keys (not secrets).

## How payments flow

1. lnemail's `MultiProviderBackend` picks a provider (NWC or LND) and
   asks it to create an invoice; if one errors it falls back to the next.
2. An NWC `make_invoice` is fulfilled by the wallet on the merchant LND,
   so the resulting invoice lives on the same node as the LND backend.
3. Invoices are paid from the router LND (regtest), and settlement is
   confirmed via either provider.

## Privacy

NWC wallets are third parties, so lnemail treats them as **untrusted**:
they only ever receive a generic invoice memo, never the email address,
access token or recipient (see `src/lnemail/services/payments/base.py`).

## Note

`wallet.py` is a dev/test harness implementing just enough of NIP-47 for
lnemail; it is not a production wallet.
