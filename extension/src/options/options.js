/**
 * Options page: service, wallet allowance, renewal, and backup settings.
 */

import { ext } from "../lib/browser.js";
import { monthlySpent } from "../lib/allowance.js";

const $ = (id) => document.getElementById(id);

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

function fillForm(settings) {
  $("apiBase").value = settings.apiBase;
  $("autofillEnabled").checked = settings.autofillEnabled;
  $("backgroundPollingEnabled").checked = settings.backgroundPollingEnabled;
  $("nwcUri").value = settings.nwcUri;
  $("autoPayEnabled").checked = settings.autoPayEnabled;
  $("autoRenewEnabled").checked = settings.autoRenewEnabled;
  $("renewDaysBefore").value = settings.renewDaysBefore;
}

function readForm() {
  return {
    apiBase: $("apiBase").value.trim().replace(/\/+$/, "") || "https://lnemail.net",
    autofillEnabled: $("autofillEnabled").checked,
    backgroundPollingEnabled: $("backgroundPollingEnabled").checked,
    nwcUri: $("nwcUri").value.trim(),
    autoPayEnabled: $("autoPayEnabled").checked,
    autoRenewEnabled: $("autoRenewEnabled").checked,
    renewDaysBefore: Math.min(
      365,
      Math.max(1, Number($("renewDaysBefore").value) || 30),
    ),
  };
}

async function updatePermissionState() {
  try {
    const granted = await ext.permissions.contains({ origins: ["<all_urls>"] });
    $("permissionState").textContent = granted
      ? "Site access granted."
      : "Site access not granted: autofill and custom API bases will not work.";
    $("grantPermissionsBtn").hidden = granted;
  } catch {
    $("permissionState").textContent = "";
  }
}

async function boot() {
  const state = await send("state:get");
  fillForm(state.settings);
  updatePermissionState();

  const spent = monthlySpent(state.spendHistory, Date.now());
  $("spendSummary").textContent =
    `Auto-paid in the last 30 days: ${spent} sats across ` +
    `${state.spendHistory.length} recorded payments.`;

  $("grantPermissionsBtn").addEventListener("click", async () => {
    await ext.permissions.request({ origins: ["<all_urls>"] });
    updatePermissionState();
  });

  $("testNwcBtn").addEventListener("click", async () => {
    const uri = $("nwcUri").value.trim();
    $("nwcTestResult").textContent = "Testing...";
    try {
      const result = await send("nwc:test", { uri });
      const sats =
        result.balanceMsats !== null
          ? `${Math.floor(result.balanceMsats / 1000)} sats available`
          : "connected";
      $("nwcTestResult").textContent = `Wallet OK (${sats}).`;
    } catch (error) {
      $("nwcTestResult").textContent = `Failed: ${error.message}`;
    }
  });

  $("saveBtn").addEventListener("click", async () => {
    try {
      await send("settings:set", { settings: readForm() });
      $("saveStatus").textContent = "Saved.";
      setTimeout(() => ($("saveStatus").textContent = ""), 2000);
    } catch (error) {
      $("saveStatus").textContent = `Failed: ${error.message}`;
    }
  });

  $("exportBtn").addEventListener("click", async () => {
    const current = await send("state:get");
    const blob = new Blob(
      [JSON.stringify({ accounts: current.accounts }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `lnemail-accounts-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    $("backupStatus").textContent = `Exported ${current.accounts.length} accounts.`;
  });

  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = Array.isArray(parsed) ? parsed : parsed.accounts;
      if (!Array.isArray(incoming)) throw new Error("No accounts array found");
      const current = await send("state:get");
      const byEmail = new Map(
        current.accounts.map((account) => [account.email, account]),
      );
      let added = 0;
      for (const account of incoming) {
        if (!account?.email || !account?.token) continue;
        if (!byEmail.has(account.email)) added += 1;
        byEmail.set(account.email, { ...byEmail.get(account.email), ...account });
      }
      await ext.storage.local.set({ accounts: [...byEmail.values()] });
      $("backupStatus").textContent =
        `Imported ${incoming.length} accounts (${added} new).`;
    } catch (error) {
      $("backupStatus").textContent = `Import failed: ${error.message}`;
    } finally {
      event.target.value = "";
    }
  });
}

boot().catch((error) => {
  document.body.textContent = `Failed to load: ${error.message}`;
});
