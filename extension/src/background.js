/**
 * Background service worker (Chrome) / event page (Firefox).
 *
 * Owns all state mutations and network access: LNemail API calls, NWC
 * payments, payment polling, renewal checks, unread counts,
 * notifications, and the one-shot inbox token handoff used to open an
 * inbox pre-authenticated.
 *
 * Design rule: message handlers respond as fast as possible (the
 * autofill flow fills the email field with the API response right
 * away); slower side effects such as NWC payment attempts or opening a
 * payment window run after the response, fire-and-forget.
 */

import { ext } from "./lib/browser.js";
import { LnemailApi } from "./lib/api.js";
import { canAutoPay, recordSpend } from "./lib/allowance.js";
import { computeBadge } from "./lib/badge.js";
import { invoiceAmountSats } from "./lib/bolt11.js";
import { payInvoice, getBalance, parseNwcUri } from "./lib/nwc.js";
import {
  BACKGROUND_POLLING_MODE,
  POLLING_ACTIVITY_WINDOW_MS,
  UNREAD_ACTIVITY_PERIOD_MINUTES,
  UNREAD_BACKGROUND_PERIOD_MINUTES,
  backgroundPollingMode,
} from "./lib/background-polling.js";
import {
  ACCOUNT_STATUS,
  EXPIRY_WARNING_PREFIX,
  accountFromInvoice,
  accountsNeedingRenewal,
  findByEmail,
  findByPaymentHash,
  findByRenewalHash,
  latestUnread,
  loadState,
  recordUsage,
  saveState,
  upsertAccount,
} from "./lib/store.js";

const storage = ext.storage.local;

const POLL_ALARM = "lnemail-poll-payments";
const RENEWAL_ALARM = "lnemail-renewal-check";
const UNREAD_ALARM = "lnemail-unread-refresh";
const POLLING_ACTIVE_UNTIL_KEY = "backgroundPollingActiveUntil";
const RENEWAL_NOTIFY_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const CONTEXT_MENU_ID = "lnemail-fill-new-address";

// The in-memory fallback keeps the privacy window session-scoped on old
// Chromium builds that do not expose storage.session. It may end early when
// the worker stops, but it must never persist into a later browser session.
let inMemoryPollingActiveUntil = null;
let pollingPolicyRevision = 0;
let pollingPolicyUpdatesPending = 0;

/**
 * Log an error with a stable prefix (visible in the extension's
 * background console: chrome://extensions or about:debugging).
 *
 * @param {string} where Failing operation.
 * @param {unknown} error Error value.
 */
function logError(where, error) {
  console.error(`[LNemail] ${where}:`, error);
}

/** @param {object} settings Current settings. @returns {LnemailApi} */
function apiFor(settings, apiBase = null) {
  return new LnemailApi(apiBase ?? settings.apiBase);
}

/**
 * Whether an auto-pay attempt is worth starting at all.
 *
 * @param {object} settings Current settings.
 * @returns {boolean} True when a wallet is configured and enabled.
 */
function willAutoPay(settings) {
  return Boolean(settings.autoPayEnabled && settings.nwcUri);
}

/**
 * Extract a hostname for account metadata.
 *
 * @param {string} url Page URL.
 * @returns {string | null} Hostname or null.
 */
