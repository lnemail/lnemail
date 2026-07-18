/**
 * Autofill content script.
 *
 * Adds a small LNemail button to email fields. Clicking it opens a menu
 * (in a shadow root, so page CSS cannot interfere) offering addresses
 * already used on this site plus "New LNemail address". Password
 * managers keep their usual role of saving the site credentials.
 */

const ext = globalThis.browser ?? globalThis.chrome;

const BUTTON_SIZE = 20;
const EMAIL_HINT_RE = /e-?mail/i;

let shadowHost = null;
let shadowRoot = null;
let anchorInput = null;
let hideTimer = null;

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

/**
 * Heuristic: is this input an email field?
 *
 * @param {Element} input Candidate element.
 * @returns {boolean} True for likely email inputs.
 */
function isEmailInput(input) {
  if (!(input instanceof HTMLInputElement)) return false;
  if (input.disabled || input.readOnly) return false;
  if (input.type === "email") return true;
  if (input.type !== "text") return false;
  const hints = [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute("autocomplete") ?? "",
    input.getAttribute("aria-label") ?? "",
  ].join(" ");
  return EMAIL_HINT_RE.test(hints);
}

/**
 * Set an input value the way frameworks expect (native setter + events).
 *
 * @param {HTMLInputElement} input Target input.
 * @param {string} value Value to set.
 */
function fillInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function ensureShadow() {
  if (shadowRoot) return;
  shadowHost = document.createElement("div");
  shadowHost.style.all = "initial";
  shadowHost.style.position = "absolute";
  shadowHost.style.top = "0";
  shadowHost.style.left = "0";
  shadowHost.style.zIndex = "2147483647";
  // "open" mode: closed shadow roots are not a security boundary, and
  // open roots let the Playwright e2e suite (and curious users) inspect
  // the widget.
  shadowRoot = shadowHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .btn {
      position: absolute;
      width: ${BUTTON_SIZE}px;
      height: ${BUTTON_SIZE}px;
      border-radius: 4px;
      border: none;
      padding: 0;
      cursor: pointer;
      background: #f7931a;
      color: #14100a;
      font: bold 12px/1 system-ui, sans-serif;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .menu {
      position: absolute;
      min-width: 240px;
      background: #171a21;
      color: #e6e8ec;
      border: 1px solid #2a2f3a;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      font: 13px system-ui, sans-serif;
      display: none;
      overflow: hidden;
    }
    .menu-item {
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      color: inherit;
      padding: 9px 12px;
      cursor: pointer;
      font: inherit;
    }
    .menu-item:hover { background: #232836; }
    .menu-item .mono {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      display: block;
      word-break: break-all;
    }
    .menu-item .dim { color: #9aa1ad; font-size: 11px; }
    .menu-header {
      padding: 8px 12px 4px;
      color: #9aa1ad;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
  `;
  shadowRoot.appendChild(style);

  const button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  button.textContent = "\u26A1";
  button.title = "Fill with an LNemail address";
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", onButtonClick);
  shadowRoot.appendChild(button);

  const menu = document.createElement("div");
  menu.className = "menu";
  shadowRoot.appendChild(menu);

  document.documentElement.appendChild(shadowHost);
  document.addEventListener("mousedown", (event) => {
    if (event.target !== shadowHost) hideMenu();
  });
}

function getButton() {
  return shadowRoot.querySelector(".btn");
}

function getMenu() {
  return shadowRoot.querySelector(".menu");
}

function positionForInput(input) {
  const rect = input.getBoundingClientRect();
  return {
    top: window.scrollY + rect.top + (rect.height - BUTTON_SIZE) / 2,
    left: window.scrollX + rect.right - BUTTON_SIZE - 6,
    menuTop: window.scrollY + rect.bottom + 4,
    menuLeft: window.scrollX + rect.left,
  };
}

function showButton(input) {
  ensureShadow();
  anchorInput = input;
  const { top, left } = positionForInput(input);
  const button = getButton();
  button.style.top = `${top}px`;
  button.style.left = `${left}px`;
  button.style.display = "flex";
}

function hideButton() {
  if (!shadowRoot) return;
  getButton().style.display = "none";
}

function hideMenu() {
  if (!shadowRoot) return;
  getMenu().style.display = "none";
}

async function onButtonClick() {
  if (!anchorInput) return;
  const menu = getMenu();
  const { menuTop, menuLeft } = positionForInput(anchorInput);
  menu.style.top = `${menuTop}px`;
  menu.style.left = `${menuLeft}px`;
  menu.innerHTML = "";

  const header = document.createElement("div");
  header.className = "menu-header";
  header.textContent = "LNemail";
  menu.appendChild(header);

  let existing = [];
  try {
    const result = await send("autofill:accounts", {
      domain: location.hostname,
    });
    existing = result.accounts;
  } catch {
    // Background unavailable; still offer creating a new address.
  }

  for (const account of existing) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item";
    item.innerHTML =
      `<span class="mono"></span>` +
      `<span class="dim">used here before` +
      `${account.status === "pending" ? " (awaiting payment)" : ""}</span>`;
    item.querySelector(".mono").textContent = account.email;
    item.addEventListener("click", () => {
      fillInput(anchorInput, account.email);
      send("autofill:used", {
        email: account.email,
        domain: location.hostname,
      }).catch(() => {});
      hideMenu();
    });
    menu.appendChild(item);
  }

  const createItem = document.createElement("button");
  createItem.type = "button";
  createItem.className = "menu-item";
  createItem.innerHTML =
    `<span class="mono">New LNemail address</span>` +
    `<span class="dim">fresh Lightning-paid inbox for this site</span>`;
  createItem.addEventListener("click", async () => {
    createItem.disabled = true;
    createItem.querySelector(".dim").textContent = "Creating...";
    try {
      const result = await send("autofill:new", {
        domain: location.hostname,
        url: location.href,
      });
      fillInput(anchorInput, result.email);
      hideMenu();
    } catch (error) {
      createItem.querySelector(".dim").textContent = `Failed: ${error.message}`;
      createItem.disabled = false;
    }
  });
  menu.appendChild(createItem);

  menu.style.display = "block";
}

function onFocusIn(event) {
  const target = event.target;
  clearTimeout(hideTimer);
  if (isEmailInput(target)) {
    showButton(target);
  } else {
    hideButton();
    hideMenu();
  }
}

function onFocusOut() {
  // Delay so clicks on the button/menu are not cancelled by blur.
  hideTimer = setTimeout(() => {
    hideButton();
  }, 250);
}

async function main() {
  let enabled = true;
  try {
    const stored = await ext.storage.local.get("settings");
    enabled = stored.settings?.autofillEnabled ?? true;
    const apiBase = stored.settings?.apiBase ?? "https://lnemail.net";
    // Never decorate the LNemail site itself.
    if (location.origin === new URL(apiBase).origin) return;
  } catch {
    // Default to enabled if settings are unreadable.
  }

  // Context-menu fill requests work even with the button disabled.
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "lnemail:fill") return false;
    const active = document.activeElement;
    const target = isEmailInput(active)
      ? active
      : document.querySelector('input[type="email"]');
    if (target) {
      fillInput(target, message.email);
      send("autofill:used", {
        email: message.email,
        domain: location.hostname,
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  });

  if (!enabled) return;
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
}

main();
