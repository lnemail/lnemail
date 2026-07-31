/** Build standards-based external wallet links for BOLT11 invoices. */

const BOLT11_RE =
  /^ln(?:bc|tb|tbs|bcrt)(?:[1-9][0-9]*(?:[mun]|0p)?)?1[02-9ac-hj-np-z]+$/i;

/**
 * Detect Android without an asynchronous platform lookup. Wallet links must
 * be ready before the trusted user click that launches an external app.
 *
 * @param {string} userAgent Browser user-agent string.
 * @returns {boolean} True for Android browsers.
 */
export function isAndroidUserAgent(userAgent) {
  return /\bAndroid\b/i.test(userAgent ?? "");
}

/** @param {string} invoice BOLT11 payment request. */
function validateInvoice(invoice) {
  const singleCase =
    typeof invoice === "string" &&
    (invoice === invoice.toLowerCase() || invoice === invoice.toUpperCase());
  if (!singleCase || !BOLT11_RE.test(invoice)) {
    throw new Error("Invalid BOLT11 invoice");
  }
}

/**
 * Build a BIP 321 wallet URI, wrapped as an Android intent when needed.
 *
 * @param {string} invoice BOLT11 payment request.
 * @param {{android?: boolean}} [options] Target platform.
 * @returns {string} URI suitable for a user-clicked anchor.
 */
export function walletUri(invoice, { android = false } = {}) {
  validateInvoice(invoice);
  const payment = `?lightning=${encodeURIComponent(invoice)}`;
  return android
    ? `intent:${payment}#Intent;scheme=bitcoin;end`
    : `bitcoin:${payment}`;
}