function domainFromUrl(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Badge and notifications                                             */
/* ------------------------------------------------------------------ */

/**
 * Update the toolbar badge: accounts needing attention (orange) win,
 * otherwise the total unread email count (blue). See lib/badge.js.
 */
async function updateBadge() {
  const { settings, accounts } = await loadState(storage);
  const badge = computeBadge(accounts, settings, Date.now());
  const action = ext.action ?? ext.browserAction;
  await action.setBadgeText({ text: badge.text });
  await action.setBadgeBackgroundColor({ color: badge.color });
  await action.setTitle({ title: badge.title });
}

/**
 * Show a notification whose id encodes the click action.
 *
 * @param {string} id Notification id ("pay:<hash>" or "renew:<email>").
 * @param {string} title Notification title.
 * @param {string} message Notification body.
 */
async function notify(id, title, message) {
  try {
    await ext.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch (error) {
    logError("notify", error);
  }
}

ext.notifications?.onClicked.addListener((notificationId) => {
  const [action, ...rest] = notificationId.split(":");
  const value = rest.join(":");
  if (action === "pay") {
    openPaymentWindow(value).catch((error) => logError("openPaymentWindow", error));
  } else if (action === "renew") {
    openPaymentWindow(null, value).catch((error) =>
      logError("openPaymentWindow", error),
    );
  }
  ext.notifications.clear(notificationId);
});

/**
 * Open the standalone payment popup window.
 *
 * @param {string | null} paymentHash Payment to display.
 * @param {string | null} [renewEmail] Account to start a renewal for.
 */
function openPaymentWindow(paymentHash, renewEmail = null) {
  const params = new URLSearchParams();
  if (paymentHash) params.set("pay", paymentHash);
  if (renewEmail) params.set("renew", renewEmail);
  return ext.windows.create({
    url: ext.runtime.getURL(`popup.html?${params.toString()}`),
    type: "popup",
    width: 400,
    height: 640,
  });
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

/**
 * Try to pay an invoice with the configured NWC wallet, recording the
 * spend on success. The real budget lives in the wallet (issuer-side);
 * the only local check is that the invoice matches the quoted price.
 *
 * @param {string} paymentRequest BOLT11 invoice.
 * @param {number} expectedSats Price the API quoted.
 * @param {string} kind Spend kind ("signup" or "renewal").
 * @returns {Promise<{ok: boolean, reason: string | null}>} Outcome.
 */
async function tryAutoPay(paymentRequest, expectedSats, kind) {
  const { settings } = await loadState(storage);
  let amountSats;
  try {
    amountSats = invoiceAmountSats(paymentRequest);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const verdict = canAutoPay(settings, amountSats, expectedSats);
  if (!verdict.allowed) {
    return { ok: false, reason: verdict.reason };
  }
  try {
    await payInvoice(settings.nwcUri, paymentRequest);
  } catch (error) {
    logError("NWC pay_invoice", error);
    return { ok: false, reason: error.message };
  }
  const state = await loadState(storage);
  await saveState(storage, {
    spendHistory: recordSpend(state.spendHistory, {
      at: Date.now(),
      sats: amountSats,
      kind,
    }),
  });
  return { ok: true, reason: null };
}

/** Reconcile payment polling with pending state and the privacy policy. */
async function schedulePaymentPolling() {
  while (true) {
    const revision = pollingPolicyRevision;
    const { settings, accounts } = await loadState(storage);
    const hasPending = accounts.some(
      (account) =>
        account.status === ACCOUNT_STATUS.PENDING || account.renewal !== null,
    );
    const mode = await currentBackgroundPollingMode(settings);
    if (revision !== pollingPolicyRevision) continue;
    if (hasPending && mode !== BACKGROUND_POLLING_MODE.OFF) {
      await ext.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
    } else {
      await ext.alarms.clear(POLL_ALARM);
    }
    if (revision === pollingPolicyRevision) break;
  }
  await updateBadge();
}

/**
 * Check one pending signup payment and update state when paid.
 *
 * @param {string} paymentHash Signup payment hash.
 * @param {(() => Promise<boolean>) | null} canRequest Optional policy guard.
 * @returns {Promise<object | null>} Updated account or null.
 */
async function checkSignupPayment(paymentHash, canRequest = null) {
  const { settings, accounts } = await loadState(storage);
  const account = findByPaymentHash(accounts, paymentHash);
  if (!account || account.status !== ACCOUNT_STATUS.PENDING) {
    return account ?? null;
  }
  if (canRequest && !(await canRequest())) return account;
  const api = apiFor(settings, account.apiBase);
  const status = await api.checkPayment(paymentHash);
  if (status.payment_status === "paid") {
    const updated = {
      ...account,
      status: ACCOUNT_STATUS.ACTIVE,
      paymentRequest: null,
    };
    const state = await loadState(storage);
    await saveState(storage, {
      accounts: upsertAccount(state.accounts, updated),
    });
    await notify(
      `ready:${updated.email}`,
      "LNemail account ready",
      `${updated.email} is active. Remember to back up its access token.`,
    );
    await schedulePaymentPolling();
    return updated;
  }
  return account;
}

/**
 * Check one pending renewal payment and update state when paid.
 *
 * @param {string} paymentHash Renewal payment hash.
 * @param {(() => Promise<boolean>) | null} canRequest Optional policy guard.
 * @returns {Promise<object | null>} Updated account or null.
 */
async function checkRenewalPayment(paymentHash, canRequest = null) {
  const { settings, accounts } = await loadState(storage);
  const account = findByRenewalHash(accounts, paymentHash);
  if (!account) return null;
  if (canRequest && !(await canRequest())) return account;
  const api = apiFor(settings, account.apiBase);
  const status = await api.renewalStatus(paymentHash);
  if (status.payment_status === "paid") {
    const updated = {
      ...account,
      status: ACCOUNT_STATUS.ACTIVE,
      expiresAt: status.new_expires_at ?? account.renewal?.newExpiresAt ?? null,
      renewal: null,
    };
    const state = await loadState(storage);
    await saveState(storage, {
      accounts: upsertAccount(state.accounts, updated),
    });
    await notify(
      `renewed:${updated.email}`,
      "LNemail account renewed",
      `${updated.email} was renewed successfully.`,
    );
    await schedulePaymentPolling();
    return updated;
  }
  return account;
}

/** Poll every pending signup and renewal payment once. */
async function pollPendingPayments(canRequest = null) {
  const { accounts } = await loadState(storage);
  for (const account of accounts) {
    try {
      if (account.status === ACCOUNT_STATUS.PENDING && account.paymentHash) {
        await checkSignupPayment(account.paymentHash, canRequest);
      }
      if (account.renewal?.paymentHash) {
        await checkRenewalPayment(account.renewal.paymentHash, canRequest);
      }
    } catch {
      // Transient API errors: retried on the next alarm tick.
    }
  }
  await schedulePaymentPolling();
}

/**
 * Create a fresh account plus invoice and persist it. Fast path only:
 * auto-payment is handled separately so callers can respond to the UI
 * immediately (the email address is known as soon as the API answers).
 *
 * @param {{sourceDomain?: string | null, sourceUrl?: string | null}} context
 * @returns {Promise<object>} The new (pending) account record.
 */
async function createAccount(context = {}) {
  await activateBackgroundPolling();
  const { settings } = await loadState(storage);
  const invoice = await apiFor(settings).createAccount();
  const account = accountFromInvoice(
    invoice,
    { apiBase: settings.apiBase, ...context },
    Date.now(),
  );
  const state = await loadState(storage);
  await saveState(storage, { accounts: upsertAccount(state.accounts, account) });
  await schedulePaymentPolling();
  return account;
}

/**
 * Post-creation follow-up: attempt NWC auto-pay; when that is not
 * possible (or fails) optionally surface the manual payment window.
 * Runs after the message response, fire-and-forget.
 *
 * @param {object} account Pending account record.
 * @param {{openWindowOnManual?: boolean}} [options] Behavior flags.
 * @returns {Promise<void>} Resolves when the follow-up completed.
 */
async function followUpNewAccount(account, { openWindowOnManual = false } = {}) {
  const result = await tryAutoPay(
    account.paymentRequest,
    account.priceSats,
    "signup",
  );
  if (result.ok) {
    pollSoon(account.paymentHash, "signup");
    return;
  }
  const { settings } = await loadState(storage);
  if (willAutoPay(settings)) {
    // A configured wallet failed: tell the user instead of silently
    // leaving the account unpaid.
    await notify(
      `pay:${account.paymentHash}`,
      "LNemail payment needed",
      `Wallet payment failed (${result.reason}). Click to pay manually.`,
    );
  }
  if (openWindowOnManual) {
    await openPaymentWindow(account.paymentHash);
  }
}

/**
 * Poll a payment a few times with a short interval (post NWC payment).
 *
 * @param {string} paymentHash Payment hash to poll.
 * @param {string} kind "signup" or "renewal".
 * @param {(() => Promise<boolean>) | null} canRequest Optional policy guard.
 */
function pollSoon(paymentHash, kind, canRequest = null) {
  const check = kind === "signup" ? checkSignupPayment : checkRenewalPayment;
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    try {
      if (canRequest && !(await canRequest())) return;
      const account = await check(paymentHash, canRequest);
      const stillPending =
        kind === "signup"
          ? account?.status === ACCOUNT_STATUS.PENDING
          : account?.renewal?.paymentHash === paymentHash;
      if (stillPending && attempts < 10) setTimeout(tick, 3000);
    } catch {
      if (attempts < 10) setTimeout(tick, 3000);
    }
  };
  setTimeout(tick, 2000);
}

/**
 * Start a renewal for an account and optionally auto-pay it.
 *
 * @param {string} email Account email.
 * @param {number} years Years to renew.
 * @param {boolean} attemptAutoPay Try paying via NWC.
 * @param {(() => Promise<boolean>) | null} canRequest Optional policy guard.
 * @returns {Promise<{account: object, autoPay: {ok: boolean, reason: string | null}}>}
 */
async function startRenewal(email, years, attemptAutoPay, canRequest = null) {
  const { settings, accounts } = await loadState(storage);
  const account = findByEmail(accounts, email);
  if (!account) throw new Error("Account not found");
  if (canRequest && !(await canRequest())) {
    return { account, autoPay: { ok: false, reason: "Polling disabled" } };
  }
  const api = apiFor(settings, account.apiBase);
  const invoice = await api.renewAccount(account.token, years);
  const updated = {
    ...account,
    renewal: {
      paymentHash: invoice.payment_hash,
      paymentRequest: invoice.payment_request,
      priceSats: invoice.price_sats,
      years: invoice.years,
      newExpiresAt: invoice.new_expires_at,
      provider: invoice.provider ?? null,
    },
  };
  const state = await loadState(storage);
  await saveState(storage, { accounts: upsertAccount(state.accounts, updated) });
  await schedulePaymentPolling();

  let autoPay = { ok: false, reason: "Auto-pay not attempted" };
  if (attemptAutoPay && (!canRequest || (await canRequest()))) {
    autoPay = await tryAutoPay(
      invoice.payment_request,
      invoice.price_sats,
      "renewal",
    );
    if (autoPay.ok) pollSoon(invoice.payment_hash, "renewal", canRequest);
  }
  return { account: updated, autoPay };
}

/* ------------------------------------------------------------------ */
/* Unread counts                                                       */
/* ------------------------------------------------------------------ */

/**
 * Refresh unread email counts and previews for all active accounts.
 *
 * Writes `unreadCount` / `unreadPreview` / `unreadAt` onto each account
 * record, which the popup picks up through its storage.onChanged
 * subscription. Failures are per-account and non-fatal.
 *
 * @param {(() => Promise<boolean>) | null} canRequest Optional policy guard.
 * @returns {Promise<Record<string, number>>} email -> unread count.
 */
async function refreshUnreadCounts(canRequest = null) {
  const { settings, accounts } = await loadState(storage);
  const counts = {};
  for (const account of accounts) {
    if (account.status !== ACCOUNT_STATUS.ACTIVE) continue;
    try {
      if (canRequest && !(await canRequest())) break;
      const api = apiFor(settings, account.apiBase);
      const listing = await api.listEmails(account.token);
      const unread = (listing.emails ?? []).filter(
        (email) => !email.read && !email.id.startsWith(EXPIRY_WARNING_PREFIX),
      ).length;
      counts[account.email] = unread;
      const state = await loadState(storage);
      const current = findByEmail(state.accounts, account.email);
      if (current) {
        await saveState(storage, {
          accounts: upsertAccount(state.accounts, {
            ...current,
            unreadCount: unread,
            unreadPreview: latestUnread(listing.emails ?? []),
            unreadAt: Date.now(),
          }),
        });
      }
    } catch (error) {
      logError(`unread count for ${account.email}`, error);
    }
  }
  await updateBadge();
  return counts;
}

/** Return the session-scoped expiry for interaction-triggered polling. */
async function pollingActiveUntil() {
  const session = ext.storage.session;
  if (!session) return inMemoryPollingActiveUntil;
  const stored = await session.get(POLLING_ACTIVE_UNTIL_KEY);
  const value = stored[POLLING_ACTIVE_UNTIL_KEY];
  return Number.isFinite(value) ? value : null;
}

/** Persist the activity expiry without allowing it to cross browser sessions. */
async function setPollingActiveUntil(activeUntil) {
  const session = ext.storage.session;
  if (session) {
    await session.set({ [POLLING_ACTIVE_UNTIL_KEY]: activeUntil });
  } else {
    inMemoryPollingActiveUntil = activeUntil;
  }
}

/** Resolve the current global polling mode. */
async function currentBackgroundPollingMode(settings = null) {
  const currentSettings = settings ?? (await loadState(storage)).settings;
  return backgroundPollingMode(
    currentSettings,
    await pollingActiveUntil(),
    Date.now(),
  );
}

/** Reconcile the unread alarm with settings and recent user activity. */
async function configureUnreadPolling() {
  while (true) {
    const revision = pollingPolicyRevision;
    const mode = await currentBackgroundPollingMode();
    if (revision !== pollingPolicyRevision) continue;
    if (mode === BACKGROUND_POLLING_MODE.BACKGROUND) {
      await ext.alarms.create(UNREAD_ALARM, {
        periodInMinutes: UNREAD_BACKGROUND_PERIOD_MINUTES,
      });
    } else if (mode === BACKGROUND_POLLING_MODE.ACTIVITY) {
      await ext.alarms.create(UNREAD_ALARM, {
        periodInMinutes: UNREAD_ACTIVITY_PERIOD_MINUTES,
      });
    } else {
      await ext.alarms.clear(UNREAD_ALARM);
    }
    if (revision === pollingPolicyRevision) return mode;
  }
}

/** Run unattended renewal checks only after the global polling opt-in. */
async function configureRenewalPolling() {
  while (true) {
    const revision = pollingPolicyRevision;
    const mode = await currentBackgroundPollingMode();
    if (revision !== pollingPolicyRevision) continue;
    if (mode === BACKGROUND_POLLING_MODE.BACKGROUND) {
      await ext.alarms.create(RENEWAL_ALARM, { periodInMinutes: 360 });
    } else {
      await ext.alarms.clear(RENEWAL_ALARM);
    }
    if (revision === pollingPolicyRevision) return;
  }
}

/** Start or extend the short polling window after an explicit interaction. */
async function activateBackgroundPolling() {
  const { settings } = await loadState(storage);
  if (!settings.backgroundPollingEnabled) {
    await setPollingActiveUntil(Date.now() + POLLING_ACTIVITY_WINDOW_MS);
  }
  await Promise.all([
    configureUnreadPolling(),
    schedulePaymentPolling(),
  ]);
}

/** Build a per-request guard for one automatic alarm run. */
function automaticRequestGuard(allowedModes) {
  const revision = pollingPolicyRevision;
  return async () => {
    if (
      pollingPolicyUpdatesPending > 0 ||
      revision !== pollingPolicyRevision
    ) {
      return false;
    }
    const mode = await currentBackgroundPollingMode();
    return (
      pollingPolicyUpdatesPending === 0 &&
      revision === pollingPolicyRevision &&
      allowedModes.includes(mode)
    );
  };
}

/** Run an alarm refresh only when the privacy policy still permits it. */
async function handleUnreadAlarm() {
  const mode = await configureUnreadPolling();
  if (mode === BACKGROUND_POLLING_MODE.OFF) return;
  const canRequest = automaticRequestGuard([
    BACKGROUND_POLLING_MODE.ACTIVITY,
    BACKGROUND_POLLING_MODE.BACKGROUND,
  ]);
  await refreshUnreadCounts(canRequest);
  if (mode === BACKGROUND_POLLING_MODE.ACTIVITY) {
    await configureUnreadPolling();
  }
}

/** Run pending-payment polling only while background requests are allowed. */
async function handlePaymentAlarm() {
  const mode = await currentBackgroundPollingMode();
  if (mode === BACKGROUND_POLLING_MODE.OFF) {
    await schedulePaymentPolling();
    return;
  }
  const canRequest = automaticRequestGuard([
    BACKGROUND_POLLING_MODE.ACTIVITY,
    BACKGROUND_POLLING_MODE.BACKGROUND,
  ]);
  await pollPendingPayments(canRequest);
}

/** Ignore a stale renewal alarm after background polling is disabled. */
async function handleRenewalAlarm() {
  const mode = await currentBackgroundPollingMode();
  if (mode !== BACKGROUND_POLLING_MODE.BACKGROUND) {
    await configureRenewalPolling();
    return;
  }
  const canRequest = automaticRequestGuard([
    BACKGROUND_POLLING_MODE.BACKGROUND,
  ]);
  await renewalCheck(canRequest);
}

/* ------------------------------------------------------------------ */
/* Renewal watchdog                                                    */
/* ------------------------------------------------------------------ */

/**
 * Refresh account expiry data from the API and update local status.
 *
 * @param {object} account Stored account (must be active/expired).
 * @param {(() => Promise<boolean>) | null} canRequest Optional policy guard.
 * @returns {Promise<object>} Updated account record.
 */
async function refreshAccount(account, canRequest = null) {
  const { settings } = await loadState(storage);
  if (canRequest && !(await canRequest())) return account;
  const api = apiFor(settings, account.apiBase);
  try {
    const info = await api.getAccount(account.token);
    return {
      ...account,
      expiresAt: info.expires_at,
      status: info.is_expired ? ACCOUNT_STATUS.EXPIRED : ACCOUNT_STATUS.ACTIVE,
    };
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      return { ...account, status: ACCOUNT_STATUS.EXPIRED };
    }
    return account;
  }
}

/** Daily-ish check: refresh accounts, auto-renew or notify. */
async function renewalCheck(canRequest = null) {
  const { settings, accounts } = await loadState(storage);
  const now = Date.now();

  // Refresh non-pending accounts (updates expiry after external renewals).
  let refreshed = accounts;
  for (const account of accounts) {
    if (account.status === ACCOUNT_STATUS.PENDING) continue;
    if (canRequest && !(await canRequest())) return;
    const updated = await refreshAccount(account, canRequest);
    refreshed = upsertAccount(refreshed, updated);
  }
  await saveState(storage, { accounts: refreshed });

  const needing = accountsNeedingRenewal(refreshed, now, settings.renewDaysBefore);
  for (const account of needing) {
    if (canRequest && !(await canRequest())) return;
    if (account.renewal) continue; // Renewal already in flight.
    if (willAutoPay(settings) && settings.autoRenewEnabled) {
      try {
        const { autoPay } = await startRenewal(
          account.email,
          1,
          true,
          canRequest,
        );
        if (autoPay.ok) continue;
      } catch (error) {
        logError(`auto-renewal for ${account.email}`, error);
      }
    }
    const last = account.lastRenewalNotifiedAt ?? 0;
    if (now - last > RENEWAL_NOTIFY_COOLDOWN_MS) {
      await notify(
        `renew:${account.email}`,
        "LNemail account expiring",
        `${account.email} expires soon. Click to renew with a Lightning payment.`,
      );
      const state = await loadState(storage);
      const current = findByEmail(state.accounts, account.email);
      if (current) {
        await saveState(storage, {
          accounts: upsertAccount(state.accounts, {
            ...current,
            lastRenewalNotifiedAt: now,
          }),
        });
      }
    }
  }
  await updateBadge();
}

/* ------------------------------------------------------------------ */
/* Inbox token handoff                                                 */
/* ------------------------------------------------------------------ */

/**
 * Open the account's inbox in a new tab, handing the token to the
 * inbox-bridge content script via a tab-scoped one-shot entry.
 *
 * @param {string} email Account email.
 * @returns {Promise<void>} Resolves when the tab is created.
 */
async function openInbox(email) {
  const { settings, accounts } = await loadState(storage);
  const account = findByEmail(accounts, email);
  if (!account) throw new Error("Account not found");
  const base = (account.apiBase ?? settings.apiBase).replace(/\/+$/, "");
  const tab = await ext.tabs.create({ url: `${base}/inbox` });
  const session = ext.storage.session ?? ext.storage.local;
  await session.set({
    [`inboxToken:${tab.id}`]: { token: account.token, base, at: Date.now() },
  });
}

/**
 * One-shot token retrieval for the inbox-bridge content script.
 *
 * @param {object} sender Message sender (must be a tab).
 * @param {string} pageUrl URL reported by the content script.
 * @returns {Promise<{token: string} | null>} Token or null.
 */
async function consumeInboxToken(sender, pageUrl) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  const session = ext.storage.session ?? ext.storage.local;
  const key = `inboxToken:${tabId}`;
  const stored = await session.get(key);
  const entry = stored[key];
  if (!entry) return null;
  // The token is only released to the exact origin we navigated to,
  // within a short window.
  const sameOrigin = pageUrl?.startsWith(entry.base);
  const fresh = Date.now() - entry.at < 2 * 60 * 1000;
  await session.remove(key);
  if (!sameOrigin || !fresh) return null;
  return { token: entry.token };
}

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

const handlers = {
  "state:get": async () => loadState(storage),
  "polling:activate": async () => {
    await activateBackgroundPolling();
    return { ok: true };
  },
  "settings:set": async ({ settings }) => {
    pollingPolicyUpdatesPending += 1;
    try {
      const state = await loadState(storage);
      const updatedSettings = { ...state.settings, ...settings };
      await saveState(storage, { settings: updatedSettings });
      pollingPolicyRevision += 1;
      await Promise.all([
        configureUnreadPolling(),
        configureRenewalPolling(),
        schedulePaymentPolling(),
      ]);
      return loadState(storage);
    } finally {
      pollingPolicyUpdatesPending -= 1;
    }
  },
  "health:get": async () => {
    const { settings } = await loadState(storage);
    return apiFor(settings).health();
  },
  "accounts:create": async ({ sourceDomain, sourceUrl }) => {
    const account = await createAccount({ sourceDomain, sourceUrl });
    const { settings } = await loadState(storage);
    // Auto-pay (and, on failure, a notification) happens after the
    // response so the UI shows the address and invoice immediately.
    followUpNewAccount(account).catch((error) =>
      logError("followUpNewAccount", error),
    );
    return { account, willAutoPay: willAutoPay(settings) };
  },
  "accounts:delete": async ({ email }) => {
    const state = await loadState(storage);
    await saveState(storage, {
      accounts: state.accounts.filter((account) => account.email !== email),
    });
    await schedulePaymentPolling();
    return { ok: true };
  },
  "accounts:refresh": async ({ email }) => {
    const state = await loadState(storage);
    const account = findByEmail(state.accounts, email);
    if (!account) throw new Error("Account not found");
    const updated = await refreshAccount(account);
    await saveState(storage, {
      accounts: upsertAccount(state.accounts, updated),
    });
    return updated;
  },
  "accounts:unread": async () => {
    const mode = await currentBackgroundPollingMode();
    if (mode === BACKGROUND_POLLING_MODE.OFF) return {};
    const canRequest = automaticRequestGuard([
      BACKGROUND_POLLING_MODE.ACTIVITY,
      BACKGROUND_POLLING_MODE.BACKGROUND,
    ]);
    return refreshUnreadCounts(canRequest);
  },
  "payments:check": async ({ paymentHash, kind }) => {
    const mode = await currentBackgroundPollingMode();
    if (mode === BACKGROUND_POLLING_MODE.OFF) return null;
    const canRequest = automaticRequestGuard([
      BACKGROUND_POLLING_MODE.ACTIVITY,
      BACKGROUND_POLLING_MODE.BACKGROUND,
    ]);
    return kind === "renewal"
      ? checkRenewalPayment(paymentHash, canRequest)
      : checkSignupPayment(paymentHash, canRequest);
  },
  "payments:payNwc": async ({ paymentHash }) => {
    await activateBackgroundPolling();
    const { accounts } = await loadState(storage);
    const signup = findByPaymentHash(accounts, paymentHash);
    const renewal = findByRenewalHash(accounts, paymentHash);
    const request = signup?.paymentRequest ?? renewal?.renewal?.paymentRequest;
    const price = signup?.priceSats ?? renewal?.renewal?.priceSats;
    if (!request) throw new Error("Payment not found");
    const { settings, spendHistory } = await loadState(storage);
    // Manual "pay with wallet" only checks the invoice against the
    // quoted price, not the autoPayEnabled toggle: the user clicked pay.
    const amount = invoiceAmountSats(request);
    if (amount !== null && price && amount > price) {
      throw new Error("Invoice amount does not match the quoted price");
    }
    if (!settings.nwcUri) throw new Error("No NWC wallet configured");
    await payInvoice(settings.nwcUri, request);
    await saveState(storage, {
      spendHistory: recordSpend(spendHistory, {
        at: Date.now(),
        sats: amount ?? price ?? 0,
        kind: signup ? "signup" : "renewal",
      }),
    });
    pollSoon(paymentHash, signup ? "signup" : "renewal");
    return { ok: true };
  },
  "payments:reissue": async ({ paymentHash, excludeProvider }) => {
    await activateBackgroundPolling();
    const { settings, accounts } = await loadState(storage);
    const signup = findByPaymentHash(accounts, paymentHash);
    if (signup) {
      const api = apiFor(settings, signup.apiBase);
      const invoice = await api.newSignupInvoice(paymentHash, excludeProvider);
      const updated = {
        ...signup,
        paymentHash: invoice.payment_hash,
        paymentRequest: invoice.payment_request,
        provider: invoice.provider ?? null,
      };
      const state = await loadState(storage);
      await saveState(storage, {
        accounts: upsertAccount(state.accounts, updated),
      });
      return updated;
    }
    const renewal = findByRenewalHash(accounts, paymentHash);
    if (renewal) {
      const api = apiFor(settings, renewal.apiBase);
      const invoice = await api.newRenewalInvoice(
        renewal.token,
        paymentHash,
        renewal.renewal.years,
        excludeProvider,
      );
      const updated = {
        ...renewal,
        renewal: {
          ...renewal.renewal,
          paymentHash: invoice.payment_hash,
          paymentRequest: invoice.payment_request,
          provider: invoice.provider ?? null,
        },
      };
      const state = await loadState(storage);
      await saveState(storage, {
        accounts: upsertAccount(state.accounts, updated),
      });
      return updated;
    }
    throw new Error("Payment not found");
  },
  "renewal:create": async ({ email, years, attemptAutoPay }) => {
    await activateBackgroundPolling();
    return startRenewal(email, years ?? 1, Boolean(attemptAutoPay));
  },
  "inbox:open": async ({ email }) => {
    await openInbox(email);
    return { ok: true };
  },
  "inbox:getToken": async (payload, sender) =>
    consumeInboxToken(sender, payload.url),
  "autofill:accounts": async ({ domain }) => {
    await activateBackgroundPolling();
    const { settings, accounts } = await loadState(storage);
    const lastUse = (account) =>
      Math.max(0, ...(account.usedOn ?? []).map((use) => use.at));
    const items = accounts
      .filter((account) => account.status !== ACCOUNT_STATUS.EXPIRED)
      .map((account) => ({
        email: account.email,
        status: account.status,
        usedHere: (account.usedOn ?? []).some((use) => use.domain === domain),
        lastDomain:
          (account.usedOn ?? []).slice(-1)[0]?.domain ??
          account.sourceDomain ??
          null,
        sortKey: lastUse(account) || account.createdAt || 0,
      }))
      .sort(
        (a, b) => Number(b.usedHere) - Number(a.usedHere) || b.sortKey - a.sortKey,
      )
      .map(({ sortKey, ...item }) => item);
    return { enabled: settings.autofillEnabled, accounts: items };
  },
  "autofill:used": async ({ email, domain }) => {
    const state = await loadState(storage);
    const account = findByEmail(state.accounts, email);
    if (!account || !domain) return { ok: false };
    await saveState(storage, {
      accounts: upsertAccount(
        state.accounts,
        recordUsage(account, domain, Date.now()),
      ),
    });
    await activateBackgroundPolling();
    return { ok: true };
  },
  "autofill:new": async ({ domain, url }) => {
    const account = await createAccount({
      sourceDomain: domain ?? null,
      sourceUrl: url ?? null,
    });
    const { settings } = await loadState(storage);
    const auto = willAutoPay(settings);
    // Respond immediately so the field is filled without waiting for
    // any payment. Auto-pay or the manual payment window follows.
    followUpNewAccount(account, { openWindowOnManual: !auto }).catch((error) =>
      logError("followUpNewAccount", error),
    );
    return {
      email: account.email,
      paymentHash: account.paymentHash,
      willAutoPay: auto,
    };
  },
  "nwc:test": async ({ uri }) => {
    parseNwcUri(uri); // Throws a descriptive error on malformed URIs.
    const result = await getBalance(uri, { timeoutMs: 15000 });
    return { ok: true, balanceMsats: result.balance ?? null };
  },
  "window:openPayment": async ({ paymentHash, renewEmail }) => {
    await openPaymentWindow(paymentHash ?? null, renewEmail ?? null);
    return { ok: true };
  },
};

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      logError(`handler ${message.type}`, error);
      sendResponse({ ok: false, error: error.message });
    });
  return true; // Keep the message channel open for the async response.
});

