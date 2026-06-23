"""Payment backend factory.

Builds the configured :class:`PaymentBackend` from application settings.

Behaviour (see ``Settings`` for the env vars):

* ``PAYMENT_BACKEND="lnd"`` (default): a single self-hosted LND backend.
  This is fully backward compatible with the original behaviour.
* ``PAYMENT_BACKEND in {"nwc", "multi"}``: build the NWC provider(s) from
  ``NWC_CONNECTIONS`` (+ optional ``NWC_PRIMARY_CONNECTION``) and, unless
  ``NWC_ONLY`` is set, also include the LND node as an extra provider.
  Everything is wrapped in a :class:`MultiProviderBackend` for random
  selection and fallback.

The factory degrades gracefully: if NWC is requested but no usable
connection is configured/available, it falls back to LND so the app keeps
working rather than failing to start.
"""

from __future__ import annotations

from loguru import logger

from ...config import settings
from .base import GENERIC_MEMO, InvoiceResult, PaymentBackend, public_memo
from .lnd_backend import LNDBackend
from .multi import AllProvidersFailedError, MultiProviderBackend

__all__ = [
    "AllProvidersFailedError",
    "GENERIC_MEMO",
    "InvoiceResult",
    "LNDBackend",
    "MultiProviderBackend",
    "PaymentBackend",
    "get_payment_backend",
    "public_memo",
]


def _clean_uri(value: str) -> str:
    """Trim whitespace and any surrounding quotes from a connection URI.

    Tolerates the common docker-compose mistake of writing
    ``- NWC_CONNECTIONS="nostr+walletconnect://..."`` in the list form of
    ``environment:``, where the quotes become part of the value.
    """
    uri = value.strip()
    if len(uri) >= 2 and uri[0] == uri[-1] and uri[0] in ("'", '"'):
        uri = uri[1:-1].strip()
    return uri


def _parse_connections(raw: str) -> list[str]:
    """Split a newline/comma separated list of NWC URIs into clean entries."""
    # Strip wrapping quotes around the whole value first (compose list form),
    # then split. A single quoted entry like "a,b" would otherwise keep its
    # quotes around the first/last item only.
    cleaned = _clean_uri(raw)
    parts: list[str] = []
    for chunk in cleaned.replace("\n", ",").split(","):
        uri = _clean_uri(chunk)
        if uri:
            parts.append(uri)
    return parts


def _build_nwc_backends(uris: list[str]) -> list[PaymentBackend]:
    """Construct NWC backends, skipping any that fail to initialise."""
    from .nwc_backend import NWCBackend  # local import: optional dependency

    backends: list[PaymentBackend] = []
    for uri in uris:
        try:
            backends.append(NWCBackend(uri))
        except Exception as exc:
            logger.error(f"Failed to initialise an NWC provider, skipping: {exc}")
    return backends


def get_payment_backend() -> PaymentBackend:
    """Return the payment backend selected by the current settings."""
    backend_choice = (settings.PAYMENT_BACKEND or "lnd").strip().lower()

    if backend_choice not in {"nwc", "multi"}:
        # Default / "lnd": preserve the original single-LND behaviour.
        return LNDBackend()

    primary_uri = _clean_uri(settings.NWC_PRIMARY_CONNECTION)
    uris = _parse_connections(settings.NWC_CONNECTIONS)
    if primary_uri and primary_uri not in uris:
        uris.insert(0, primary_uri)

    if not uris:
        logger.warning(
            "PAYMENT_BACKEND requests NWC but no NWC_CONNECTIONS are "
            "configured; falling back to LND."
        )
        return LNDBackend()

    nwc_backends = _build_nwc_backends(uris)
    if not nwc_backends:
        logger.warning("No usable NWC providers; falling back to LND.")
        return LNDBackend()

    primary: PaymentBackend | None = None
    if primary_uri:
        # The primary is the backend whose URI matched the primary setting;
        # it is always the first entry we inserted above.
        primary = nwc_backends[0]

    providers: list[PaymentBackend] = list(nwc_backends)
    if not settings.NWC_ONLY:
        # Add the self-hosted node as an additional (trusted) provider.
        try:
            providers.append(LNDBackend())
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(f"Could not add LND as a fallback provider: {exc}")

    logger.info(
        f"Payment backend: multi-provider with {len(providers)} provider(s) "
        f"({'NWC-only' if settings.NWC_ONLY else 'NWC + LND'}"
        f"{', primary set' if primary else ''})"
    )
    return MultiProviderBackend(providers, primary=primary)
