"""High-level UI helpers (a thin page-object layer).

These wrap the most important user journeys so the actual test bodies
read like prose and stay resilient to small UI tweaks. They never
import application code: they speak only HTTP and DOM, exactly like a
real user would.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from playwright.sync_api import Page, expect


# Match the polling intervals in static/js/improved/config.js (3s/5s)
# plus generous slack for CI.
PAYMENT_TIMEOUT_MS = 30_000
INBOX_TIMEOUT_MS = 30_000


@dataclass(frozen=True)
class Account:
    email: str
    token: str


def signup_and_pay(
    page: Page,
    pay_invoice: Callable[[str], str],
) -> Account:
    """Drive the public signup flow end-to-end and return credentials.

    Steps:
      1. Open ``/`` and click "Create Lightning Invoice".
      2. Capture the BOLT11 invoice from the API response.
      3. Pay it from the router LND container.
      4. Wait for the success card and read email + token from the form.
    """
    page.goto("/")

    expect(page.locator("#create-invoice")).to_be_visible()

    with page.expect_response(
        lambda r: r.url.endswith("/api/v1/email") and r.request.method == "POST"
    ) as resp_info:
        page.locator("#create-invoice").click()
    invoice_payload = resp_info.value.json()
    bolt11 = invoice_payload["payment_request"]
    assert bolt11, f"No payment_request in response: {invoice_payload}"

    expect(page.locator("#payment-pending")).to_be_visible()

    pay_invoice(bolt11)

    expect(page.locator("#payment-success")).to_be_visible(timeout=PAYMENT_TIMEOUT_MS)

    email = page.locator("#email-address-input").input_value()
    token = page.locator("#access-token-input").input_value()
    assert email.endswith(("@lnemail.test", "@lnemail.net")), email
    assert token.startswith("lne_") or token, token
    return Account(email=email, token=token)


def login_with_token(page: Page, token: str) -> None:
    """Navigate to /inbox and ensure the user is logged in with ``token``.

    If the page already has the token in localStorage, the frontend
    auto-connects and the modal never appears - that's a valid logged-in
    state and we just wait for ``#mainApp``. Otherwise, we paste the
    token into the modal and click Connect.

    Note: ``#connectBtn`` stays disabled until the periodic /api/health
    check passes, so we wait for it to become enabled rather than
    relying on a fixed sleep.
    """
    page.goto("/inbox")

    main_app = page.locator("#mainApp")
    token_modal = page.locator("#tokenModal.active")

    # Race: either main app shows up (auto-connected) or the modal is active.
    page.wait_for_function(
        """() => {
            const m = document.getElementById('mainApp');
            const t = document.getElementById('tokenModal');
            return (m && m.offsetParent !== null) ||
                   (t && t.classList.contains('active'));
        }""",
        timeout=15_000,
    )

    if main_app.is_visible():
        # Already authenticated via localStorage - nothing more to do.
        return

    expect(token_modal).to_be_visible()
    page.locator("#accessToken").fill(token)

    connect = page.locator("#connectBtn")
    expect(connect).to_be_enabled(timeout=15_000)
    connect.click()

    expect(main_app).to_be_visible(timeout=15_000)
    expect(page.locator("#tokenModal")).not_to_be_visible()


def open_inbox_view(page: Page) -> None:
    page.locator('[data-view="inbox"]').first.click()
    expect(page.locator("#inboxView")).to_be_visible()


def compose_and_send(
    page: Page,
    pay_invoice: Callable[[str], str],
    *,
    recipient: str,
    subject: str,
    body: str,
) -> None:
    """Open the compose view, fill it, pay the send invoice, wait for delivery."""
    page.locator("#composeBtn").click()
    expect(page.locator("#composeForm")).to_be_visible()

    page.locator("#recipient").fill(recipient)
    page.locator("#subject").fill(subject)
    page.locator("#body").fill(body)

    with page.expect_response(
        lambda r: r.url.endswith("/api/v1/email/send") and r.request.method == "POST"
    ) as resp_info:
        page.locator('#composeForm button[type="submit"]').click()
    payload = resp_info.value.json()
    bolt11 = payload["payment_request"]
    assert bolt11, payload

    expect(page.locator("#paymentModal")).to_be_visible()

    pay_invoice(bolt11)

    expect(page.locator("#paymentStatusText")).to_contain_text(
        "delivered", ignore_case=True, timeout=PAYMENT_TIMEOUT_MS
    )

    # After delivery the cancel button is renamed to "Close". Click it
    # to dismiss the modal so the inbox is interactable again.
    close_btn = page.locator("#cancelPaymentBtn")
    expect(close_btn).to_contain_text("Close", timeout=5_000)
    close_btn.click()
    expect(page.locator("#paymentModal")).not_to_be_visible()


def wait_for_email(page: Page, *, subject_contains: str) -> None:
    """Wait until an email whose subject contains ``subject_contains`` shows up.

    The inbox refreshes itself every 5s; we also click the manual
    refresh button to nudge it, which is what an impatient user would do.
    """
    open_inbox_view(page)
    item = page.locator(".inbox-email-row", has_text=subject_contains).first
    try:
        expect(item).to_be_visible(timeout=INBOX_TIMEOUT_MS)
    except AssertionError:
        # One last manual refresh before failing.
        page.locator("#refreshBtn").click()
        expect(item).to_be_visible(timeout=10_000)


def open_email(page: Page, *, subject_contains: str) -> None:
    item = page.locator(".inbox-email-row", has_text=subject_contains).first
    expect(item).to_be_visible()
    item.click()
    expect(page.locator("#emailDetailView")).to_be_visible()
    expect(page.locator("#emailSubject")).to_contain_text(subject_contains)
