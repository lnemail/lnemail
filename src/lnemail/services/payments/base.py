"""Payment backend abstraction.

LNemail historically talked to a single self-hosted LND node directly.
This package introduces a small abstraction so the app can additionally
use one or more Nostr Wallet Connect (NWC) wallets as alternative
payment providers for better reliability, while keeping LND as the
default.

Design goals:

* **Single seam** - every payment call goes through the
  :class:`PaymentBackend` protocol (``create_invoice`` / ``check_invoice``),
  matching the existing ``LNDService`` contract exactly so call sites do
  not change.
* **Reliability** - :class:`~lnemail.services.payments.multi.MultiProviderBackend`
  tries an optional primary provider first, then a randomly ordered set
  of the remaining providers, falling back to the next one on error.
* **Privacy** - third-party (NWC) providers must not learn who is paying
  or why. A provider declares whether it is ``trusted`` (self-hosted);
  the dispatcher passes the descriptive memo only to trusted providers
  and a generic memo to everyone else. See :func:`public_memo`.
"""

from __future__ import annotations

from typing import Protocol, TypedDict, runtime_checkable


# A generic, non-identifying memo used for invoices served by untrusted
# (third-party) providers, so they cannot correlate a payment with an
# email address, access token, or recipient.
GENERIC_MEMO = "LNemail payment"


class InvoiceResult(TypedDict):
    """Minimal invoice shape every backend must return.

    Mirrors the subset of ``LNDService.create_invoice``'s return value
    that the rest of the application actually consumes. ``provider`` is
    the name of the backend that issued the invoice so callers can later
    ask for a fresh invoice from a *different* provider.
    """

    payment_hash: str
    payment_request: str
    provider: str


@runtime_checkable
class PaymentBackend(Protocol):
    """A source of Lightning invoices and settlement checks."""

    #: Whether this backend is self-hosted and may therefore receive the
    #: full, descriptive invoice memo. Third-party providers set this to
    #: ``False`` so they only ever see a generic memo.
    trusted: bool

    #: Short identifier used in logs (never include secrets).
    name: str

    def create_invoice(
        self, amount_sats: int, memo: str, exclude_provider: str | None = None
    ) -> InvoiceResult:
        """Create an invoice for ``amount_sats`` with ``memo``.

        ``exclude_provider`` names a provider to avoid when possible (used
        to re-issue an invoice from a *different* provider). Single-backend
        implementations may ignore it. Implementations may raise on
        failure; the dispatcher handles fallback to another provider.
        """
        ...

    def check_invoice(self, payment_hash: str) -> bool:
        """Return ``True`` iff the invoice for ``payment_hash`` is settled.

        Must not raise for the common "not paid yet" / "unknown" cases;
        return ``False`` instead, matching ``LNDService.check_invoice``.
        """
        ...


def public_memo(backend: PaymentBackend, memo: str) -> str:
    """Return the memo that is safe to expose to ``backend``.

    Trusted (self-hosted) backends get the descriptive memo; untrusted
    third-party backends get a generic one so they cannot learn private
    details (email address, access token, recipient).
    """
    return memo if getattr(backend, "trusted", False) else GENERIC_MEMO
