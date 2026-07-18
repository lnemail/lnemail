"""Browser-extension e2e flows (Chromium only).

Loads the built extension (``extension/dist/chrome``) into a persistent
Chromium context and drives the real user journeys against the running
dev stack:

  1. Create an address from the popup, pay the invoice over the regtest
     channel, watch it flip to active, and open the inbox in one click
     (token handoff + auto-connect).
  2. On a third-party signup page, use the autofill button injected on
     the email field to create and fill a brand-new address, then pay
     its invoice and verify the account activates with the right
     source-domain metadata.

Playwright only supports extensions in Chromium via a persistent
context, so this module manages its own context instead of using the
default ``page`` fixture wiring (the local ``page`` override keeps the
shared screenshot-on-failure hook working).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import BrowserContext, Page, Playwright, expect

from .conftest import ARTIFACTS_DIR

REPO_ROOT = Path(__file__).resolve().parents[2]
EXTENSION_DIR = REPO_ROOT / "extension"
EXTENSION_DIST = EXTENSION_DIR / "dist" / "chrome"

PAYMENT_TIMEOUT_MS = 30_000


@pytest.fixture(scope="session")
def extension_dist() -> Path:
    """Path to the built Chrome extension, building it if possible."""
    if not EXTENSION_DIST.exists():
        bun = shutil.which("bun")
        if bun is None:
            pytest.skip(
                "extension/dist/chrome is missing and bun is not installed; "
                "run `bun install && bun run build` in extension/ first"
            )
        assert bun is not None
        subprocess.run([bun, "install"], cwd=EXTENSION_DIR, check=True)
        subprocess.run([bun, "run", "build"], cwd=EXTENSION_DIR, check=True)
    return EXTENSION_DIST


@pytest.fixture
def extension_context(
    playwright: Playwright,
    request: pytest.FixtureRequest,
    tmp_path: Path,
    base_url: str,
    extension_dist: Path,
) -> Iterator[BrowserContext]:
    """Persistent Chromium context with the extension loaded.

    Extensions need a persistent context. In headless runs, Chromium's
    "new" headless mode (which supports extensions) is selected via the
    ``--headless=new`` switch while Playwright itself is told
    ``headless=False``.
    """
    args = [
        f"--disable-extensions-except={extension_dist}",
        f"--load-extension={extension_dist}",
    ]
    if not request.config.getoption("--headed"):
        args.append("--headless=new")
    videos_dir = ARTIFACTS_DIR / "videos"
    videos_dir.mkdir(parents=True, exist_ok=True)
    context = playwright.chromium.launch_persistent_context(
        str(tmp_path / "profile"),
        headless=False,
        args=args,
        base_url=base_url,
        viewport={"width": 1280, "height": 800},
        record_video_dir=str(videos_dir),
    )
    yield context
    context.close()


@pytest.fixture
def page(extension_context: BrowserContext) -> Page:
    """Override the default page fixture with one from the extension
    context, so shared hooks (screenshot-on-failure) keep working."""
    return extension_context.new_page()


@pytest.fixture
def background(extension_context: BrowserContext, base_url: str) -> Any:
    """The extension's MV3 service worker, with the API base pointed at
    the dev stack."""
    if extension_context.service_workers:
        worker = extension_context.service_workers[0]
    else:
        worker = extension_context.wait_for_event("serviceworker", timeout=15_000)
    worker.evaluate(
        "(apiBase) => chrome.storage.local.set({ settings: { apiBase } })",
        base_url,
    )
    return worker


def extension_id(background: Any) -> str:
    return str(background.url).split("/")[2]


def stored_accounts(background: Any) -> list[dict[str, Any]]:
    accounts = background.evaluate(
        "async () => (await chrome.storage.local.get('accounts')).accounts ?? []"
    )
    return list(accounts)


def wait_for(
    predicate: Callable[[], Any], *, timeout_s: float = 30, interval_s: float = 0.5
) -> Any:
    """Poll ``predicate`` until it returns a truthy value or times out."""
    deadline = time.monotonic() + timeout_s
    last: Any = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval_s)
    raise AssertionError(f"Condition not met within {timeout_s}s (last: {last!r})")


@pytest.fixture
def signup_site() -> Iterator[str]:
    """Tiny local site with an email field, standing in for any
    third-party signup form."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
            body = (
                b"<!doctype html><html><body>"
                b"<h1>Example signup</h1>"
                b'<form><label>Email <input type="email" id="email" '
                b'name="email"></label></form>'
                b"</body></html>"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_popup_signup_pay_and_open_inbox(
    page: Page,
    background: Any,
    extension_context: BrowserContext,
    pay_invoice: Callable[[str], str],
) -> None:
    """Create an account from the popup, pay it, and jump to its inbox."""
    page.goto(f"chrome-extension://{extension_id(background)}/popup.html")

    page.locator("#newAccountBtn").click()
    # No NWC wallet configured: the manual payment view (QR) opens.
    expect(page.locator("#viewPayment")).to_be_visible(timeout=15_000)

    accounts = wait_for(lambda: stored_accounts(background))
    assert accounts[0]["status"] == "pending"
    pay_invoice(accounts[0]["paymentRequest"])

    expect(page.locator("#paymentStatus")).to_contain_text(
        "confirmed", ignore_case=True, timeout=PAYMENT_TIMEOUT_MS
    )
    # The popup returns to the account list with the account active.
    expect(page.locator("#viewList")).to_be_visible(timeout=10_000)
    expect(page.locator(".tag-active").first).to_be_visible()

    with extension_context.expect_page() as page_info:
        page.locator(".account-actions button", has_text="Inbox").first.click()
    inbox = page_info.value
    inbox.wait_for_url("**/inbox**", timeout=15_000)
    # The bridge hands over the token and the inbox auto-connects: the
    # main app appears without any manual token entry.
    expect(inbox.locator("#mainApp")).to_be_visible(timeout=20_000)
    expect(inbox.locator("#tokenModal.active")).not_to_be_visible()

    # Reopening the popup triggers an unread-count refresh for active
    # accounts, persisted on the account record.
    popup = extension_context.new_page()
    popup.goto(f"chrome-extension://{extension_id(background)}/popup.html")
    wait_for(
        lambda: any(
            a.get("unreadCount") is not None for a in stored_accounts(background)
        )
    )
    expect(popup.locator(".account-meta", has_text="unread").first).to_be_visible(
        timeout=10_000
    )


def test_autofill_creates_fills_and_activates_account(
    page: Page,
    background: Any,
    signup_site: str,
    pay_invoice: Callable[[str], str],
) -> None:
    """Use the injected email-field button on a third-party page."""
    page.goto(signup_site)
    page.wait_for_load_state("domcontentloaded")

    email_input = page.locator("#email")
    email_input.click()

    fill_button = page.locator("[title='Fill with an LNemail address']")
    expect(fill_button).to_be_visible(timeout=10_000)
    fill_button.click()

    page.get_by_text("New LNemail address").click()
    expect(email_input).to_have_value(
        re.compile(r".+@lnemail\.(test|net)"), timeout=20_000
    )
    filled_email = email_input.input_value()

    accounts = wait_for(lambda: stored_accounts(background))
    account = next(a for a in accounts if a["email"] == filled_email)
    assert account["status"] == "pending"
    assert account["sourceDomain"] == "127.0.0.1"
    assert any(use["domain"] == "127.0.0.1" for use in account["usedOn"]), json.dumps(
        account["usedOn"]
    )

    # Without NWC auto-pay a payment window opened; pay manually instead
    # (same effect) and watch the background poller activate the account.
    pay_invoice(account["paymentRequest"])
    wait_for(
        lambda: any(
            a["email"] == filled_email and a["status"] == "active"
            for a in stored_accounts(background)
        ),
        timeout_s=90,
    )
