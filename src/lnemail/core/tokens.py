"""Human-friendly access token generation and normalization.

Tokens use a prefix plus Crockford Base32 encoding of cryptographically random
bytes. Crockford Base32 was chosen because it:

* Uses only digits and uppercase letters (no special characters).
* Excludes the visually ambiguous characters ``I``, ``L``, ``O``, ``U``.
* Defines explicit ambiguity-folding rules (``i``/``l`` -> ``1``,
  ``o`` -> ``0``) so users who transcribe a token with a small mistake can
  still authenticate.
* Is widely used in identifier formats (ULID, Stripe-style keys), so it is
  familiar to users and password managers.

Format
------
``lne_XXXXX-XXXXX-XXXXX-XXXXX-XXXXX``

* Prefix ``lne_`` makes the secret recognisable to users and to tooling
  (similar to ``sk_`` / ``ghp_`` style keys), and keeps the token easy to
  scan for in logs and configuration files.
* 25 Crockford Base32 characters provide 125 bits of entropy, which exceeds
  the 122 bits of a random UUID4 and is comfortably above the 100-bit
  threshold typically considered sufficient for high-value bearer secrets.
* Dashes every 5 characters chunk the value into groups that are easier to
  read, transcribe, and dictate aloud.

Normalization (see :func:`normalize_token`) accepts case-insensitive input,
strips whitespace and dashes, and folds the Crockford ambiguity classes,
allowing users who write the token by hand to log in even with minor
transcription differences.
"""

from __future__ import annotations

import secrets

# Crockford Base32 alphabet: digits 0-9 then A-Z minus I, L, O, U.
# Reference: https://www.crockford.com/base32.html
_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

#: Prefix used to identify LNemail access tokens.
TOKEN_PREFIX = "lne_"

#: Number of random bytes used for the token body. 16 bytes -> 128 bits of
#: random material; encoded as 25 Crockford Base32 characters yields 125 bits
#: of effective entropy (the last character contributes 5 bits but only 3
#: bits of randomness; we discard the trailing low bits deterministically).
_RANDOM_BYTES = 16

#: Number of Crockford Base32 characters in the encoded body.
_BODY_LENGTH = 25

#: Group size for human-friendly chunking with dashes.
_GROUP_SIZE = 5


def _encode_crockford(data: bytes, length: int) -> str:
    """Encode ``data`` using Crockford Base32 and truncate to ``length`` chars.

    A simple bit-packing implementation that does not depend on external
    libraries. Bits are consumed most-significant first.
    """
    bits = 0
    value = 0
    out: list[str] = []
    for byte in data:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5 and len(out) < length:
            bits -= 5
            out.append(_CROCKFORD_ALPHABET[(value >> bits) & 0x1F])
    if len(out) < length:
        # Pad remaining bits left-aligned within a 5-bit chunk.
        out.append(_CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1F])
    return "".join(out[:length])


def _group(s: str, size: int = _GROUP_SIZE, sep: str = "-") -> str:
    """Insert ``sep`` every ``size`` characters."""
    return sep.join(s[i : i + size] for i in range(0, len(s), size))


def generate_access_token() -> str:
    """Generate a new human-friendly access token.

    Returns:
        A token of the form ``lne_XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`` using the
        Crockford Base32 alphabet.
    """
    raw = secrets.token_bytes(_RANDOM_BYTES)
    body = _encode_crockford(raw, _BODY_LENGTH)
    return f"{TOKEN_PREFIX}{_group(body)}"


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

# Crockford ambiguity folding for decode: lower/upper accepted, ``I``/``L`` ->
# ``1``, ``O`` -> ``0``. ``U`` is excluded from the alphabet and rejected.
_CROCKFORD_FOLD = {
    "I": "1",
    "L": "1",
    "O": "0",
}


def normalize_token(token: str) -> str:
    """Normalize a user-supplied token for database lookup.

    The function is intentionally lenient for tokens in the new
    ``lne_`` Crockford format so that minor human-transcription
    variations (case, dashes, spaces, ``O`` vs ``0``, ``I``/``l`` vs ``1``)
    still authenticate the same account.

    Legacy tokens (those that do not start with the ``lne_`` prefix) are
    returned unchanged so that previously issued ``secrets.token_urlsafe``
    values continue to work without modification.

    Args:
        token: The raw token as supplied by the user (e.g. from an
            ``Authorization: Bearer`` header or a login form).

    Returns:
        The canonical form of the token suitable for direct comparison
        against the value stored in the database.
    """
    if not token:
        return token

    stripped = token.strip()

    # Legacy tokens are case-sensitive opaque strings; do not transform.
    if not stripped.lower().startswith(TOKEN_PREFIX):
        return stripped

    body = stripped[len(TOKEN_PREFIX) :]
    # Remove all common visual separators and whitespace.
    cleaned = "".join(ch for ch in body if ch not in "-_ \t\r\n")
    folded_chars: list[str] = []
    for ch in cleaned.upper():
        folded_chars.append(_CROCKFORD_FOLD.get(ch, ch))
    folded = "".join(folded_chars)

    # Re-group with dashes for canonical form. We only re-group if the
    # length matches the expected body length to avoid masking unrelated
    # input errors -- an unexpected length will simply fail the DB lookup.
    if len(folded) == _BODY_LENGTH:
        folded = _group(folded)

    return f"{TOKEN_PREFIX}{folded}"
