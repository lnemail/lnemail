"""Time helpers.

The codebase stores and compares naive UTC datetimes (SQLite has no
timezone support, so values round-trip as naive). ``datetime.utcnow()``
is deprecated in modern Python, so this module provides a single
replacement that keeps the exact same naive-UTC semantics:
``datetime.now(timezone.utc)`` produces an aware value, and we strip the
tzinfo to stay compatible with the naive datetimes loaded from the DB.
"""

from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Return the current UTC time as a naive ``datetime`` (no tzinfo)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)
