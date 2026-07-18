/**
 * Autofill content script.
 *
 * Adds a small LNemail button to email fields. Clicking it opens a menu
 * (in a shadow root, so page CSS cannot interfere) listing every saved
 * account, with the ones already used on this site first, plus "New
 * LNemail address". The new-address flow fills the field immediately
 * (before the invoice settles) so the signup is never blocked on the
 * payment; the invoice is then auto-paid via NWC or shown in a payment
 * window. Password managers keep their usual role of saving the site
 * credentials.
 */

const ext = globalThis.browser ?? globalThis.chrome;

const BUTTON_SIZE = 20;
const EMAIL_HINT_RE = /e-?mail/i;

let shadowHost = null;
let shadowRoot = null;
let anchorInput = null;
let hideTimer = null;

/**
 * Log an error with a stable prefix so users can report issues.
 *
 * @param {string} where Failing operation.
 * @param {unknown} error Error value.
 */
function logError(where, error) {
  console.error(`[LNemail] ${where}:`, error);
}

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
      padding: 2px;
      cursor: pointer;
      background: #171a21;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .btn img { width: 100%; height: 100%; display: block; }
    .menu {
      position: absolute;
      min-width: 260px;
      max-width: 320px;
      max-height: 320px;
      overflow-y: auto;
      background: #171a21;
      color: #e6e8ec;
      border: 1px solid #2a2f3a;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      font: 13px system-ui, sans-serif;
      display: none;
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
    .menu-item .err { color: #f85149; font-size: 11px; }
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
  button.title = "Fill with an LNemail address";
  const logo = document.createElement("img");
  logo.src = ext.runtime.getURL("icons/icon32.png");
  logo.alt = "LNemail";
  button.appendChild(logo);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    onButtonClick().catch((error) => logError("menu", error));
  });
  shadowRoot.appendChild(button);

  const menu = document.createElement("div");
  menu.className = "menu";
  // Keep focus on the input while interacting with the menu: without
  // this, mousedown on a menu item blurs the input, the focus handler
  // hides the menu before mouseup, and the click never fires.
  menu.addEventListener("mousedown", (event) => event.preventDefault());
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

/**
 * Append a menu entry.
 *
 * @param {HTMLElement} menu Menu container.
 * @param {{title: string, subtitle: string, onClick: Function}} spec
 * @returns {HTMLButtonElement} The created item.
 */
function addMenuItem(menu, { title, subtitle, onClick }) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "menu-item";
  const titleEl = document.createElement("span");
  titleEl.className = "mono";
  titleEl.textContent = title;
  const subtitleEl = document.createElement("span");
  subtitleEl.className = "dim";
  subtitleEl.textContent = subtitle;
  item.append(titleEl, subtitleEl);
  item.addEventListener("click", () => onClick(item, subtitleEl));
  menu.appendChild(item);
  return item;
}

function addMenuHeader(menu, text) {
  const header = document.createElement("div");
  header.className = "menu-header";
  header.textContent = text;
  menu.appendChild(header);
}

async function onButtonClick() {
  if (!anchorInput) return;
  const menu = getMenu();
  const { menuTop, menuLeft } = positionForInput(anchorInput);
  menu.style.top = `${menuTop}px`;
  menu.style.left = `${menuLeft}px`;
  menu.innerHTML = "";
  menu.style.display = "block";

  const fillWith = (email) => {
    fillInput(anchorInput, email);
    send("autofill:used", { email, domain: location.hostname }).catch((error) =>
      logError("autofill:used", error),
    );
    hideMenu();
  };

  let accounts = [];
  let loadErrorMessage = null;
  try {
    const result = await send("autofill:accounts", {
      domain: location.hostname,
    });
    accounts = result.accounts;
  } catch (error) {
    logError("autofill:accounts", error);
    loadErrorMessage = error.message;
  }

  const usedHere = accounts.filter((account) => account.usedHere);
  const others = accounts.filter((account) => !account.usedHere);

  if (usedHere.length > 0) {
    addMenuHeader(menu, "Used on this site");
    for (const account of usedHere) {
      addMenuItem(menu, {
        title: account.email,
        subtitle:
          account.status === "pending" ? "awaiting payment" : "used here before",
        onClick: () => fillWith(account.email),
      });
    }
  }
  if (others.length > 0) {
    addMenuHeader(menu, usedHere.length > 0 ? "Other accounts" : "Your accounts");
    for (const account of others) {
      const origin = account.lastDomain ? `used on ${account.lastDomain}` : "unused";
      addMenuItem(menu, {
        title: account.email,
        subtitle:
          account.status === "pending" ? `awaiting payment, ${origin}` : origin,
        onClick: () => fillWith(account.email),
      });
    }
  }

  addMenuHeader(menu, "LNemail");
  addMenuItem(menu, {
    title: "New LNemail address",
    subtitle: "fresh Lightning-paid inbox, filled instantly",
    onClick: async (item, subtitleEl) => {
      item.disabled = true;
      subtitleEl.textContent = "Creating...";
      try {
        const result = await send("autofill:new", {
          domain: location.hostname,
          url: location.href,
        });
        fillInput(anchorInput, result.email);
        hideMenu();
      } catch (error) {
        logError("autofill:new", error);
        subtitleEl.className = "err";
        subtitleEl.textContent = `Failed: ${error.message}`;
        item.disabled = false;
      }
    },
  });

  if (loadErrorMessage) {
    const errorEl = document.createElement("div");
    errorEl.className = "menu-header";
    errorEl.style.color = "#f85149";
    errorEl.textContent = `Could not load saved accounts: ${loadErrorMessage}`;
    menu.appendChild(errorEl);
  }
}

function onFocusIn(event) {
  const target = event.target;
  // Focus moving into our own widget (retargeted to the host) must not
  // dismiss it.
  if (target === shadowHost) return;
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
  } catch (error) {
    // Default to enabled if settings are unreadable.
    logError("settings read", error);
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
      }).catch((error) => logError("autofill:used", error));
    }
    sendResponse({ ok: true });
    return false;
  });

  if (!enabled) return;
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
}

main().catch((error) => logError("init", error));
