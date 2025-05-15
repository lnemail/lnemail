"""
Enhanced LND Service with debugging capabilities for packet inspection.
"""

import codecs
import json
from typing import Any, Dict, Tuple, Callable

import grpc
import requests
from loguru import logger

from ..config import settings
from ..services.lnd.lightning_pb2 import AddInvoiceResponse, Invoice, PaymentHash  # type: ignore
from ..services.lnd.lightning_pb2_grpc import LightningStub


class DebugInterceptor(grpc.UnaryUnaryClientInterceptor):
    """Interceptor to debug gRPC messages before they're sent."""

    def intercept_unary_unary(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request: Any,
    ) -> Any:
        # Log the request details
        logger.debug(f"gRPC Method: {client_call_details.method}")
        logger.debug(f"Request type: {type(request)}")

        # Serialize the request to see the actual bytes
        try:
            serialized = request.SerializeToString()
            logger.debug(f"Serialized request size: {len(serialized)} bytes")
            logger.debug(
                f"Serialized request (first 100 bytes): {serialized[:100].hex()}"
            )

            # Try to inspect the protobuf structure
            logger.debug(f"Request fields: {request.ListFields()}")

            # For Invoice specifically, log all fields
            if hasattr(request, "value"):
                logger.debug(f"Invoice.value: {request.value}")
            if hasattr(request, "memo"):
                logger.debug(
                    f"Invoice.memo: '{request.memo}' (length: {len(request.memo)})"
                )
            if hasattr(request, "expiry"):
                logger.debug(f"Invoice.expiry: {request.expiry}")

        except Exception as e:
            logger.error(f"Error serializing request for debug: {e}")

        # Continue with the actual call
        try:
            response = continuation(client_call_details, request)
            logger.debug("gRPC call successful")
            return response
        except grpc.RpcError as e:
            logger.error(f"gRPC error: {e.code()}: {e.details()}")
            # Log the raw error details
            logger.error(f"Error debug_error_string: {e.debug_error_string()}")
            raise


