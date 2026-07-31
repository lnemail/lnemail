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
  auto-connects). Active accounts show their unread email count plus an
  inline preview of the latest unread subjects (click-through to the
  inbox), the toolbar icon carries a badge (orange for accounts needing
  attention, blue for total unread emails), and the popup refreshes
  itself whenever anything changes (for example a pending payment
  settling or new mail arriving). Opening the extension, using autofill,
  or creating an account allows automatic checks for five minutes.
  Continuous 15-minute background server checks are available as an
  explicit opt-in.
- **Payments**: invoices can be paid with QR, copy, a BIP 321 system-wallet
  link, or a configured Nostr Wallet Connect (NWC) connection. On Android, the
  system-wallet action asks the browser to open an installed wallet app (with a
  chooser when applicable).
  Spending limits belong in the wallet that issues
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
bun run lint:firefox  # checks dist/firefox with Mozilla's extension linter
bun test          # unit tests for the pure logic
```

(`bun run package` needs the `zip` command.)

## Install

### Chrome / Chromium

Google Chrome does not permit normal off-store installs on Windows or
macOS. The store-free desktop installation uses an unpacked release:

1. Open the [LNemail GitHub Releases](https://github.com/lnemail/lnemail/releases)
   page and download `lnemail-extension-chrome-<version>.zip` from the latest
   extension release.
2. Extract it into a permanent folder, for example
   `~/Applications/lnemail-extension`. Do not load the zip itself.
3. Open `chrome://extensions` (or the equivalent extension page in Brave,
   Edge, or another Chromium browser) and enable Developer mode.
4. Click "Load unpacked" and select the extracted folder containing
   `manifest.json`.

Updates are manual. Download the newer Chrome zip, replace the contents of the
same permanent folder, then click "Reload" for LNemail on the extensions page.
Keeping the same folder path preserves the unpacked extension identity and its
locally stored accounts. The browser may continue to display a Developer mode
warning. Chromium browsers on Android generally do not support desktop
extensions.

For a source build, run `bun run build`, open the extensions page, and load
`extension/dist/chrome` instead.

### Firefox

Install the signed extension from
[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/lnemail/).
Firefox 142 or newer is required. AMO handles updates automatically.

For a temporary development install (removed when Firefox restarts):

1. `bun run build`
2. Open `about:debugging#/runtime/this-firefox`
3. "Load Temporary Add-on", select
   `extension/dist/firefox/manifest.json`

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
- **Privacy**: periodic background server checks are off by default.
  Opening the extension or using autofill starts a five-minute polling
  window for unread mail and pending payments. Enable background server
  checks to keep the unread badge, payment confirmation, and renewal
  monitoring active outside those five-minute windows.
- **Backup**: export or import the account list (email + access token +
  metadata) as JSON.
- **Import account**: add one existing account from the popup by entering its
  access token. The configured LNemail server validates the token before the
  account is stored.

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
    badge.js           toolbar badge policy (pure)
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
