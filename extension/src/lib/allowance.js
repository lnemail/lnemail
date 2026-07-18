/**
 * Automatic payment gating and spend bookkeeping.
 *
 * Spending limits deliberately live in the NWC wallet (the connection
 * issuer sets a budget there), not in the extension: a compromised
 * browser profile could rewrite any extension-side limit, so only the
 * wallet-side budget is real. The extension only checks that auto-pay
 * is enabled, a wallet is configured, and the invoice amount matches
 * what the API quoted. The spend history is informational.
 *
 * History entries: `{ at: epochMs, sats: number, kind: string }`.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Total sats spent in the rolling 30-day window ending at `now`.
 *
 * @param {Array<{at: number, sats: number}>} history Spend history.
 * @param {number} now Epoch milliseconds.
 * @returns {number} Total sats spent in the window.
 */
export function monthlySpent(history, now) {
  const cutoff = now - THIRTY_DAYS_MS;
  return (history ?? [])
    .filter((entry) => entry.at > cutoff)
    .reduce((total, entry) => total + entry.sats, 0);
}

/**
 * Decide whether an automatic payment of `amountSats` may be attempted.
 *
 * @param {{autoPayEnabled: boolean, nwcUri: string}} settings Settings.
 * @param {number | null} amountSats Invoice amount in sats.
 * @param {number | null} [expectedSats] Price quoted by the API.
 * @returns {{allowed: boolean, reason: string | null}}
 */
export function canAutoPay(settings, amountSats, expectedSats = null) {
  if (!settings?.autoPayEnabled) {
    return { allowed: false, reason: "Automatic payments are disabled" };
  }
  if (!settings.nwcUri) {
    return { allowed: false, reason: "No NWC wallet configured" };
  }
  if (amountSats === null || amountSats === undefined) {
    return { allowed: false, reason: "Invoice has no fixed amount" };
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    return { allowed: false, reason: "Invalid invoice amount" };
  }
  if (expectedSats && amountSats > expectedSats) {
    return {
      allowed: false,
      reason:
        `Invoice amount ${amountSats} sats exceeds the quoted price ` +
        `${expectedSats} sats`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Append a spend entry, pruning entries older than the retention window.
 *
 * @param {Array<{at: number, sats: number, kind: string}>} history
 * @param {{at: number, sats: number, kind: string}} entry
 * @returns {Array<{at: number, sats: number, kind: string}>} New history.
 */
export function recordSpend(history, entry) {
  const cutoff = entry.at - HISTORY_RETENTION_MS;
  return [...(history ?? []).filter((item) => item.at > cutoff), entry];
}
