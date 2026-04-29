"""Account renewal flow.

Pre-condition: an existing paid account whose ``expires_at`` is inside
the 90-day "renewal banner" window. We seed that with the same
``scripts/create_account.py`` tool the maintainers use locally - that
script exists *because* exercising near-expiry without literally
waiting a year is exactly what is needed here. The renewal payment
itself still goes through the real Lightning regtest channel, which
is the part of the flow that can actually break.
"""

from __future__ import annotations

import secrets
import subprocess
import time

import pytest
from playwright.sync_api import Page, expect

from .helpers import login_with_token


def _seed_account(api_container: str, *, days: int = 5) -> tuple[str, str]:
    """Create a near-expiry paid account and return (email, token).

    Runs ``scripts/create_account.py`` inside the lnemail-api container
    and parses the loguru output for the credentials. The script logs
    the email + token + expiry on success - we don't assume any
    specific format beyond the labelled lines we already control.
    """
    local = f"e2e-renewal-{secrets.token_hex(3)}"
    cmd = [
        "docker",
        "exec",
        api_container,
        "python",
        "scripts/create_account.py",
        local,
        "--days",
        str(days),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        pytest.skip(
            "Could not seed renewal account via scripts/create_account.py: "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )

    output = result.stdout + result.stderr
    email = None
    token = None
    for line in output.splitlines():
        if "Email:" in line:
            email = line.rsplit("Email:", 1)[-1].strip()
        elif "Access token:" in line:
            token = line.rsplit("Access token:", 1)[-1].strip()
    if not email or not token:
        pytest.skip(f"Could not parse seeded credentials from: {output!r}")
    return email, token


def test_renewal_flow_extends_expiry(
    page: Page,
    pay_invoice,
    api_container: str,
):
    email, token = _seed_account(api_container, days=5)

    # Capture the original expiry via the API so we can assert the
    # renewal pushed it forward.
    initial = page.request.get(
        "/api/v1/account",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert initial.ok, initial.text()
    original_expiry = initial.json()["expires_at"]

    # Login - the near-expiry banner should be visible.
    login_with_token(page, token)

    # The renewal CTA only appears when ≤90 days remain. We seeded 5.
    expect(page.locator("#renewBtn")).to_be_visible(timeout=10_000)
    page.locator("#renewBtn").click()
    expect(page.locator("#renewalModal.active")).to_be_visible()
    expect(page.locator("#renewalOptions")).to_be_visible()

    # Default selection (1 year) is fine; just generate and pay.
    with page.expect_response(
        lambda r: r.url.endswith("/api/v1/account/renew") and r.request.method == "POST"
    ) as resp_info:
        page.locator("#renewalPayBtn").click()
    bolt11 = resp_info.value.json()["payment_request"]
    assert bolt11

    expect(page.locator("#renewalPaymentInfo")).to_be_visible()
    pay_invoice(bolt11)

    expect(page.locator("#renewalPaymentStatusText")).to_contain_text(
        "renewed", ignore_case=True, timeout=30_000
    )

    # Close the modal via the now-"Close" button.
    close_btn = page.locator("#cancelRenewalBtn")
    expect(close_btn).to_contain_text("Close", timeout=5_000)
    close_btn.click()
    expect(page.locator("#renewalModal.active")).not_to_be_visible()

    # The server-side expiry should now be later than before.
    # Allow up to ~10s for the worker to process the renewal.
    deadline = time.monotonic() + 15
    new_expiry = original_expiry
    while time.monotonic() < deadline:
        check = page.request.get(
            "/api/v1/account",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert check.ok, check.text()
        new_expiry = check.json()["expires_at"]
        if new_expiry > original_expiry:
            break
        time.sleep(1)
    assert new_expiry > original_expiry, (
        f"expiry did not advance after renewal: was {original_expiry}, "
        f"is {new_expiry}"
    )
