"""Multi-provider payment dispatcher.

Wraps an ordered/!randomised set of :class:`PaymentBackend` providers and
adds reliability:

* **create_invoice** - try the primary provider first (if configured),
  then the remaining providers in random order, falling back to the next
  one whenever a provider errors. The first success wins. The descriptive
  memo is only passed to ``trusted`` providers; untrusted ones receive a
  generic memo (see :func:`public_memo`).

* **check_invoice** - a ``payment_hash`` is specific to the provider that
  issued it, and we do not persist which provider that was. We therefore
  ask every provider; only the issuing wallet can report the invoice as
  settled, so "any provider says settled" is the correct answer. Provider
  errors are swallowed (treated as "not settled here").
"""

from __future__ import annotations

import random
from collections.abc import Sequence

from loguru import logger

from .base import InvoiceResult, PaymentBackend, public_memo


class AllProvidersFailedError(RuntimeError):
    """Raised when every payment provider failed to create an invoice."""


class MultiProviderBackend(PaymentBackend):
    """Dispatch invoice creation/lookup across several providers."""

    trusted = True  # not meaningful for the dispatcher itself
    name = "multi"

    def __init__(
        self,
        providers: Sequence[PaymentBackend],
        *,
        primary: PaymentBackend | None = None,
    ) -> None:
        if not providers:
            raise ValueError("MultiProviderBackend requires at least one provider")
        self._providers = list(providers)
        self._primary = primary

    def _ordered_for_create(self) -> list[PaymentBackend]:
        """Primary first (if set), then the rest shuffled."""
        rest = [p for p in self._providers if p is not self._primary]
        random.shuffle(rest)
        if self._primary is not None:
            return [self._primary, *rest]
        return rest

    def create_invoice(self, amount_sats: int, memo: str) -> InvoiceResult:
        errors: list[str] = []
        for provider in self._ordered_for_create():
            try:
                safe_memo = public_memo(provider, memo)
                result = provider.create_invoice(amount_sats, safe_memo)
                if not result.get("payment_request") or not result.get("payment_hash"):
                    raise ValueError("provider returned an incomplete invoice")
                logger.info(f"Invoice created via provider '{provider.name}'")
                return result
            except Exception as exc:
                logger.warning(
                    f"Payment provider '{provider.name}' failed to create "
                    f"invoice, falling back: {exc}"
                )
                errors.append(f"{provider.name}: {exc}")
        raise AllProvidersFailedError(
            "All payment providers failed to create an invoice: " + "; ".join(errors)
        )

    def check_invoice(self, payment_hash: str) -> bool:
        # Ask every provider; only the issuing wallet can confirm settlement.
        for provider in self._providers:
            try:
                if provider.check_invoice(payment_hash):
                    return True
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug(
                    f"Provider '{provider.name}' check_invoice errored for "
                    f"{payment_hash[:16]}...: {exc}"
                )
        return False
