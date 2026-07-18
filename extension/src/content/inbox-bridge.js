/**
 * Inbox bridge content script (runs at document_start on every page,
 * exits immediately unless the path is /inbox).
 *
 * When the background worker opened this tab via "open inbox", it holds
 * a one-shot token for this tab id. The bridge fetches it and places it
 * in localStorage before the page scripts run, so the inbox
 * auto-connects to the selected account.
 */

const ext = globalThis.browser ?? globalThis.chrome;

async function main() {
  if (location.pathname !== "/inbox") return;
  let response;
  try {
    response = await ext.runtime.sendMessage({
      type: "inbox:getToken",
      url: location.href,
    });
  } catch {
    return; // Background not reachable; normal page load.
  }
  const token = response?.ok ? response.result?.token : null;
  if (!token) return;
  try {
    localStorage.setItem("lnemail_access_token", token);
  } catch {
    return;
  }
  // The inbox auto-connect logic reads localStorage during page init.
  // If the page already initialized before the token arrived, reload
  // once so it picks the token up.
  if (document.readyState !== "loading") {
    location.reload();
  }
}

main();
