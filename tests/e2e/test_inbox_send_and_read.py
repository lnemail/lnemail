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
from typing import Any

from playwright.sync_api import Page, expect

from .helpers import (
    compose_and_send,
    login_with_token,
    open_compose_view,
    open_email,
    open_inbox_view,
    signup_and_pay,
    wait_for_email,
)


def test_send_to_self_read_and_reply(page: Page, pay_invoice: Any) -> None:
    account = signup_and_pay(page, pay_invoice)

    # Login from a clean state (the signup left us on /). Going through
    # /inbox + token entry is what a returning user does.
    login_with_token(page, account.token)

    # A fresh account advertises its free first send in the compose view.
    open_compose_view(page)
    expect(page.locator("#freeSendNote")).to_be_visible()

    timestamp = int(time.time())
    local_part, domain = account.email.rsplit("@", 1)
    tagged_recipient = f"{local_part}+e2e-{timestamp}@{domain}"
    subject = f"E2E hello {timestamp}"
    body_text = "Hello from the e2e suite. This is plain text body."
    compose_and_send(
        page,
        pay_invoice,
        recipient=tagged_recipient,
        subject=subject,
        body=body_text,
    )
    # The free send is consumed; the hint disappears.
    open_compose_view(page)
    expect(page.locator("#freeSendNote")).not_to_be_visible()

    # The body is kept only in this browser: the Sent view can show it and
    # the user can wipe the local copies.
    page.locator('[data-view="sent"]').first.click()
    expect(page.locator("#sentView")).to_be_visible()
    sent_row = page.locator("#sentEmailsList [data-copy-hash]").first
    expect(sent_row).to_contain_text(subject)
    sent_row.click()
    expect(page.locator("#sentEmailsList .sent-body").first).to_contain_text(
        "Hello from the e2e suite"
    )
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#clearSentCopiesBtn").click()
    expect(page.locator("#sentEmailsList [data-copy-hash]")).to_have_count(0)
    expect(page.locator("#sentCopiesCount")).to_have_text("0")

    # Dovecot routes the tagged address to the primary mailbox while LNemail
    # preserves the original delivery address in both inbox views.
    wait_for_email(page, subject_contains=subject)
    snippet = page.locator(".email-snippet", has_text=subject).first
    expect(snippet.locator(".email-recipient")).to_contain_text(tagged_recipient)
    open_email(page, subject_contains=subject)
    expect(page.locator("#emailToRow")).to_be_visible()
    expect(page.locator("#emailTo")).to_have_text(tagged_recipient)

    # The body is rendered into #emailBody. We do not assert exact HTML
    # because the renderer wraps plain text into <pre>/<div>; we just
    # assert that the content the user typed is visible.
    expect(page.locator("#emailBody")).to_contain_text("Hello from the e2e suite")

    # Reply: the UI prefills recipient + Re: subject, we add a body and
    # submit a new send. The free send is used up, so this one is paid.
    page.locator("#replyBtn").click()
    expect(page.locator("#composeView")).to_be_visible()
    expect(page.locator("#recipient")).to_have_value(account.email)
    expect(page.locator("#subject")).to_have_value(f"Re: {subject}")

    reply_body = "And this is the reply. Thanks for reading!"
    page.locator("#body").fill(reply_body)

    with page.expect_response(
        lambda r: r.url.endswith("/api/v1/email/send") and r.request.method == "POST"
    ) as resp_info:
        page.locator("#composeSubmitBtn").click()
    reply_payload = resp_info.value.json()
    assert reply_payload["price_sats"] > 0, reply_payload
    pay_invoice(reply_payload["payment_request"])

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
