/**
 * Minimal BOLT11 helpers.
 *
 * Only the human-readable part (amount) is parsed; this is enough to
 * sanity-check an invoice amount against the expected price before an
 * automatic NWC payment. Signature validation is left to the paying
 * wallet.
 */

const HRP_RE = /^ln(bc|tb|tbs|bcrt)([0-9]+)?([munp])?1/;

// Multiplier -> divisor applied to the BTC amount.
const DIVISORS = { m: 1e3, u: 1e6, n: 1e9, p: 1e12 };

/**
 * Parse the amount encoded in a BOLT11 payment request.
 *
 * @param {string} paymentRequest BOLT11 invoice (any case).
 * @returns {{ sats: number | null, msats: number | null }} The invoice
 *   amount, or nulls for an "any amount" invoice.
 * @throws {Error} If the string is not a BOLT11 payment request.
 */
export function invoiceAmount(paymentRequest) {
  if (typeof paymentRequest !== "string") {
    throw new Error("Invalid payment request");
  }
  const normalized = paymentRequest.trim().toLowerCase();
  const match = HRP_RE.exec(normalized);
  if (!match) {
    throw new Error("Not a BOLT11 payment request");
  }
  const [, , digits, multiplier] = match;
  if (digits === undefined) {
    if (multiplier !== undefined) {
      throw new Error("Invalid BOLT11 amount");
    }
    return { sats: null, msats: null };
  }
  const amount = Number(digits);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid BOLT11 amount");
  }
  const divisor = multiplier ? DIVISORS[multiplier] : 1;
  const msats = (amount * 1e11) / divisor;
  if (!Number.isInteger(msats)) {
    throw new Error("Invalid BOLT11 amount (sub-millisatoshi)");
  }
  return { sats: msats / 1000, msats };
}

/**
 * Convenience wrapper returning the amount in whole sats.
 *
 * @param {string} paymentRequest BOLT11 invoice.
 * @returns {number | null} Amount in sats (may be fractional for
 *   sub-sat invoices) or null for "any amount" invoices.
 */
export function invoiceAmountSats(paymentRequest) {
  return invoiceAmount(paymentRequest).sats;
}
