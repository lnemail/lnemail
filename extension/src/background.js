/**
 * Background service worker (Chrome) / event page (Firefox).
 *
 * Owns all state mutations and network access: LNemail API calls, NWC
 * payments, payment polling, renewal checks, notifications, and the
 * one-shot inbox token handoff used to open an inbox pre-authenticated.
 */

import { ext } from "./lib/browser.js";
import { LnemailApi } from "./lib/api.js";
import { evaluateSpend, recordSpend } from "./lib/allowance.js";
import { invoiceAmountSats } from "./lib/bolt11.js";
import { payInvoice, getBalance, parseNwcUri } from "./lib/nwc.js";
import {
  ACCOUNT_STATUS,
  accountFromInvoice,
  accountsForDomain,
  accountsNeedingRenewal,
  findByEmail,
  findByPaymentHash,
  findByRenewalHash,
  loadState,
  recordUsage,
  saveState,
  upsertAccount,
} from "./lib/store.js";

const storage = ext.storage.local;

const POLL_ALARM = "lnemail-poll-payments";
const RENEWAL_ALARM = "lnemail-renewal-check";
const RENEWAL_NOTIFY_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const CONTEXT_MENU_ID = "lnemail-fill-new-address";

/** @param {object} settings Current settings. @returns {LnemailApi} */
function apiFor(settings, apiBase = null) {
  return new LnemailApi(apiBase ?? settings.apiBase);
}

/**
 * Extract a registrable-ish domain label for account metadata.
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

/** Update the action badge with the number of items needing attention. */
async function updateBadge() {
  const { settings, accounts } = await loadState(storage);
  const now = Date.now();
  const pending = accounts.filter(
    (account) => account.status === ACCOUNT_STATUS.PENDING,
  ).length;
  const expiring = accountsNeedingRenewal(
    accounts,
    now,
    settings.renewDaysBefore,
  ).length;
  const count = pending + expiring;
  const action = ext.action ?? ext.browserAction;
  await action.setBadgeText({ text: count > 0 ? String(count) : "" });
  if (count > 0) {
    await action.setBadgeBackgroundColor({ color: "#f7931a" });
  }
}

/**
 * Show a notification whose id encodes the click action.
 *
 * @param {string} id Notification id ("pay:<hash>" or "renew:<email>").
 * @param {string} title Notification title.
 * @param {string} message Notification body.
 */
function notify(id, title, message) {
  return ext.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
  });
}

