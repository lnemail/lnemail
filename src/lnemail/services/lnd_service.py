"""LND service.

A thin gRPC client around the subset of the LND ``Lightning`` API that
LNemail needs: creating invoices and checking whether they have settled.
"""

import codecs
from typing import Any, Callable, Dict

import grpc
from loguru import logger

from ..config import settings
from ..services.lnd.lightning_pb2 import AddInvoiceResponse, Invoice, PaymentHash  # type: ignore
from ..services.lnd.lightning_pb2_grpc import LightningStub

# Invoice expiry, in seconds. Kept in sync with the renewal polling budget
# in services.tasks (RENEWAL_INVOICE_EXPIRY).
INVOICE_EXPIRY_SECONDS = 600

# LND invoice state for a settled invoice (Invoice.InvoiceState.SETTLED).
_INVOICE_STATE_SETTLED = 1


class _ErrorLoggingInterceptor(grpc.UnaryUnaryClientInterceptor):
    """Log gRPC failures; otherwise stay out of the way."""

    def intercept_unary_unary(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request: Any,
    ) -> Any:
        try:
            return continuation(client_call_details, request)
        except grpc.RpcError as exc:
            logger.error(
                f"gRPC call {client_call_details.method} failed: "
                f"{exc.code()}: {exc.details()}"
            )
            raise


class LNDService:
    """Service for interacting with the Lightning Network Daemon."""

    def __init__(self) -> None:
        """Initialize the LND service with a gRPC connection to the node."""
        self._setup_grpc_channel()
        logger.info("LND service initialized")

    def _setup_grpc_channel(self) -> None:
        """Set up a secure gRPC channel with TLS and macaroon authentication."""
        try:
            with open(settings.LND_CERT_PATH, "rb") as f:
                cert = f.read()

            with open(settings.LND_MACAROON_PATH, "rb") as f:
                macaroon = codecs.encode(f.read(), "hex")

            auth_creds = grpc.metadata_call_credentials(
                lambda context, callback: callback([("macaroon", macaroon)], None)
            )
            ssl_creds = grpc.ssl_channel_credentials(cert)
            combined_creds = grpc.composite_channel_credentials(ssl_creds, auth_creds)

            channel = grpc.secure_channel(settings.LND_GRPC_HOST, combined_creds)
            intercepted_channel = grpc.intercept_channel(
                channel, _ErrorLoggingInterceptor()
            )
            self.stub = LightningStub(intercepted_channel)
        except Exception as e:
            logger.error(f"Failed to initialize LND service: {str(e)}")
            raise

    def create_invoice(self, amount_sats: int, memo: str) -> Dict[str, Any]:
        """Create a Lightning invoice.

        Args:
            amount_sats: Invoice amount in satoshis.
            memo: Invoice description.

        Returns:
            A dict with ``payment_hash``, ``payment_request`` and ``add_index``.
        """
        try:
            request = Invoice(
                value=amount_sats,
                memo=memo,
                expiry=INVOICE_EXPIRY_SECONDS,
            )
            response: AddInvoiceResponse = self.stub.AddInvoice(request)
            logger.info(
                f"Created invoice for {amount_sats} sats "
                f"(hash={response.r_hash.hex()[:16]}...)"
            )
            return {
                "payment_hash": response.r_hash.hex(),
                "payment_request": response.payment_request,
                "add_index": response.add_index,
            }
        except Exception as e:
            logger.error(f"Failed to create invoice: {str(e)}")
            raise

    def check_invoice(self, payment_hash: str) -> bool:
        """Return ``True`` if the invoice for ``payment_hash`` has settled.

        Never raises for the common "not found / not paid" cases; returns
        ``False`` instead so callers can poll safely.
        """
        try:
            r_hash_bytes = bytes.fromhex(payment_hash)
            lookup_request = PaymentHash(r_hash=r_hash_bytes)
            invoice = self.stub.LookupInvoice(lookup_request)
            return bool(invoice.state == _INVOICE_STATE_SETTLED)
        except grpc.RpcError as e:
            # "invoice not found" is an expected, benign outcome when this
            # node did not issue the invoice (e.g. in a multi-provider setup
            # where another wallet did). Log it quietly; report not-settled.
            if e.code() == grpc.StatusCode.NOT_FOUND:
                logger.debug(f"Invoice {payment_hash[:16]}... not found on this node")
            else:
                logger.error(
                    f"Error checking invoice {payment_hash}: {e.code()}: {e.details()}"
                )
            return False
        except Exception as e:
            logger.error(f"Error checking invoice {payment_hash}: {str(e)}")
            return False
