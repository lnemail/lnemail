"""Tests for the human-friendly access token module."""

from __future__ import annotations

import re

import pytest

from lnemail.core.tokens import (
    TOKEN_PREFIX,
    _BODY_LENGTH,
    _CROCKFORD_ALPHABET,
    generate_access_token,
    normalize_token,
)


_TOKEN_RE = re.compile(
    r"^lne_[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}"
    r"-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$"
)


class TestGenerateAccessToken:
    def test_format_matches_specification(self) -> None:
        token = generate_access_token()
        assert _TOKEN_RE.match(token), token

    def test_uses_prefix(self) -> None:
        assert generate_access_token().startswith(TOKEN_PREFIX)

    def test_only_uses_crockford_alphabet(self) -> None:
        token = generate_access_token()
        body = token[len(TOKEN_PREFIX) :].replace("-", "")
        for ch in body:
            assert ch in _CROCKFORD_ALPHABET, f"invalid char {ch!r} in {token}"

    def test_no_ambiguous_characters(self) -> None:
        # Crockford Base32 deliberately excludes I, L, O, U.
        token = generate_access_token()
        body = token[len(TOKEN_PREFIX) :]
        for ch in "ILOUilou":
            assert ch not in body

    def test_tokens_are_unique(self) -> None:
        tokens = {generate_access_token() for _ in range(1000)}
        assert len(tokens) == 1000

    def test_body_length(self) -> None:
        token = generate_access_token()
        body = token[len(TOKEN_PREFIX) :].replace("-", "")
        assert len(body) == _BODY_LENGTH


class TestNormalizeToken:
    def test_canonical_token_is_unchanged(self) -> None:
        token = generate_access_token()
        assert normalize_token(token) == token

    def test_strips_surrounding_whitespace(self) -> None:
        token = generate_access_token()
        assert normalize_token(f"  {token}\n") == token

    def test_lowercase_input_is_uppercased(self) -> None:
        token = generate_access_token()
        assert normalize_token(token.lower()) == token

    def test_dashes_are_optional(self) -> None:
        token = generate_access_token()
        body = token[len(TOKEN_PREFIX) :].replace("-", "")
        assert normalize_token(f"{TOKEN_PREFIX}{body}") == token

    def test_internal_whitespace_is_removed(self) -> None:
        token = generate_access_token()
        spaced = token.replace("-", " ")
        assert normalize_token(spaced) == token

    def test_ambiguous_o_folded_to_zero(self) -> None:
        # Build a token whose canonical form has a 0 we will substitute with O.
        token = f"{TOKEN_PREFIX}00000-00000-00000-00000-00000"
        assert normalize_token(token.replace("0", "O")) == token

    def test_ambiguous_i_and_l_folded_to_one(self) -> None:
        token = f"{TOKEN_PREFIX}11111-11111-11111-11111-11111"
        assert normalize_token(token.replace("1", "I")) == token
        assert normalize_token(token.replace("1", "l")) == token

    def test_legacy_tokens_pass_through_unchanged(self) -> None:
        # Old format: secrets.token_urlsafe(32) -> contains lower/upper/dashes.
        legacy = "Abc-DEF_ghi-JKLMNOPQRSTUVWXYZ0123456789abcdef"
        assert normalize_token(legacy) == legacy

    def test_legacy_lookalike_with_lne_prefix_is_normalized(self) -> None:
        # If someone (or a test) uses a custom token starting with lne_
        # but of unexpected length, normalization MUST NOT silently regroup
        # it; we leave the body without dashes so it either matches the DB
        # or fails cleanly.
        wrong = f"{TOKEN_PREFIX}ABCDE"  # too short for re-grouping
        assert normalize_token(wrong) == f"{TOKEN_PREFIX}ABCDE"

    def test_empty_input(self) -> None:
        assert normalize_token("") == ""

    @pytest.mark.parametrize(
        "raw",
        [
            "lne_k3m9x-2h7p4-nqr8t-vwy5f-xjz6b",
            "LNE_K3M9X 2H7P4 NQR8T VWY5F XJZ6B",
            "lne_k3m9x2h7p4nqr8tvwy5fxjz6b",
        ],
    )
    def test_user_friendly_variants_collapse_to_canonical(self, raw: str) -> None:
        canonical = "lne_K3M9X-2H7P4-NQR8T-VWY5F-XJZ6B"
        assert normalize_token(raw) == canonical