/* ------------------------------------------------------------------ */
/* Alarms, context menu, lifecycle                                     */
/* ------------------------------------------------------------------ */

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    handlePaymentAlarm().catch((error) => logError("handlePaymentAlarm", error));
  } else if (alarm.name === RENEWAL_ALARM) {
    handleRenewalAlarm().catch((error) => logError("handleRenewalAlarm", error));
  } else if (alarm.name === UNREAD_ALARM) {
    handleUnreadAlarm().catch((error) => logError("handleUnreadAlarm", error));
  }
});

async function setupContextMenu() {
  if (!ext.contextMenus) return;
  try {
    await ext.contextMenus.removeAll();
    ext.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Fill with a new LNemail address",
      contexts: ["editable"],
    });
  } catch (error) {
    logError("setupContextMenu", error);
  }
}

ext.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  const domain = domainFromUrl(info.pageUrl ?? tab.url ?? "");
  try {
    const account = await createAccount({
      sourceDomain: domain,
      sourceUrl: info.pageUrl ?? tab.url ?? null,
    });
    await ext.tabs.sendMessage(tab.id, {
      type: "lnemail:fill",
      email: account.email,
    });
    const { settings } = await loadState(storage);
    followUpNewAccount(account, {
      openWindowOnManual: !willAutoPay(settings),
    }).catch((error) => logError("followUpNewAccount", error));
  } catch (error) {
    logError("context menu fill", error);
    notify(
      "error:create",
      "LNemail",
      `Could not create an address: ${error.message}`,
    );
  }
});

async function initialize() {
  await setupContextMenu();
  // These calls also clear continuous alarms created by older versions
  // unless the user explicitly enables background server polling.
  await Promise.all([
    configureUnreadPolling(),
    configureRenewalPolling(),
    schedulePaymentPolling(),
  ]);
}

ext.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => logError("initialize", error));
});
ext.runtime.onStartup?.addListener(() => {
  initialize().catch((error) => logError("initialize", error));
});
