# LNemail browser extension

Cross-browser extension (Chrome and Firefox, Manifest V3) that makes
LNemail practical for day-to-day use:

- **Autofill on signups**: email fields get a small LNemail button
  listing every saved address (the ones already used on that site
  first) plus a brand-new address, which is filled instantly, before
  its invoice even settles (also available from the right-click context
  menu). Saving the site credentials stays with your password manager.
- **Account list with metadata**: every account is stored with all the
  sites it was used on, so you can filter by site, tell addresses
  apart, and jump straight into the right inbox with one click (the
  extension hands the access token to the inbox page, which
  auto-connects). Active accounts show their unread email count, and
  the popup refreshes itself whenever anything changes (for example a
  pending payment settling).
- **Payments**: invoices can be paid manually (QR code, copy, or
  `lightning:` link) or automatically through a Nostr Wallet Connect
  (NWC) connection. Spending limits belong in the wallet that issues
  the connection (a wallet-side budget stays effective even if the
  browser profile is compromised); the extension only refuses invoices
  that do not match the price quoted by the API. "Can't pay this
  invoice? Get a new one" re-issuing is supported when the server has
  several providers.
- **Renewals**: a background check watches account expiry. With NWC
  auto-pay enabled it renews accounts automatically; otherwise it shows
  a notification that opens the payment view.

## Build

```bash
cd extension
bun install
bun run build     # writes dist/chrome and dist/firefox
bun run package   # same, plus dist/lnemail-extension-<browser>-<version>.zip
bun test          # unit tests for the pure logic
```

(`bun run package` needs the `zip` command.)

## Install

### Chrome / Chromium

`chrome://extensions`, enable Developer mode, "Load unpacked", select
`extension/dist/chrome`.

### Firefox

For development (goes away when Firefox restarts):

1. `bun run build`
2. Open `about:debugging#/runtime/this-firefox`
3. "Load Temporary Add-on", select
   `extension/dist/firefox/manifest.json`

For a permanent install, regular Firefox only accepts signed add-ons,
so pick one of:

- **Firefox Developer Edition, Nightly, or ESR**: set
  `xpinstall.signatures.required` to `false` in `about:config`, run
  `bun run package`, then open `about:addons`, gear menu, "Install
  Add-on From File", and pick
  `dist/lnemail-extension-firefox-<version>.zip`.
- **Self-distribution signing**: upload the same zip to
  [addons.mozilla.org](https://addons.mozilla.org/developers/) as
  "unlisted" (or use `web-ext sign`); AMO returns a signed `.xpi` that
  installs on any Firefox.

After installing on Firefox, open the extension options or popup and
click "Grant site access" (Firefox treats MV3 host permissions as
optional, and the extension needs them for autofill and API calls).

## Configuration

Open the extension options page:

- **API base URL**: defaults to `https://lnemail.net`; point it at your
  own instance if you self-host.
- **NWC connection string**: create a dedicated connection in your
  wallet (Alby Hub, Coinos, Primal, and others) **with a small budget
  set in the wallet** and paste the `nostr+walletconnect://` URI. Use
  "Test connection" to verify it. The wallet-side budget is the real
  spending limit; the extension does not implement its own.
- **Renewals**: choose how many days before expiry renewals should
  start, and whether they should be paid automatically.
- **Backup**: export or import the account list (email + access token +
  metadata) as JSON.

On Firefox, host permissions are optional by default: use the "Grant
site access" button (shown in the popup and options page) to enable
autofill and API access.

## Security notes

- Access tokens and the NWC string are stored unencrypted in
  `browser.storage.local`, which is the same trust level as a password
  manager without a master password. Anyone with access to the browser
  profile can read them. Export backups to a safe place and consider
  saving tokens in your password manager as well.
- The NWC connection should be a dedicated one with a small budget set
  in the issuing wallet, so a compromise of the browser profile cannot
  drain more than that budget. This is why the extension deliberately
  has no spending-limit settings of its own: an attacker with access to
  the profile could rewrite them, while the wallet-side budget holds.
- The inbox token handoff is one-shot, tab-scoped, origin-checked, and
  expires after two minutes.

## Architecture

```
src/
  background.js        message router, payments, polling, renewals
  lib/
    api.js             LNemail REST client
    nwc.js             minimal NIP-47 client (nostr-tools)
    allowance.js       auto-pay gating + spend bookkeeping (pure)
    bolt11.js          invoice amount parsing (pure)
    store.js           settings/accounts state helpers (pure)
    browser.js         chrome/browser API shim
  popup/               account list, payment view (QR), renewal starter
  options/             settings, NWC test, backup import/export
  content/
    autofill.js        email-field button and fill menu (shadow DOM)
    inbox-bridge.js    one-shot token handoff on /inbox pages
  manifest.chrome.json service worker background
  manifest.firefox.json event-page background + gecko settings
```

The build (`build.js`) bundles each entry point into a flat IIFE script
per browser because MV3 content scripts and the Firefox background page
cannot load ES modules.
