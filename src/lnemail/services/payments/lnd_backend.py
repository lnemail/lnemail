"""LND payment backend.

A thin adapter that exposes the existing :class:`LNDService` through the
:class:`~lnemail.services.payments.base.PaymentBackend` protocol. LND is
self-hosted, so it is ``trusted`` and may receive descriptive memos.
"""

from __future__ import annotations

from ..lnd_service import LNDService
from .base import InvoiceResult, PaymentBackend


class LNDBackend(PaymentBackend):
    """Self-hosted LND, used as the default payment backend."""

    trusted = True
    name = "lnd"

    def __init__(self, service: LNDService | None = None) -> None:
        # Lazily construct the underlying service so importing this module
        # never opens a gRPC channel (mirrors how LNDService was used before).
        self._service = service or LNDService()

    def create_invoice(
        self,
        amount_sats: int,
        memo: str,
        exclude_provider: str | None = None,
        untrusted_only: bool = False,
    ) -> InvoiceResult:
        # Single self-hosted backend: exclude_provider/untrusted_only do not apply.
        result = self._service.create_invoice(amount_sats, memo)
        return {
            "payment_hash": result["payment_hash"],
            "payment_request": result["payment_request"],
            "provider": self.name,
        }

    def check_invoice(self, payment_hash: str) -> bool:
        return self._service.check_invoice(payment_hash)

    def reissue_available(self) -> bool:
        # A single self-hosted backend: nothing to rotate to.
        return False