ext.notifications?.onClicked.addListener((notificationId) => {
  const [action, ...rest] = notificationId.split(":");
  const value = rest.join(":");
  if (action === "pay") {
    openPaymentWindow(value);
  } else if (action === "renew") {
    openPaymentWindow(null, value);
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
 * Try to pay an invoice with the configured NWC wallet within the
 * allowance, recording the spend on success.
 *
 * @param {string} paymentRequest BOLT11 invoice.
 * @param {number} expectedSats Price the API quoted.
 * @param {string} kind Spend kind ("signup" or "renewal").
 * @returns {Promise<{ok: boolean, reason: string | null}>} Outcome.
 */
async function tryAutoPay(paymentRequest, expectedSats, kind) {
  const { settings, spendHistory } = await loadState(storage);
  const now = Date.now();
  let amountSats;
  try {
    amountSats = invoiceAmountSats(paymentRequest);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (amountSats !== null && expectedSats && amountSats > expectedSats) {
    return {
      ok: false,
      reason: `Invoice amount ${amountSats} sats exceeds quoted price ${expectedSats} sats`,
    };
  }
  const verdict = evaluateSpend(settings, spendHistory, amountSats, now);
  if (!verdict.allowed) {
    return { ok: false, reason: verdict.reason };
  }
  try {
    await payInvoice(settings.nwcUri, paymentRequest);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const state = await loadState(storage);
  await saveState(storage, {
    spendHistory: recordSpend(state.spendHistory, {
      at: now,
      sats: amountSats,
      kind,
    }),
  });
  return { ok: true, reason: null };
}

/** Ensure the payment-poll alarm runs while any payment is pending. */
async function schedulePaymentPolling() {
  const { accounts } = await loadState(storage);
  const hasPending = accounts.some(
    (account) =>
      account.status === ACCOUNT_STATUS.PENDING || account.renewal !== null,
  );
  if (hasPending) {
    await ext.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
    // Also poll shortly after scheduling for fast feedback.
    pollPendingPayments().catch(() => {});
  } else {
    await ext.alarms.clear(POLL_ALARM);
  }
  await updateBadge();
}

/**
 * Check one pending signup payment and update state when paid.
 *
 * @param {string} paymentHash Signup payment hash.
 * @returns {Promise<object | null>} Updated account or null.
 */
async function checkSignupPayment(paymentHash) {
  const { settings, accounts } = await loadState(storage);
  const account = findByPaymentHash(accounts, paymentHash);
  if (!account || account.status !== ACCOUNT_STATUS.PENDING) {
    return account ?? null;
  }
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
 * @returns {Promise<object | null>} Updated account or null.
 */
async function checkRenewalPayment(paymentHash) {
  const { settings, accounts } = await loadState(storage);
  const account = findByRenewalHash(accounts, paymentHash);
  if (!account) return null;
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
async function pollPendingPayments() {
  const { accounts } = await loadState(storage);
  for (const account of accounts) {
    try {
      if (account.status === ACCOUNT_STATUS.PENDING && account.paymentHash) {
        await checkSignupPayment(account.paymentHash);
      }
      if (account.renewal?.paymentHash) {
        await checkRenewalPayment(account.renewal.paymentHash);
      }
    } catch {
      // Transient API errors: retried on the next alarm tick.
    }
  }
  await schedulePaymentPolling();
}

/**
 * Create a fresh account plus invoice, persist it, and try auto-pay.
 *
 * @param {{sourceDomain?: string | null, sourceUrl?: string | null}} context
 * @returns {Promise<{account: object, autoPay: {ok: boolean, reason: string | null}}>}
 */
async function createAccount(context = {}) {
  const { settings } = await loadState(storage);
  const api = apiFor(settings);
  const invoice = await api.createAccount();
  const account = accountFromInvoice(
    invoice,
    { apiBase: settings.apiBase, ...context },
    Date.now(),
  );
  const state = await loadState(storage);
  await saveState(storage, { accounts: upsertAccount(state.accounts, account) });
  await schedulePaymentPolling();

  const autoPay = await tryAutoPay(
    invoice.payment_request,
    invoice.price_sats,
    "signup",
  );
  if (autoPay.ok) {
    // Settlement typically shows up within seconds; poll a few times so
    // the UI flips to "active" quickly.
    pollSoon(account.paymentHash, "signup");
  }
  return { account, autoPay };
}

/**
 * Poll a payment a few times with a short interval (post NWC payment).
 *
 * @param {string} paymentHash Payment hash to poll.
 * @param {string} kind "signup" or "renewal".
 */
function pollSoon(paymentHash, kind) {
  const check = kind === "signup" ? checkSignupPayment : checkRenewalPayment;
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    try {
      const account = await check(paymentHash);
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
 * @returns {Promise<{account: object, autoPay: {ok: boolean, reason: string | null}}>}
 */
async function startRenewal(email, years, attemptAutoPay) {
  const { settings, accounts } = await loadState(storage);
  const account = findByEmail(accounts, email);
  if (!account) throw new Error("Account not found");
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
  if (attemptAutoPay) {
    autoPay = await tryAutoPay(
      invoice.payment_request,
      invoice.price_sats,
      "renewal",
    );
    if (autoPay.ok) pollSoon(invoice.payment_hash, "renewal");
  }
  return { account: updated, autoPay };
}

/* ------------------------------------------------------------------ */
/* Renewal watchdog                                                    */
/* ------------------------------------------------------------------ */

/**
 * Refresh account expiry data from the API and update local status.
 *
 * @param {object} account Stored account (must be active/expired).
 * @returns {Promise<object>} Updated account record.
 */
async function refreshAccount(account) {
  const { settings } = await loadState(storage);
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
async function renewalCheck() {
  const { settings, accounts } = await loadState(storage);
  const now = Date.now();

  // Refresh non-pending accounts (updates expiry after external renewals).
  let refreshed = accounts;
  for (const account of accounts) {
    if (account.status === ACCOUNT_STATUS.PENDING) continue;
    const updated = await refreshAccount(account);
    refreshed = upsertAccount(refreshed, updated);
  }
  await saveState(storage, { accounts: refreshed });

  const needing = accountsNeedingRenewal(refreshed, now, settings.renewDaysBefore);
  for (const account of needing) {
    if (account.renewal) continue; // Renewal already in flight.
    if (settings.autoPayEnabled && settings.autoRenewEnabled && settings.nwcUri) {
      try {
        const { autoPay } = await startRenewal(account.email, 1, true);
        if (autoPay.ok) continue;
      } catch {
        // Fall through to the notification path.
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
  "settings:set": async ({ settings }) => {
    const state = await loadState(storage);
    await saveState(storage, { settings: { ...state.settings, ...settings } });
    return loadState(storage);
  },
  "health:get": async () => {
    const { settings } = await loadState(storage);
    return apiFor(settings).health();
  },
  "accounts:create": async ({ sourceDomain, sourceUrl }) =>
    createAccount({ sourceDomain, sourceUrl }),
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
  "payments:check": async ({ paymentHash, kind }) =>
    kind === "renewal"
      ? checkRenewalPayment(paymentHash)
      : checkSignupPayment(paymentHash),
  "payments:payNwc": async ({ paymentHash }) => {
    const { accounts } = await loadState(storage);
    const signup = findByPaymentHash(accounts, paymentHash);
    const renewal = findByRenewalHash(accounts, paymentHash);
    const request = signup?.paymentRequest ?? renewal?.renewal?.paymentRequest;
    const price = signup?.priceSats ?? renewal?.renewal?.priceSats;
    if (!request) throw new Error("Payment not found");
    const { settings, spendHistory } = await loadState(storage);
    // Manual "pay with wallet" only honors the per-payment sanity check,
    // not the autoPayEnabled toggle: the user explicitly clicked pay.
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
  "renewal:create": async ({ email, years, attemptAutoPay }) =>
    startRenewal(email, years ?? 1, Boolean(attemptAutoPay)),
  "inbox:open": async ({ email }) => {
    await openInbox(email);
    return { ok: true };
  },
  "inbox:getToken": async (payload, sender) =>
    consumeInboxToken(sender, payload.url),
  "autofill:accounts": async ({ domain }) => {
    const { settings, accounts } = await loadState(storage);
    return {
      enabled: settings.autofillEnabled,
      accounts: accountsForDomain(accounts, domain)
        .filter((account) => account.status !== ACCOUNT_STATUS.EXPIRED)
        .map((account) => ({ email: account.email, status: account.status })),
    };
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
    return { ok: true };
  },
  "autofill:new": async ({ domain, url }) => {
    const { account, autoPay } = await createAccount({
      sourceDomain: domain ?? null,
      sourceUrl: url ?? null,
    });
    if (!autoPay.ok) {
      // Manual payment needed: surface the invoice in a popup window.
      await openPaymentWindow(account.paymentHash);
    }
    return { email: account.email, autoPay, paymentHash: account.paymentHash };
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
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true; // Keep the message channel open for the async response.
});

/* ------------------------------------------------------------------ */
/* Alarms, context menu, lifecycle                                     */
/* ------------------------------------------------------------------ */

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollPendingPayments().catch(() => {});
  } else if (alarm.name === RENEWAL_ALARM) {
    renewalCheck().catch(() => {});
  }
});

function setupContextMenu() {
  if (!ext.contextMenus) return;
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Fill with a new LNemail address",
      contexts: ["editable"],
    });
  });
}

ext.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  const domain = domainFromUrl(info.pageUrl ?? tab.url ?? "");
  try {
    const { account, autoPay } = await createAccount({
      sourceDomain: domain,
      sourceUrl: info.pageUrl ?? tab.url ?? null,
    });
    await ext.tabs.sendMessage(tab.id, {
      type: "lnemail:fill",
      email: account.email,
    });
    if (!autoPay.ok) await openPaymentWindow(account.paymentHash);
  } catch (error) {
    notify(
      "error:create",
      "LNemail",
      `Could not create an address: ${error.message}`,
    );
  }
});

async function initialize() {
  setupContextMenu();
  await ext.alarms.create(RENEWAL_ALARM, { periodInMinutes: 360 });
  await schedulePaymentPolling();
}

ext.runtime.onInstalled.addListener(() => {
  initialize().catch(() => {});
});
ext.runtime.onStartup?.addListener(() => {
  initialize().catch(() => {});
});
