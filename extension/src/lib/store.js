/**
 * Extension state: settings and saved accounts.
 *
 * Pure helpers operate on plain objects; the thin load/save wrappers at
 * the bottom bind them to `browser.storage.local`. Keeping the logic
 * pure makes it unit-testable without a browser.
 */

// Spending limits are intentionally absent: the NWC wallet issuer sets
// the real budget on the wallet side (see lib/allowance.js).
export const DEFAULT_SETTINGS = {
  apiBase: "https://lnemail.net",
  nwcUri: "",
  autoPayEnabled: false,
  autoRenewEnabled: true,
  renewDaysBefore: 30,
  autofillEnabled: true,
  backgroundPollingEnabled: false,
};

export const ACCOUNT_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  EXPIRED: "expired",
};

// Virtual expiration-warning emails injected by the API into inbox
// listings; excluded from unread counts and previews.
export const EXPIRY_WARNING_PREFIX = "lnemail-expiry-warning";

/**
 * Extract the latest unread email headers for the popup preview.
 *
 * Filters out read emails and virtual expiry warnings, sorts newest
 * first, and truncates fields so the stored preview stays small.
 *
 * @param {Array<{id: string, subject: string, sender: string,
 *         date: string, read: boolean}>} emails Email headers.
 * @param {number} [limit] Maximum number of entries.
 * @returns {Array<{id: string, subject: string, sender: string,
 *          date: string}>} Newest unread headers.
 */
export function latestUnread(emails, limit = 3) {
  const parseDate = (value) => {
    const time = Date.parse(value ?? "");
    return Number.isNaN(time) ? 0 : time;
  };
  return (emails ?? [])
    .filter(
      (email) => !email.read && !email.id.startsWith(EXPIRY_WARNING_PREFIX),
    )
    .sort((a, b) => parseDate(b.date) - parseDate(a.date))
    .slice(0, limit)
    .map((email) => ({
      id: email.id,
      subject: (email.subject ?? "").slice(0, 120),
      sender: (email.sender ?? "").slice(0, 80),
      date: email.date,
    }));
}

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
 * Build or refresh a stored account from the authenticated account endpoint.
 *
 * @param {{email_address: string, expires_at: string, is_expired?: boolean}} info
 * @param {{token: string, apiBase: string, existing?: object | null}} context
 * @param {number} now Epoch milliseconds.
 * @returns {object} Complete imported account record.
 */
export function accountFromAccountInfo(info, context, now) {
  const email = info?.email_address?.trim();
  const token = context?.token?.trim();
  let apiBase;
  try {
    const url = new URL(context?.apiBase);
    if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
      throw new Error();
    }
    apiBase = url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("Invalid account response");
  }
  const expiresAt = new Date(info?.expires_at ?? "");
  if (!email || !email.includes("@") || !token || !apiBase) {
    throw new Error("Invalid account response");
  }
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("Invalid account response");
  }
  const existing = context.existing ?? null;
  let existingBase = apiBase;
  if (existing?.apiBase) {
    try {
      existingBase = new URL(existing.apiBase).toString().replace(/\/+$/, "");
    } catch {
      existingBase = existing.apiBase.replace(/\/+$/, "");
    }
  }
  if (existing && existingBase !== apiBase) {
    throw new Error("This email is already stored for a different LNemail server");
  }
  const imported = {
    email,
    token,
    apiBase,
    status: info.is_expired ? ACCOUNT_STATUS.EXPIRED : ACCOUNT_STATUS.ACTIVE,
    createdAt: now,
    expiresAt: expiresAt.toISOString(),
    paymentHash: null,
    paymentRequest: null,
    priceSats: null,
    provider: null,
    sourceDomain: null,
    sourceUrl: null,
    usedOn: [],
    renewal: null,
    lastRenewalNotifiedAt: null,
  };
  return {
    ...imported,
    ...existing,
    email,
    token,
    apiBase,
    status: info.is_expired ? ACCOUNT_STATUS.EXPIRED : ACCOUNT_STATUS.ACTIVE,
    expiresAt: expiresAt.toISOString(),
    paymentHash: null,
    paymentRequest: null,
    priceSats: null,
    provider: null,
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
