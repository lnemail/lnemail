"""Signup + login e2e flow.

Covers the full first-time user journey:
  1. Open the public landing page.
  2. Create a Lightning invoice and pay it from the regtest router LND.
  3. Read back the issued credentials from the success card.
  4. Click "Continue to Inbox": the login form should be pre-filled
     with the just-issued email + token (so the password manager has
     a credential pair to save), and a single click on Connect logs
     the user in. Critically, the user is NOT auto-logged-in -- the
     real <form> submit is what triggers Bitwarden / browser
     password-manager save heuristics.
  5. Open /inbox in a *fresh, isolated* browser context, paste the
     access token, and verify the same account loads. This is the
     "log in from another device" scenario.
"""

from __future__ import annotations

from typing import Any

from playwright.sync_api import Browser, Page, expect

from .helpers import login_with_token, signup_and_pay


def test_signup_pay_and_token_works_on_other_device(
    page: Page,
    browser: Browser,
    browser_context_args: dict[str, Any],
    pay_invoice: Any,
) -> None:
    account = signup_and_pay(page, pay_invoice)

    # 1) "Continue to Inbox" must land the user on the login form with
    #    email + token already filled in -- ready for a single Connect
    #    click that will trigger a password-manager save prompt.
    page.locator("#continue-to-inbox-btn").click()
    expect(page.locator("#tokenModal.active")).to_be_visible(timeout=15_000)

    email_input = page.locator("#loginEmail")
    token_input = page.locator("#accessToken")
    expect(email_input).to_have_value(account.email)
    expect(token_input).to_have_value(account.token)

    # User has not been auto-connected: the inbox is hidden until they
    # actually submit the form.
    expect(page.locator("#mainApp")).not_to_be_visible()

    connect = page.locator("#connectBtn")
    expect(connect).to_be_enabled(timeout=15_000)
    connect.click()

    expect(page.locator("#mainApp")).to_be_visible(timeout=15_000)
    expect(page.locator("#tokenModal")).not_to_be_visible()

    # 2) Now simulate a different device: a brand-new browser context
    #    has no localStorage, so the user must paste their token.
    other = browser.new_context(**browser_context_args)
    try:
        fresh_page = other.new_page()
        login_with_token(fresh_page, account.token)
        # Sanity check: the loaded account is the one we just created.
        # We don't depend on a specific selector for the email display
        # here (UI may change); instead we hit the API the same way the
        # frontend does, with the token as authentication.
        response = fresh_page.request.get(
            "/api/v1/account",
            headers={"Authorization": f"Bearer {account.token}"},
        )
        assert response.ok, response.text()
        assert response.json()["email_address"] == account.email
    finally:
        other.close()