class LNDService:
    """Service for interacting with Lightning Network Daemon with enhanced debugging."""

    def __init__(self) -> None:
        """Initialize the LND service with gRPC connection to the LND node."""
        self._setup_grpc_channel()
        logger.info("LND service initialized with debugging")

    def _setup_grpc_channel(self) -> None:
        """Set up secure gRPC channel with TLS and macaroon authentication."""
        try:
            # Read TLS certificate
            with open(settings.LND_CERT_PATH, "rb") as f:
                cert = f.read()

            # Read and encode macaroon for authentication
            with open(settings.LND_MACAROON_PATH, "rb") as f:
                macaroon = codecs.encode(f.read(), "hex")

            # Set up auth credentials with macaroon
            auth_creds = grpc.metadata_call_credentials(
                lambda context, callback: callback([("macaroon", macaroon)], None)
            )

            # Create SSL credentials with the certificate
            ssl_creds = grpc.ssl_channel_credentials(cert)

            # Combine auth and SSL credentials
            combined_creds = grpc.composite_channel_credentials(ssl_creds, auth_creds)

            # Create the secure channel with debugging interceptor
            channel = grpc.secure_channel(settings.LND_GRPC_HOST, combined_creds)

            # Add debug interceptor
            intercepted_channel = grpc.intercept_channel(channel, DebugInterceptor())

            self.stub = LightningStub(intercepted_channel)

        except Exception as e:
            logger.error(f"Failed to initialize LND service: {str(e)}")
            raise

    def create_invoice_debug(self, amount_sats: int, memo: str) -> Dict[str, Any]:
        """Create invoice with extensive debugging."""

        logger.info(f"Creating invoice: amount={amount_sats}, memo_length={len(memo)}")

        # Log memo content for debugging (be careful with sensitive data)
        logger.debug(f"Memo content: '{memo[:100]}{'...' if len(memo) > 100 else ''}'")

        # Check for potentially problematic characters
        try:
            memo.encode("utf-8")
            logger.debug("Memo is valid UTF-8")
        except UnicodeEncodeError as e:
            logger.error(f"Memo contains invalid UTF-8: {e}")

        # Test different memo configurations
        test_cases = [
            ("original", memo),
            ("ascii_only", "".join(c for c in memo if ord(c) < 128)),
            ("empty", ""),
            ("simple", "test invoice"),
        ]

        for case_name, test_memo in test_cases:
            try:
                logger.info(f"Testing case: {case_name}")

                invoice_request = Invoice(
                    value=amount_sats,
                    memo=test_memo,
                    expiry=600,
                )

                # Try to serialize manually first
                serialized = invoice_request.SerializeToString()
                logger.debug(
                    f"Case {case_name}: serialized size = {len(serialized)} bytes"
                )

                if case_name == "original":
                    # Only actually call the API for the original case
                    response: AddInvoiceResponse = self.stub.AddInvoice(invoice_request)
                    return {
                        "payment_hash": response.r_hash.hex(),
                        "payment_request": response.payment_request,
                        "add_index": response.add_index,
                    }

            except Exception as e:
                logger.error(f"Case {case_name} failed: {str(e)}")
                if case_name == "original":
                    raise

        raise Exception("All test cases failed")

    def create_invoice_minimal(self, amount_sats: int) -> Dict[str, Any]:
        """Create invoice with minimal fields to isolate the issue."""

        logger.info(f"Creating minimal invoice: amount={amount_sats}")

        # Try with absolute minimum fields
        invoice_request = Invoice(value=amount_sats)

        try:
            response: AddInvoiceResponse = self.stub.AddInvoice(invoice_request)
            return {
                "payment_hash": response.r_hash.hex(),
                "payment_request": response.payment_request,
                "add_index": response.add_index,
            }
        except Exception as e:
            logger.error(f"Minimal invoice creation failed: {str(e)}")
            raise

    def create_invoice(self, amount_sats: int, memo: str) -> Dict[str, Any]:
        """Create a Lightning invoice with debugging."""

        # First try minimal invoice
        try:
            logger.info("Attempting minimal invoice first...")
            _result = self.create_invoice_minimal(amount_sats)
            logger.info("Minimal invoice succeeded, now trying with memo...")
        except Exception as e:
            logger.error(f"Even minimal invoice failed: {e}")
            raise

        # Now try with full debugging
        return self.create_invoice_debug(amount_sats, memo)

    def inspect_protobuf_structure(self, memo: str) -> None:
        """Inspect the protobuf structure for debugging."""

        invoice = Invoice(
            value=1000,
            memo=memo,
            expiry=600,
        )

        logger.debug("=== Protobuf Structure Inspection ===")
        logger.debug(f"Invoice descriptor: {invoice.DESCRIPTOR}")
        logger.debug(f"Invoice fields: {invoice.DESCRIPTOR.fields}")

        for field in invoice.DESCRIPTOR.fields:
            logger.debug(
                f"Field: {field.name}, Type: {field.type}, Number: {field.number}"
            )

        # Serialize and inspect bytes
        serialized = invoice.SerializeToString()
        logger.debug(f"Serialized length: {len(serialized)}")
        logger.debug(f"Raw bytes: {serialized.hex()}")

        # Try to parse the protobuf wire format manually
        self._parse_protobuf_wire_format(serialized)

    def _parse_protobuf_wire_format(self, data: bytes) -> None:
        """Parse protobuf wire format for debugging."""

        logger.debug("=== Protobuf Wire Format Analysis ===")
        i = 0
        while i < len(data):
            if i + 1 > len(data):
                break

            # Read varint for field header
            tag, i = self._read_varint(data, i)
            field_number = tag >> 3
            wire_type = tag & 0x7

            logger.debug(f"Field {field_number}, Wire type {wire_type}")

            if wire_type == 0:  # Varint
                value, i = self._read_varint(data, i)
                logger.debug(f"  Varint value: {value}")
            elif wire_type == 2:  # Length-delimited
                length, i = self._read_varint(data, i)
                if i + length <= len(data):
                    value_bytes = data[i : i + length]
                    logger.debug(
                        f"  Length-delimited ({length} bytes): {value_bytes[:50]!r}{'...' if len(value_bytes) > 50 else ''}"
                    )
                    # Try to decode as string
                    try:
                        str_value = value_bytes.decode("utf-8")
                        logger.debug(
                            f"  As string: '{str_value[:50]}{'...' if len(str_value) > 50 else ''}'"
                        )
                    except UnicodeDecodeError:
                        pass
                    i += length
                else:
                    logger.error("  Invalid length-delimited field")
                    break
            else:
                logger.debug(f"  Unknown wire type: {wire_type}")
                break

    def _read_varint(self, data: bytes, offset: int) -> Tuple[int, int]:
        """Read a varint from protobuf data."""
        result = 0
        shift = 0
        while offset < len(data):
            byte = data[offset]
            offset += 1
            result |= (byte & 0x7F) << shift
            if (byte & 0x80) == 0:
                break
            shift += 7
        return result, offset

    def wrap_with_lnproxy(self, invoice: str) -> Dict[str, Any]:
        """Wrap an invoice with LNProxy relay."""
        try:
            headers = {"Content-Type": "application/json"}
            payload = {"invoice": invoice}

            response = requests.post(
                settings.LNPROXY_URL,
                headers=headers,
                data=json.dumps(payload),
                timeout=30,
            )

            if response.status_code != 200:
                logger.error(
                    f"LNProxy error: Status {response.status_code}, {response.text}"
                )
                raise Exception(f"LNProxy returned status code {response.status_code}")

            result: Dict[str, Any] = response.json()
            if "proxy_invoice" not in result:
                raise Exception("LNProxy response missing proxy_invoice field")

            return result
        except Exception as e:
            logger.error(f"Error wrapping invoice with LNProxy: {str(e)}")
            raise

    def check_invoice(self, payment_hash: str) -> bool:
        """Check if a Lightning invoice has been paid."""
        try:
            # Convert hex payment hash to bytes
            r_hash_bytes = bytes.fromhex(payment_hash)

            # Create lookup request
            lookup_request = PaymentHash(r_hash=r_hash_bytes)

            # Lookup invoice
            invoice = self.stub.LookupInvoice(lookup_request)

            # Check if settled (state 1 means SETTLED)
            return bool(invoice.state == 1)
        except Exception as e:
            logger.error(f"Error checking invoice {payment_hash}: {str(e)}")
            return False
