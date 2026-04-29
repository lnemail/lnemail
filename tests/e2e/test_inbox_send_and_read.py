"""Inbox flow: compose -> pay -> deliver -> read -> reply.

This is one big test on purpose: the goal is to assert the realistic
end-to-end behaviour of a paying user who sends an email to themselves,
sees it land in the inbox, opens it, replies, pays the reply invoice,
and sees the threaded reply arrive too.

Splitting this further would require multiple full payment cycles for
something that is fundamentally one user journey, and would slow the
suite down without finding additional bugs.
"""

from __future__ import annotations

import time

from playwright.sync_api import Page, expect

from .helpers import (
    compose_and_send,
    login_with_token,
    open_email,
    open_inbox_view,
    signup_and_pay,
    wait_for_email,
)


def test_send_to_self_read_and_reply(page: Page, pay_invoice):
    account = signup_and_pay(page, pay_invoice)

    # Login from a clean state (the signup left us on /). Going through
    # /inbox + token entry is what a returning user does.
    login_with_token(page, account.token)

    subject = f"E2E hello {int(time.time())}"
    body_text = "Hello from the e2e suite. This is plain text body."
    compose_and_send(
        page,
        pay_invoice,
        recipient=account.email,
        subject=subject,
        body=body_text,
    )

    # The send succeeded; the email should land in our own inbox shortly.
    wait_for_email(page, subject_contains=subject)
    open_email(page, subject_contains=subject)

    # The body is rendered into #emailBody. We do not assert exact HTML
    # because the renderer wraps plain text into <pre>/<div>; we just
    # assert that the content the user typed is visible.
    expect(page.locator("#emailBody")).to_contain_text("Hello from the e2e suite")

    # Reply: the UI prefills recipient + Re: subject, we add a body and
    # submit a new send (which requires another Lightning payment).
    page.locator("#replyBtn").click()
    expect(page.locator("#composeForm")).to_be_visible()
    expect(page.locator("#recipient")).to_have_value(account.email)
    expect(page.locator("#subject")).to_have_value(f"Re: {subject}")

    reply_body = "And this is the reply. Thanks for reading!"
    page.locator("#body").fill(reply_body)

    with page.expect_response(
        lambda r: r.url.endswith("/api/v1/email/send") and r.request.method == "POST"
    ) as resp_info:
        page.locator('#composeForm button[type="submit"]').click()
    bolt11 = resp_info.value.json()["payment_request"]
    pay_invoice(bolt11)

    expect(page.locator("#paymentStatusText")).to_contain_text(
        "delivered", ignore_case=True, timeout=30_000
    )
    close_btn = page.locator("#cancelPaymentBtn")
    expect(close_btn).to_contain_text("Close", timeout=5_000)
    close_btn.click()
    expect(page.locator("#paymentModal")).not_to_be_visible()

    # The reply itself arrives in the inbox.
    open_inbox_view(page)
    wait_for_email(page, subject_contains=f"Re: {subject}")
    open_email(page, subject_contains=f"Re: {subject}")
    expect(page.locator("#emailBody")).to_contain_text("And this is the reply")
