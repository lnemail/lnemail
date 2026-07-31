/**
 * Popup UI: account list with domain filtering, payment view with QR
 * and NWC pay button, and the renewal starter. Also used as a
 * standalone payment window via `popup.html?pay=<hash>` or
 * `popup.html?renew=<email>`.
 */

import { ext } from "../lib/browser.js";
import { createQrSvg } from "../lib/qr.js";
import { isAndroidUserAgent, walletUri } from "../lib/wallet-uri.js";

const $ = (id) => document.getElementById(id);

let state = { settings: null, accounts: [], spendHistory: [] };
let currentPayment = null; // {paymentHash, kind, email}
let pollTimer = null;
let reissueAvailable = false;

/**
 * Send a typed message to the background worker.
 *
 * @param {string} type Message type.
 * @param {object} [payload] Message payload.
 * @returns {Promise<object>} Handler result.
 */
async function send(type, payload = {}) {
  const response = await ext.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? "Unknown error");
  return response.result;
}

/** Reload state from the background worker. */
async function refreshState() {
  state = await send("state:get");
}

/* ------------------------------------------------------------------ */
/* View switching                                                      */
/* ------------------------------------------------------------------ */

function showView(name) {
  for (const id of ["viewList", "viewImport", "viewPayment", "viewRenew"]) {
    $(id).classList.toggle("hidden", id !== name);
  }
  if (name !== "viewPayment") stopPolling();
}

function setStatus(elementId, message, kind = "") {
  const el = $(elementId);
  el.textContent = message;
  el.className = `status ${kind}`.trim();
}

/* ------------------------------------------------------------------ */
/* Account list                                                        */
/* ------------------------------------------------------------------ */

function accountTag(account) {
  if (account.status === "pending") return ["tag-pending", "awaiting payment"];
  if (account.status === "expired") return ["tag-expired", "expired"];
  const remaining = account.expiresAt
    ? new Date(account.expiresAt).getTime() - Date.now()
    : null;
  if (remaining !== null) {
    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    if (days <= (state.settings?.renewDaysBefore ?? 30)) {
      return ["tag-expiring", `expires in ${Math.max(days, 0)}d`];
    }
    return ["tag-active", `${days}d left`];
  }
  return ["tag-active", "active"];
}

