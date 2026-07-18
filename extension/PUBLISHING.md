# Publishing the LNemail extension

Reference material for submitting to the Chrome Web Store (CWS) and
addons.mozilla.org (AMO): release process, listing copy, permission
justifications, and the privacy policy text both stores require.

## Release process

1. Bump the version in `package.json`, `src/manifest.chrome.json`, and
   `src/manifest.firefox.json` (keep them identical).
2. Verify locally: `bun test && bun run package`.
3. Commit, then tag `ext-vX.Y.Z` and push the tag. The
   `extension-release` workflow builds, tests, packages, and attaches
   both zips to a GitHub release.
4. Upload `lnemail-extension-chrome-X.Y.Z.zip` to the
   [CWS developer dashboard](https://chrome.google.com/webstore/devconsole)
   and `lnemail-extension-firefox-X.Y.Z.zip` to the
   [AMO developer hub](https://addons.mozilla.org/developers/).
   For AMO, source code is not required (the zips contain readable,
   unminified bundles), but if requested point reviewers at this
   repository and `extension/build.js`.

## Store listing copy

- **Name**: LNemail
- **Summary** (short description): Anonymous Lightning-paid email
  addresses: create, autofill, and manage LNemail inboxes without
  accounts, phone numbers, or personal data.
- **Category**: Productivity (CWS) / Privacy & Security (AMO)
- **Description**:

  > LNemail gives you real, persistent email addresses paid with
  > Bitcoin Lightning instead of your identity. This extension makes
  > them effortless to use day to day:
  >
  > - Click the LNemail button on any signup form to fill in a fresh
  >   address instantly, or reuse one you already created for that
  >   site. Your password manager still saves the site credentials.
  > - See all your addresses in the popup, together with the sites
  >   each one was used on, unread counts, and a preview of the
  >   latest unread messages. One click opens the inbox, already
  >   logged in.
  > - Pay invoices by scanning a QR code, copying the invoice, or
  >   automatically through your own wallet via Nostr Wallet Connect
  >   (NWC). Spending limits stay in your wallet, where they belong.
  > - Renewals are handled for you: automatic payment through NWC, or
  >   a notification when manual payment is needed.
  >
  > Works with the public lnemail.net service or your own self-hosted
  > instance. No tracking, no analytics, no third-party services
  > beyond the LNemail API you configure and, optionally, your own
  > NWC wallet relay.

## Permission justifications (for review forms)

- `storage`: persists account records (email address + access token),
  settings, and unread counts locally.
- `alarms`: periodic checks for invoice settlement, account expiry
  (renewals), and unread counts.
- `notifications`: informs the user when an account is activated,
  renewed, expiring, or when a wallet payment fails.
- `contextMenus`: "Fill with a new LNemail address" on editable
  fields.
- Host permission `<all_urls>`: required for two features, both
  user-triggered: (1) the optional autofill button on email fields of
  arbitrary signup pages, and (2) API access to the LNemail server the
  user configures (self-hosted instances can live on any origin). The
  extension injects no ads, collects no browsing data, and its content
  script only reads/writes the email input the user interacts with.
- `web_accessible_resources` (icons): the inline button shows the
  extension icon inside pages.

## Privacy policy (paste into the store forms)

> The LNemail extension does not collect, transmit, or sell any
> personal data or telemetry. All data it handles (email addresses,
> access tokens, settings, unread counts, and the list of sites where
> an address was used) is stored locally in the browser profile via
> the WebExtension storage API and never leaves the device except as
> part of the following user-initiated network requests:
>
> - Calls to the LNemail API server configured by the user (default
>   lnemail.net) to create accounts, list emails, and manage
>   renewals, authenticated with the user's own access tokens.
> - Optional Nostr Wallet Connect messages to the relay specified in
>   the user's own wallet connection string, used exclusively to pay
>   Lightning invoices the user requested (encrypted end-to-end to
>   the wallet, NIP-04).
>
> No analytics, tracking, fingerprinting, or third-party services are
> used. Uninstalling the extension removes all locally stored data.

AMO data-collection disclosure: "None" (declared via
`browser_specific_settings.gecko.data_collection_permissions.required:
["none"]` in the manifest).

## Review-friendliness notes

- Bundles are unminified (`minify: false` in `build.js`) so reviewers
  can read the shipped code directly.
- The only remote endpoints are the user-configured API base and the
  user-provided NWC relay; there are no hardcoded third-party hosts.
- No remote code is loaded or evaluated (MV3 compliant, no `eval`).
