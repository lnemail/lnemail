"""Signup + login e2e flow.

Covers the full first-time user journey:
  1. Open the public landing page.
  2. Create a Lightning invoice and pay it from the regtest router LND.
  3. Read back the issued credentials from the success card.
  4. Visit /inbox in the *same* browser context (same localStorage):
     the user should be auto-logged-in, no token re-entry needed.
  5. Open /inbox in a *fresh, isolated* browser context, paste the
     access token, and verify the same account loads. This is the
     "log in from another device" scenario.
"""

from __future__ import annotations

from playwright.sync_api import Browser, Page, expect

from .helpers import login_with_token, signup_and_pay


def test_signup_pay_and_token_works_on_other_device(
    page: Page,
    browser: Browser,
    browser_context_args,
    pay_invoice,
):
    account = signup_and_pay(page, pay_invoice)

    # 1) After payment success, the landing page persisted the token to
    #    localStorage. Following the "Go to Inbox" link should auto-login.
    page.locator('a[href="/inbox"].btn.primary').click()
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
