/**
 * Extension state: settings and saved accounts.
 *
 * Pure helpers operate on plain objects; the thin load/save wrappers at
 * the bottom bind them to `browser.storage.local`. Keeping the logic
 * pure makes it unit-testable without a browser.
 */

export const DEFAULT_SETTINGS = {
  apiBase: "https://lnemail.net",
  nwcUri: "",
  autoPayEnabled: false,
  maxSatsPerPayment: 1000,
  monthlyBudgetSats: 10000,
  autoRenewEnabled: true,
  renewDaysBefore: 30,
  autofillEnabled: true,
};

export const ACCOUNT_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  EXPIRED: "expired",
};

/**
 * Build a new account record from an InvoiceResponse payload.
 *
 * @param {object} invoice InvoiceResponse from the API.
 * @param {{apiBase: string, sourceDomain?: string | null,
 *          sourceUrl?: string | null}} context Creation context.
 * @param {number} now Epoch milliseconds.
 * @returns {object} Account record.
 */
export function accountFromInvoice(invoice, context, now) {
  return {
    email: invoice.email_address,
    token: invoice.access_token,
    apiBase: context.apiBase,
    status: ACCOUNT_STATUS.PENDING,
    createdAt: now,
    expiresAt: invoice.expires_at ?? null,
    paymentHash: invoice.payment_hash,
    paymentRequest: invoice.payment_request,
    priceSats: invoice.price_sats,
    provider: invoice.provider ?? null,
    sourceDomain: context.sourceDomain ?? null,
    sourceUrl: context.sourceUrl ?? null,
    usedOn: context.sourceDomain
      ? [{ domain: context.sourceDomain, at: now }]
      : [],
    renewal: null,
    lastRenewalNotifiedAt: null,
  };
}

/**
 * Insert or replace an account (keyed by email address).
 *
 * @param {object[]} accounts Current account list.
 * @param {object} account Account to upsert.
 * @returns {object[]} New account list.
 */
export function upsertAccount(accounts, account) {
  const rest = (accounts ?? []).filter((item) => item.email !== account.email);
  return [...rest, account];
}

/**
 * Find an account by email address.
 *
 * @param {object[]} accounts Account list.
 * @param {string} email Email address.
 * @returns {object | undefined} Matching account.
 */
export function findByEmail(accounts, email) {
  return (accounts ?? []).find((item) => item.email === email);
}

/**
 * Find an account by signup payment hash.
 *
 * @param {object[]} accounts Account list.
 * @param {string} paymentHash Signup payment hash.
 * @returns {object | undefined} Matching account.
 */
export function findByPaymentHash(accounts, paymentHash) {
  return (accounts ?? []).find((item) => item.paymentHash === paymentHash);
}

/**
 * Find an account by pending renewal payment hash.
 *
 * @param {object[]} accounts Account list.
 * @param {string} paymentHash Renewal payment hash.
 * @returns {object | undefined} Matching account.
 */
export function findByRenewalHash(accounts, paymentHash) {
  return (accounts ?? []).find(
    (item) => item.renewal?.paymentHash === paymentHash,
  );
}

/**
 * Accounts previously used on a domain, most recently used first.
 *
 * @param {object[]} accounts Account list.
 * @param {string} domain Hostname to match.
 * @returns {object[]} Matching accounts.
 */
export function accountsForDomain(accounts, domain) {
  const lastUse = (account) =>
    Math.max(0, ...(account.usedOn ?? []).map((use) => use.at));
  return (accounts ?? [])
    .filter((account) =>
      (account.usedOn ?? []).some((use) => use.domain === domain),
    )
    .sort((a, b) => lastUse(b) - lastUse(a));
}

/**
 * Record that an account was used (filled) on a domain.
 *
 * @param {object} account Account record.
 * @param {string} domain Hostname where it was used.
 * @param {number} now Epoch milliseconds.
 * @returns {object} Updated account record.
 */
export function recordUsage(account, domain, now) {
  const usedOn = (account.usedOn ?? []).filter((use) => use.domain !== domain);
  return { ...account, usedOn: [...usedOn, { domain, at: now }] };
}

/**
 * Milliseconds until an account expires.
 *
 * @param {object} account Account record.
 * @param {number} now Epoch milliseconds.
 * @returns {number | null} Time to expiry, or null if unknown.
 */
export function msUntilExpiry(account, now) {
  if (!account.expiresAt) return null;
  return new Date(account.expiresAt).getTime() - now;
}

/**
 * Active accounts that expire within `days` (including already expired
 * accounts still inside the renewal grace period).
 *
 * @param {object[]} accounts Account list.
 * @param {number} now Epoch milliseconds.
 * @param {number} days Renewal window in days.
 * @returns {object[]} Accounts needing renewal attention.
 */
export function accountsNeedingRenewal(accounts, now, days) {
  const windowMs = days * 24 * 60 * 60 * 1000;
  return (accounts ?? []).filter((account) => {
    if (account.status === ACCOUNT_STATUS.PENDING) return false;
    const remaining = msUntilExpiry(account, now);
    return remaining !== null && remaining <= windowMs;
  });
}

/**
 * Load settings merged with defaults plus accounts and spend history.
 *
 * @param {object} storageArea `browser.storage.local`-compatible area.
 * @returns {Promise<{settings: object, accounts: object[],
 *           spendHistory: object[]}>} Full extension state.
 */
export async function loadState(storageArea) {
  const stored = await storageArea.get(["settings", "accounts", "spendHistory"]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) },
    accounts: stored.accounts ?? [],
    spendHistory: stored.spendHistory ?? [],
  };
}

/**
 * Persist a partial state update.
 *
 * @param {object} storageArea `browser.storage.local`-compatible area.
 * @param {object} partial Any of settings, accounts, spendHistory.
 * @returns {Promise<void>} Resolves when stored.
 */
export function saveState(storageArea, partial) {
  return storageArea.set(partial);
}