function matchesFilter(account, filter) {
  if (!filter) return true;
  const haystack = [
    account.email,
    account.sourceDomain ?? "",
    ...(account.usedOn ?? []).map((use) => use.domain),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(filter.toLowerCase());
}

function renderAccounts() {
  const filter = $("searchInput").value.trim();
  const list = $("accountList");
  list.replaceChildren();
  const accounts = [...state.accounts]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .filter((account) => matchesFilter(account, filter));

  $("emptyState").classList.toggle("hidden", accounts.length > 0);

  for (const account of accounts) {
    const item = document.createElement("li");
    item.className = "account";

    const email = document.createElement("div");
    email.className = "account-email";
    email.textContent = account.email;
    item.appendChild(email);

    const meta = document.createElement("div");
    meta.className = "account-meta";
    const [tagClass, tagText] = accountTag(account);
    const tag = document.createElement("span");
    tag.className = `tag ${tagClass}`;
    tag.textContent = tagText;
    meta.appendChild(tag);
    if (account.status === "active" && Number.isInteger(account.unreadCount)) {
      const unread = document.createElement("span");
      unread.className = account.unreadCount > 0 ? "tag tag-unread" : "chip";
      unread.textContent =
        account.unreadCount === 1 ? "1 unread" : `${account.unreadCount} unread`;
      meta.appendChild(unread);
    }
    // Every site this address was used on (newest last), so accounts
    // can be told apart and reused on the right services.
    for (const use of [...(account.usedOn ?? [])].sort((a, b) => a.at - b.at)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = use.domain;
      meta.appendChild(chip);
    }
    item.appendChild(meta);

    // Inline inbox preview: the latest unread subjects, click-through
    // to the full inbox.
    if (
      account.status === "active" &&
      (account.unreadCount ?? 0) > 0 &&
      (account.unreadPreview ?? []).length > 0
    ) {
      const preview = document.createElement("div");
      preview.className = "preview";
      for (const header of account.unreadPreview) {
        const line = document.createElement("button");
        line.type = "button";
        line.className = "preview-line";
        line.title = "Open inbox";
        const sender = document.createElement("span");
        sender.className = "preview-sender";
        // Prefer the display name over the raw address for compactness.
        sender.textContent =
          header.sender.replace(/<[^>]*>/, "").trim() || header.sender;
        const subject = document.createElement("span");
        subject.className = "preview-subject";
        subject.textContent = header.subject || "(no subject)";
        line.append(sender, subject);
        line.addEventListener("click", () => {
          send("inbox:open", { email: account.email }).then(() => window.close());
        });
        preview.appendChild(line);
      }
      item.appendChild(preview);
    }

    const actions = document.createElement("div");
    actions.className = "account-actions";
    const addButton = (label, onClick, primary = false) => {
      const button = document.createElement("button");
      button.className = primary ? "btn btn-sm btn-primary" : "btn btn-sm";
      button.textContent = label;
      button.addEventListener("click", onClick);
      actions.appendChild(button);
      return button;
    };

    if (account.status === "pending") {
      addButton("Pay invoice", () => openPaymentView(account.paymentHash, "signup"), true);
    } else if (account.status === "active") {
      addButton("Inbox", () => {
        send("inbox:open", { email: account.email }).then(() => window.close());
      }, true);
    } else if (account.renewal) {
      addButton(
        "Pay renewal",
        () => openPaymentView(account.renewal.paymentHash, "renewal"),
        true,
      );
    } else {
      addButton("Renew", () => openRenewView(account.email), true);
    }
    addButton("Copy email", async (event) => {
      await navigator.clipboard.writeText(account.email);
      event.target.textContent = "Copied";
      setTimeout(() => (event.target.textContent = "Copy email"), 1200);
    });
    addButton("Copy token", async (event) => {
      await navigator.clipboard.writeText(account.token);
      event.target.textContent = "Copied";
      setTimeout(() => (event.target.textContent = "Copy token"), 1200);
    });
    if (account.status === "active") {
      if (account.renewal) {
        addButton("Pay renewal", () =>
          openPaymentView(account.renewal.paymentHash, "renewal"),
        );
      } else {
        addButton("Renew", () => openRenewView(account.email));
      }
    }
    // Two-step inline confirmation: window.confirm is unreliable in
    // Firefox extension popups.
    const forgetBtn = addButton("Forget", async () => {
      if (forgetBtn.dataset.armed !== "true") {
        forgetBtn.dataset.armed = "true";
        forgetBtn.textContent = "Really forget?";
        setTimeout(() => {
          forgetBtn.dataset.armed = "false";
          forgetBtn.textContent = "Forget";
        }, 3000);
        return;
      }
      await send("accounts:delete", { email: account.email });
      await refreshState();
      renderAccounts();
    });

    item.appendChild(actions);
    list.appendChild(item);
  }
}

/* ------------------------------------------------------------------ */
/* Payment view                                                        */
/* ------------------------------------------------------------------ */

function findPayment(paymentHash) {
  for (const account of state.accounts) {
    if (account.paymentHash === paymentHash && account.status === "pending") {
      return {
        kind: "signup",
        email: account.email,
        request: account.paymentRequest,
        sats: account.priceSats,
        provider: account.provider,
      };
    }
    if (account.renewal?.paymentHash === paymentHash) {
      return {
        kind: "renewal",
        email: account.email,
        request: account.renewal.paymentRequest,
        sats: account.renewal.priceSats,
        provider: account.renewal.provider,
      };
    }
  }
  return null;
}

function openPaymentView(paymentHash, kind) {
  const payment = findPayment(paymentHash);
  if (!payment) {
    showView("viewList");
    renderAccounts();
    return;
  }
  currentPayment = { paymentHash, kind: kind ?? payment.kind, email: payment.email };

  $("paymentTitle").textContent =
    payment.kind === "renewal"
      ? `Renew for ${payment.sats} sats`
      : `Pay ${payment.sats} sats to activate`;
  $("paymentSubtitle").textContent = payment.email;

  const invoice = payment.request ?? "";
  const android = isAndroidUserAgent(navigator.userAgent);
  let validInvoice = true;
  try {
    $("walletLink").href = walletUri(invoice, { android });
  } catch {
    validInvoice = false;
    $("walletLink").removeAttribute("href");
  }
  $("walletLink").classList.toggle("hidden", !validInvoice);
  $("qrContainer").classList.toggle("hidden", !validInvoice);
  $("qrContainer").replaceChildren(
    ...(validInvoice
      ? [createQrSvg(invoice.toUpperCase(), { ecc: "L", border: 4 })]
      : []),
  );
  $("copyInvoiceBtn").disabled = !validInvoice;
  $("copyInvoiceBtn").onclick = async () => {
    await navigator.clipboard.writeText(invoice);
    setStatus("paymentStatus", "Invoice copied to clipboard", "success");
  };
  $("payNwcBtn").classList.toggle(
    "hidden",
    !validInvoice || !state.settings?.nwcUri,
  );
  $("payNwcBtn").onclick = async () => {
    $("payNwcBtn").disabled = true;
    setStatus("paymentStatus", "Paying with connected wallet...");
    try {
      await send("payments:payNwc", { paymentHash: currentPayment.paymentHash });
      setStatus("paymentStatus", "Payment sent, waiting for confirmation...", "success");
    } catch (error) {
      setStatus("paymentStatus", error.message, "error");
      $("payNwcBtn").disabled = false;
    }
  };
  $("reissueBtn").classList.toggle("hidden", !reissueAvailable);
  $("reissueBtn").onclick = async () => {
    setStatus("paymentStatus", "Requesting a new invoice...");
    try {
      await send("payments:reissue", {
        paymentHash: currentPayment.paymentHash,
        excludeProvider: payment.provider,
      });
      await refreshState();
      const account = state.accounts.find((item) => item.email === payment.email);
      const newHash =
        payment.kind === "renewal"
          ? account?.renewal?.paymentHash
          : account?.paymentHash;
      if (newHash) openPaymentView(newHash, payment.kind);
    } catch (error) {
      setStatus("paymentStatus", error.message, "error");
    }
  };

  setStatus(
    "paymentStatus",
    validInvoice
      ? "Waiting for payment..."
      : "This invoice is invalid. Go back and try again later.",
    validInvoice ? "" : "error",
  );
  showView("viewPayment");
  startPolling();
}

function onPaymentSettled() {
  if (!currentPayment) return;
  setStatus(
    "paymentStatus",
    currentPayment.kind === "renewal"
      ? "Renewal confirmed."
      : "Payment confirmed. Your inbox is ready.",
    "success",
  );
  currentPayment = null;
  stopPolling();
  setTimeout(() => {
    showView("viewList");
    renderAccounts();
  }, 1500);
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!currentPayment) return;
    try {
      await send("payments:check", {
        paymentHash: currentPayment.paymentHash,
        kind: currentPayment.kind,
      });
      await refreshState();
      if (!findPayment(currentPayment.paymentHash)) {
        onPaymentSettled();
      }
    } catch {
      // Transient errors: keep polling.
    }
  }, 3000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ------------------------------------------------------------------ */
