/**
 * Spending allowance accounting for automatic NWC payments.
 *
 * Pure functions over a spend-history array so the rules are easy to
 * test. History entries: `{ at: epochMs, sats: number, kind: string }`.
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
 * Decide whether an automatic payment of `amountSats` is allowed.
 *
 * @param {{autoPayEnabled: boolean, nwcUri: string,
 *          maxSatsPerPayment: number, monthlyBudgetSats: number}} settings
 * @param {Array<{at: number, sats: number}>} history Spend history.
 * @param {number | null} amountSats Invoice amount in sats.
 * @param {number} now Epoch milliseconds.
 * @returns {{allowed: boolean, reason: string | null}}
 */
export function evaluateSpend(settings, history, amountSats, now) {
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
  const maxPerPayment = settings.maxSatsPerPayment ?? 0;
  if (maxPerPayment <= 0 || amountSats > maxPerPayment) {
    return {
      allowed: false,
      reason: `Amount ${amountSats} sats exceeds the per-payment limit of ${maxPerPayment} sats`,
    };
  }
  const budget = settings.monthlyBudgetSats ?? 0;
  const spent = monthlySpent(history, now);
  if (budget <= 0 || spent + amountSats > budget) {
    return {
      allowed: false,
      reason: `Payment would exceed the 30-day budget (${spent}/${budget} sats used)`,
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
