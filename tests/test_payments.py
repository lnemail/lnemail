"""Unit tests for the payment backend abstraction and dispatcher.

These cover the provider-selection, fallback and privacy logic without
touching the network (no real LND or NWC connection). The NWC client
itself is integration-tested separately against the dev stack.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from lnemail.services.payments import get_payment_backend
from lnemail.services.payments.base import (
    GENERIC_MEMO,
    PaymentBackend,
    public_memo,
)
from lnemail.services.payments.multi import (
    AllProvidersFailedError,
    MultiProviderBackend,
)


class _FakeBackend(PaymentBackend):
    """A controllable in-memory PaymentBackend for tests."""

    def __init__(
        self,
        name: str,
        *,
        trusted: bool = False,
        fail_create: bool = False,
        settled: bool = False,
    ) -> None:
        self.name = name
        self.trusted = trusted
        self.fail_create = fail_create
        self.settled = settled
        self.seen_memos: list[str] = []
        self.created = 0

    def create_invoice(
        self, amount_sats: int, memo: str, exclude_provider: str | None = None
    ) -> dict[str, str]:
        self.seen_memos.append(memo)
        self.created += 1
        if self.fail_create:
            raise RuntimeError(f"{self.name} boom")
        return {
            "payment_hash": f"{self.name}_hash",
            "payment_request": f"lnbc_{self.name}",
            "provider": self.name,
        }

    def check_invoice(self, payment_hash: str) -> bool:
        # Only "our" hash can be settled here.
        return self.settled and payment_hash == f"{self.name}_hash"


class TestPublicMemo:
    def test_trusted_backend_sees_full_memo(self) -> None:
        backend = _FakeBackend("lnd", trusted=True)
        assert public_memo(backend, "Send email from a@x to b@y") == (
            "Send email from a@x to b@y"
        )

    def test_untrusted_backend_gets_generic_memo(self) -> None:
        backend = _FakeBackend("nwc", trusted=False)
        assert public_memo(backend, "Token: lne_secret") == GENERIC_MEMO


class TestMultiProviderCreate:
    def test_primary_is_tried_first(self) -> None:
        primary = _FakeBackend("primary")
        other = _FakeBackend("other")
        multi = MultiProviderBackend([other, primary], primary=primary)

        result = multi.create_invoice(1000, "memo")

        assert result["payment_hash"] == "primary_hash"
        assert primary.created == 1
        assert other.created == 0

    def test_result_includes_provider_name(self) -> None:
        a = _FakeBackend("alpha")
        multi = MultiProviderBackend([a], primary=a)
        result = multi.create_invoice(1000, "memo")
        assert result["provider"] == "alpha"

    def test_exclude_provider_prefers_a_different_one(self) -> None:
        a = _FakeBackend("alpha")
        b = _FakeBackend("beta")
        multi = MultiProviderBackend([a, b])
        # Excluding alpha must yield beta even across repeated calls.
        for _ in range(10):
            result = multi.create_invoice(1000, "memo", exclude_provider="alpha")
            assert result["provider"] == "beta"

    def test_exclude_provider_falls_back_when_only_option(self) -> None:
        only = _FakeBackend("solo")
        multi = MultiProviderBackend([only], primary=only)
        # Even when excluded, the sole provider is still used as a last resort.
        result = multi.create_invoice(1000, "memo", exclude_provider="solo")
        assert result["provider"] == "solo"

    def test_untrusted_only_prefers_nwc_over_lnd(self) -> None:
        lnd = _FakeBackend("lnd", trusted=True)
        nwc = _FakeBackend("nwc", trusted=False)
        multi = MultiProviderBackend([lnd, nwc], primary=lnd)
        # 'Get a new one' should rotate among NWC (untrusted) providers,
        # never returning LND while an NWC provider works.
        for _ in range(10):
            result = multi.create_invoice(1000, "memo", untrusted_only=True)
            assert result["provider"] == "nwc"

    def test_untrusted_only_falls_back_to_lnd_if_nwc_fails(self) -> None:
        lnd = _FakeBackend("lnd", trusted=True)
        nwc = _FakeBackend("nwc", trusted=False, fail_create=True)
        multi = MultiProviderBackend([lnd, nwc], primary=lnd)
        # If the only NWC provider can't issue an invoice, fall back to LND so
        # the user still gets one.
        result = multi.create_invoice(1000, "memo", untrusted_only=True)
        assert result["provider"] == "lnd"

    def test_falls_back_when_a_provider_fails(self) -> None:
        bad = _FakeBackend("bad", fail_create=True)
        good = _FakeBackend("good")
        # Force deterministic order: bad is primary, good is fallback.
        multi = MultiProviderBackend([good, bad], primary=bad)

        result = multi.create_invoice(1000, "memo")

        assert result["payment_hash"] == "good_hash"
        assert bad.created == 1  # attempted
        assert good.created == 1  # fell back

    def test_raises_when_all_fail(self) -> None:
        a = _FakeBackend("a", fail_create=True)
        b = _FakeBackend("b", fail_create=True)
        multi = MultiProviderBackend([a, b])

        with pytest.raises(AllProvidersFailedError):
            multi.create_invoice(1000, "memo")

    def test_untrusted_provider_never_sees_private_memo(self) -> None:
        nwc = _FakeBackend("nwc", trusted=False)
        multi = MultiProviderBackend([nwc], primary=nwc)

        multi.create_invoice(100, "Send email from alice@x to bob@y")

        assert nwc.seen_memos == [GENERIC_MEMO]

    def test_trusted_provider_sees_private_memo(self) -> None:
        lnd = _FakeBackend("lnd", trusted=True)
        multi = MultiProviderBackend([lnd], primary=lnd)

        multi.create_invoice(100, "Send email from alice@x to bob@y")

        assert lnd.seen_memos == ["Send email from alice@x to bob@y"]

    def test_incomplete_invoice_triggers_fallback(self) -> None:
        class _Incomplete(_FakeBackend):
            def create_invoice(
                self, amount_sats: int, memo: str, exclude_provider: str | None = None
            ) -> dict[str, str]:
                self.created += 1
                return {"payment_hash": "", "payment_request": ""}

        broken = _Incomplete("broken")
        good = _FakeBackend("good")
        multi = MultiProviderBackend([good, broken], primary=broken)

        result = multi.create_invoice(1000, "memo")
        assert result["payment_hash"] == "good_hash"


class TestMultiProviderCheck:
    def test_returns_true_if_any_provider_settled(self) -> None:
        a = _FakeBackend("a", settled=False)
        b = _FakeBackend("b", settled=True)
        multi = MultiProviderBackend([a, b])

        # b's hash is settled.
        assert multi.check_invoice("b_hash") is True

    def test_returns_false_when_none_settled(self) -> None:
        a = _FakeBackend("a", settled=False)
        b = _FakeBackend("b", settled=False)
        multi = MultiProviderBackend([a, b])

        assert multi.check_invoice("b_hash") is False

    def test_provider_errors_are_swallowed_during_check(self) -> None:
        class _Raises(_FakeBackend):
            def check_invoice(self, payment_hash: str) -> bool:
                raise RuntimeError("relay down")

        raising = _Raises("raising")
        settled = _FakeBackend("settled", settled=True)
        multi = MultiProviderBackend([raising, settled])

        assert multi.check_invoice("settled_hash") is True


class TestFactory:
    def test_empty_requires_at_least_one_provider(self) -> None:
        with pytest.raises(ValueError):
            MultiProviderBackend([])

    def test_default_returns_lnd_backend(self) -> None:
        from lnemail.services.payments.lnd_backend import LNDBackend

        fake_settings = MagicMock()
        fake_settings.PAYMENT_BACKEND = "lnd"
        with (
            patch("lnemail.services.payments.settings", fake_settings),
            patch(
                "lnemail.services.payments.lnd_backend.LNDService",
                return_value=MagicMock(),
            ),
        ):
            backend = get_payment_backend()
        assert isinstance(backend, LNDBackend)
        assert backend.trusted is True

    def test_nwc_without_connections_falls_back_to_lnd(self) -> None:
        from lnemail.services.payments.lnd_backend import LNDBackend

        fake_settings = MagicMock()
        fake_settings.PAYMENT_BACKEND = "nwc"
        fake_settings.NWC_CONNECTIONS = ""
        fake_settings.NWC_PRIMARY_CONNECTION = ""
        with (
            patch("lnemail.services.payments.settings", fake_settings),
            patch(
                "lnemail.services.payments.lnd_backend.LNDService",
                return_value=MagicMock(),
            ),
        ):
            backend = get_payment_backend()
        assert isinstance(backend, LNDBackend)

    def test_nwc_builds_multi_with_lnd_fallback(self) -> None:
        fake_settings = MagicMock()
        fake_settings.PAYMENT_BACKEND = "nwc"
        fake_settings.NWC_CONNECTIONS = (
            "nostr+walletconnect://a,nostr+walletconnect://b"
        )
        fake_settings.NWC_PRIMARY_CONNECTION = ""
        fake_settings.NWC_ONLY = False

        built: list[Any] = []

        def _fake_nwc(uri: str) -> Any:
            b = _FakeBackend(f"nwc:{uri[-1]}", trusted=False)
            built.append(b)
            return b

        with (
            patch("lnemail.services.payments.settings", fake_settings),
            patch(
                "lnemail.services.payments.nwc_backend.NWCBackend",
                side_effect=_fake_nwc,
            ),
            patch(
                "lnemail.services.payments.lnd_backend.LNDService",
                return_value=MagicMock(),
            ),
        ):
            backend = get_payment_backend()

        assert isinstance(backend, MultiProviderBackend)
        # 2 NWC + 1 LND fallback.
        assert len(backend._providers) == 3
        assert sum(1 for p in backend._providers if not p.trusted) == 2

    def test_nwc_only_excludes_lnd(self) -> None:
        fake_settings = MagicMock()
        fake_settings.PAYMENT_BACKEND = "nwc"
        fake_settings.NWC_CONNECTIONS = "nostr+walletconnect://a"
        fake_settings.NWC_PRIMARY_CONNECTION = "nostr+walletconnect://a"
        fake_settings.NWC_ONLY = True

        def _fake_nwc(uri: str) -> Any:
            return _FakeBackend("nwc", trusted=False)

        with (
            patch("lnemail.services.payments.settings", fake_settings),
            patch(
                "lnemail.services.payments.nwc_backend.NWCBackend",
                side_effect=_fake_nwc,
            ),
        ):
            backend = get_payment_backend()

        assert isinstance(backend, MultiProviderBackend)
        assert all(not p.trusted for p in backend._providers)
        assert backend._primary is not None


class TestParseConnections:
    """NWC connection parsing tolerates quoting/whitespace quirks."""

    def test_strips_surrounding_double_quotes(self) -> None:
        from lnemail.services.payments import _parse_connections

        raw = '"nostr+walletconnect://abc?relay=wss%3A%2F%2Fr&secret=def"'
        assert _parse_connections(raw) == [
            "nostr+walletconnect://abc?relay=wss%3A%2F%2Fr&secret=def"
        ]

    def test_strips_surrounding_single_quotes(self) -> None:
        from lnemail.services.payments import _parse_connections

        assert _parse_connections("'nostr+walletconnect://abc'") == [
            "nostr+walletconnect://abc"
        ]

    def test_splits_and_trims_multiple(self) -> None:
        from lnemail.services.payments import _parse_connections

        raw = " nostr+walletconnect://a , nostr+walletconnect://b \n"
        assert _parse_connections(raw) == [
            "nostr+walletconnect://a",
            "nostr+walletconnect://b",
        ]

    def test_empty_is_empty(self) -> None:
        from lnemail.services.payments import _parse_connections

        assert _parse_connections("") == []
        assert _parse_connections('""') == []


class TestNWCToleranceParsing:
    """NWCBackend tolerates wallet responses that omit fields like 'amount'.

    These drive NWCBackend.check_invoice/create_invoice through a stubbed
    _nip47_call so no relay/network is touched, verifying the parsing is
    tolerant of the real-world (coinos) response shapes that broke the
    strict nostr-sdk client.
    """

    def _backend(self) -> Any:
        from unittest.mock import patch

        from lnemail.services.payments import nwc_backend as nb

        # Skip real URI parsing/keys.
        backend = nb.NWCBackend.__new__(nb.NWCBackend)
        backend.name = "nwc:test"
        backend.trusted = False
        return backend, nb, patch

    def test_check_invoice_settled_via_settled_at_without_amount(self) -> None:
        backend, nb, patch = self._backend()

        async def fake_call(method: str, params: dict) -> dict:
            # coinos-style: no 'amount' field, settled_at set when paid.
            return {
                "result": {
                    "type": "incoming",
                    "payment_hash": params["payment_hash"],
                    "settled_at": 1781630298,
                    "state": "settled",
                }
            }

        with patch.object(backend, "_nip47_call", fake_call):
            assert backend.check_invoice("abc") is True

    def test_check_invoice_pending_without_amount(self) -> None:
        backend, nb, patch = self._backend()

        async def fake_call(method: str, params: dict) -> dict:
            return {
                "result": {
                    "type": "incoming",
                    "payment_hash": params["payment_hash"],
                    "settled_at": None,
                    "state": "pending",
                }
            }

        with patch.object(backend, "_nip47_call", fake_call):
            assert backend.check_invoice("abc") is False

    def test_check_invoice_swallows_errors(self) -> None:
        backend, nb, patch = self._backend()

        async def boom(method: str, params: dict) -> dict:
            raise RuntimeError("relay down")

        with patch.object(backend, "_nip47_call", boom):
            assert backend.check_invoice("abc") is False

    def test_create_invoice_reads_invoice_field(self) -> None:
        backend, nb, patch = self._backend()

        async def fake_call(method: str, params: dict) -> dict:
            return {
                "result": {
                    "type": "incoming",
                    "invoice": "lnbc_test",
                    "payment_hash": "deadbeef",
                }
            }

        with patch.object(backend, "_nip47_call", fake_call):
            result = backend.create_invoice(10, "memo")
        assert result["payment_request"] == "lnbc_test"
        assert result["payment_hash"] == "deadbeef"
        assert result["provider"] == "nwc:test"