/* Renewal view                                                        */
/* ------------------------------------------------------------------ */

function openRenewView(email) {
  $("renewEmail").textContent = email;
  setStatus("renewStatus", "");
  $("renewStartBtn").disabled = false;
  $("renewStartBtn").onclick = async () => {
    $("renewStartBtn").disabled = true;
    setStatus("renewStatus", "Creating renewal invoice...");
    try {
      const years = Number($("renewYears").value);
      const { account } = await send("renewal:create", { email, years });
      await refreshState();
      openPaymentView(account.renewal.paymentHash, "renewal");
    } catch (error) {
      setStatus("renewStatus", error.message, "error");
      $("renewStartBtn").disabled = false;
    }
  };
  showView("viewRenew");
}

/* ------------------------------------------------------------------ */
/* Header actions and boot                                             */
/* ------------------------------------------------------------------ */

async function checkPermissions() {
  try {
    const granted = await ext.permissions.contains({
      origins: ["<all_urls>"],
    });
    $("permissionBanner").classList.toggle("hidden", granted);
  } catch {
    $("permissionBanner").classList.add("hidden");
  }
}

async function boot() {
  await refreshState();
  await send("polling:activate");
  renderAccounts();
  checkPermissions();

  // Live refresh: the background writes every state change (payment
  // settled, renewal done, unread counts, autofill usage) to
  // storage.local, so re-render whenever accounts change instead of
  // relying on the user to reopen the popup.
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.accounts) return;
    refreshState()
      .then(() => {
        if (currentPayment && !findPayment(currentPayment.paymentHash)) {
          onPaymentSettled();
        } else if (!$("viewList").classList.contains("hidden")) {
          renderAccounts();
        }
      })
      .catch(() => {});
  });

  // Unread counts: refresh on open and periodically while open. The
  // results land in storage, so rendering happens via the listener.
  send("accounts:unread").catch(() => {});
  setInterval(() => send("accounts:unread").catch(() => {}), 30_000);

  send("health:get")
    .then((health) => {
      reissueAvailable = Boolean(health?.reissue_available);
    })
    .catch(() => {});

  $("searchInput").addEventListener("input", renderAccounts);
  $("importAccountBtn").addEventListener("click", () => {
    setStatus("importStatus", "");
    showView("viewImport");
    $("importToken").focus();
  });
  $("importBackBtn").addEventListener("click", () => {
    showView("viewList");
    renderAccounts();
  });
  $("importAccountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = $("importToken").value.trim();
    $("importSubmitBtn").disabled = true;
    setStatus("importStatus", "Validating account...");
    try {
      const { account, added } = await send("accounts:import", { token });
      await refreshState();
      $("importToken").value = "";
      showView("viewList");
      renderAccounts();
      setStatus(
        "listStatus",
        added ? `Imported ${account.email}` : `Updated ${account.email}`,
        "success",
      );
    } catch (error) {
      setStatus("importStatus", error.message, "error");
    } finally {
      $("importSubmitBtn").disabled = false;
    }
  });
  $("settingsBtn").addEventListener("click", () => ext.runtime.openOptionsPage());
  $("backBtn").addEventListener("click", () => {
    showView("viewList");
    renderAccounts();
  });
  $("renewBackBtn").addEventListener("click", () => {
    showView("viewList");
    renderAccounts();
  });
  $("grantPermissionsBtn").addEventListener("click", async () => {
    await ext.permissions.request({ origins: ["<all_urls>"] });
    checkPermissions();
  });
  $("newAccountBtn").addEventListener("click", async () => {
    $("newAccountBtn").disabled = true;
    setStatus("listStatus", "Creating a new address...");
    try {
      const { account, willAutoPay } = await send("accounts:create", {});
      await refreshState();
      setStatus("listStatus", "");
      openPaymentView(account.paymentHash, "signup");
      if (willAutoPay) {
        setStatus("paymentStatus", "Paying with your connected wallet...");
      }
    } catch (error) {
      setStatus("listStatus", `Could not create an address: ${error.message}`, "error");
    } finally {
      $("newAccountBtn").disabled = false;
    }
  });

  // Standalone payment window deep links.
  const params = new URLSearchParams(window.location.search);
  const payHash = params.get("pay");
  const renewEmail = params.get("renew");
  if (payHash) {
    openPaymentView(payHash);
  } else if (renewEmail) {
    openRenewView(renewEmail);
  }
}

boot().catch((error) => {
  document.body.textContent = `Failed to load: ${error.message}`;
});
